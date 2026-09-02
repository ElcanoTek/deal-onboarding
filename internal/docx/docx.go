// Package docx extracts plain text from Microsoft Word .docx files using only
// the standard library. A .docx is a ZIP container; the body text lives in
// word/document.xml as OOXML. We stream that XML and reconstruct readable text,
// turning paragraphs and table rows into newlines and table cells into " | "
// separators so the structure survives for downstream LLM parsing.
//
// Only .docx (Word 2007+) is supported. The legacy binary .doc format is an OLE
// compound file and is intentionally out of scope.
package docx

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// documentPath is the OOXML part that holds the document body.
const documentPath = "word/document.xml"

// maxDecompressedBytes caps how much of word/document.xml we will inflate. A
// .docx is a ZIP, and DEFLATE can hit ~1000:1, so a small upload can decompress
// to gigabytes — a classic zip bomb. 16 MB of body XML is far larger than any
// real brief, so this only ever trips on pathological input.
const maxDecompressedBytes = 16 << 20

// ExtractText reads a .docx from r (which must be the whole file, size bytes)
// and returns its text content. It returns an error if r is not a valid ZIP,
// does not contain a Word document body, or the body would inflate past
// maxDecompressedBytes.
func ExtractText(r io.ReaderAt, size int64) (string, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return "", fmt.Errorf("not a valid .docx (could not open as zip): %w", err)
	}
	var doc *zip.File
	for _, f := range zr.File {
		if f.Name == documentPath {
			doc = f
			break
		}
	}
	if doc == nil {
		return "", fmt.Errorf("not a Word document (%s missing) — if this is a spreadsheet, use the .xlsx/.csv path instead", documentPath)
	}
	// Reject an honestly-declared oversized body before inflating a single byte.
	if doc.UncompressedSize64 > maxDecompressedBytes {
		return "", fmt.Errorf("document body is too large (%d bytes; limit %d)", doc.UncompressedSize64, maxDecompressedBytes)
	}
	rc, err := doc.Open()
	if err != nil {
		return "", fmt.Errorf("could not open %s: %w", documentPath, err)
	}
	defer rc.Close()
	// Defense in depth: the central-directory size can lie, so also bound the
	// decompressed stream. If a bomb overruns the cap the XML stream truncates
	// and the decoder errors out — memory and CPU both stay bounded.
	return parseDocumentXML(io.LimitReader(rc, maxDecompressedBytes))
}

// Internal boundary markers. We emit these for table cells/rows, then resolve
// them in normalize() so a paragraph's trailing newline inside a cell doesn't
// collide with the cell separator. They are control runes that never occur in
// real document text.
const (
	cellSep = "\x00"
	rowSep  = "\x01"
)

// parseDocumentXML streams word/document.xml and assembles readable text.
//
// Real document text lives only inside w:t runs, so we capture character data
// only while inside one — this ignores the inter-element whitespace some writers
// emit. We deliberately do NOT capture w:instrText (field instruction codes like
// HYPERLINK/REF — noise, never visible content) or w:delText (tracked-change
// DELETED text — content the author removed; emitting it would resurface stale
// values, e.g. an old campaign ID, glued onto the replacement). A field's or
// hyperlink's *visible* text is in a normal w:t run and is still captured.
//
// Structural elements map to whitespace:
//   - </w:p>  (paragraph end) -> newline
//   - </w:tr> (table row end) -> row marker (becomes a newline)
//   - </w:tc> (table cell end) -> cell marker (becomes " | ", or dropped at a row edge)
//   - <w:tab/> -> tab ;  <w:br/> / <w:cr/> -> newline
func parseDocumentXML(r io.Reader) (string, error) {
	dec := xml.NewDecoder(r)
	var b strings.Builder
	textDepth := 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("parsing %s: %w", documentPath, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				textDepth++
			case "tab":
				b.WriteByte('\t')
			case "br", "cr":
				b.WriteByte('\n')
			}
		case xml.CharData:
			if textDepth > 0 {
				b.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				if textDepth > 0 {
					textDepth--
				}
			case "p":
				b.WriteByte('\n')
			case "tc":
				b.WriteString(cellSep)
			case "tr":
				b.WriteString(rowSep)
			}
		}
	}
	return normalize(b.String()), nil
}

var (
	reAroundCell  = regexp.MustCompile(`\s*` + cellSep + `\s*`)              // tighten ws around a cell boundary
	reAroundRow   = regexp.MustCompile(`\s*` + rowSep + `\s*`)               // tighten ws around a row boundary
	reLeadCellAt  = regexp.MustCompile(`(^|` + rowSep + `)` + cellSep + `+`) // dangling cell sep at a row's start
	reTrailCellAt = regexp.MustCompile(cellSep + `+(` + rowSep + `|$)`)      // dangling cell sep at a row's end
	reTrailingWS  = regexp.MustCompile(`[ \t]+\n`)
	reBlankRuns   = regexp.MustCompile(`\n{3,}`)
)

// normalize resolves the cell/row markers into " | " / newlines and tidies
// whitespace: an in-cell paragraph's trailing newline is absorbed into the cell
// boundary, the dangling separators at a row's start and end are dropped (so an
// empty first/last cell doesn't leave an orphan pipe), and long blank runs
// collapse.
func normalize(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = reAroundCell.ReplaceAllString(s, cellSep)
	s = reAroundRow.ReplaceAllString(s, rowSep)
	s = reLeadCellAt.ReplaceAllString(s, "$1")
	s = reTrailCellAt.ReplaceAllString(s, "$1")
	s = strings.ReplaceAll(s, cellSep, " | ")
	s = strings.ReplaceAll(s, rowSep, "\n")
	s = reTrailingWS.ReplaceAllString(s, "\n")
	s = reBlankRuns.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

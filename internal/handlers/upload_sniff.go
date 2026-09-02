package handlers

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"
)

// =============================================================================
// Upload content sniffing (#208).
//
// Uploads used to get EXTENSION-ONLY validation. Uploaded files ride straight
// into a LIVE runner agent run
// as the "authoritative" targeting source  —
// so a body that isn't remotely the file type its name claims must be rejected
// at the door, on BOTH upload paths (trader /api/upload and public
// any future upload route share handleUploadInto):
//
//   - .csv/.tsv/.txt  → the first ~KB must be text/CSV-shaped: no binary
//     container magics, no NUL/control bytes, and not HTML/script-shaped
//     (an HTML or shell body renamed .csv is exactly the smuggling shape
//     this closes).
//   - .xlsx           → must open with the OOXML ZIP magic PK\x03\x04.
//   - .xls            → must open with the legacy OLE compound-document magic
//     (a modern workbook saved with the legacy extension — ZIP magic — is
//     also accepted; both are real workbooks the pipeline can read).
//
// This is a shape check, not a content audit: adversarial ROWS inside a real
// CSV still pass it, which is why the row lint below computes how list-like
// the rows actually are and the trader review modal surfaces the result.
// =============================================================================

// sniffWindowBytes is how much of the file head the content sniff examines.
const sniffWindowBytes = 1024

var (
	zipMagic = []byte{0x50, 0x4B, 0x03, 0x04}                         // PK\x03\x04 — OOXML/ZIP
	oleMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1} // legacy Office compound doc
)

// binarySignatures are container/image/executable magics that must never open
// a text list. Formats whose heads are pure ASCII for a while (PDF, GIF) need
// the explicit signature; the rest would usually also trip the control-byte
// check, but naming the format makes the rejection actionable.
var binarySignatures = []struct {
	magic []byte
	kind  string
}{
	{zipMagic, "a ZIP/Office container"},
	{oleMagic, "a legacy Office document"},
	{[]byte("%PDF-"), "a PDF document"},
	{[]byte{0x7F, 'E', 'L', 'F'}, "an executable"},
	{[]byte{0x1F, 0x8B}, "a gzip archive"},
	{[]byte{0x89, 'P', 'N', 'G'}, "a PNG image"},
	{[]byte("GIF8"), "a GIF image"},
	{[]byte{0xFF, 0xD8, 0xFF}, "a JPEG image"},
}

// htmlTagStartRe matches a head whose first non-whitespace byte opens an
// HTML/XML tag ("<!doctype", "<html", "<script", "<?php", "</", …). Digits
// after '<' deliberately do NOT match, so a data cell like "<10ms" survives.
var htmlTagStartRe = regexp.MustCompile(`^<[!?/a-zA-Z]`)

// sniffUploadHead validates that head (the first sniffWindowBytes of an
// upload) is plausibly the declared extension. Returns a trader-actionable
// error on mismatch; nil means the upload may proceed.
func sniffUploadHead(ext string, head []byte) error {
	switch ext {
	case ".xlsx":
		if !bytes.HasPrefix(head, zipMagic) {
			return fmt.Errorf("file content does not match the %s extension — a real .xlsx workbook starts with the ZIP signature (PK). Re-export the workbook and upload it again", ext)
		}
		return nil
	case ".xls":
		if !bytes.HasPrefix(head, oleMagic) && !bytes.HasPrefix(head, zipMagic) {
			return fmt.Errorf("file content does not match the %s extension — a real .xls workbook starts with the Office document signature. Re-export the workbook and upload it again", ext)
		}
		return nil
	case ".csv", ".tsv", ".txt":
		return sniffTextShaped(ext, head)
	}
	// Extensions outside the allowlist were already rejected by the caller.
	return nil
}

// sniffTextShaped rejects a head that isn't plausible text/CSV content.
func sniffTextShaped(ext string, head []byte) error {
	if len(head) == 0 {
		// An empty file carries no rows and no payload — harmless.
		return nil
	}
	for _, sig := range binarySignatures {
		if bytes.HasPrefix(head, sig.magic) {
			return fmt.Errorf("file content does not match the %s extension — it looks like %s renamed to %s. Upload the actual list as text/CSV", ext, sig.kind, ext)
		}
	}
	text, ok := decodeSniffWindow(head)
	if !ok {
		return fmt.Errorf("file content does not match the %s extension — it contains binary data, not text rows. Upload the actual list as text/CSV", ext)
	}
	lower := strings.ToLower(text)
	trimmed := strings.TrimLeft(lower, " \t\r\n\v\f")
	switch {
	case htmlTagStartRe.MatchString(trimmed),
		strings.Contains(lower, "<script"),
		strings.Contains(lower, "<?php"):
		return fmt.Errorf("file content does not match the %s extension — it looks like an HTML/markup document renamed to %s. Upload the actual list as text/CSV", ext, ext)
	case strings.HasPrefix(trimmed, "#!"):
		return fmt.Errorf("file content does not match the %s extension — it looks like a script, not a list. Upload the actual list as text/CSV", ext)
	}
	return nil
}

// decodeSniffWindow turns the raw head bytes into the text the shape checks
// run against, honoring BOMs so real Excel exports pass:
//   - UTF-8 BOM        → stripped;
//   - UTF-16 LE/BE BOM → decoded (Excel's "Unicode Text" export is UTF-16LE,
//     whose alternating NULs would otherwise read as binary);
//   - anything else    → taken as-is (UTF-8 / Windows-1252 both pass the
//     byte-level checks: only C0 controls are rejected, high bytes are fine).
//
// Returns ok=false when the bytes contain NUL or non-whitespace C0 control
// characters — the binary tell for every container/executable format.
func decodeSniffWindow(head []byte) (string, bool) {
	var text string
	switch {
	case bytes.HasPrefix(head, []byte{0xEF, 0xBB, 0xBF}):
		text = string(head[3:])
	case bytes.HasPrefix(head, []byte{0xFF, 0xFE}), bytes.HasPrefix(head, []byte{0xFE, 0xFF}):
		be := head[0] == 0xFE
		b := head[2:]
		if len(b)%2 == 1 {
			b = b[:len(b)-1] // the window may split a code unit — drop the half
		}
		u16 := make([]uint16, 0, len(b)/2)
		for i := 0; i+1 < len(b); i += 2 {
			if be {
				u16 = append(u16, uint16(b[i])<<8|uint16(b[i+1]))
			} else {
				u16 = append(u16, uint16(b[i+1])<<8|uint16(b[i]))
			}
		}
		text = string(utf16.Decode(u16))
	default:
		text = string(head)
	}
	for _, r := range text {
		if r < 0x20 && r != '\t' && r != '\n' && r != '\v' && r != '\f' && r != '\r' {
			return "", false
		}
	}
	return text, true
}

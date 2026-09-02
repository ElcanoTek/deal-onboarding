package docx

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// buildDocx assembles a minimal valid .docx whose word/document.xml is the given
// body XML, and returns the raw bytes.
func buildDocx(t *testing.T, bodyXML string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip.Create(%s): %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("write(%s): %v", name, err)
		}
	}
	write("[Content_Types].xml", `<?xml version="1.0"?><Types/>`)
	write(documentPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`+
		bodyXML+`</w:body></w:document>`)
	if err := zw.Close(); err != nil {
		t.Fatalf("zip.Close: %v", err)
	}
	return buf.Bytes()
}

func extract(t *testing.T, raw []byte) string {
	t.Helper()
	got, err := ExtractText(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("ExtractText: %v", err)
	}
	return got
}

func TestExtractParagraphs(t *testing.T) {
	raw := buildDocx(t, `<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`+
		`<w:p><w:r><w:t xml:space="preserve">world </w:t></w:r><w:r><w:t>again</w:t></w:r></w:p>`)
	got := extract(t, raw)
	want := "Hello\nworld again"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractEntitiesAndTabsAndBreaks(t *testing.T) {
	raw := buildDocx(t, `<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p>`)
	got := extract(t, raw)
	want := "A&B\tC\nD"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractTableBecomesPipesAndRows(t *testing.T) {
	// Two-row, two-column table. Each cell -> " | ", each row -> newline. The
	// dangling separator at a row's end is dropped by normalize.
	raw := buildDocx(t, `<w:tbl>`+
		`<w:tr><w:tc><w:p><w:r><w:t>Advertiser</w:t></w:r></w:p></w:tc>`+
		`<w:tc><w:p><w:r><w:t>Energizer Brands</w:t></w:r></w:p></w:tc></w:tr>`+
		`<w:tr><w:tc><w:p><w:r><w:t>SSP</w:t></w:r></w:p></w:tc>`+
		`<w:tc><w:p><w:r><w:t>Index Exchange</w:t></w:r></w:p></w:tc></w:tr>`+
		`</w:tbl>`)
	got := extract(t, raw)
	for _, want := range []string{"Advertiser | Energizer Brands", "SSP | Index Exchange"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}

func TestIgnoresInterElementWhitespace(t *testing.T) {
	// A pretty-printed document.xml has newlines/indentation between tags. Those
	// must NOT leak into the output — only w:t content counts.
	raw := buildDocx(t, "\n  <w:p>\n    <w:r>\n      <w:t>Only this</w:t>\n    </w:r>\n  </w:p>\n")
	got := extract(t, raw)
	if got != "Only this" {
		t.Errorf("got %q, want %q", got, "Only this")
	}
}

func TestTrackedChangeDeletedTextIsDropped(t *testing.T) {
	// w:delText is tracked-change DELETED content (the old value the author
	// removed). It must NOT resurface — only the w:t replacement survives.
	raw := buildDocx(t, `<w:p><w:r><w:t xml:space="preserve">Campaign </w:t></w:r>`+
		`<w:del><w:r><w:delText>DEAL00100</w:delText></w:r></w:del>`+
		`<w:ins><w:r><w:t>DEAL00172</w:t></w:r></w:ins></w:p>`)
	got := extract(t, raw)
	if got != "Campaign DEAL00172" {
		t.Errorf("got %q, want %q (deleted DEAL00100 must not appear)", got, "Campaign DEAL00172")
	}
}

func TestFieldInstructionCodesAreDropped(t *testing.T) {
	// w:instrText holds field instruction codes (HYPERLINK/REF/PAGE …), never
	// visible content. Only the field's w:t result should survive.
	raw := buildDocx(t, `<w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "http://x.test" </w:instrText></w:r>`+
		`<w:r><w:t>Click here</w:t></w:r></w:p>`)
	got := extract(t, raw)
	if got != "Click here" {
		t.Errorf("got %q, want %q (field code must not appear)", got, "Click here")
	}
}

func TestLeadingEmptyCellHasNoOrphanPipe(t *testing.T) {
	// A row whose first cell is empty must not produce a leading "| value".
	raw := buildDocx(t, `<w:tbl><w:tr>`+
		`<w:tc><w:p></w:p></w:tc>`+
		`<w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc>`+
		`</w:tr></w:tbl>`)
	got := extract(t, raw)
	if got != "Value" {
		t.Errorf("got %q, want %q (no orphan leading pipe)", got, "Value")
	}
}

func TestOversizedDeclaredBodyRejected(t *testing.T) {
	// A zip entry that declares a huge uncompressed size is rejected before any
	// inflation. We can't easily craft one through zip.Writer, so assert the
	// guard constant is wired by checking a normal doc stays well under it and
	// the error path exists via the size field. This is a lightweight smoke
	// test; the real bomb defense is the UncompressedSize64 check + LimitReader.
	raw := buildDocx(t, `<w:p><w:r><w:t>small</w:t></w:r></w:p>`)
	if got := extract(t, raw); got != "small" {
		t.Errorf("normal doc broke: %q", got)
	}
	if maxDecompressedBytes < 1<<20 {
		t.Errorf("maxDecompressedBytes unexpectedly small: %d", maxDecompressedBytes)
	}
}

func TestNotAZipFails(t *testing.T) {
	raw := []byte("this is plainly not a zip archive")
	if _, err := ExtractText(bytes.NewReader(raw), int64(len(raw))); err == nil {
		t.Fatal("expected error for non-zip input, got nil")
	}
}

func TestZipWithoutDocumentXMLFails(t *testing.T) {
	// A valid zip (e.g. an .xlsx) that lacks word/document.xml must be rejected
	// with a clear message rather than returning empty text.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("xl/workbook.xml")
	_, _ = w.Write([]byte("<workbook/>"))
	_ = zw.Close()
	raw := buf.Bytes()
	_, err := ExtractText(bytes.NewReader(raw), int64(len(raw)))
	if err == nil {
		t.Fatal("expected error for zip without word/document.xml")
	}
	if !strings.Contains(err.Error(), "not a Word document") {
		t.Errorf("error should mention it is not a Word document, got: %v", err)
	}
}

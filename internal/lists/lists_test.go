package lists

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFixture builds a temp lists directory with the given manifests and
// data files. Manifests are passed as "filename.json" → raw JSON; data files
// likewise. Returns the directory path.
func writeFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestLoadEmptyDirReturnsEmptyRegistry(t *testing.T) {
	dir := t.TempDir()
	reg, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := len(reg.List()); got != 0 {
		t.Fatalf("expected empty registry, got %d entries", got)
	}
}

func TestLoadMissingDirReturnsEmptyRegistry(t *testing.T) {
	reg, err := Load(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := len(reg.List()); got != 0 {
		t.Fatalf("expected empty registry, got %d entries", got)
	}
}

func TestLoadParsesManifestsAndCountsLines(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"longtail-block.json": `{
			"id": "longtail-block",
			"name": "Longtail Block List",
			"description": "Default exclude",
			"kind": "block",
			"scope": "domain",
			"file": "longtail-block.csv"
		}`,
		"longtail-block.csv": "example.com\nspam.net\n\nlow-quality.org\n",
		"partner-premium.json": `{
			"id": "partner-premium",
			"name": "Partner Premium Allow",
			"kind": "allow",
			"scope": "domain",
			"file": "partner-premium.csv"
		}`,
		"partner-premium.csv": "news.example\nsports.example\n",
	})

	reg, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got := len(reg.List()); got != 2 {
		t.Fatalf("expected 2 lists, got %d", got)
	}

	longtail, ok := reg.Get("longtail-block")
	if !ok {
		t.Fatal("longtail-block not loaded")
	}
	if longtail.Kind != KindBlock || longtail.Scope != ScopeDomain {
		t.Fatalf("longtail kind/scope wrong: %+v", longtail)
	}
	if longtail.LineCount != 3 {
		t.Fatalf("expected 3 non-blank lines, got %d", longtail.LineCount)
	}
	if longtail.Path == "" {
		t.Fatal("Path not populated")
	}

}

func TestLoadRejectsDuplicateID(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"a.json": `{"id":"same","name":"A","kind":"block","scope":"domain","file":"d.csv"}`,
		"b.json": `{"id":"same","name":"B","kind":"allow","scope":"domain","file":"d.csv"}`,
		"d.csv":  "x.com\n",
	})
	if _, err := Load(dir); err == nil {
		t.Fatal("expected duplicate-id error, got nil")
	}
}

func TestLoadRejectsInvalidKind(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"bad.json": `{"id":"bad","name":"Bad","kind":"include","scope":"domain","file":"d.csv"}`,
		"d.csv":    "x.com\n",
	})
	if _, err := Load(dir); err == nil {
		t.Fatal("expected invalid-kind error, got nil")
	}
}

func TestLoadRejectsMissingDataFile(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"orphan.json": `{"id":"orphan","name":"Orphan","kind":"block","scope":"domain","file":"missing.csv"}`,
	})
	if _, err := Load(dir); err == nil {
		t.Fatal("expected missing-file error, got nil")
	}
}

func TestResolvePreservesOrderAndDropsUnknown(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"a.json": `{"id":"a","name":"A","kind":"block","scope":"domain","file":"a.csv"}`,
		"a.csv":  "x\n",
		"b.json": `{"id":"b","name":"B","kind":"allow","scope":"domain","file":"b.csv"}`,
		"b.csv":  "y\n",
	})
	reg, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	got := reg.Resolve([]string{"b", "missing", "a"})
	if len(got) != 2 {
		t.Fatalf("expected 2 resolved (b, a), got %d", len(got))
	}
	if got[0].ID != "b" || got[1].ID != "a" {
		t.Fatalf("order not preserved: %v", []string{got[0].ID, got[1].ID})
	}
}

// #198 — the name a standard list travels under. An extensionless display
// name gains the data file's extension (IX rejects extensionless list files;
// OpenX routes .csv vs .xlsx to different parsers); a name that already
// carries an extension is never double-suffixed. The exact literals here are
// the byte-identity contract with the frontend's standardListUploadName
// (dealPromptYaml.test.ts pins the same inputs → same outputs).
func TestUploadNameAppendsDataFileExtension(t *testing.T) {
	cases := []struct {
		name string
		list List
		want string
	}{
		{"extensionless name gains .csv", List{Name: "Longtail Block", Path: "/lists/longtail-block.csv"}, "Longtail Block.csv"},
		{"extensionless name gains .xlsx", List{Name: "Premium Allow", Path: "/lists/premium.xlsx"}, "Premium Allow.xlsx"},
		{"name already carrying a DATA extension is not double-suffixed", List{Name: "Longtail Block.csv", Path: "/lists/longtail-block.csv"}, "Longtail Block.csv"},
		{"surrounding whitespace trimmed before the check", List{Name: "  Longtail Block  ", Path: "/lists/longtail-block.csv"}, "Longtail Block.csv"},
		{"blank name falls back to the on-disk basename", List{Name: "  ", Path: "/lists/longtail-block.csv"}, "longtail-block.csv"},
		{"extensionless data file appends nothing", List{Name: "Raw List", Path: "/lists/rawlist"}, "Raw List"},
		// FIX 8 — a version-suffixed name has a non-empty (but non-DATA)
		// filepath.Ext, so it must STILL gain the real data extension.
		{"dotted version name gains the data extension", List{Name: "Sites v2.1", Path: "/lists/sites.csv"}, "Sites v2.1.csv"},
		{"dotted date-ish name gains the data extension", List{Name: "Q3.2026 Blocklist", Path: "/lists/q3.csv"}, "Q3.2026 Blocklist.csv"},
		// FIX 7 — Go strings.TrimSpace does NOT strip a leading BOM (U+FEFF)
		// but DOES strip NEL (U+0085); the TS mirror must match these exactly.
		{"leading BOM is NOT stripped (matches TrimSpace)", List{Name: "\ufeffLongtail Block", Path: "/lists/x.csv"}, "\ufeffLongtail Block.csv"},
		{"trailing NEL IS stripped (matches TrimSpace)", List{Name: "Longtail\u0085", Path: "/lists/x.csv"}, "Longtail.csv"},
	}
	for _, tc := range cases {
		if got := tc.list.UploadName(); got != tc.want {
			t.Errorf("%s: UploadName() = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// #198 — the /api/lists Summary must expose the data file's extension so the
// frontend can derive the same UploadName the server uploads under.
func TestSummaryCarriesFileExt(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"a.json": `{"id":"a","name":"A","kind":"block","scope":"domain","file":"a.csv"}`,
		"a.csv":  "x\n",
	})
	reg, _ := Load(dir)
	summaries := reg.List()
	if len(summaries) != 1 || summaries[0].FileExt != ".csv" {
		t.Fatalf("Summary.FileExt = %+v, want .csv", summaries)
	}
	// #198 FIX 7 — the basename is exposed so the frontend can mirror the
	// blank-name → basename UploadName fallback byte-for-byte.
	if summaries[0].FileBase != "a.csv" {
		t.Fatalf("Summary.FileBase = %q, want a.csv", summaries[0].FileBase)
	}
}

func TestSummaryExcludesPath(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"a.json": `{"id":"a","name":"A","kind":"block","scope":"domain","file":"a.csv"}`,
		"a.csv":  "x\n",
	})
	reg, _ := Load(dir)
	summaries := reg.List()
	if len(summaries) != 1 {
		t.Fatalf("want 1, got %d", len(summaries))
	}
	// Summary type intentionally has no Path field — compile-time guarantee.
	// This test asserts the surface is what we want by name.
	if summaries[0].ID != "a" || summaries[0].Kind != KindBlock {
		t.Fatalf("summary contents wrong: %+v", summaries[0])
	}
}

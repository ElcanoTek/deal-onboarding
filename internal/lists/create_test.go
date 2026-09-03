// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package lists

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateRegistersAndPersists(t *testing.T) {
	dir := t.TempDir()
	reg, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	src := filepath.Join(t.TempDir(), "pasted.csv")
	if err := os.WriteFile(src, []byte("example.com\nfoo.com\n\nbar.com\n"), 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	sum, err := reg.Create("Hispanic News Domains", KindBlock, ScopeDomain, src)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sum.ID != "hispanic-news-domains" {
		t.Errorf("slug id: got %q", sum.ID)
	}
	if sum.LineCount != 3 {
		t.Errorf("line count: want 3 non-blank, got %d", sum.LineCount)
	}
	if sum.Kind != KindBlock || sum.Scope != ScopeDomain {
		t.Errorf("kind/scope: %+v", sum)
	}

	// Appears in List immediately.
	found := false
	for _, s := range reg.List() {
		if s.ID == sum.ID {
			found = true
		}
	}
	if !found {
		t.Error("created list not in List()")
	}

	// Resolvable to a real on-disk path.
	got := reg.Resolve([]string{sum.ID})
	if len(got) != 1 || got[0].Path == "" {
		t.Fatalf("Resolve: %+v", got)
	}
	if _, err := os.Stat(got[0].Path); err != nil {
		t.Errorf("data file not written: %v", err)
	}
	// Deal Onboarding persisted (a fresh Load picks it up).
	reg2, err := Load(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if _, ok := reg2.Get(sum.ID); !ok {
		t.Error("created list did not survive a reload")
	}

	// Invalid kind/scope rejected.
	if _, err := reg.Create("bad", Kind("nope"), ScopeDomain, src); err == nil {
		t.Error("expected error on invalid kind")
	}
}

// writeRepoList drops a manifest + data file into dir so a merged load has a
// versioned repo list to work with.
func writeRepoList(t *testing.T, dir, id string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir repo dir: %v", err)
	}
	dataName := id + ".csv"
	if err := os.WriteFile(filepath.Join(dir, dataName), []byte("Sites\nexample.com\n"), 0o644); err != nil {
		t.Fatalf("write repo data: %v", err)
	}
	manifest := `{"id":"` + id + `","name":"` + id + `","kind":"block","scope":"domain","file":"` + dataName + `"}`
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("write repo manifest: %v", err)
	}
}

// TestLoadMergedPersistsRuntimeSeparately is the P0 data-loss guard: a
// trader-created list must be written into the RUNTIME dir (under DATA_DIR,
// deploy-safe), never the repo dir that `rsync --delete` wipes — while repo
// lists still load and are visible.
func TestLoadMergedPersistsRuntimeSeparately(t *testing.T) {
	repoDir := t.TempDir()
	runtimeDir := t.TempDir()
	writeRepoList(t, repoDir, "longtail-block")

	reg, err := LoadMerged(repoDir, runtimeDir)
	if err != nil {
		t.Fatalf("LoadMerged: %v", err)
	}
	if _, ok := reg.Get("longtail-block"); !ok {
		t.Fatal("repo list should be visible after merge")
	}

	src := filepath.Join(t.TempDir(), "pasted.csv")
	if err := os.WriteFile(src, []byte("Sites\nfoo.com\nbar.com\n"), 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}
	sum, err := reg.Create("Client Roster", KindAllow, ScopeDomain, src)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// The created list's files must be in the RUNTIME dir, not the repo dir.
	if _, err := os.Stat(filepath.Join(runtimeDir, sum.ID+".json")); err != nil {
		t.Errorf("runtime manifest not written to runtimeDir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repoDir, sum.ID+".json")); err == nil {
		t.Error("runtime list leaked into the repo dir — deploy rsync would wipe it")
	}

	// A merged reload (simulating a restart after a deploy that kept DATA_DIR
	// but re-synced the repo dir) still finds BOTH lists.
	reg2, err := LoadMerged(repoDir, runtimeDir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if _, ok := reg2.Get(sum.ID); !ok {
		t.Error("runtime-created list did not survive a merged reload")
	}
	if _, ok := reg2.Get("longtail-block"); !ok {
		t.Error("repo list missing after merged reload")
	}
}

// TestLoadMergedRepoWinsOnIDCollision pins that a runtime list can never shadow
// a repo list of the same id (the repo list is canonical/versioned).
func TestLoadMergedRepoWinsOnIDCollision(t *testing.T) {
	repoDir := t.TempDir()
	runtimeDir := t.TempDir()
	writeRepoList(t, repoDir, "shared-id") // kind=block

	// Hand-plant a runtime manifest with the same id but a different kind.
	if err := os.WriteFile(filepath.Join(runtimeDir, "shared-id.csv"), []byte("Sites\nother.com\n"), 0o644); err != nil {
		t.Fatalf("write runtime data: %v", err)
	}
	rt := `{"id":"shared-id","name":"runtime shadow","kind":"allow","scope":"domain","file":"shared-id.csv"}`
	if err := os.WriteFile(filepath.Join(runtimeDir, "shared-id.json"), []byte(rt), 0o644); err != nil {
		t.Fatalf("write runtime manifest: %v", err)
	}

	reg, err := LoadMerged(repoDir, runtimeDir)
	if err != nil {
		t.Fatalf("LoadMerged: %v", err)
	}
	l, ok := reg.Get("shared-id")
	if !ok {
		t.Fatal("shared-id should load")
	}
	if l.Kind != KindBlock {
		t.Errorf("repo list must win on id collision: kind=%q, want block", l.Kind)
	}
	// Exactly one entry with that id.
	count := 0
	for _, s := range reg.List() {
		if s.ID == "shared-id" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("want exactly 1 shared-id entry, got %d", count)
	}
}

// seedSrc writes content to a temp file with the given extension and returns
// its path. Used to drive Create's promote-time validation.
func seedSrc(t *testing.T, ext, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "pasted"+ext)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}
	return p
}

func firstDataLine(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		return strings.TrimSpace(line)
	}
	return ""
}

// TestCreateNormalizesAndValidatesHeader covers the promote-time validation:
// canonical header kept, headerless data gets the header prepended, scope
// mismatch + foreign header + binary xlsx are rejected.
func TestCreateNormalizesAndValidatesHeader(t *testing.T) {
	t.Run("headerless domain data gets Sites prepended", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "example.com\nfoo.com\n")
		sum, err := reg.Create("Roster", KindBlock, ScopeDomain, src)
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		l, _ := reg.Get(sum.ID)
		if got := firstDataLine(t, l.Path); got != "Sites" {
			t.Errorf("first row = %q, want prepended header Sites", got)
		}
		if sum.LineCount != 2 {
			t.Errorf("line count = %d, want 2 (header excluded)", sum.LineCount)
		}
	})

	t.Run("canonical header kept, not duplicated", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "Sites\nexample.com\n")
		sum, err := reg.Create("Roster2", KindAllow, ScopeDomain, src)
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		l, _ := reg.Get(sum.ID)
		b, _ := os.ReadFile(l.Path)
		if strings.Count(string(b), "Sites") != 1 {
			t.Errorf("header duplicated: %q", string(b))
		}
	})

	t.Run("bundles data with Bundles scope prepends Bundles", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "com.foo.bar\n284882215\n")
		sum, err := reg.Create("Apps", KindBlock, ScopeAppBundle, src)
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		l, _ := reg.Get(sum.ID)
		if got := firstDataLine(t, l.Path); got != "Bundles" {
			t.Errorf("first row = %q, want Bundles", got)
		}
	})

	t.Run("scope mismatch (Bundles header, domain scope) rejected", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "Bundles\ncom.foo.bar\n")
		if _, err := reg.Create("Wrong", KindBlock, ScopeDomain, src); err == nil {
			t.Error("expected rejection on scope mismatch")
		}
	})

	t.Run("foreign header rejected", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "URL List\nexample.com\n")
		if _, err := reg.Create("Foreign", KindBlock, ScopeDomain, src); err == nil {
			t.Error("expected rejection on foreign header 'URL List'")
		}
	})

	t.Run("bare 'domain' header rejected (not a value, not canonical)", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "domain\nexample.com\n")
		if _, err := reg.Create("Bare", KindBlock, ScopeDomain, src); err == nil {
			t.Error("expected rejection on bare 'domain' header")
		}
	})

	t.Run("xlsx source rejected with guidance", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".xlsx", "PK\x03\x04 binary")
		_, err := reg.Create("Excel", KindBlock, ScopeDomain, src)
		if err == nil || !strings.Contains(err.Error(), "CSV") {
			t.Errorf("want an actionable xlsx rejection, got %v", err)
		}
	})

	t.Run("empty file rejected", func(t *testing.T) {
		reg, _ := Load(t.TempDir())
		src := seedSrc(t, ".csv", "")
		if _, err := reg.Create("Empty", KindBlock, ScopeDomain, src); err == nil {
			t.Error("expected rejection on empty file")
		}
	})
}

// TestCreateSetsVersionFields pins that a created list carries a sha256 + a
// non-zero updatedAt so the picker can show a version/staleness signal.
func TestCreateSetsVersionFields(t *testing.T) {
	reg, _ := Load(t.TempDir())
	src := seedSrc(t, ".csv", "Sites\nexample.com\n")
	sum, err := reg.Create("Versioned", KindAllow, ScopeDomain, src)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(sum.SHA256) != 64 {
		t.Errorf("sha256 = %q, want a 64-char hex digest", sum.SHA256)
	}
	if sum.UpdatedAt.IsZero() {
		t.Error("updatedAt should be set")
	}
	// A fresh load recomputes the same digest.
	l, _ := reg.Get(sum.ID)
	if l.SHA256 != sum.SHA256 {
		t.Errorf("registry sha256 %q != summary %q", l.SHA256, sum.SHA256)
	}
}

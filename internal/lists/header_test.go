// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package lists

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRepoListFilesCarryValueColumnHeader pins the lists-dir contract: every
// curated lists/*.csv opens with a literal value-column header — exactly
// "Sites" for domain lists, "Bundles" for app-bundle lists — matching the
// detectedColumn the prompt builder emits for standard lists
// (standardListAsFile in frontend/src/lib/dealPromptYaml.ts). The header also
// mitigates cutlass #675, which drops row 0 of headerless files: with a header
// present, the dropped row is metadata, never a targeted domain/bundle.
// Guarded here so a new or edited list can't silently regress the contract.
func TestRepoListFilesCarryValueColumnHeader(t *testing.T) {
	dir := filepath.Join("..", "..", "lists")
	reg, err := Load(dir)
	if err != nil {
		t.Fatalf("Load(%s): %v", dir, err)
	}
	summaries := reg.List()
	if len(summaries) == 0 {
		t.Fatalf("no lists loaded from %s — expected the repo's curated lists", dir)
	}

	csvCount := 0
	for _, s := range summaries {
		l, ok := reg.Get(s.ID)
		if !ok {
			t.Fatalf("list %s not resolvable", s.ID)
		}
		if !strings.HasSuffix(strings.ToLower(l.File), ".csv") {
			continue
		}
		csvCount++

		want := "Sites"
		if l.Scope == ScopeAppBundle {
			want = "Bundles"
		}
		if got := firstLine(t, l.Path); got != want {
			t.Errorf("list %s (%s scope): first line = %q, want %q — every lists/*.csv must open with its value-column header", l.ID, l.Scope, got, want)
		}
	}
	if csvCount == 0 {
		t.Fatal("no .csv list files checked — the header contract has nothing to guard")
	}
}

// firstLine reads the file's first line with a leading UTF-8 BOM stripped
// (the BOM belongs to the file, not the header — longtail-block.csv carries
// one). Scanner's ScanLines already drops the trailing \r of CRLF files.
func firstLine(t *testing.T, path string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	if !s.Scan() {
		t.Fatalf("%s is empty", path)
	}
	return strings.TrimPrefix(s.Text(), "\ufeff")
}

// TestCountLinesSkipsHeaderRow pins that the canonical header row is excluded
// from LineCount (the picker's "N domains" figure), including behind a BOM,
// while a non-header first line still counts as data.
func TestCountLinesSkipsHeaderRow(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"sites.json":   `{"id":"sites","name":"S","kind":"block","scope":"domain","file":"sites.csv"}`,
		"sites.csv":    "Sites\r\nexample.com\r\nspam.net\r\n",
		"bundles.json": `{"id":"bundles","name":"B","kind":"allow","scope":"app_bundle","file":"bundles.csv"}`,
		"bundles.csv":  "\ufeffBundles\ncom.hulu.plus\n",
		"bare.json":    `{"id":"bare","name":"Bare","kind":"block","scope":"domain","file":"bare.csv"}`,
		"bare.csv":     "example.com\nspam.net\n",
	})
	reg, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	for id, want := range map[string]int{"sites": 2, "bundles": 1, "bare": 2} {
		l, _ := reg.Get(id)
		if l.LineCount != want {
			t.Errorf("%s: LineCount = %d, want %d", id, l.LineCount, want)
		}
	}
}

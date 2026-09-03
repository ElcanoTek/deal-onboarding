// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package gc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeUpload(t *testing.T, dir, name string, size int, mod time.Time) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBuildPlan_ClassifiesByAge(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	uploads := filepath.Join(t.TempDir(), "uploads")
	writeUpload(t, uploads, "old.csv", 10, now.Add(-30*24*time.Hour))
	writeUpload(t, uploads, "fresh.csv", 20, now.Add(-2*time.Hour))
	if err := os.MkdirAll(filepath.Join(uploads, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	plan, err := BuildPlan([]string{uploads}, 7*24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Candidates) != 1 || filepath.Base(plan.Candidates[0].Path) != "old.csv" {
		t.Fatalf("candidates = %+v", plan.Candidates)
	}
	if len(plan.Protected) != 1 || filepath.Base(plan.Protected[0].Path) != "fresh.csv" {
		t.Fatalf("protected = %+v", plan.Protected)
	}
	if plan.CandidateBytes() != 10 {
		t.Fatalf("candidate bytes = %d", plan.CandidateBytes())
	}
}

func TestBuildPlan_MissingDirIsSkipped(t *testing.T) {
	plan, err := BuildPlan([]string{filepath.Join(t.TempDir(), "nope")}, time.Hour, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ScannedDirs) != 0 || len(plan.Candidates) != 0 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
}

func TestApply_DeletesOnlyCandidates(t *testing.T) {
	now := time.Now()
	uploads := filepath.Join(t.TempDir(), "uploads")
	old := writeUpload(t, uploads, "old.csv", 10, now.Add(-30*24*time.Hour))
	fresh := writeUpload(t, uploads, "fresh.csv", 10, now)
	plan, err := BuildPlan([]string{uploads}, 7*24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	deleted, freed, errs := plan.Apply()
	if len(errs) != 0 || deleted != 1 || freed != 10 {
		t.Fatalf("deleted=%d freed=%d errs=%v", deleted, freed, errs)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old file must be deleted")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh file must survive")
	}
}

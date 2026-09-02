package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteFileAtomicCreatesAndOverwrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rec.json")

	if err := WriteFileAtomic(path, []byte("v1"), 0o644); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "v1" {
		t.Fatalf("got %q, want v1", got)
	}

	if err := WriteFileAtomic(path, []byte("v2"), 0o644); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "v2" {
		t.Fatalf("got %q, want v2", got)
	}

	// No temp files left behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected only the target file in dir, found %d entries", len(entries))
	}
}

func TestRandomSuffix(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		s := RandomSuffix(6)
		if len(s) != 6 {
			t.Fatalf("len(%q) = %d, want 6", s, len(s))
		}
		for _, r := range s {
			if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
				t.Fatalf("unexpected char %q in %q", r, s)
			}
		}
		seen[s] = true
	}
	// 200 draws from 36^6 should essentially never collide.
	if len(seen) < 199 {
		t.Fatalf("suspicious collision rate: %d unique of 200", len(seen))
	}
}

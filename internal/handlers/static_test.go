// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeDistFixture(t *testing.T) string {
	t.Helper()
	dist := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"index.html":                         "<html>v1</html>",
		"assets/index-AbC123.js":             "console.log(1)",
		"design-system/icons/core-icons.svg": "<svg/>",
	}
	for name, content := range files {
		p := filepath.Join(dist, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dist
}

func TestStaticHandlerCacheHeaders(t *testing.T) {
	dist := writeDistFixture(t)
	h := NewStaticHandler(dist)

	cases := []struct {
		path string
		want string
	}{
		// Hashed bundles are immutable — a change ships under a new URL.
		{"/assets/index-AbC123.js", "public, max-age=31536000, immutable"},
		// The shell and unhashed files must revalidate every load.
		// (/index.html itself 301s to "/" via http.FileServer — same policy.)
		{"/", "no-cache"},
		{"/design-system/icons/core-icons.svg", "no-cache"},
		// SPA fallback routes serve index.html with its policy.
		{"/pending", "no-cache"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d", tc.path, rec.Code)
			continue
		}
		if got := rec.Header().Get("Cache-Control"); got != tc.want {
			t.Errorf("%s: Cache-Control = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestAppVersion(t *testing.T) {
	dist := writeDistFixture(t)
	h := HandleAppVersion(dist)

	get := func() (string, string) {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, "/api/version", nil))
		var body struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("version body: %v", err)
		}
		return body.Version, rec.Header().Get("Cache-Control")
	}

	v1, cc := get()
	if cc != "no-store" {
		t.Errorf("version probe must be no-store, got %q", cc)
	}
	if len(v1) != 12 || v1 == "dev" {
		t.Errorf("expected a 12-hex content hash, got %q", v1)
	}
	if v2, _ := get(); v2 != v1 {
		t.Errorf("version should be stable across requests: %q vs %q", v1, v2)
	}

	// A new build (different content + mtime) changes the version.
	indexPath := filepath.Join(dist, "index.html")
	if err := os.WriteFile(indexPath, []byte("<html>v2</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(indexPath, future, future); err != nil {
		t.Fatal(err)
	}
	if v3, _ := get(); v3 == v1 {
		t.Error("version should change when index.html changes")
	}
}

func TestAppVersionMissingDist(t *testing.T) {
	h := HandleAppVersion(filepath.Join(t.TempDir(), "nope"))
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/api/version", nil))
	var body struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Version != "dev" {
		t.Errorf("missing dist should report the dev sentinel, got %q", body.Version)
	}
}

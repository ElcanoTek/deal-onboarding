// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// App version = a content hash of the built index.html. That file changes on
// every frontend build (it references the new content-hashed bundles), so it
// is exactly the signal a long-lived tab needs to know a deploy shipped —
// no build-time ldflags or CI plumbing required. The hash is re-derived only
// when the file's mtime/size change, so a deploy that swaps ./frontend/dist
// under a running server (rsync without restart) is still picked up.

type appVersion struct {
	mu      sync.Mutex
	modTime time.Time
	size    int64
	hash    string
}

func (v *appVersion) current(indexPath string) string {
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := os.Stat(indexPath)
	if err != nil {
		// No built frontend (dev, or API-only deployment) — a constant
		// sentinel so clients never see a spurious "update available".
		return "dev"
	}
	if v.hash != "" && info.ModTime().Equal(v.modTime) && info.Size() == v.size {
		return v.hash
	}
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return "dev"
	}
	sum := sha256.Sum256(data)
	v.modTime = info.ModTime()
	v.size = info.Size()
	v.hash = hex.EncodeToString(sum[:])[:12]
	return v.hash
}

// HandleAppVersion — GET /api/version. Unauthenticated (it exposes only a
// content hash) so the login page and expired sessions can poll it too. The
// frontend compares this against the version it booted with and offers a
// reload when they diverge.
func HandleAppVersion(distDir string) http.HandlerFunc {
	v := &appVersion{}
	indexPath := filepath.Join(distDir, "index.html")
	return func(w http.ResponseWriter, r *http.Request) {
		// Never cache the version probe — a cached answer would defeat it.
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"version": v.current(indexPath)})
	}
}

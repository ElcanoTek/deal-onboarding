package handlers

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Cache policy: Vite fingerprints everything under /assets/ (content-hashed
// filenames), so those are immutable — a changed file gets a new URL.
// Everything else (index.html, the SPA fallback, the unhashed /design-system
// icons and logos)
// must revalidate on every load: `no-cache` doesn't mean "don't cache", it
// means "check freshness first", and http.ServeFile's Last-Modified handling
// turns those checks into cheap 304s. Without an explicit policy browsers
// heuristically cache index.html, which is what forced hard refreshes after
// deploys — the stale shell kept referencing old hashed bundles.
const (
	cacheImmutable  = "public, max-age=31536000, immutable"
	cacheRevalidate = "no-cache"
)

func NewStaticHandler(distDir string) http.HandlerFunc {
	indexPath := filepath.Join(distDir, "index.html")
	fs := http.FileServer(http.Dir(distDir))

	return func(w http.ResponseWriter, r *http.Request) {
		if distDir == "" {
			http.NotFound(w, r)
			return
		}

		cleanPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if cleanPath == "." || cleanPath == "" {
			w.Header().Set("Cache-Control", cacheRevalidate)
			http.ServeFile(w, r, indexPath)
			return
		}

		requested := filepath.Join(distDir, cleanPath)
		if fileInfo, err := os.Stat(requested); err == nil && !fileInfo.IsDir() {
			if strings.HasPrefix(cleanPath, "assets"+string(filepath.Separator)) {
				w.Header().Set("Cache-Control", cacheImmutable)
			} else {
				w.Header().Set("Cache-Control", cacheRevalidate)
			}
			fs.ServeHTTP(w, r)
			return
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "failed to serve frontend", http.StatusInternalServerError)
			return
		}

		if strings.Contains(cleanPath, ".") {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Cache-Control", cacheRevalidate)
		http.ServeFile(w, r, indexPath)
	}
}

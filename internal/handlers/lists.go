package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/lists"
)

// HandleListLists returns metadata for every loaded standard list. The
// deal-form picker calls this once on mount; sizes are small (a few KB at
// the scale we operate at), so there's no cursoring or filtering server-side
// — the frontend groups/filters by client tag locally.
func HandleListLists(reg *lists.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"lists": reg.List(),
		})
	}
}

type createListRequest struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`       // "allow" | "block"
	Scope      string `json:"scope"`      // "domain" | "app_bundle"
	SourcePath string `json:"sourcePath"` // an already-uploaded file under the trader upload dir
}

// HandleCreateList promotes an already-uploaded ad-hoc file into a reusable
// standard list (the workspace "save as a standard list" action). The source
// file must live under the trader upload dir; the registry copies it into the
// lists dir and registers it so it shows in the picker immediately.
func HandleCreateList(reg *lists.Registry, uploadDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createListRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		raw := strings.TrimSpace(req.SourcePath)
		if raw == "" {
			writeError(w, http.StatusBadRequest, "sourcePath is required")
			return
		}
		// Anchor the client-supplied path to an absolute one BEFORE the
		// containment check. The upload handler returns a path that is relative
		// when DATA_DIR is (the default ./data), so a filepath.Clean-only check
		// against the absolute upload dir never matched — save-as-standard-list
		// was silently broken in every relative-DATA_DIR deployment. Mirror the
		// moc.go handoff: Abs + EvalSymlinks (rejects nonexistent + symlink
		// smuggling), then containment.
		abs, err := filepath.Abs(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid source file path")
			return
		}
		resolved, err := filepath.EvalSymlinks(abs)
		if err != nil {
			writeError(w, http.StatusBadRequest, "source file not found")
			return
		}
		cleanDir := safeDir(uploadDir)
		if cleanDir == "" || (resolved != cleanDir && !strings.HasPrefix(resolved, cleanDir+string(os.PathSeparator))) {
			writeError(w, http.StatusBadRequest, "source file outside the upload directory")
			return
		}
		summary, err := reg.Create(req.Name, lists.Kind(req.Kind), lists.Scope(req.Scope), resolved)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, summary)
	}
}

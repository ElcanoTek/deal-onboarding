// Package lists loads and serves curated allow/block lists that traders can
// toggle on for any deal.
//
// A standard list is a named, pre-typed roster of domains (or app bundles)
// that recurs across many deals — e.g. a longtail block list applied to most
// display deals, a premium allow list applied to brand-safety-sensitive
// flights, or a per-client roster pre-approved by a publisher. The raw data
// lives next to a JSON manifest under DEAL_ONBOARDING_LISTS_DIR (default ./lists);
// the manifest declares kind (allow/block), scope (domain/app-bundle), and
// optional client tags so the deal-form picker can group entries.
//
// The frontend fetches the metadata via GET /api/lists; the audit and
// prompt-generation handlers resolve selected ids to file paths and treat
// them like ad-hoc uploads with their inclusion/exclusion already set.
package lists

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/fsutil"
)

// Kind is the allow-or-block disposition of a list. Translated to the
// existing Include/Exclude file-attribute at audit and prompt time so
// downstream code doesn't need a second vocabulary.
type Kind string

const (
	KindAllow Kind = "allow"
	KindBlock Kind = "block"
)

// Scope is the kind of identifier the list contains. Determines which
// dropzone on the deal form the list surfaces under.
type Scope string

const (
	ScopeDomain    Scope = "domain"
	ScopeAppBundle Scope = "app_bundle"
)

// List is the in-memory shape of a single lists/<id>.json manifest plus its
// resolved data-file path and line count.
type List struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Kind        Kind   `json:"kind"`
	Scope       Scope  `json:"scope"`
	File        string `json:"file"`

	// Path is the absolute path to the resolved data file. Populated by Load.
	Path string `json:"-"`
	// LineCount is the number of non-blank lines in the data file, cached
	// at load time so the picker can show "1.2M domains" without re-scanning.
	LineCount int `json:"line_count"`
	// SHA256 is the hex digest of the data file, and UpdatedAt its modification
	// time — both cached at load. They give the picker a staleness/version
	// signal (a list edited in place shows a fresh "updated" date and a changed
	// hash) and let a submitted deal pin the exact list version it targeted.
	SHA256    string    `json:"sha256,omitempty"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}

// Summary is the payload returned by GET /api/lists. Excludes the on-disk
// path (server-internal) but keeps everything the picker needs.
type Summary struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Kind        Kind      `json:"kind"`
	Scope       Scope     `json:"scope"`
	LineCount   int       `json:"line_count"`
	SHA256      string    `json:"sha256,omitempty"`
	UpdatedAt   time.Time `json:"updated_at,omitempty"`
	// FileExt is the data file's extension including the dot (".csv"), so the
	// frontend can derive the exact attachment name the runner upload uses
	// (UploadName) and keep the prompt's file reference byte-identical to the
	// uploaded file's name (#198). Empty for an extensionless data file.
	FileExt string `json:"file_ext,omitempty"`
	// FileBase is the data file's on-disk basename, the fallback UploadName
	// uses for a blank list name — exposed so the frontend's
	// standardListUploadName can mirror that fallback byte-for-byte (#198
	// FIX 7). Empty when there is no path.
	FileBase string `json:"file_base,omitempty"`
}

// dataFileExts is the set of extensions a list's DATA file may carry — the
// same allowlist the upload handler enforces. UploadName appends the data
// extension unless the list NAME already ends in one of these; a version-
// suffixed name like "Sites v2.1" has a non-empty filepath.Ext (".1") that is
// NOT a data extension, so it must still gain ".csv" (#198 FIX 8), where a
// merely-non-empty check would have wrongly treated it as already-extensioned
// and re-triggered the IX-reject / OpenX-misroute class.
var dataFileExts = map[string]bool{
	".csv": true, ".tsv": true, ".txt": true, ".xlsx": true, ".xls": true,
}

// UploadName is the display name the list's data file is uploaded to the runner under
// AND the exact name the generated prompts reference (#198). It is the human
// list name with the data file's extension appended unless the name already
// ends in a recognized DATA extension (.csv/.tsv/.txt/.xlsx/.xls): IX rejects
// an extensionless list file outright, and OpenX routes .csv vs .xlsx to
// different parsers, so a real data extension must survive the upload. The
// frontend derives the SAME name (standardListUploadName in dealPromptYaml.ts,
// from Summary.FileExt/FileBase) so the agent's name match against the prompt
// stays exact, never fuzzy. A name already ending in a data extension is not
// double-suffixed; a version-suffixed name ("Sites v2.1") is not mistaken for
// one. Falls back to the on-disk basename when the manifest has no name.
func (l List) UploadName() string {
	name := strings.TrimSpace(l.Name)
	if name == "" {
		name = filepath.Base(l.Path)
	}
	if !dataFileExts[strings.ToLower(filepath.Ext(name))] {
		name += filepath.Ext(l.Path)
	}
	return name
}

// Registry holds every loaded list keyed by id. It's read-mostly (loaded once
// at boot) but supports runtime Create (trader "save as a standard list"), so
// reads take an RLock and Create takes the write lock.
//
// runtimeDir is where Create persists trader-created lists. In production it is
// a directory under DATA_DIR (persisted across deploys), NOT the repo-shipped
// lists dir — a deploy's `rsync --delete` over the app dir would otherwise wipe
// every trader-created list on every update. Repo-shipped lists load from a
// separate versioned dir (see LoadMerged).
type Registry struct {
	mu         sync.RWMutex
	runtimeDir string
	lists      map[string]List
	order      []string
}

// Load builds a registry from a single dir. Create persists new lists back to
// the same dir. Retained for tests and single-dir setups; production uses
// LoadMerged so trader-created lists survive deploys.
//
// The referenced data file must exist next to the manifest. Empty registries
// are tolerated (the feature is optional — a fresh install has no lists) but
// malformed manifests bubble up as errors so a typo can't silently hide a list
// at deploy time.
func Load(dir string) (*Registry, error) {
	reg := &Registry{lists: map[string]List{}, runtimeDir: dir}
	if err := reg.loadDirStrict(dir); err != nil {
		return nil, err
	}
	sort.Strings(reg.order)
	return reg, nil
}

// LoadMerged builds a registry from a versioned repoDir (canonical lists
// shipped with the repo and deployed via `rsync`) merged with a runtimeDir
// (trader-created lists, kept under DATA_DIR so a deploy's `rsync --delete`
// never wipes them). Create persists new lists to runtimeDir.
//
// Repo lists load STRICTLY: a malformed or duplicate manifest fails the deploy,
// exactly as Load does, so a typo can't silently hide a curated list. Runtime
// lists load LENIENTLY: a single corrupt or duplicate trader-created list is
// logged and skipped rather than crashing startup, and a runtime id that
// collides with a repo id never shadows the repo list (the repo list wins).
func LoadMerged(repoDir, runtimeDir string) (*Registry, error) {
	reg := &Registry{lists: map[string]List{}, runtimeDir: runtimeDir}
	if err := reg.loadDirStrict(repoDir); err != nil {
		return nil, err
	}
	if strings.TrimSpace(runtimeDir) != "" && sameDir(runtimeDir, repoDir) == false {
		reg.loadDirLenient(runtimeDir)
	}
	sort.Strings(reg.order)
	return reg, nil
}

// sameDir reports whether two paths resolve to the same directory, so
// LoadMerged doesn't double-load when repoDir == runtimeDir.
func sameDir(a, b string) bool {
	ca, err1 := filepath.Abs(a)
	cb, err2 := filepath.Abs(b)
	if err1 != nil || err2 != nil {
		return a == b
	}
	return filepath.Clean(ca) == filepath.Clean(cb)
}

// loadDirStrict walks dir for *.json manifests and inserts each into the
// registry, returning an error on any problem (missing id/file, bad kind/scope,
// duplicate id, unreadable data file). A nonexistent dir is not an error.
func (r *Registry) loadDirStrict(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read lists dir %s: %w", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		l, err := parseManifest(dir, path)
		if err != nil {
			return err
		}
		if _, dup := r.lists[l.ID]; dup {
			return fmt.Errorf("duplicate list id %q (second manifest: %s)", l.ID, path)
		}
		r.lists[l.ID] = l
		r.order = append(r.order, l.ID)
	}
	return nil
}

// loadDirLenient is loadDirStrict for trader-created lists: per-file problems
// (parse error, missing data file, duplicate/shadowing id) are logged and
// skipped instead of failing the whole registry, so one bad runtime list can't
// take down startup. A nonexistent runtime dir is normal on a fresh install.
func (r *Registry) loadDirLenient(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("lists: skipping runtime lists dir %s: %v", dir, err)
		}
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		l, err := parseManifest(dir, path)
		if err != nil {
			log.Printf("lists: skipping runtime list %s: %v", path, err)
			continue
		}
		if _, dup := r.lists[l.ID]; dup {
			log.Printf("lists: runtime list %s has id %q that already exists — skipping (repo list wins)", path, l.ID)
			continue
		}
		r.lists[l.ID] = l
		r.order = append(r.order, l.ID)
	}
}

// parseManifest reads and validates one <id>.json manifest, resolving and
// line-counting its data file. Shared by the strict and lenient loaders.
func parseManifest(dir, path string) (List, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return List{}, fmt.Errorf("read %s: %w", path, err)
	}
	var l List
	if jsonErr := json.Unmarshal(data, &l); jsonErr != nil {
		return List{}, fmt.Errorf("parse %s: %w", path, jsonErr)
	}
	if strings.TrimSpace(l.ID) == "" {
		return List{}, fmt.Errorf("list manifest %s missing id", path)
	}
	if err := validateKindScope(l, path); err != nil {
		return List{}, err
	}
	if strings.TrimSpace(l.File) == "" {
		return List{}, fmt.Errorf("list manifest %s missing file field", path)
	}
	dataPath := filepath.Join(dir, l.File)
	info, statErr := os.Stat(dataPath)
	if statErr != nil {
		return List{}, fmt.Errorf("list %s data file %s: %w", l.ID, dataPath, statErr)
	}
	if info.IsDir() {
		return List{}, fmt.Errorf("list %s file %s is a directory", l.ID, dataPath)
	}
	l.Path = dataPath
	l.LineCount = countLines(dataPath)
	l.UpdatedAt = info.ModTime().UTC()
	l.SHA256 = fileSHA256(dataPath)
	return l, nil
}

// fileSHA256 returns the hex-encoded SHA-256 of the file, or "" on any I/O
// error (the digest is a UI/version signal, not a correctness gate — a failure
// to hash must not fail the whole registry load).
func fileSHA256(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func validateKindScope(l List, path string) error {
	switch l.Kind {
	case KindAllow, KindBlock:
	default:
		return fmt.Errorf("list manifest %s has invalid kind %q (want \"allow\" or \"block\")", path, l.Kind)
	}
	switch l.Scope {
	case ScopeDomain, ScopeAppBundle:
	default:
		return fmt.Errorf("list manifest %s has invalid scope %q (want \"domain\" or \"app_bundle\")", path, l.Scope)
	}
	return nil
}

// countLines returns the number of non-blank data lines in the file. A first
// line that is exactly the canonical value-column header ("Sites" for domain
// lists, "Bundles" for app-bundle lists — see header_test.go for the lists-dir
// contract) is metadata, not data, and is excluded so the picker's
// "1.2M domains" stays honest. Best-effort: on any I/O error returns 0 rather
// than failing the entire registry load, since the count is purely
// informational for the UI.
func countLines(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	n := 0
	first := true
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for s.Scan() {
		line := s.Text()
		if first {
			first = false
			// Tolerate a UTF-8 BOM before the header (longtail-block.csv).
			trimmed := strings.TrimPrefix(line, "\ufeff")
			if trimmed == "Sites" || trimmed == "Bundles" {
				continue
			}
		}
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// Get returns the list with the given id.
func (r *Registry) Get(id string) (List, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	l, ok := r.lists[id]
	return l, ok
}

// List returns metadata for every loaded list, sorted alphabetically by id.
func (r *Registry) List() []Summary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Summary, 0, len(r.lists))
	for _, id := range r.order {
		l := r.lists[id]
		out = append(out, Summary{
			ID:          l.ID,
			Name:        l.Name,
			Description: l.Description,
			Kind:        l.Kind,
			Scope:       l.Scope,
			LineCount:   l.LineCount,
			SHA256:      l.SHA256,
			UpdatedAt:   l.UpdatedAt,
			FileExt:     filepath.Ext(l.Path),
			FileBase:    filepath.Base(l.Path),
		})
	}
	return out
}

// Resolve maps a slice of selected ids to their fully-loaded List records,
// silently dropping unknown ids (the audit handler logs them separately).
// Order is preserved so the caller can keep trader-selected order in the
// generated YAML.
func (r *Registry) Resolve(ids []string) []List {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]List, 0, len(ids))
	for _, id := range ids {
		if l, ok := r.lists[id]; ok {
			out = append(out, l)
		}
	}
	return out
}

// Create persists a new standard list from an already-uploaded source file and
// registers it at runtime, so a trader can promote an ad-hoc upload into the
// reusable picker. Writes a <id>.json manifest + a copied data file into the
// lists dir and inserts the list into the in-memory registry. Additive only —
// never mutates existing lists.

func (r *Registry) Create(name string, kind Kind, scope Scope, srcPath string) (Summary, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Summary{}, fmt.Errorf("list name is required")
	}
	if err := validateKindScope(List{Kind: kind, Scope: scope}, "new list"); err != nil {
		return Summary{}, err
	}
	if strings.TrimSpace(r.runtimeDir) == "" {
		return Summary{}, fmt.Errorf("lists directory not configured")
	}
	if err := os.MkdirAll(r.runtimeDir, 0o755); err != nil {
		return Summary{}, fmt.Errorf("create lists dir: %w", err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	id := slugify(name)
	if id == "" {
		id = "list"
	}
	if _, exists := r.lists[id]; exists {
		id = id + "-" + randomHex(3)
	}

	// Validate + normalize the source before it becomes a reusable targeting
	// asset. A promoted list that lacks the canonical value-column header, or
	// carries the wrong one for its scope, blocks the Cutlass batch at
	// deal-creation time with a column-not-found error (the prompt builder pins
	// each list's column to "Sites"/"Bundles"). We reject a scope mismatch /
	// unrecognized header and prepend the canonical header to a headerless data
	// file, so what lands in the picker is always contract-compliant. Only text
	// formats can be normalized — a binary XLSX is refused with guidance. The
	// output is always written as .csv (single-column list + header).
	srcExt := strings.ToLower(filepath.Ext(srcPath))
	switch srcExt {
	case ".csv", ".tsv", ".txt", "":
		// text — normalizable below
	default:
		return Summary{}, fmt.Errorf("cannot promote a %s file to a standard list — export it to CSV first", srcExt)
	}
	dataName := id + ".csv"
	dataPath := filepath.Join(r.runtimeDir, dataName)
	if err := writeNormalizedList(srcPath, dataPath, scope); err != nil {
		// Best-effort cleanup of a partial data file so a rejected promote
		// leaves no orphan.
		_ = os.Remove(dataPath)
		return Summary{}, err
	}

	manifest := map[string]any{"id": id, "name": name, "kind": kind, "scope": scope, "file": dataName}
	mb, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return Summary{}, err
	}
	if err := fsutil.WriteFileAtomic(filepath.Join(r.runtimeDir, id+".json"), mb, 0o644); err != nil {
		return Summary{}, fmt.Errorf("write list manifest: %w", err)
	}

	l := List{ID: id, Name: name, Kind: kind, Scope: scope, File: dataName, Path: dataPath}
	l.LineCount = countLines(dataPath)
	if info, statErr := os.Stat(dataPath); statErr == nil {
		l.UpdatedAt = info.ModTime().UTC()
	}
	l.SHA256 = fileSHA256(dataPath)
	r.lists[id] = l
	r.order = append(r.order, id)
	sort.Strings(r.order)

	return Summary{
		ID: id, Name: name, Kind: kind, Scope: scope,
		LineCount: l.LineCount, SHA256: l.SHA256, UpdatedAt: l.UpdatedAt,
		FileExt: filepath.Ext(l.Path), FileBase: filepath.Base(l.Path),
	}, nil
}

// canonicalHeader is the value-column header a list of the given scope must
// open with — the column the prompt builder targets ("Sites" for domains,
// "Bundles" for app bundles). See header_test.go for the repo-dir contract.
func canonicalHeader(scope Scope) string {
	if scope == ScopeAppBundle {
		return "Bundles"
	}
	return "Sites"
}

// writeNormalizedList streams src → dst, guaranteeing the output opens with the
// canonical header for scope. A file that already has the canonical header is
// copied through; a headerless data file gets the header prepended; a file
// whose first row is the OTHER canonical header (scope mismatch) or an
// unrecognized non-value token is rejected with an actionable error. Streaming
// (not a full read) keeps a multi-MB list off the heap.
func writeNormalizedList(src, dst string, scope Scope) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer in.Close()

	br := bufio.NewReaderSize(in, 64*1024)
	firstLine, readErr := br.ReadString('\n')
	if readErr != nil && readErr != io.EOF {
		return fmt.Errorf("read source: %w", readErr)
	}
	probe := strings.TrimSpace(strings.TrimPrefix(firstLine, "\ufeff"))
	if probe == "" && readErr == io.EOF {
		return fmt.Errorf("the uploaded file is empty")
	}

	want := canonicalHeader(scope)
	other := "Bundles"
	if want == "Bundles" {
		other = "Sites"
	}

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create data file: %w", err)
	}
	defer out.Close()

	switch {
	case probe == want:
		// Already headed correctly — write a clean header (drops any BOM /
		// trailing whitespace) and stream the remainder (firstLine WAS the
		// header, so don't re-emit it).
		if _, err := out.WriteString(want + "\n"); err != nil {
			return err
		}
	case probe == other:
		return fmt.Errorf("this looks like a %q list, but you're saving it as a %s list — check the file's first row", other, scope)
	case probe == "" || looksLikeValue(probe, scope):
		// Headerless data (or a leading blank line) — prepend the canonical
		// header, then keep the original first line as data.
		if _, err := out.WriteString(want + "\n"); err != nil {
			return err
		}
		if _, err := out.WriteString(firstLine); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unrecognized first row %q — a %s list must start with the header %q or with %s values", truncateForError(probe), scope, want, scope)
	}
	if _, err := io.Copy(out, br); err != nil {
		return fmt.Errorf("write data file: %w", err)
	}
	return nil
}

// looksLikeValue reports whether s is plausibly a data value (not a foreign
// header) for the scope: a domain has a dot and no spaces; an app bundle is a
// dotted package id or an all-digit store id. Deliberately permissive — it only
// needs to separate real values from header words like "URL List" or "domain".
func looksLikeValue(s string, scope Scope) bool {
	if s == "" || strings.ContainsAny(s, " \t") {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '-' || r == '_' || r == '*' || r == ':' || r == '/':
		default:
			return false
		}
	}
	if scope == ScopeDomain {
		return strings.Contains(s, ".")
	}
	if strings.Contains(s, ".") {
		return true
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// truncateForError bounds an untrusted token echoed into an error message.
func truncateForError(s string) string {
	const max = 40
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

func slugify(s string) string {
	var b strings.Builder
	prevDash := false
	for _, ch := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			b.WriteRune(ch)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "x"
	}
	return hex.EncodeToString(buf)
}

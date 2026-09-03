// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

// OpenRouter model catalog + pricing cache — Go port of fleet's
// web/src/app/lib/openrouterModels.ts, serving the composer model picker.
//
// The /api/v1/models endpoint is public (no key needed). We pull it once a
// day, index by slug, and expose the same three session-gated routes fleet
// serves: the full catalog (picker search), the latest-per-lab rankings
// (picker browse rows), and the advisory slug check. There is deliberately
// NO price ceiling: any model on OpenRouter is pickable.
//
// The catalog must be fetched through this same-origin proxy, never directly
// from openrouter.ai in the browser — the proxy is what keeps the list behind
// session auth (and mirrors fleet, whose CSP pins connect-src to 'self').

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	openRouterModelsAPIURL  = "https://openrouter.ai/api/v1/models"
	openRouterModelsPageURL = "https://openrouter.ai/models"
	modelCatalogTTL         = 24 * time.Hour
)

// Chat model ROLE slots — server-side mirror of
// frontend/src/lib/modelAliases.ts (DEFAULT_MODEL / ADVANCED_MODEL), the
// same way fleet mirrors them in internal/agentcore/models.go. Keep the
// three spots in sync.
const (
	defaultChatModel  = "z-ai/glm-5.2"
	advancedChatModel = "openai/gpt-5.6-sol"
)

// tierModelSlugs are pinned at the top of the picker client-side; the
// rankings endpoint excludes them so each of its rows expands the user's
// choices instead of duplicating a pinned row.
var tierModelSlugs = []string{defaultChatModel, advancedChatModel}

// majorLabs — slug-prefix groups for the curated picker. The rankings
// endpoint emits one entry per lab: the newest text-only model, with tier
// slugs filtered out. Order is the order the picker shows them in. Meta and
// Cohere are intentionally omitted (fleet parity).
var majorLabs = []string{
	"z-ai",
	"anthropic",
	"openai",
	"google",
	"x-ai",
	"deepseek",
	"moonshotai",
	"qwen",
	"mistralai",
	"nvidia",
}

type catalogEntry struct {
	Slug          string
	CanonicalSlug string
	Name          string
	// USD per completion token. OpenRouter uses "0" for free tiers, which
	// is a real number and passes through.
	CompletionPerToken float64
	PromptPerToken     float64
	OutputModalities   []string
	// Total tokens the provider accepts (prompt + completion). 0 = unknown.
	ContextLength int
	// Unix seconds the model was first listed on OpenRouter. Drives the
	// "newest per lab" curation and the picker's "✨ new" pill. 0 = unknown.
	Created int64
}

type modelCatalog struct {
	// Catalog order, keyed positions by the short stable id.
	entries []catalogEntry
	// Keyed by the short id OR the dated canonical_slug, so either form of
	// a slug resolves to the same entry.
	bySlug    map[string]*catalogEntry
	fetchedAt time.Time
}

var (
	catalogMu     sync.Mutex
	cachedCatalog *modelCatalog
	// Overridable in tests.
	modelsAPIURL     = openRouterModelsAPIURL
	modelsHTTPClient = &http.Client{Timeout: 5 * time.Second}
)

type rawCatalogModel struct {
	ID            string `json:"id"`
	CanonicalSlug string `json:"canonical_slug"`
	Name          string `json:"name"`
	ContextLength any    `json:"context_length"`
	Created       any    `json:"created"`
	Pricing       *struct {
		Prompt     any `json:"prompt"`
		Completion any `json:"completion"`
	} `json:"pricing"`
	Architecture *struct {
		OutputModalities []string `json:"output_modalities"`
	} `json:"architecture"`
}

// parseCatalogNumber coerces OpenRouter's number-or-string fields ("0.000003",
// 200000) into a float. Returns ok=false for anything non-numeric.
func parseCatalogNumber(raw any) (float64, bool) {
	switch v := raw.(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case string:
		if strings.TrimSpace(v) == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(v, 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func buildModelCatalog(payload []byte) (*modelCatalog, error) {
	var body struct {
		Data []rawCatalogModel `json:"data"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, fmt.Errorf("openrouter models response: %w", err)
	}
	if body.Data == nil {
		return nil, fmt.Errorf("openrouter models response missing data[] array")
	}
	cat := &modelCatalog{bySlug: make(map[string]*catalogEntry)}
	for _, raw := range body.Data {
		if raw.ID == "" || raw.Pricing == nil {
			continue
		}
		// Skip entries without a numeric completion price — we cannot
		// reason about them (fleet parity).
		completion, ok := parseCatalogNumber(raw.Pricing.Completion)
		if !ok {
			continue
		}
		prompt, _ := parseCatalogNumber(raw.Pricing.Prompt)
		entry := catalogEntry{
			Slug:               raw.ID,
			Name:               raw.Name,
			CompletionPerToken: completion,
			PromptPerToken:     prompt,
		}
		if entry.Name == "" {
			entry.Name = raw.ID
		}
		if raw.CanonicalSlug != "" && raw.CanonicalSlug != raw.ID {
			entry.CanonicalSlug = raw.CanonicalSlug
		}
		if raw.Architecture != nil {
			entry.OutputModalities = raw.Architecture.OutputModalities
		}
		if n, ok := parseCatalogNumber(raw.ContextLength); ok && n > 0 {
			entry.ContextLength = int(n)
		}
		if n, ok := parseCatalogNumber(raw.Created); ok && n > 0 {
			entry.Created = int64(n)
		}
		cat.entries = append(cat.entries, entry)
	}
	if len(cat.entries) == 0 {
		return nil, fmt.Errorf("openrouter models response contained no usable entries")
	}
	for i := range cat.entries {
		e := &cat.entries[i]
		cat.bySlug[e.Slug] = e
		if e.CanonicalSlug != "" {
			cat.bySlug[e.CanonicalSlug] = e
		}
	}
	cat.fetchedAt = time.Now()
	return cat, nil
}

// loadModelCatalog returns the cached catalog, refreshing it from OpenRouter
// when older than the TTL. The mutex is held across the fetch, which doubles
// as in-flight dedupe: concurrent callers block, then read the fresh cache.
// The 5s client timeout bounds how long that can take.
func loadModelCatalog() (*modelCatalog, error) {
	catalogMu.Lock()
	defer catalogMu.Unlock()
	if cachedCatalog != nil && time.Since(cachedCatalog.fetchedAt) < modelCatalogTTL {
		return cachedCatalog, nil
	}
	req, err := http.NewRequest(http.MethodGet, modelsAPIURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Deal Onboarding/1.0")
	req.Header.Set("Accept", "application/json")
	resp, err := modelsHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openrouter models fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openrouter models fetch failed: %d", resp.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("openrouter models read: %w", err)
	}
	built, err := buildModelCatalog(payload)
	if err != nil {
		return nil, err
	}
	cachedCatalog = built
	return cachedCatalog, nil
}

// baseModelSlug strips an OpenRouter ":variant" suffix (":nitro", ":free", …)
// so variant slugs compare equal to their base model.
func baseModelSlug(slug string) string {
	if i := strings.IndexByte(slug, ':'); i != -1 {
		return slug[:i]
	}
	return slug
}

// isTextCompletion — text-completion models emit text tokens ONLY. Models
// declaring image/audio outputs are dedicated generators the chat UI can't
// render. Entries with a missing modalities list pass through (the field is
// a recent addition; missing it shouldn't drop legacy text models).
func isTextCompletion(e *catalogEntry) bool {
	if len(e.OutputModalities) == 0 {
		return true
	}
	for _, m := range e.OutputModalities {
		if m != "text" {
			return false
		}
	}
	return true
}

// listAllowedModels — entries the picker may offer: any catalog model capable
// of text output (no price ceiling). Sorted by completion price descending —
// expensive surfaces first as a proxy for quality — with a stable slug
// tiebreak.
func listAllowedModels(cat *modelCatalog) []*catalogEntry {
	out := make([]*catalogEntry, 0, len(cat.entries))
	for i := range cat.entries {
		if isTextCompletion(&cat.entries[i]) {
			out = append(out, &cat.entries[i])
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CompletionPerToken != out[j].CompletionPerToken {
			return out[i].CompletionPerToken > out[j].CompletionPerToken
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}

// listLatestPerLab — curated cross-lab picker rows. For each lab in
// majorLabs, the newest text-only model whose base slug isn't excluded;
// `:free` variants are skipped (same weights as a paid sibling with stricter
// limits — surfacing one as a lab's "newest" would mislead). Ties on
// `created` fall back to completion price desc as a flagship proxy. Labs
// with no qualifying entry are omitted; output order matches majorLabs.
func listLatestPerLab(cat *modelCatalog, excludeSlugs []string) []*catalogEntry {
	exclude := make(map[string]bool, len(excludeSlugs))
	for _, s := range excludeSlugs {
		exclude[baseModelSlug(s)] = true
	}
	var out []*catalogEntry
	for _, lab := range majorLabs {
		labPrefix := lab + "/"
		var best *catalogEntry
		for i := range cat.entries {
			e := &cat.entries[i]
			if !strings.HasPrefix(e.Slug, labPrefix) {
				continue
			}
			if exclude[baseModelSlug(e.Slug)] {
				continue
			}
			if strings.HasSuffix(e.Slug, ":free") {
				continue
			}
			if !isTextCompletion(e) {
				continue
			}
			if best == nil {
				best = e
				continue
			}
			if e.Created > best.Created {
				best = e
			} else if e.Created == best.Created && e.CompletionPerToken > best.CompletionPerToken {
				best = e
			}
		}
		if best != nil {
			out = append(out, best)
		}
	}
	return out
}

// HandleModelCatalog — GET /api/models/catalog. The picker's search source:
// every text-capable OpenRouter model, expensive-first. Response shape
// mirrors fleet's /api/model-catalog.
func HandleModelCatalog() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cat, err := loadModelCatalog()
		if err != nil {
			writeError(w, http.StatusBadGateway, "model catalog unavailable")
			return
		}
		type wireModel struct {
			Slug            string  `json:"slug"`
			Name            string  `json:"name"`
			ContextLength   int     `json:"context_length,omitempty"`
			Created         int64   `json:"created,omitempty"`
			PriceCompletion float64 `json:"price_completion"`
		}
		allowed := listAllowedModels(cat)
		models := make([]wireModel, 0, len(allowed))
		for _, e := range allowed {
			models = append(models, wireModel{
				Slug:            e.Slug,
				Name:            e.Name,
				ContextLength:   e.ContextLength,
				Created:         e.Created,
				PriceCompletion: e.CompletionPerToken,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": models, "cached_at": cat.fetchedAt.UnixMilli()})
	}
}

// HandleModelRankings — GET /api/models/rankings. The picker's browse rows:
// the newest model per major lab, excluding the pinned tier slugs. Response
// shape mirrors fleet's /api/model-rankings.
func HandleModelRankings() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cat, err := loadModelCatalog()
		if err != nil {
			writeError(w, http.StatusBadGateway, "model rankings unavailable")
			return
		}
		type wireModel struct {
			Slug    string `json:"slug"`
			Name    string `json:"name"`
			Created int64  `json:"created,omitempty"`
		}
		ranked := listLatestPerLab(cat, tierModelSlugs)
		if len(ranked) == 0 {
			writeError(w, http.StatusBadGateway, "no per-lab models were found")
			return
		}
		models := make([]wireModel, 0, len(ranked))
		for _, e := range ranked {
			models = append(models, wireModel{Slug: e.Slug, Name: e.Name, Created: e.Created})
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": models, "cached_at": cat.fetchedAt.UnixMilli()})
	}
}

// HandleModelCheck — GET /api/models/check?slug=. Advisory validation,
// fleet parity: empty → not allowed; known slug → allowed with pricing;
// unknown slug → allowed anyway, so newly released models keep working
// against a stale cache. Callers fail open on errors.
func HandleModelCheck() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimSpace(r.URL.Query().Get("slug"))
		if slug == "" {
			writeJSON(w, http.StatusOK, map[string]any{
				"allowed":    false,
				"reason":     "empty",
				"message":    "Model slug is required.",
				"models_url": openRouterModelsPageURL,
			})
			return
		}
		cat, err := loadModelCatalog()
		if err != nil {
			writeError(w, http.StatusBadGateway, "model catalog unavailable")
			return
		}
		entry, known := cat.bySlug[slug]
		out := map[string]any{"allowed": true, "slug": slug, "known": known}
		if known {
			// Emit the short stable id back so canonical slugs normalize.
			out["slug"] = entry.Slug
			out["completion_usd_per_million"] = entry.CompletionPerToken * 1_000_000
		}
		writeJSON(w, http.StatusOK, out)
	}
}

package handlers

import "testing"

// fixtureCatalog mirrors the shapes OpenRouter's /api/v1/models actually
// returns: string prices, optional canonical_slug, optional
// architecture.output_modalities, and the occasional junk entry.
const fixtureCatalog = `{"data": [
	{"id": "z-ai/glm-5.2", "name": "Z.AI: GLM 5.2", "created": 1700, "context_length": 200000,
	 "pricing": {"prompt": "0.000001", "completion": "0.000002"},
	 "architecture": {"output_modalities": ["text"]}},
	{"id": "anthropic/claude-opus-5", "canonical_slug": "anthropic/claude-opus-5-20260601",
	 "name": "Anthropic: Claude Opus 5", "created": 1900, "context_length": 1000000,
	 "pricing": {"prompt": "0.000005", "completion": "0.000025"},
	 "architecture": {"output_modalities": ["text"]}},
	{"id": "anthropic/claude-sonnet-4.6", "name": "Anthropic: Claude Sonnet 4.6", "created": 1600,
	 "pricing": {"prompt": "0.000003", "completion": "0.000015"},
	 "architecture": {"output_modalities": ["text"]}},
	{"id": "anthropic/claude-cheap:free", "name": "Anthropic: Cheap (free)", "created": 2000,
	 "pricing": {"prompt": "0", "completion": "0"},
	 "architecture": {"output_modalities": ["text"]}},
	{"id": "openai/gpt-image-2", "name": "OpenAI: GPT Image 2", "created": 1950,
	 "pricing": {"prompt": "0.00001", "completion": "0.00004"},
	 "architecture": {"output_modalities": ["image"]}},
	{"id": "openai/gpt-5.4", "name": "OpenAI: GPT-5.4", "created": 1800,
	 "pricing": {"prompt": "0.00000125", "completion": "0.00001"}},
	{"id": "google/broken-price", "name": "Google: Broken", "created": 2100,
	 "pricing": {"prompt": "0.000001", "completion": "not-a-number"}},
	{"id": "google/gemini-3.2-pro", "name": "Google: Gemini 3.2 Pro", "created": 1850,
	 "pricing": {"prompt": "0.000002", "completion": "0.000012"},
	 "architecture": {"output_modalities": ["text"]}}
]}`

func mustBuildFixture(t *testing.T) *modelCatalog {
	t.Helper()
	cat, err := buildModelCatalog([]byte(fixtureCatalog))
	if err != nil {
		t.Fatalf("buildModelCatalog: %v", err)
	}
	return cat
}

func TestBuildModelCatalog(t *testing.T) {
	cat := mustBuildFixture(t)
	// The broken-price entry is skipped; everything else parses.
	if _, ok := cat.bySlug["google/broken-price"]; ok {
		t.Error("entry without a numeric completion price should be skipped")
	}
	// Both the short id and the dated canonical slug resolve to one entry.
	short, ok1 := cat.bySlug["anthropic/claude-opus-5"]
	canon, ok2 := cat.bySlug["anthropic/claude-opus-5-20260601"]
	if !ok1 || !ok2 || short != canon {
		t.Error("canonical_slug should resolve to the same entry as the short id")
	}
	if short.ContextLength != 1000000 || short.Created != 1900 {
		t.Errorf("context/created parse: got %d / %d", short.ContextLength, short.Created)
	}
}

func TestBuildModelCatalogRejectsEmpty(t *testing.T) {
	if _, err := buildModelCatalog([]byte(`{"data": []}`)); err == nil {
		t.Error("empty data[] should error")
	}
	if _, err := buildModelCatalog([]byte(`{}`)); err == nil {
		t.Error("missing data[] should error")
	}
}

func TestListAllowedModels(t *testing.T) {
	cat := mustBuildFixture(t)
	allowed := listAllowedModels(cat)
	for _, e := range allowed {
		if e.Slug == "openai/gpt-image-2" {
			t.Error("image-output model should be excluded from the allowed list")
		}
	}
	// Sorted by completion price descending: opus-5 (25) first, then
	// sonnet-4.6 (15), gemini (12), gpt-5.4 (10, no modalities → passes),
	// glm (2), free (0).
	if allowed[0].Slug != "anthropic/claude-opus-5" {
		t.Errorf("expensive-first sort: got %q first", allowed[0].Slug)
	}
	if allowed[len(allowed)-1].Slug != "anthropic/claude-cheap:free" {
		t.Errorf("free tier should sort last: got %q", allowed[len(allowed)-1].Slug)
	}
}

func TestListLatestPerLab(t *testing.T) {
	cat := mustBuildFixture(t)
	ranked := listLatestPerLab(cat, []string{"z-ai/glm-5.2", "openai/gpt-5.6-sol"})
	slugs := make([]string, 0, len(ranked))
	for _, e := range ranked {
		slugs = append(slugs, e.Slug)
	}
	// z-ai's only model is excluded as a tier slug; anthropic's newest
	// non-free entry wins (the :free variant is newer but skipped, and the
	// image model never qualifies); output order follows majorLabs.
	want := []string{"anthropic/claude-opus-5", "openai/gpt-5.4", "google/gemini-3.2-pro"}
	if len(slugs) != len(want) {
		t.Fatalf("ranked slugs: got %v, want %v", slugs, want)
	}
	for i := range want {
		if slugs[i] != want[i] {
			t.Fatalf("ranked slugs: got %v, want %v", slugs, want)
		}
	}
}

func TestBaseModelSlug(t *testing.T) {
	if got := baseModelSlug("z-ai/glm-5.2:nitro"); got != "z-ai/glm-5.2" {
		t.Errorf("variant strip: got %q", got)
	}
	if got := baseModelSlug("z-ai/glm-5.2"); got != "z-ai/glm-5.2" {
		t.Errorf("plain slug unchanged: got %q", got)
	}
}

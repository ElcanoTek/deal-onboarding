package handlers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ElcanoTek/deal-onboarding/internal/lists"
	"github.com/ElcanoTek/deal-onboarding/internal/moc"
)

// The attachment gates run on the create path after the audit gate, so each
// case rides a passing audited form + brief + prompt and perturbs only the
// attachment inputs under test.

func createBodyWithExtras(t *testing.T, promptSuffix, extras string) string {
	t.Helper()
	formJSON, dealName := passingMocFormJSON(t)
	prompt := createPromptFor(dealName) + promptSuffix
	return fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s%s}`, jsonString(prompt), formJSON, jsonString(passingMocBrief(t, dealName)), extras)
}

func postCreate(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/runner/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestHandleMOCCreate_RejectsFileNamesLengthMismatch(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://runner.example", APIKey: "k"}), nil, nil, t.TempDir())
	// One path, two names — the check fires before any path resolution.
	w := postCreate(h, createBodyWithExtras(t, "", `,"filePaths":["/tmp/x.csv"],"fileNames":["a.csv","b.csv"]`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 on fileNames/filePaths length mismatch, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "pair 1:1") {
		t.Errorf("error should explain the pairing requirement, got %s", w.Body.String())
	}
}

func TestHandleMOCCreate_RejectsTooManyAttachments(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://runner.example", APIKey: "k"}), nil, nil, t.TempDir())
	paths := make([]string, maxAttachRefs+1)
	for i := range paths {
		paths[i] = fmt.Sprintf(`"/tmp/f%d.csv"`, i)
	}
	w := postCreate(h, createBodyWithExtras(t, "", `,"filePaths":[`+strings.Join(paths, ",")+`]`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 when attachment count exceeds the cap, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "too many attachments") {
		t.Errorf("error should mention the cap, got %s", w.Body.String())
	}
}

func TestHandleMOCCreate_RejectsUnknownListID(t *testing.T) {
	listReg, err := lists.Load(t.TempDir()) // empty registry — no id resolves
	if err != nil {
		t.Fatalf("load lists: %v", err)
	}
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://runner.example", APIKey: "k"}), listReg, nil, t.TempDir())
	w := postCreate(h, createBodyWithExtras(t, "", `,"listIds":["ghost-list"]`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 when a listId does not resolve, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "ghost-list") {
		t.Errorf("error should name the unresolved list, got %s", w.Body.String())
	}
}

func TestHandleMOCCreate_RejectsUnattachedPromptReference(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://runner.example", APIKey: "k"}), nil, nil, t.TempDir())
	// Every reference syntax the generated prompts emit, none attached.
	refs := "\ndomain_file_path: \"Preferred News Sites\"\n" +
		"app_bundle_file_path: bundles.csv\n" +
		"#     values_file: Master Block List\n" +
		"      - file_path: oneoff.csv    # original name; resolve by fuzzy match\n"
	w := postCreate(h, createBodyWithExtras(t, refs, ""))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on referenced-but-unattached files, got %d: %s", w.Code, w.Body.String())
	}
	got := gateErrorBody(t, w)
	if got.Error != "prompt_reference_unattached" {
		t.Fatalf("want prompt_reference_unattached, got %+v", got)
	}
	for _, name := range []string{"Preferred News Sites", "bundles.csv", "Master Block List", "oneoff.csv"} {
		if !strings.Contains(got.Message, name) {
			t.Errorf("message should name %q, got %q", name, got.Message)
		}
	}
}

func TestHandleMOCCreate_BlockedMarkerPromptRejected(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://runner.example", APIKey: "k"}), nil, nil, t.TempDir())
	marker := "\n      # BLOCKED: OpenX requires an inventory attachment — upload a domain or app-bundle list for this deal.\n"
	w := postCreate(h, createBodyWithExtras(t, marker, ""))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on a BLOCKED don't-run marker, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "prompt_blocked_marker" {
		t.Fatalf("want prompt_blocked_marker, got %+v", got)
	}
}

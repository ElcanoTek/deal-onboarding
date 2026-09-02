// All rights reserved. This is a private repository.

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/idempotency"
	"github.com/ElcanoTek/deal-onboarding/internal/moc"
	"github.com/ElcanoTek/deal-onboarding/internal/overrideaudit"
	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

func TestGateExclusionOverrideEnvelopeBindsSessionPromptAndBrief(t *testing.T) {
	detail := validation.ExclusionOverrideDetails{DealID: "d-1", SSP: "OpenX", Audience: []string{"Blocked"}, Geo: []string{"zip:90210"}, Source: "trader"}
	b, _ := json.Marshal(detail)
	marker := "# EXCLUSION_OVERRIDE: " + string(b)
	briefBytes, _ := json.Marshal(map[string]any{"deals": []map[string]any{{"prompt_inputs": marker + "\naudience_segments_exclude: []"}}})
	store, err := overrideaudit.NewStore(filepath.Join(t.TempDir(), "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/moc/create", nil)
	req = req.WithContext(WithSessionEmail(context.Background(), "trader@example.com"))
	w := httptest.NewRecorder()
	if !gateExclusionOverrideEnvelope(w, req, store, marker, string(briefBytes), []validation.ExclusionOverrideDetails{detail}) {
		t.Fatalf("canonical envelope rejected: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	if gateExclusionOverrideEnvelope(w, req, store, "no marker", string(briefBytes), []validation.ExclusionOverrideDetails{detail}) || w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("prompt mismatch must fail closed: %d %s", w.Code, w.Body.String())
	}
}

func TestGateExclusionOverrideEnvelopeRejectsOrphanAndMissingStore(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/moc/create", nil)
	req = req.WithContext(WithSessionEmail(context.Background(), "trader@example.com"))
	w := httptest.NewRecorder()
	if gateExclusionOverrideEnvelope(w, req, nil, "# EXCLUSION_OVERRIDE: {}", `{}`, nil) || w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("orphan marker must fail closed: %d %s", w.Code, w.Body.String())
	}
	detail := validation.ExclusionOverrideDetails{DealID: "d-1", SSP: "OpenX", Audience: []string{"Blocked"}, Source: "trader"}
	b, _ := json.Marshal(detail)
	marker := "# EXCLUSION_OVERRIDE: " + string(b)
	brief, _ := json.Marshal(map[string]any{"deals": []map[string]any{{"prompt_inputs": marker}}})
	w = httptest.NewRecorder()
	if gateExclusionOverrideEnvelope(w, req, nil, marker, string(brief), []validation.ExclusionOverrideDetails{detail}) || w.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing durable store must fail closed: %d %s", w.Code, w.Body.String())
	}
}

// passingMocFormJSON returns an audited-form payload that passes RunAudit with
// a nil client registry, plus the single deal name the audit regenerates for
// it — the fixture behind the create-gate tests (#152).
func passingMocFormJSON(t *testing.T) (formJSON, dealName string) {
	t.Helper()
	form := map[string]any{
		"submitterName":        "Test Trader",
		"submitterEmail":       "trader@example.com",
		"flightStartDate":      time.Now().Format("2006-01-02"),
		"flightEndDate":        time.Now().AddDate(0, 0, 30).Format("2006-01-02"),
		"agency":               "Northwind",
		"brand":                "Acme",
		"feeType":              "Percentage of Media",
		"curatedDealFee":       "1.50",
		"campaignId":           "DEAL12345",
		"dealSheetRecipient":   "trader@example.com",
		"defaultInventoryType": "All",
		"dsps":                 []map[string]any{{"id": "dsp1", "dsp": "The Trade Desk", "seatId": "12345"}},
		"deals": []map[string]any{{
			"id": "d1", "theme": "Digital Consumer", "channel": "Display",
			"ssp": "Index Exchange", "cpm": "2.50",
		}},
	}
	raw, err := json.Marshal(form)
	if err != nil {
		t.Fatalf("marshal form fixture: %v", err)
	}
	return string(raw), "Curator_Index_TTD_Northwind_Acme_NA_Digital Consumer_Display_All_Global_DEAL12345_A1"
}

// passingMocBrief returns a serialized brief (embeddable in a JSON body) that
// passes validateDealBrief and carries the given deal name.
func passingMocBrief(t *testing.T, dealName string) string {
	t.Helper()
	brief := map[string]any{
		"client_name": "Acme",
		"recipient":   "trader@example.com",
		"campaign_id": "DEAL12345",
		"deals": []map[string]any{{
			"ssp": "Index Exchange", "tool": "mcp_ix_create_deal_with_audit",
			"channel": "Display", "deal_name": dealName,
			"recommended_bid": "$2-$5", "prompt_inputs": "args",
		}},
	}
	raw, err := json.Marshal(brief)
	if err != nil {
		t.Fatalf("marshal brief fixture: %v", err)
	}
	return string(raw)
}

// createPromptFor returns a minimal create prompt that satisfies the gate's
// prompt binding: it embeds the audited deal name the way buildBatchPrompt
// does (a literal `name:` line). Embed into JSON bodies via jsonString.
func createPromptFor(dealName string) string {
	return "create the batch\ndeals:\n  - name: " + dealName
}

// gateErrorBody decodes the structured rejection the audit gate writes.
func gateErrorBody(t *testing.T, w *httptest.ResponseRecorder) struct {
	Error   string                   `json:"error"`
	Message string                   `json:"message"`
	Checks  []validation.CheckResult `json:"checks"`
	Missing []string                 `json:"missing_deal_names"`
} {
	t.Helper()
	var body struct {
		Error   string                   `json:"error"`
		Message string                   `json:"message"`
		Checks  []validation.CheckResult `json:"checks"`
		Missing []string                 `json:"missing_deal_names"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", w.Body.String(), err)
	}
	return body
}

// mocTestServer is a stub MOC that accepts uploads and task creation.
func mocTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv, _ := stubMoc(t, "task-1")
	return srv
}

func TestHandleMOCCreate_DisabledReturns503(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{}), nil, nil, t.TempDir())
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(`{"prompt":"x"}`))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 when MOC unconfigured, got %d", w.Code)
	}
}

// The #279 blocker, unit level: a DEFAULT-SEAT create emits no
// mcp_load_servers lines, so the selection must come from the audited form's
// batch SSPs (accountless) — never collapse to [deal_sheet, sendgrid], which
// fleet's Gate-3 would enforce as a total SSP lockout.
func TestResolveMCPSelectionDefaultSeatCreate(t *testing.T) {
	form := &validation.AuditRequest{Deals: []validation.DealEntry{
		{ID: "d1", SSP: "Index Exchange"},
		{ID: "d2", SSP: "Media.net"},
		{ID: "d3", SSP: "Index Exchange"},         // duplicate SSP → one entry
		{ID: "d4", SSP: "OpenX", SheetOnly: true}, // sheet-only rows create nothing
		{ID: "d5"}, // SSP-less rows are not batch deals
	}}
	got := resolveMCPSelection(&mocCreateRequest{Prompt: "deals:\n  - name: X", Form: form})
	want := []moc.MCPChoice{
		{Server: "indexexchange_mcp"},
		{Server: "medianet_mcp"},
		{Server: "deal_sheet"},
		{Server: "sendgrid"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("selection = %v, want %v", got, want)
	}
}

// A prompt with no recognizable batch structure (hand-written free text)
// yields nil — the moc client then inherits the full default-seat roster
// instead of shipping a deal_sheet/sendgrid-only lockout allowlist.
func TestResolveMCPSelectionUnrecognizableBatchIsNil(t *testing.T) {
	if got := resolveMCPSelection(&mocCreateRequest{Prompt: "please pause every deal for Acme"}); got != nil {
		t.Fatalf("want nil selection for free-text prompt, got %v", got)
	}
	if got := resolveMCPSelection(&mocCreateRequest{Prompt: "deals:\n  - name: X"}); got != nil {
		t.Fatalf("want nil selection for a form-less create, got %v", got)
	}
}

func TestHandleMOCCreate_MissingPrompt(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(`{"prompt":"  "}`))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 on blank prompt, got %d", w.Code)
	}
}

func TestHandleMOCCreate_RejectsUnresolvedPromptToken(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	// A prompt carrying an unresolved FILL marker (a required deal field the
	// trader never filled) must be rejected before any network call — covers
	// the brief-less deal-update flow too.
	for _, tok := range []string{"buyer: <FILL>", "to: <UNSET-trader-email>", "x: ${y}", "x: {{ y }}"} {
		body := `{"prompt":"name: deal\n` + tok + `"}`
		r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400 on unresolved token %q, got %d", tok, w.Code)
		}
	}
}

func TestHandleMOCCreate_RejectsPathTraversal(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	// A fully gate-passing create (form + matching brief + name-bearing prompt)
	// so the rejection under test is the path containment check itself.
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	body := fmt.Sprintf(`{"prompt":%s,"filePaths":["/etc/passwd"],"form":%s,"brief":%s}`,
		jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 on out-of-dir file path, got %d", w.Code)
	}
	if got := gateErrorBody(t, w).Error; strings.Contains(got, "audit") || strings.Contains(got, "brief") {
		t.Fatalf("rejection should be the path check, not the audit gate: %q", got)
	}
}

func TestHandleMOCCreate_RejectsMissingAndSymlinkEscapedFiles(t *testing.T) {
	uploadDir := t.TempDir()
	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "secret.csv")
	if err := os.WriteFile(outside, []byte("secret.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(uploadDir, "170-escape.csv")
	if err := os.Symlink(outside, symlink); err != nil {
		t.Fatal(err)
	}
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://moc.example", APIKey: "k"}), nil, nil, uploadDir)
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)

	tests := []struct {
		name string
		path string
		want string
	}{
		{name: "missing file names the stale attachment", path: filepath.Join(uploadDir, "missing.csv"), want: "no longer available"},
		{name: "symlink cannot escape the allowed root", path: symlink, want: "outside the allowed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"prompt":%s,"filePaths":[%s],"fileNames":["Client Sites.csv"],"form":%s,"brief":%s}`,
				jsonString(createPromptFor(dealName)), jsonString(tc.path), formJSON, jsonString(brief))
			rr := httptest.NewRecorder()
			h(rr, httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body)))
			if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), tc.want) {
				t.Fatalf("want 400 containing %q, got %d: %s", tc.want, rr.Code, rr.Body.String())
			}
		})
	}
}

// #152: the QA gate must hold server-side. A create submit without the audited
// form is rejected before any reservation/upload/network work.
func TestHandleMOCCreate_CreateWithoutFormRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	for _, body := range []string{
		`{"prompt":"create the batch"}`,                      // legacy caller, no operation
		`{"prompt":"create the batch","operation":"create"}`, // explicit create
	} {
		r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400 for create without form (body %s), got %d", body, w.Code)
		}
		if got := gateErrorBody(t, w); got.Error != "audit_form_required" || got.Message == "" {
			t.Fatalf("want audit_form_required with a message, got %+v", got)
		}
	}
}

// A create whose form fails a validation rule is rejected with the failed
// checks so the caller sees exactly what to fix.
func TestHandleMOCCreate_CreateWithFailingFormRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	// Blank out the deal fee — rule "deal_fee" must fail the re-audit.
	broken := strings.Replace(formJSON, `"curatedDealFee":"1.50"`, `"curatedDealFee":""`, 1)
	if broken == formJSON {
		t.Fatal("fixture edit did not apply")
	}
	body := fmt.Sprintf(`{"prompt":"go","form":%s,"brief":%s}`, broken, jsonString(passingMocBrief(t, dealName)))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on failing re-audit, got %d: %s", w.Code, w.Body.String())
	}
	got := gateErrorBody(t, w)
	if got.Error != "audit_failed" || len(got.Checks) == 0 {
		t.Fatalf("want audit_failed with failed checks, got %+v", got)
	}
	found := false
	for _, c := range got.Checks {
		if c.Passed {
			t.Fatalf("response checks must contain only failures, got passing %+v", c)
		}
		if c.Rule == "deal_fee" {
			found = true
		}
	}
	if !found {
		t.Fatalf("want the failed deal_fee check in the response, got %+v", got.Checks)
	}
}

// A form without a campaignId can pass /api/audit (a random ELC is minted),
// but the deal names in the prompt/brief embed the FINAL id — require it.
func TestHandleMOCCreate_CreateWithoutCampaignIDRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	broken := strings.Replace(formJSON, `"campaignId":"DEAL12345"`, `"campaignId":""`, 1)
	if broken == formJSON {
		t.Fatal("fixture edit did not apply")
	}
	body := fmt.Sprintf(`{"prompt":"go","form":%s,"brief":%s}`, broken, jsonString(passingMocBrief(t, dealName)))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on missing campaignId, got %d", w.Code)
	}
	if got := gateErrorBody(t, w); got.Error != "campaign_id_required" {
		t.Fatalf("want campaign_id_required, got %+v", got)
	}
}

// Auditing form A and submitting brief B must not pass: the brief's deal set
// has to match the deal names the re-audited form regenerates.
func TestHandleMOCCreate_CreateWithMismatchedBriefRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, _ := passingMocFormJSON(t)
	brief := passingMocBrief(t, "Curator_OpenX_TTD_Other_Batch_NA_Other_Display_All_Global_DEAL99999_A1")
	body := fmt.Sprintf(`{"prompt":"go","form":%s,"brief":%s}`, formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on brief/form mismatch, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "audit_brief_mismatch" {
		t.Fatalf("want audit_brief_mismatch, got %+v", got)
	}
}

// A create without the structured brief is rejected even when the audited
// form passes: the brief is the artifact the form↔batch name binding runs
// against, and the legitimate create flow always sends one.
func TestHandleMOCCreate_CreateWithoutBriefRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s}`, jsonString(createPromptFor(dealName)), formJSON)
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 for create without brief, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "brief_required" || got.Message == "" {
		t.Fatalf("want brief_required with a message, got %+v", got)
	}
}

// The PROMPT is what MOC executes — a prompt that doesn't embed the audited
// deal names is an unreviewed batch riding audit evidence for another one.
func TestHandleMOCCreate_CreateWithPromptMissingDealNameRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	// Form passes and the brief matches — but the prompt never mentions the
	// audited deal.
	body := fmt.Sprintf(`{"prompt":"create something else entirely","form":%s,"brief":%s}`, formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on prompt missing the audited deal name, got %d: %s", w.Code, w.Body.String())
	}
	got := gateErrorBody(t, w)
	if got.Error != "audit_prompt_mismatch" {
		t.Fatalf("want audit_prompt_mismatch, got %+v", got)
	}
	if len(got.Missing) != 1 || got.Missing[0] != dealName {
		t.Fatalf("want missing_deal_names=[%q], got %v", dealName, got.Missing)
	}
}

// Happy path: a passing audited form + a matching brief + a prompt embedding
// the audited deal name creates the task (the gate must never falsely reject
// the money path).
func TestHandleMOCCreate_CreateHappyPath(t *testing.T) {
	srv := mocTestServer(t)
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: srv.URL, APIKey: "k"}), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200 on passing form + matching brief + name-bearing prompt, got %d: %s", w.Code, w.Body.String())
	}
	var resp mocCreateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TaskID != "task-1" {
		t.Fatalf("want task-1, got %+v", resp)
	}
}

// jsonString embeds an already-serialized JSON document as a JSON string value.
func jsonString(raw string) string {
	b, _ := json.Marshal(raw)
	return string(b)
}

// prodEnvs wraps a single config as the prod environment — the shape every
// pre-picker test exercised. An enabled prod config gets a node pin stamped
// (#237: prod submits fail closed without MOC_TARGET_NODE; these fixtures
// exercise the gates BEYOND that requirement — the requirement itself is
// covered by TestHandleMOCCreate_ProdWithoutTargetNodeRejected).
func prodEnvs(cfg moc.Config) moc.Environments {
	if cfg.Enabled() && cfg.TargetNode == "" {
		cfg.TargetNode = "test-node"
	}
	return moc.Environments{Prod: cfg}
}

// stubMoc is mocTestServer with a task counter and a configurable task id, so
// environment-routing tests can assert WHICH instance received the work.
func stubMoc(t *testing.T, taskID string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var tasks atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/tasks":
			tasks.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": taskID})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &tasks
}

// mocEnv:"dev" routes the task to the dev instance and only the dev instance;
// the response echoes the environment.
func TestHandleMOCCreate_DevEnvRoutesToDevMoc(t *testing.T) {
	prodSrv, prodTasks := stubMoc(t, "task-prod")
	devSrv, devTasks := stubMoc(t, "task-dev")
	envs := moc.Environments{
		Prod: moc.Config{BaseURL: prodSrv.URL, APIKey: "pk", TargetNode: "prod-node"},
		Dev:  moc.Config{BaseURL: devSrv.URL, APIKey: "dk"},
	}
	h := HandleMOCCreate(envs, nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s,"mocEnv":"dev"}`, jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200 on dev submit, got %d: %s", w.Code, w.Body.String())
	}
	var resp mocCreateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TaskID != "task-dev" || resp.MocEnv != "dev" {
		t.Fatalf("want task-dev on mocEnv dev, got %+v", resp)
	}
	if got := devTasks.Load(); got != 1 {
		t.Fatalf("want 1 task on the dev instance, got %d", got)
	}
	if got := prodTasks.Load(); got != 0 {
		t.Fatalf("dev submit must not touch prod, got %d prod task(s)", got)
	}
}

// Picking dev while only prod is configured fails closed with an actionable
// 503 — never a silent fallback to prod.
func TestHandleMOCCreate_DevRequestedButUnconfigured(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://moc.example", APIKey: "k"}), nil, nil, t.TempDir())
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(`{"prompt":"x","mocEnv":"dev"}`))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 when dev env unset, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "moc_env_not_configured" || got.Message == "" {
		t.Fatalf("want moc_env_not_configured with a message, got %+v", got)
	}
}

// An unknown environment id is a hard 400 — a typo must never submit a live
// batch to the wrong MOC.
func TestHandleMOCCreate_InvalidEnvRejected(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://moc.example", APIKey: "k"}), nil, nil, t.TempDir())
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(`{"prompt":"x","mocEnv":"staging"}`))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 on unknown mocEnv, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "moc_env_invalid" {
		t.Fatalf("want moc_env_invalid, got %+v", got)
	}
}

// One idempotency key maps to at most one live task EVER: a same-env retry
// replays the original task, while reusing the key on the OTHER environment
// is a 409 conflict — never a second live batch and never a cross-env replay
// that would mislabel where the task ran.
func TestHandleMOCCreate_IdempotencyCrossEnvConflict(t *testing.T) {
	prodSrv, prodTasks := stubMoc(t, "task-prod")
	devSrv, devTasks := stubMoc(t, "task-dev")
	envs := moc.Environments{
		Prod: moc.Config{BaseURL: prodSrv.URL, APIKey: "pk", TargetNode: "prod-node"},
		Dev:  moc.Config{BaseURL: devSrv.URL, APIKey: "dk"},
	}
	store, err := idempotency.NewStore(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatalf("idempotency store: %v", err)
	}
	h := HandleMOCCreate(envs, nil, store, t.TempDir())

	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	send := func(mocEnv string) *httptest.ResponseRecorder {
		t.Helper()
		envField := ""
		if mocEnv != "" {
			envField = fmt.Sprintf(`,"mocEnv":%q`, mocEnv)
		}
		body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s,"idempotencyKey":"same-key"%s}`,
			jsonString(createPromptFor(dealName)), formJSON, jsonString(brief), envField)
		r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}
	decode := func(w *httptest.ResponseRecorder) mocCreateResponse {
		t.Helper()
		var resp mocCreateResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return resp
	}

	first := send("")
	if first.Code != http.StatusOK {
		t.Fatalf("want 200 on first prod submit, got %d: %s", first.Code, first.Body.String())
	}
	if resp := decode(first); resp.TaskID != "task-prod" || resp.Duplicate {
		t.Fatalf("want fresh prod task, got %+v", resp)
	}
	crossEnv := send("dev")
	if crossEnv.Code != http.StatusConflict {
		t.Fatalf("same key on the other env must 409, got %d: %s", crossEnv.Code, crossEnv.Body.String())
	}
	if got := gateErrorBody(t, crossEnv); got.Error != "idempotency_env_conflict" || got.Message == "" {
		t.Fatalf("want idempotency_env_conflict with a message, got %+v", got)
	} else if strings.Contains(got.Message, "new key") {
		// #FIX4: the key is content-derived now, so "submit with a new key" is
		// not actionable — the message must give real guidance instead.
		t.Fatalf("cross-env message must not advise a 'new key' (content-derived now): %q", got.Message)
	} else if !strings.Contains(got.Message, "change the batch content") {
		t.Fatalf("cross-env message should guide the user to change the batch content or clear the reservation, got %q", got.Message)
	}
	if got := devTasks.Load(); got != 0 {
		t.Fatalf("cross-env conflict must not create a dev task, got %d", got)
	}
	replay := send("")
	if replay.Code != http.StatusOK {
		t.Fatalf("want 200 on same-env retry, got %d: %s", replay.Code, replay.Body.String())
	}
	if resp := decode(replay); !resp.Duplicate || resp.TaskID != "task-prod" || resp.MocEnv != "prod" {
		t.Fatalf("same-env retry must replay the original prod task, got %+v", resp)
	}
	if got := prodTasks.Load(); got != 1 {
		t.Fatalf("prod must have created exactly one task, got %d", got)
	}
}

// The operation string namespaces the idempotency ledger, so it is
// allowlisted — a forged value like "create@dev" could otherwise collide with
// another environment's namespace and replay that environment's task.
func TestHandleMOCCreate_InvalidOperationRejected(t *testing.T) {
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://moc.example", APIKey: "k"}), nil, nil, t.TempDir())
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(`{"prompt":"x","operation":"create@dev"}`))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 on forged operation, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "operation_invalid" {
		t.Fatalf("want operation_invalid, got %+v", got)
	}
}

// A fully-disabled deployment answers 503 BEFORE reading the body — malformed
// JSON must not turn the actionable "not configured" signal into a 400.
func TestHandleMOCCreate_DisabledReturns503BeforeDecode(t *testing.T) {
	h := HandleMOCCreate(moc.Environments{}, nil, nil, t.TempDir())
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(`{not json`))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 for a disabled deployment regardless of body, got %d: %s", w.Code, w.Body.String())
	}
}

// The environments endpoint reports per-instance enablement without leaking
// API keys.
func TestHandleMOCEnvironments(t *testing.T) {
	envs := moc.Environments{
		Prod: moc.Config{BaseURL: "https://moc.example", APIKey: "prod-secret-key", TargetNode: "node-a"},
		Dev:  moc.Config{BaseURL: "https://dev.example"}, // no key → disabled
	}
	w := httptest.NewRecorder()
	HandleMOCEnvironments(envs)(w, httptest.NewRequest("GET", "/api/moc/environments", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	var body struct {
		Environments []struct {
			ID         string `json:"id"`
			BaseURL    string `json:"baseUrl"`
			TargetNode string `json:"targetNode"`
			Enabled    bool   `json:"enabled"`
		} `json:"environments"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Environments) != 2 {
		t.Fatalf("want prod+dev entries, got %+v", body.Environments)
	}
	prod, dev := body.Environments[0], body.Environments[1]
	if prod.ID != "prod" || !prod.Enabled || prod.TargetNode != "node-a" {
		t.Fatalf("bad prod entry: %+v", prod)
	}
	if dev.ID != "dev" || dev.Enabled || dev.BaseURL != "https://dev.example" {
		t.Fatalf("bad dev entry (keyless dev must report disabled): %+v", dev)
	}
	if strings.Contains(w.Body.String(), "prod-secret-key") {
		t.Fatal("API key leaked into the environments response")
	}
}

// The connection check defaults to the dev instance (the Fleet port target),
// refuses an unknown env rather than silently probing prod, and creates
// nothing.
func TestHandleRunnerCheck(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/api-info" {
			_, _ = w.Write([]byte(`{"api_version":"1","fleet_version":"9.9.9"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	envs := moc.Environments{
		Prod: moc.Config{BaseURL: "https://moc.example", APIKey: "prod-secret-key"},
		Dev:  moc.Config{Backend: "fleet", BaseURL: srv.URL, APIKey: "dev-secret-key"},
	}

	// No ?env → dev.
	w := httptest.NewRecorder()
	HandleRunnerCheck(envs)(w, httptest.NewRequest("GET", "/api/runner/check", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Env   string `json:"env"`
		Check struct {
			Reachable     bool   `json:"reachable"`
			KeyAccepted   bool   `json:"keyAccepted"`
			ServerVersion string `json:"serverVersion"`
		} `json:"check"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Env != "dev" || !body.Check.Reachable || !body.Check.KeyAccepted || body.Check.ServerVersion != "9.9.9" {
		t.Fatalf("bad dev check: %+v", body)
	}
	// Probe endpoints only — never the task-create path.
	for _, p := range paths {
		if p != "GET /api-info" && p != "POST /v1/tasks/estimate" {
			t.Fatalf("connection check touched %s; it must create nothing", p)
		}
	}
	if strings.Contains(w.Body.String(), "dev-secret-key") || strings.Contains(w.Body.String(), "prod-secret-key") {
		t.Fatal("API key leaked into the check response")
	}

	// An unknown env is refused, not silently routed to prod.
	w = httptest.NewRecorder()
	HandleRunnerCheck(envs)(w, httptest.NewRequest("GET", "/api/runner/check?env=staging", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown env: want 400, got %d", w.Code)
	}
}

// #157: an ad-hoc upload lives on disk under a hash-suffixed name, but the

// generated prompt references it by its ORIGINAL client filename. The handler
// must upload it under the original name (supplied in fileNames) so the agent's
// fuzzy name-match against the prompt resolves — while still reading the bytes
// from the validated hashed path.
func TestHandleMOCCreate_UploadsUnderOriginalFilename(t *testing.T) {
	uploadDir := t.TempDir()
	// Simulate what the upload handler wrote: a hash-suffixed on-disk name.
	hashed := filepath.Join(uploadDir, "1720000000-abc123.csv")
	if err := os.WriteFile(hashed, []byte("example.com\nfoo.com\n"), 0o644); err != nil {
		t.Fatalf("seed upload: %v", err)
	}

	var uploadedNames []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			f, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Fatalf("FormFile: %v", ferr)
			}
			defer f.Close()
			uploadedNames = append(uploadedNames, h.Filename)
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename, "checksum": "sha"})
		case "/tasks":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "task-1"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	cfg := moc.Config{BaseURL: srv.URL, APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, uploadDir)

	formJSON, dealName := passingMocFormJSON(t)
	original := "Auto Sites.csv"
	body := fmt.Sprintf(`{"prompt":%s,"filePaths":["`+hashed+`"],"fileNames":["`+original+`"],"form":%s,"brief":%s}`,
		jsonString(createPromptFor(dealName)), formJSON, jsonString(passingMocBrief(t, dealName)))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if len(uploadedNames) == 0 || uploadedNames[0] != original {
		t.Errorf("uploaded under %v, want the prompt-referenced original name %q first", uploadedNames, original)
	}
	var resp mocCreateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// The attachment plus the (now required) structured brief.
	if len(resp.Uploaded) != 2 || resp.Uploaded[0] != original || resp.Uploaded[1] != "deal_brief.json" {
		t.Errorf("response Uploaded=%v, want [%q deal_brief.json]", resp.Uploaded, original)
	}
}

// Without fileNames (legacy caller) the handler falls back to the on-disk
// basename — no regression for callers that don't yet supply original names.
func TestHandleMOCCreate_FallsBackToBasenameWithoutFileNames(t *testing.T) {
	uploadDir := t.TempDir()
	hashed := filepath.Join(uploadDir, "1720000000-def456.csv")
	if err := os.WriteFile(hashed, []byte("a\n"), 0o644); err != nil {
		t.Fatalf("seed upload: %v", err)
	}
	var uploadedNames []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/upload" {
			f, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Fatalf("FormFile: %v", ferr)
			}
			defer f.Close()
			uploadedNames = append(uploadedNames, h.Filename)
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "t"})
	}))
	defer srv.Close()

	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: srv.URL, APIKey: "k"}), nil, nil, uploadDir)
	formJSON, dealName := passingMocFormJSON(t)
	body := fmt.Sprintf(`{"prompt":%s,"filePaths":["`+hashed+`"],"form":%s,"brief":%s}`,
		jsonString(createPromptFor(dealName)), formJSON, jsonString(passingMocBrief(t, dealName)))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if len(uploadedNames) == 0 || uploadedNames[0] != "1720000000-def456.csv" {
		t.Errorf("fallback name = %v, want the on-disk basename first", uploadedNames)
	}
}

// =============================================================================
// Sheet-only rows — a follow-up batch lists already-live deals for the deal
// sheet only. buildBatchPrompt embeds their names in the non-executable
// already_created_for_sheet section (no tool, no prompt_inputs); the gate must
// accept that shape and still require EVERY audited name in the prompt.
// =============================================================================

// passingMocFormWithSheetOnlyJSON extends the passing fixture with an
// already-live OpenX row (sheetOnly:true). Deliberately NO openxConfig and no
// per-deal CPM on that row: create-only checks must not fire for it, so the
// gate's re-audit still passes.
func passingMocFormWithSheetOnlyJSON(t *testing.T) (formJSON, createName, sheetOnlyName string) {
	t.Helper()
	sheetOnlyName = "Curator_OpenX_TTD_Northwind_Acme_NA_LiveAudience_Display_All_US_DEAL12345_A1"
	form := map[string]any{
		"submitterName":        "Test Trader",
		"submitterEmail":       "trader@example.com",
		"flightStartDate":      time.Now().Format("2006-01-02"),
		"flightEndDate":        time.Now().AddDate(0, 0, 30).Format("2006-01-02"),
		"agency":               "Northwind",
		"brand":                "Acme",
		"feeType":              "Percentage of Media",
		"curatedDealFee":       "1.50",
		"campaignId":           "DEAL12345",
		"dealSheetRecipient":   "trader@example.com",
		"defaultInventoryType": "All",
		"dsps":                 []map[string]any{{"id": "dsp1", "dsp": "The Trade Desk", "seatId": "12345"}},
		"deals": []map[string]any{
			{
				"id": "d1", "theme": "Digital Consumer", "channel": "Display",
				"ssp": "Index Exchange", "cpm": "2.50",
			},
			{
				"id": "d2", "theme": "Live Audience", "channel": "Display",
				"ssp": "OpenX", "nameOverride": sheetOnlyName, "sheetOnly": true,
			},
		},
	}
	raw, err := json.Marshal(form)
	if err != nil {
		t.Fatalf("marshal form fixture: %v", err)
	}
	return string(raw), "Curator_Index_TTD_Northwind_Acme_NA_Digital Consumer_Display_All_Global_DEAL12345_A1", sheetOnlyName
}

// passingMocBriefWithSheetOnly mirrors buildBatchBrief: the create row under
// deals[], the live row under already_created_for_sheet[] with NO tool.
func passingMocBriefWithSheetOnly(t *testing.T, createName, sheetOnlyName string) string {
	t.Helper()
	brief := map[string]any{
		"client_name": "Acme",
		"recipient":   "trader@example.com",
		"campaign_id": "DEAL12345",
		"deals": []map[string]any{{
			"ssp": "Index Exchange", "tool": "mcp_ix_create_deal_with_audit",
			"channel": "Display", "deal_name": createName,
			"recommended_bid": "$2-$5", "prompt_inputs": "args",
		}},
		"already_created_for_sheet": []map[string]any{{
			"ssp": "OpenX", "channel": "Display",
			"deal_name": sheetOnlyName, "status": "already_created",
		}},
	}
	raw, err := json.Marshal(brief)
	if err != nil {
		t.Fatalf("marshal brief fixture: %v", err)
	}
	return string(raw)
}

// createPromptWithSheetSection mirrors buildBatchPrompt's new shape: the
// create row under deals:, the sheet-only name embedded ONLY in the
// non-executable already_created_for_sheet section.
func createPromptWithSheetSection(createName, sheetOnlyName string) string {
	return "create the batch\ndeals:\n  - name: " + createName + "\n" +
		"# ALREADY-CREATED (sheet-only) rows — do NOT create, update, or call any SSP tool for them.\n" +
		"already_created_for_sheet:\n  - ssp: openx\n    name: " + sheetOnlyName + "\n    status: already_created"
}

// A create submit whose form carries sheet-only rows passes the gate with the
// new prompt shape: the sheet-only name is embedded via the section, not a
// create block, and the re-audit doesn't demand OpenX create config for it.
func TestHandleMOCCreate_SheetOnlyRowsPassGateViaSheetSection(t *testing.T) {
	srv := mocTestServer(t)
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: srv.URL, APIKey: "k"}), nil, nil, t.TempDir())
	formJSON, createName, sheetOnlyName := passingMocFormWithSheetOnlyJSON(t)
	brief := passingMocBriefWithSheetOnly(t, createName, sheetOnlyName)
	prompt := createPromptWithSheetSection(createName, sheetOnlyName)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200 for a follow-up batch with sheet-only rows, got %d: %s", w.Code, w.Body.String())
	}
}

// Regression for promptEmbedsName: dropping a sheet-only name from the prompt
// ENTIRELY (the naive fix — filtering sheet-only rows out with no replacement
// section) must still 422 — the audited set is bound in full.
func TestHandleMOCCreate_SheetOnlyNameMissingFromPromptRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, createName, sheetOnlyName := passingMocFormWithSheetOnlyJSON(t)
	brief := passingMocBriefWithSheetOnly(t, createName, sheetOnlyName)
	// Prompt embeds only the create name — the sheet-only name is nowhere.
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(createPromptFor(createName)), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 when the prompt omits a sheet-only deal name, got %d: %s", w.Code, w.Body.String())
	}
	got := gateErrorBody(t, w)
	if got.Error != "audit_prompt_mismatch" {
		t.Fatalf("want audit_prompt_mismatch, got %+v", got)
	}
	if len(got.Missing) != 1 || got.Missing[0] != sheetOnlyName {
		t.Fatalf("want missing_deal_names=[%q], got %v", sheetOnlyName, got.Missing)
	}
}

// =============================================================================
// Attachment-reference guards (#157 wiring + fail-closed hardening):
//   - fileNames must pair 1:1 with filePaths (else names shift onto wrong files)
//   - a total attachment count over the cap is rejected
//   - two attachments with the same display name are ambiguous → rejected
//   - a standard-list id that doesn't resolve fails closed (never silently drops
//     a targeting file the prompt still names)
// =============================================================================

// -----------------------------------------------------------------------------
// prompt_reference_unattached (#221) — the server-side fail-closed backstop:
// a prompt that references a list/file BY NAME (domain_file_path /
// app_bundle_file_path args, the Media.net/TripleLift `values_file:` merge
// blocks, the update flow's attachments `file_path:` rows) with no matching
// upload must be rejected before any MOC work. Pre-fix the handler uploaded
// whatever was in listIds/filePaths and never compared the set to the prompt,
// so a per-deal standard list missing from listIds sailed through and failed
// missing_domain_file mid-batch (or, on Media.net, created the deal LIVE
// without its list).
// -----------------------------------------------------------------------------

// The gate covers the CREATE path too, after the audit gate: a fully
// gate-passing create whose prompt references an unattached list is rejected.
func TestHandleMOCCreate_CreateWithUnattachedListReferenceRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	prompt := createPromptFor(dealName) + "\ndomain_file_path: \"Ghost List\""
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d: %s", w.Code, w.Body.String())
	}
	got := gateErrorBody(t, w)
	if got.Error != "prompt_reference_unattached" || !strings.Contains(got.Message, "Ghost List") {
		t.Fatalf("want prompt_reference_unattached naming Ghost List, got %+v", got)
	}
}

// =============================================================================
// Idempotency-reservation lifecycle (#225): the reservation is released ONLY
// on failures provably BEFORE CreateTask could have taken effect. A failure
// at/after the CreateTask request is AMBIGUOUS — MOC may have accepted the
// task even though the response was lost — so the key is HELD (fail closed,
// 409) and a retry with the same key can never book a second live batch.
// =============================================================================

// A CreateTask failure (the /tasks request was sent — its outcome is unknown)
// must NOT release the reservation: the handler answers 409
// moc_submission_state_unknown, the record stays "pending", and a same-key
// retry is rejected without another CreateTask attempt. Pre-fix the handler
// answered 502 and released the key, so the retry created a second live batch.
func TestHandleMOCCreate_AmbiguousCreateTaskFailureHoldsReservation(t *testing.T) {
	var taskAttempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/tasks":
			// The request reached MOC — from the caller's side the outcome is
			// ambiguous (a timeout / proxy 502 looks exactly like this).
			taskAttempts.Add(1)
			http.Error(w, "upstream blew up mid-create", http.StatusInternalServerError)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	store, err := idempotency.NewStore(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatalf("idempotency store: %v", err)
	}
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: srv.URL, APIKey: "k"}), nil, store, t.TempDir())

	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	send := func() *httptest.ResponseRecorder {
		t.Helper()
		body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s,"idempotencyKey":"ambiguous-key"}`,
			jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
		r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}

	first := send()
	if first.Code != http.StatusConflict {
		t.Fatalf("ambiguous CreateTask failure must fail closed with 409, got %d: %s", first.Code, first.Body.String())
	}
	if got := gateErrorBody(t, first); got.Error != "moc_submission_state_unknown" || got.Message == "" {
		t.Fatalf("want moc_submission_state_unknown with a message, got %+v", got)
	}
	// The reservation must still be held pending — never released.
	rec, held := store.Get("create", "ambiguous-key")
	if !held || rec.Status != "pending" {
		t.Fatalf("reservation must be held pending after an ambiguous failure, got held=%v rec=%+v", held, rec)
	}
	// A same-key retry is rejected as in flight and never re-attempts the task.
	retry := send()
	if retry.Code != http.StatusConflict {
		t.Fatalf("retry with a held key must 409, got %d: %s", retry.Code, retry.Body.String())
	}
	if !strings.Contains(retry.Body.String(), "already in progress") {
		t.Fatalf("retry rejection should report the in-flight submission, got %s", retry.Body.String())
	}
	if got := taskAttempts.Load(); got != 1 {
		t.Fatalf("exactly one CreateTask attempt allowed for a held key, got %d", got)
	}
}

// A failure provably BEFORE CreateTask (here: the MOC file upload fails, so no
// task-create request was ever issued) must still release the reservation so
// the client can retry with the same key — and the retry succeeds.
func TestHandleMOCCreate_PreCreateTaskFailureReleasesReservation(t *testing.T) {
	var failUploads atomic.Bool
	failUploads.Store(true)
	var taskAttempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			if failUploads.Load() {
				http.Error(w, "upload store unavailable", http.StatusInternalServerError)
				return
			}
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/tasks":
			taskAttempts.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "task-retry"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	store, err := idempotency.NewStore(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatalf("idempotency store: %v", err)
	}
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: srv.URL, APIKey: "k"}), nil, store, t.TempDir())

	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	send := func() *httptest.ResponseRecorder {
		t.Helper()
		// The create flow always uploads the brief, so the failing /upload
		// trips before any CreateTask request exists.
		body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s,"idempotencyKey":"pre-task-key"}`,
			jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
		r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}

	first := send()
	if first.Code != http.StatusBadGateway {
		t.Fatalf("want 502 on pre-CreateTask upload failure, got %d: %s", first.Code, first.Body.String())
	}
	if _, held := store.Get("create", "pre-task-key"); held {
		t.Fatal("a provably-pre-CreateTask failure must release the reservation")
	}
	// Upload recovers; the SAME key retries and creates the one task.
	failUploads.Store(false)
	retry := send()
	if retry.Code != http.StatusOK {
		t.Fatalf("same-key retry after a released reservation must succeed, got %d: %s", retry.Code, retry.Body.String())
	}
	var resp mocCreateResponse
	if err := json.Unmarshal(retry.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TaskID != "task-retry" || resp.Duplicate {
		t.Fatalf("want a fresh task on retry, got %+v", resp)
	}
	if got := taskAttempts.Load(); got != 1 {
		t.Fatalf("want exactly one CreateTask across the failed attempt + retry, got %d", got)
	}
}

// =============================================================================
// Update seat-routing gate (#230) — the update analogue of create's
// client_seat_routing: an update batch addressed to a client's seat must load
// that client's MCP variant, or every write silently falls through to the
// default seat (PubMatic's logged_in_owner_id:0 → env owner).
// =============================================================================

// =============================================================================
// CreateTask failure classification (#FIX1): the reservation is HELD only for
// genuinely-ambiguous failures (the task may exist). Provably-not-created
// failures (connection never established, definitive 4xx) RELEASE so the same
// content-derived key can retry cleanly — a transient MOC blip must not wedge
// the batch for the whole 24h TTL. Pre-fix EVERY CreateTask error was held.
// =============================================================================

// hangUpMoc accepts /upload but, on /tasks, hijacks the connection and closes
// it WITHOUT a response — a reset/EOF mid-request: the request reached MOC
// (ambiguous), but the transport errored. Not a dial error, so → HOLD.
func hangUpMoc(t *testing.T, taskHits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/tasks":
			taskHits.Add(1)
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("ResponseWriter is not a Hijacker")
			}
			conn, _, herr := hj.Hijack()
			if herr != nil {
				t.Fatalf("hijack: %v", herr)
			}
			_ = conn.Close() // drop the connection with no response written
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// statusMoc accepts /upload and returns a fixed status on /tasks (for the
// 4xx-release vs 5xx-hold classification tests).
func statusMoc(t *testing.T, taskStatus int, taskHits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/tasks":
			taskHits.Add(1)
			http.Error(w, "boom", taskStatus)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// =============================================================================
// Phase-3 Batch 2 — submit-path truth + server-gate hardening (#232,
// #237, #238). Each test fails on the pre-fix handler.
// =============================================================================

// #232.8 — the audit gate binds the FULL audited deal set. A prompt carrying
// the audited names PLUS an extra un-audited deal entry passed pre-fix (the
// binding was one-directional: every audited name in the prompt, nothing about
// extra prompt-only entries).
func TestHandleMOCCreate_CreateWithExtraUnauditedDealRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	extra := "Sneaky_OpenX_TTD_X_Y_NA_Z_Display_All_Global_DEAL99999_A1"
	prompt := createPromptFor(dealName) + "\n  - name: " + extra
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on a prompt carrying an un-audited extra deal, got %d: %s", w.Code, w.Body.String())
	}
	got := gateErrorBody(t, w)
	if got.Error != "audit_prompt_unaudited_deals" {
		t.Fatalf("want audit_prompt_unaudited_deals, got %+v", got)
	}
	if !strings.Contains(w.Body.String(), extra) {
		t.Fatalf("rejection should name the extra deal, got %s", w.Body.String())
	}
}

// #232.8 — a DUPLICATED audited entry (same name twice) would double-create at
// the SSP; the count binding rejects it.
func TestHandleMOCCreate_CreateWithDuplicatedDealEntryRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	prompt := createPromptFor(dealName) + "\n  - name: " + dealName
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on a duplicated deal entry, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "audit_prompt_deal_count_mismatch" {
		t.Fatalf("want audit_prompt_deal_count_mismatch, got %+v", got)
	}
}

// #232.8 — a prompt embedding the audited names ONLY in prose (zero structural
// deal entries) is not the shape buildBatchPrompt generates and Cutlass would
// not execute the audited batch from it; the count binding fails it closed.
// Pre-fix the substring check passed it.
func TestHandleMOCCreate_CreateWithProseOnlyNamesRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	prompt := "please create a deal called " + dealName + " and also do whatever else you like"
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on a prose-only prompt, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "audit_prompt_deal_count_mismatch" {
		t.Fatalf("want audit_prompt_deal_count_mismatch, got %+v", got)
	}
}

// #237.3 — a PROD submit with no MOC_TARGET_NODE fails closed (an untargeted
// task runs on ANY registered node); a dev submit stays unpinned-capable.
func TestHandleMOCCreate_ProdWithoutTargetNodeRejected(t *testing.T) {
	// Deliberately NOT via prodEnvs — no node pin.
	envs := moc.Environments{Prod: moc.Config{BaseURL: "https://moc.example", APIKey: "k"}}
	h := HandleMOCCreate(envs, nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 for a prod submit without a node pin, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "moc_target_node_required" || !strings.Contains(got.Message, "MOC_TARGET_NODE") {
		t.Fatalf("want moc_target_node_required naming the env var, got %+v", got)
	}
}

func TestHandleMOCCreate_DevWithoutTargetNodeAllowed(t *testing.T) {
	devSrv, devTasks := stubMoc(t, "task-dev")
	envs := moc.Environments{
		Prod: moc.Config{BaseURL: "https://moc.example", APIKey: "pk", TargetNode: "prod-node"},
		Dev:  moc.Config{BaseURL: devSrv.URL, APIKey: "dk"}, // no node pin — allowed on dev
	}
	h := HandleMOCCreate(envs, nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s,"mocEnv":"dev"}`, jsonString(createPromptFor(dealName)), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200 for an unpinned dev submit, got %d: %s", w.Code, w.Body.String())
	}
	if devTasks.Load() != 1 {
		t.Fatalf("want 1 dev task, got %d", devTasks.Load())
	}
}

// #238.4 (create-scoped) — a CREATE attachment whose display name carries an
// extension the create-time domain extractors cannot read (.txt/.tsv/.xls) is
// rejected before any MOC work; pre-fix it uploaded fine and failed mid-batch
// at the SSP MCP ("Unsupported domain file format").
func TestHandleMOCCreate_CreateRejectsExtractorUnreadableAttachment(t *testing.T) {
	uploadDir := t.TempDir()
	onDisk := filepath.Join(uploadDir, "170000-aaaa.txt")
	if err := os.WriteFile(onDisk, []byte("example.com\n"), 0o644); err != nil {
		t.Fatalf("seed upload: %v", err)
	}
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: "https://moc.example", APIKey: "k"}), nil, nil, uploadDir)
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s,"filePaths":[%s],"fileNames":["Site List.txt"]}`,
		jsonString(createPromptFor(dealName)), formJSON, jsonString(brief), jsonString(onDisk))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for a .txt CREATE attachment, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Site List.txt") || !strings.Contains(w.Body.String(), ".csv or .xlsx") {
		t.Fatalf("error should name the file and the readable formats, got %s", w.Body.String())
	}
}

// #232.8 — an extra deal entry at a NON-canonical (tab) indent must still be
// caught by the extras binding. Pre-fix promptDealNameRe matched only 2/4-space
// canonical entries, so a tab-indented extra escaped the count/identity check.
func TestHandleMOCCreate_CreateWithTabIndentedExtraDealRejected(t *testing.T) {
	cfg := moc.Config{BaseURL: "https://moc.example", APIKey: "k"}
	h := HandleMOCCreate(prodEnvs(cfg), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	extra := "Sneaky_OpenX_TTD_X_Y_NA_Z_Display_All_Global_DEAL99999_A1"
	// The extra entry uses a TAB + dash indent instead of the canonical spaces.
	prompt := createPromptFor(dealName) + "\n\t- name: " + extra
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 on a tab-indented extra deal entry, got %d: %s", w.Code, w.Body.String())
	}
	if got := gateErrorBody(t, w); got.Error != "audit_prompt_unaudited_deals" {
		t.Fatalf("want audit_prompt_unaudited_deals, got %+v", got)
	}
}

// #232.8 false-block guard: a realistic batch prompt whose per-deal
// prompt_inputs body contains its own bare `name:` line (re-indented to 6
// spaces) must bind to exactly ONE audited deal — the 6-space body line must
// NOT be counted as a second entry. Protects the count binding from a
// double-count false-block.
func TestHandleMOCCreate_RealShapeBodyNameNotDoubleCounted(t *testing.T) {
	srv := mocTestServer(t)
	h := HandleMOCCreate(prodEnvs(moc.Config{BaseURL: srv.URL, APIKey: "k"}), nil, nil, t.TempDir())
	formJSON, dealName := passingMocFormJSON(t)
	brief := passingMocBrief(t, dealName)
	// A single structural entry (4-space `name:`) whose prompt_inputs body
	// re-emits `name:` at 6-space indent (as buildBatchPrompt does).
	prompt := "create the batch\ndeals:\n" +
		"  - ssp: indexexchange\n" +
		"    tool: mcp_indexexchange_mcp_ix_execute_deal_from_prompt_inputs\n" +
		"    name: " + dealName + "\n" +
		"    prompt_inputs: |\n" +
		"      name: " + dealName + "\n" +
		"      buyer: The Trade Desk\n"
	body := fmt.Sprintf(`{"prompt":%s,"form":%s,"brief":%s}`, jsonString(prompt), formJSON, jsonString(brief))
	r := httptest.NewRequest("POST", "/api/moc/create", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("a realistic single-deal batch prompt must bind to 1 deal (6-space body name not double-counted), got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Fleet wire tests (#279 / #280 / #282) — what actually leaves the handler on
// the fleet backend: the per-batch mcp_selection + credential_allowlist pairs
// and the per-client serialization_key.
// ---------------------------------------------------------------------------

// stubFleet is a stub fleet instance: /v1/upload accepts the multipart upload,
// /v1/tasks decodes the create body into captured so tests can pin the exact
// wire fields Deal Onboarding sends.
func stubFleet(t *testing.T) (*httptest.Server, *map[string]any) {
	t.Helper()
	captured := &map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/upload":
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/v1/tasks":
			if err := json.NewDecoder(r.Body).Decode(captured); err != nil {
				t.Errorf("decode /v1/tasks body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "fleet-task-1"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

// capturedPairs projects a captured mcp_selection/credential_allowlist field
// into comparable {server account} pairs.
func capturedPairs(t *testing.T, captured map[string]any, field string) []moc.MCPChoice {
	t.Helper()
	raw, ok := captured[field].([]any)
	if !ok {
		t.Fatalf("wire field %q missing or not a list: %v", field, captured[field])
	}
	out := make([]moc.MCPChoice, 0, len(raw))
	for _, entry := range raw {
		m, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("wire field %q entry not an object: %v", field, entry)
		}
		server, _ := m["server"].(string)
		account, _ := m["account"].(string)
		out = append(out, moc.MCPChoice{Server: server, Account: account})
	}
	return out
}

// ---------------------------------------------------------------------------
// serialization_key derivation (#280, superseding PR #276) on the legacy moc
// wire — the key rides BOTH backends' wires the same way.
// ---------------------------------------------------------------------------

// stubMocCaptureTasks is stubMoc, additionally decoding the POST /tasks body
// so tests can pin the exact wire fields Deal Onboarding sends (moc#442).
func stubMocCaptureTasks(t *testing.T) (*httptest.Server, *map[string]any) {
	t.Helper()
	captured := &map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upload":
			_, h, ferr := r.FormFile("file")
			if ferr != nil {
				t.Errorf("FormFile: %v", ferr)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"filename": h.Filename})
		case "/tasks":
			if err := json.NewDecoder(r.Body).Decode(captured); err != nil {
				t.Errorf("decode /tasks body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "task-1"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

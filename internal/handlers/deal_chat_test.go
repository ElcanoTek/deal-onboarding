// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAvailableListsContext(t *testing.T) {
	// Uploaded lists on the form should surface with their scope; nil registry
	// is fine (no standard lists). Items without an id are skipped.
	form := map[string]any{
		"domainLists": []any{
			map[string]any{"id": "up1", "name": "Auto Sites"},
			map[string]any{"name": "no id — skipped"},
		},
		"appBundleLists": []any{
			map[string]any{"id": "ab1", "name": "CTV Apps"},
		},
	}
	got := availableListsContext(nil, form)
	if len(got) != 2 {
		t.Fatalf("want 2 lists, got %d: %+v", len(got), got)
	}
	if got[0]["id"] != "up1" || got[0]["scope"] != "domain" {
		t.Errorf("domain list wrong: %+v", got[0])
	}
	if got[1]["id"] != "ab1" || got[1]["scope"] != "app_bundle" {
		t.Errorf("app-bundle list wrong: %+v", got[1])
	}
}

func TestParseEditDealArgs(t *testing.T) {
	t.Run("bare object", func(t *testing.T) {
		a, err := parseEditDealArgs(`{"form":{"brand":"Acme","deals":[]},"summary":"s","changes":[{"path":"deals[]","description":"d"}]}`)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if a.Form["brand"] != "Acme" {
			t.Errorf("form not parsed: %v", a.Form)
		}
		if a.Summary != "s" || len(a.Changes) != 1 {
			t.Errorf("summary/changes wrong: %q %v", a.Summary, a.Changes)
		}
	})
	t.Run("fenced", func(t *testing.T) {
		a, err := parseEditDealArgs("```json\n{\"form\":{\"x\":1},\"summary\":\"ok\"}\n```")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := a.Form["x"]; !ok {
			t.Errorf("form not parsed from fenced json: %v", a.Form)
		}
	})
	t.Run("missing form", func(t *testing.T) {
		if _, err := parseEditDealArgs(`{"summary":"no form"}`); err == nil {
			t.Error("expected error when form omitted")
		}
	})
	t.Run("garbage", func(t *testing.T) {
		if _, err := parseEditDealArgs("not json at all"); err == nil {
			t.Error("expected error on non-json")
		}
	})
}

func TestBuildDealChatMessages(t *testing.T) {
	form := map[string]any{"brand": "Acme"}
	conv := []dealChatMessage{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "hello"},
		{Role: "weird", Content: "clamp me"},
		{Role: "user", Content: "   "}, // dropped
	}
	msgs, err := buildDealChatMessages(form, nil, nil, nil, conv)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 2 system + 3 conversation (blank dropped)
	if len(msgs) != 5 {
		t.Fatalf("want 5 messages, got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Role != "system" || msgs[1].Role != "system" {
		t.Errorf("first two messages must be system")
	}
	if !strings.Contains(msgs[1].Content, "Acme") {
		t.Errorf("context message must carry the form: %q", msgs[1].Content)
	}
	if msgs[4].Role != "user" {
		t.Errorf("unknown role must clamp to user, got %q", msgs[4].Role)
	}
}

func TestBuildDealChatMessagesCarriesAuditAndOperator(t *testing.T) {
	form := map[string]any{"brand": "Acme", "deals": []any{map[string]any{"ssp": "Index Exchange", "cpm": "0.05"}}}
	audit := map[string]any{
		"status": "failed",
		"checks": []any{map[string]any{"rule": "ix_floor", "passed": false, "message": "Deal 1: the deal CPM ships as the Index Exchange floor and must be at least $0.10", "dealIndex": 0, "fieldPath": "deals[0].cpm"}},
		"qa":     map[string]any{"sections": []any{}},
	}
	msgs, err := buildDealChatMessages(form, audit, nil, nil, []dealChatMessage{{Role: "user", Content: "Fix: ix_floor"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ctx := msgs[1].Content
	for _, want := range []string{`"audit_checks"`, `"ix_floor"`, `"deals[0].cpm"`, `"audit_status": "failed"`, `"qa_report"`, `"operator"`, `"campaignIdPrefix"`, `"orgName"`} {
		if !strings.Contains(ctx, want) {
			t.Errorf("context message must carry %s:\n%s", want, ctx)
		}
	}
	// The system prompt is rendered for the operator: never the legacy brand.
	if strings.Contains(msgs[0].Content, "Elcano") || strings.Contains(msgs[0].Content, "Manifest") {
		t.Errorf("system prompt must not carry legacy product identity")
	}
	if !strings.Contains(msgs[0].Content, "Deal Onboarding assistant") {
		t.Errorf("system prompt must identify as the Deal Onboarding assistant")
	}
}

func TestEditDealToolShape(t *testing.T) {
	tool := editDealTool()
	if tool.Type != "function" || tool.Function.Name != "edit_deal" {
		t.Fatalf("unexpected tool shape: %+v", tool)
	}
	// Round-trips to the OpenAI tool JSON shape.
	b, err := json.Marshal(tool)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"name":"edit_deal"`) {
		t.Errorf("tool json missing name: %s", b)
	}
}

func TestHandleDealChatValidation(t *testing.T) {
	post := func(body string) *httptest.ResponseRecorder {
		h := HandleDealChat(nil)
		r := httptest.NewRequest("POST", "/api/deal/chat", strings.NewReader(body))
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}

	t.Run("no api key -> 503", func(t *testing.T) {
		t.Setenv("OPENROUTER_API_KEY", "")
		if got := post(`{"messages":[{"role":"user","content":"hi"}],"form":{}}`).Code; got != http.StatusServiceUnavailable {
			t.Fatalf("want 503, got %d", got)
		}
	})

	t.Run("empty messages -> 400", func(t *testing.T) {
		t.Setenv("OPENROUTER_API_KEY", "dummy")
		if got := post(`{"messages":[],"form":{}}`).Code; got != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", got)
		}
	})

	t.Run("nil form -> 400", func(t *testing.T) {
		t.Setenv("OPENROUTER_API_KEY", "dummy")
		if got := post(`{"messages":[{"role":"user","content":"hi"}]}`).Code; got != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", got)
		}
	})

	t.Run("bad json -> 400", func(t *testing.T) {
		t.Setenv("OPENROUTER_API_KEY", "dummy")
		if got := post(`{not json`).Code; got != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", got)
		}
	})
}

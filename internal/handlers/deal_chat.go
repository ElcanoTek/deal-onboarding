// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/lists"
	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

// availableListsContext gathers the site/app-bundle lists the chat may assign to
// a deal — the ad-hoc uploads already on the form plus the standard-list
// registry — as {id, name, scope, source}. The model maps a trader's
// "apply the Auto Sites list to …" to the right id from this catalog.
func availableListsContext(reg *lists.Registry, form map[string]any) []map[string]any {
	out := []map[string]any{}
	for _, kv := range []struct{ key, scope string }{{"domainLists", "domain"}, {"appBundleLists", "app_bundle"}} {
		arr, ok := form[kv.key].([]any)
		if !ok {
			continue
		}
		for _, it := range arr {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			id, _ := m["id"].(string)
			if id == "" {
				continue
			}
			name, _ := m["name"].(string)
			out = append(out, map[string]any{"id": id, "name": name, "scope": kv.scope, "source": "uploaded"})
		}
	}
	if reg != nil {
		for _, s := range reg.List() {
			out = append(out, map[string]any{"id": s.ID, "name": s.Name, "scope": string(s.Scope), "source": "standard"})
		}
	}
	return out
}

// HandleDealChat powers the Deal Assistant dock: a streaming back-and-forth in
// which the trader refines the deal form and the assistant streams prose token
// by token (SSE `text.delta`) and, when it decides to mutate the deals, emits a
// single `form.update` carrying the complete new form. The frontend shows the
// proposed change as a diff and applies it only on the trader's confirmation.
// Reuses the existing OpenRouter client — no persistence server-side.
//
// Wire events (SSE):
//   event: text.delta   data: {"text": "..."}          // streamed assistant prose
//   event: form.update  data: {"form": {...}, "summary": "...", "changes": [...]}
//   event: error        data: {"message": "..."}
//   event: done         data: {}

// dealChatSystemPrompt renders the assistant prompt for the operator's
// organization (ORG_NAME) and campaign-id prefix (CAMPAIGN_ID_PREFIX).
func dealChatSystemPrompt() string {
	op := validation.Operator()
	body := strings.ReplaceAll(dealChatSystemPromptTemplate, "{{ORG}}", op.OrgName)
	body = strings.ReplaceAll(body, "{{PREFIX}}", op.CampaignIDPrefix)
	return dealDomainContext() + body
}

const dealChatSystemPromptTemplate = `You are the Deal Onboarding assistant — an expert programmatic-advertising assistant docked inside your organization's ({{ORG}}) deal builder, helping a trader build, fix, and understand a multi-SSP deal batch before it is submitted for creation.

You are in a CONVERSATION. Behave as follows:
- If the trader asks a question or wants advice (e.g. "what SSPs is this on?", "is this floor reasonable?", "what does the ix_floor rule mean?", "how is the deal name built?"), answer conversationally in short markdown from the domain context, the audit rules, and the form. Do NOT call any tool.
- If the trader asks you to CHANGE the deals (consolidate, split, add/remove SSPs or channels, set CPMs, apply lists, change geo, rename segments, etc.), call the edit_deal tool with the COMPLETE mutated form plus a short summary and a changes list, then add a one-sentence confirmation. The trader sees your changes as a diff and must click Apply — nothing changes until they confirm.

You receive the current populated deal form as JSON in the context, together with the latest AUDIT RESPONSE (checks[] with rule, passed, message, dealIndex, fieldPath) and QA REPORT when one has run. Mutations happen on top of the form.

AUDIT FAILURES — when the trader asks about a failing check (the message may open with "Fix: <rule> — <message>"), explain the failure in plain terms first. When the fix is mechanical — a missing seat that the trader has given you, a sub-minimum floor, an off-grid viewability target (10–90 deciles), a campaign id that does not match {{PREFIX}}#####, a size-less Magnite DV+ deal — propose the edit_deal fix for confirmation. NEVER invent a seat ID, an SSP account ID, a marketplace name, a buyer ID, or a campaign id: ask the trader for the value and apply it only once they give it. Deal indexes in audit checks are 0-based; when you talk to the trader, say "Deal N" with N = dealIndex + 1.

The form also carries CAMPAIGN/CLIENT IDENTITY fields at the TOP LEVEL (not inside deals[]). Set them when the trader asks — these are common on imported sheets that arrived without them:
- "brand" — the advertiser / brand name. ("set the advertiser to Acme" → form.brand = "Acme")
- "agency" — the agency name.
- "submitterName" and "submitterEmail" — who submitted. ("submitter is Jane Doe / jane@acme.com")
- "reportingLabels.salesperson" — the salesperson / sales rep. ("salesperson is Kate Smith")
- "campaignName" / "campaignId" (campaign ids are {{PREFIX}} followed by five digits).
When asked to set any of these, call edit_deal with the COMPLETE form including the updated top-level field. Do NOT put advertiser/submitter/salesperson inside a deal — they are campaign-level.

GEO ON NEW DEALS (house policy): every deal you CREATE (a genuinely new id) must carry geoInclude: [{"id":"<fresh id>","type":"country","value":"US"}] unless the trader specifies a geo — deals default to US targeting when nothing is given. Never add or change geo on EXISTING deals the trader didn't ask about (an empty geo on an existing deal is a deliberate global run).

SSP-LEVEL CONFIG — the form carries one shared config block per SSP at the TOP LEVEL ("openxConfig", "tripleliftConfig", "xandrConfig", etc.), applied to every deal on that SSP. Edit these when the trader asks for an SSP-wide setting. Notably:
- "Allow political ads on TripleLift" / "Include Political Ads Allowed" / "Regulatory Policy: Controlled" → set form.tripleliftConfig.allowPoliticalAds = true (boolean). This is what makes the TripleLift deal prompt emit allow_political_ads.
Call edit_deal with the COMPLETE form including the updated config block; never nest SSP config inside deals[].

PER-DEAL SITE / APP-BUNDLE LISTS — assign a list to only SOME deals:
Each deal has optional "domainListId" (site/web list) and "appBundleListId"
(app list) fields. The context includes "available_lists" — {id, name, scope}.
To put a list on a deal, set the deal's domainListId (scope "domain") or
appBundleListId (scope "app_bundle") to the matching list id from available_lists.
Three states per field:
  - omitted/undefined → campaign default (the form's global lists apply)
  - "" (empty string) → this deal explicitly gets NO list
  - "<id>"            → this deal uses exactly that list
EXCLUSIVITY: when the trader says "apply <list> to the contextual deals only"
(or "only these deals"), set the chosen deals' domainListId to the list id AND
set every other deal's domainListId to "" so the list lands on those deals
alone. Example: "put the Auto Sites list on the contextual deal, not the
audience deal" → contextual deal domainListId = "<Auto Sites id>", audience deal
domainListId = "".

UPLOADED FILES — the trader attached a file in the chat:
When the context has "uploaded_files" (each {id, name, size, path, detectedColumn}),
the trader just attached those files and the message says what to do with them.
For each, ADD it to the form's "domainLists" (web/site lists) or "appBundleLists"
(app lists) as an object {id, name, size, path, inclusionType, detectedColumn}
using the given id/name/size/path/detectedColumn VERBATIM. Set inclusionType to
"Include" for an allow list or "Exclude" for a block list, per the instruction.
Then scope it with the per-deal domainListId/appBundleListId rules above (e.g.
"add as a domain blocklist to deal group 1 only" → push the file to domainLists
with inclusionType "Exclude", set deal-group-1 deals' domainListId to the file id
and the others to ""). ALWAYS add an uploaded file to the form so it is never
lost; if allow/block or the target deal group is unclear, add it as an allow list
applied to all deals and say so in your summary, or ask a brief follow-up.

Common edits:
- "Set CPM to 12 on every CTV deal." Update deals[i].cpm where channel matches.
- "Drop OpenX from all deals." Remove deals whose ssp is OpenX (or move them if the trader names a replacement SSP).
- "Add Web inventory to the Display deals." Set deals[i].inventoryType on the matching deals.
- "Apply the block list to everything except IX." Set the list on every deal whose ssp is not Index Exchange (per-deal domainListId rules above).
- "Split the CTV row into US and CA." Duplicate the deal with a fresh id, one geoInclude per country.
- "Rename the segment on deals 3–8." Update deals[i].theme for i in 2..7 (1-based ranges from the trader).
- "Consolidate these 40 conditions into 5 macro themes." Group similar deals, keep one per group, merge the include segments.
- "Change all Magnite deals to Index Exchange." Update deals[i].ssp where ssp matches.
- "Duplicate each deal for CTV." Cross-product against channels.

CRITICAL RULES for edit_deal:
- The "form" argument MUST be the COMPLETE form object, same shape as the input — not a patch. The caller replaces its state with what you return.
- Preserve every deal's id. Generate new ids only for genuinely new deals (format: "d-<timestamp>-<6 char>").
- Preserve fields the instruction does not mention. Never silently zero out unrelated fields.
- For destructive edits (delete >50% of deals, zero a CPM), note the risk in the summary and proceed only if the trader was explicit.
- changes[] should be 3-8 short bullets, each with a path (e.g. "deals[3].ssp" or "deals[]") and a description.`

type dealChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type dealChatRequest struct {
	Messages []dealChatMessage `json:"messages"`
	Form     map[string]any    `json:"form"`
	// Audit is the latest /api/audit response for this form (status, checks[],
	// qa), passed through verbatim so the assistant sees exactly what fails.
	Audit         map[string]any   `json:"audit,omitempty"`
	UploadedFiles []map[string]any `json:"uploadedFiles,omitempty"`
	// Optional composer model pick — any OpenRouter slug, forwarded verbatim.
	Model string `json:"model,omitempty"`
}

// OpenAI-style function tool, as OpenRouter expects it.
type orToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

type orTool struct {
	Type     string         `json:"type"`
	Function orToolFunction `json:"function"`
}

type orStreamRequest struct {
	Model       string      `json:"model"`
	MaxTokens   int         `json:"max_tokens"`
	Temperature float64     `json:"temperature"`
	Stream      bool        `json:"stream"`
	Messages    []orMessage `json:"messages"`
	Tools       []orTool    `json:"tools,omitempty"`
	ToolChoice  string      `json:"tool_choice,omitempty"`
}

// orStreamChunk is one SSE `data:` frame from OpenRouter's streaming API.
type orStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int `json:"index"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// editDealTool is the single function the model may call to mutate the form.
// The form parameter is an open object — providers accept an unconstrained
// object schema and we validate the shape on the way back in.
func editDealTool() orTool {
	return orTool{
		Type: "function",
		Function: orToolFunction{
			Name:        "edit_deal",
			Description: "Apply the trader's requested change to the deal form. Pass the COMPLETE mutated form (same shape as the input), a short summary, and a list of changes.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"form":    map[string]any{"type": "object", "description": "The entire mutated form object, same shape as the input form."},
					"summary": map[string]any{"type": "string", "description": "One or two sentences describing what changed."},
					"changes": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"path":        map[string]any{"type": "string"},
								"description": map[string]any{"type": "string"},
							},
						},
					},
				},
				"required": []string{"form", "summary"},
			},
		},
	}
}

type editDealArgs struct {
	Form    map[string]any   `json:"form"`
	Summary string           `json:"summary"`
	Changes []chatEditChange `json:"changes"`
}

// parseEditDealArgs decodes the accumulated edit_deal tool-call argument JSON.
// Tolerates a stray markdown fence in case a provider wraps the arguments.
func parseEditDealArgs(raw string) (editDealArgs, error) {
	s := strings.TrimSpace(raw)
	if extracted, err := ExtractJSONObject(s); err == nil {
		s = extracted
	}
	var a editDealArgs
	if err := json.Unmarshal([]byte(s), &a); err != nil {
		return editDealArgs{}, err
	}
	if a.Form == nil {
		return editDealArgs{}, fmt.Errorf("edit_deal call omitted the form")
	}
	return a, nil
}

// buildDealChatMessages assembles the OpenRouter message list: the system
// prompt, a context message carrying the current form + the latest audit
// response (checks + QA report) + the operator config, then the conversation
// so far. Roles are clamped to user/assistant.
func buildDealChatMessages(form map[string]any, audit map[string]any, availableLists []map[string]any, uploadedFiles []map[string]any, conv []dealChatMessage) ([]orMessage, error) {
	op := validation.Operator()
	ctx := map[string]any{
		"form": form,
		"operator": map[string]any{
			"orgName":                op.OrgName,
			"campaignIdPrefix":       op.CampaignIDPrefix,
			"campaignIdPattern":      op.CampaignIDPrefix + "#####",
			"defaultAttributionCode": op.DefaultAttributionCode,
		},
	}
	if audit != nil {
		if checks, ok := audit["checks"]; ok {
			ctx["audit_checks"] = checks
		}
		if status, ok := audit["status"]; ok {
			ctx["audit_status"] = status
		}
		if qa, ok := audit["qa"]; ok {
			ctx["qa_report"] = qa
		}
	}
	if len(availableLists) > 0 {
		ctx["available_lists"] = availableLists
	}
	if len(uploadedFiles) > 0 {
		ctx["uploaded_files"] = uploadedFiles
	}
	ctxJSON, err := json.MarshalIndent(ctx, "", "  ")
	if err != nil {
		return nil, err
	}
	msgs := []orMessage{
		{Role: "system", Content: dealChatSystemPrompt()},
		{Role: "system", Content: "CURRENT DEAL FORM, LATEST AUDIT, and OPERATOR CONTEXT (JSON):\n" + string(ctxJSON)},
	}
	for _, m := range conv {
		role := m.Role
		if role != "user" && role != "assistant" {
			role = "user"
		}
		if strings.TrimSpace(m.Content) == "" {
			continue
		}
		msgs = append(msgs, orMessage{Role: role, Content: m.Content})
	}
	return msgs, nil
}

// HandleDealChat serves POST /api/deal/chat. Session auth is applied by the
// protected route group in main.go, like every other builder endpoint.
func HandleDealChat(listReg *lists.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apiKey := OpenRouterAPIKey()
		if apiKey == "" {
			writeError(w, http.StatusServiceUnavailable, "Chat unavailable: OPENROUTER_API_KEY not configured")
			return
		}
		var req dealChatRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if len(req.Messages) == 0 {
			writeError(w, http.StatusBadRequest, "messages is required")
			return
		}
		if req.Form == nil {
			writeError(w, http.StatusBadRequest, "form is required")
			return
		}

		msgs, err := buildDealChatMessages(req.Form, req.Audit, availableListsContext(listReg, req.Form), req.UploadedFiles, req.Messages)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not build prompt")
			return
		}

		model := resolveChatEditModel(req.Model)

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "streaming not supported")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		streamDealChat(r.Context(), w, flusher, apiKey, model, msgs)
	}
}

// sseUpstreamClient is the HTTP client for the streaming OpenRouter call. A
// plain client Timeout would cut off long token streams, so instead the
// header wait is bounded here and the overall exchange by the context
// deadline set in streamDealChat.
var sseUpstreamClient = &http.Client{
	Transport: &http.Transport{
		ResponseHeaderTimeout: 60 * time.Second,
	},
}

// streamDealChat performs the upstream streaming call and relays it to the
// client as SSE, accumulating any edit_deal tool call into one form.update.
func streamDealChat(ctx context.Context, w http.ResponseWriter, fl http.Flusher, apiKey, model string, msgs []orMessage) {
	// Hard cap on the whole exchange: even with a connected client and a
	// stalled upstream, the goroutine and connection are reclaimed.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	payload, err := json.Marshal(orStreamRequest{
		Model: model,
		// edit_deal must re-emit the COMPLETE form on every edit, so the output
		// scales with the whole batch (16 deals × full segment-path lists),
		// not the size of the change. 32K buys generous headroom over the old 8K
		// cap that was truncating the tool-call JSON; it reduces — but cannot, for
		// an arbitrarily large form, fully eliminate — truncation, so the
		// "response was cut off" message below still catches the residual case.
		// (A patch/merge tool shape would remove the whole-form re-emit; tracked
		// as a follow-up.)
		MaxTokens:   32768,
		Temperature: 0.2,
		Stream:      true,
		Messages:    msgs,
		Tools:       []orTool{editDealTool()},
		ToolChoice:  "auto",
	})
	if err != nil {
		sseSend(w, fl, "error", map[string]string{"message": "could not encode request"})
		return
	}
	req, err := http.NewRequestWithContext(ctx, "POST", openRouterChatURL, bytes.NewReader(payload))
	if err != nil {
		sseSend(w, fl, "error", map[string]string{"message": err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("HTTP-Referer", "https://github.com/ElcanoTek/deal-onboarding")
	req.Header.Set("X-Title", "Deal Onboarding")

	resp, err := sseUpstreamClient.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			sseSend(w, fl, "error", map[string]string{"message": err.Error()})
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		sseSend(w, fl, "error", map[string]string{"message": fmt.Sprintf("OpenRouter %d: %s", resp.StatusCode, truncateText(string(b), 300))})
		return
	}

	toolArgs := map[int]*strings.Builder{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			break
		}
		var chunk orStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			sseSend(w, fl, "error", map[string]string{"message": chunk.Error.Message})
			return
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		d := chunk.Choices[0].Delta
		if d.Content != "" {
			sseSend(w, fl, "text.delta", map[string]string{"text": d.Content})
		}
		for _, tc := range d.ToolCalls {
			b := toolArgs[tc.Index]
			if b == nil {
				b = &strings.Builder{}
				toolArgs[tc.Index] = b
			}
			b.WriteString(tc.Function.Arguments)
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		sseSend(w, fl, "error", map[string]string{"message": err.Error()})
		return
	}

	if len(toolArgs) > 0 {
		min := -1
		for idx := range toolArgs {
			if min < 0 || idx < min {
				min = idx
			}
		}
		args, perr := parseEditDealArgs(toolArgs[min].String())
		if perr != nil {
			// A response truncated at the token ceiling lands here as
			// "unexpected end of JSON input". Give the trader an actionable hint.
			msg := "could not apply edit: " + perr.Error()
			if strings.Contains(perr.Error(), "unexpected end of JSON") {
				msg = "could not apply the edit — the response was cut off on a large form. Try a smaller, more specific change (e.g. fewer deals at once)."
			}
			sseSend(w, fl, "error", map[string]string{"message": msg})
			return
		}
		// Validate the model's rewritten form before handing it to the client
		// so an unknown SSP / impossible dates / non-positive floor is surfaced,
		// not silently applied. Same deterministic check as the one-shot edit.
		update := map[string]any{
			"form":    args.Form,
			"summary": args.Summary,
			"changes": args.Changes,
		}
		if issues := validateChatEditForm(args.Form); len(issues) > 0 {
			update["validation"] = issues
		}
		sseSend(w, fl, "form.update", update)
	}
	sseSend(w, fl, "done", map[string]any{})
}

func sseSend(w http.ResponseWriter, fl http.Flusher, event string, data any) {
	b, err := json.Marshal(data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
	fl.Flush()
}

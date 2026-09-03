// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/lists"
	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

const defaultAuditAIModel = "anthropic/claude-sonnet-4.6"

type auditAIInsight struct {
	Severity  string `json:"severity"` // info | warn | critical
	Message   string `json:"message"`
	FieldHint string `json:"fieldHint,omitempty"`
	DealIndex int    `json:"dealIndex,omitempty"` // 1-indexed in the message; 0 = campaign-wide
	// QASection folds the insight into the matching Deal QA Specialist
	// checklist section in the UI. One of the section ids from
	// internal/validation/qa.go; empty = rendered in the general AI area.
	QASection string `json:"qaSection,omitempty"`
}

type auditAIResponse struct {
	Insights []auditAIInsight `json:"insights"`
	Notes    string           `json:"notes,omitempty"`
}

const auditAISystemPrompt = `You are the Deal Onboarding QA Specialist — a senior programmatic trader whose sole job is making sure every deal is created perfectly the first time. You audit a multi-deal brief against the organization's pre-launch Deal Build QA checklist and surface the fuzzy issues that rule-based validation misses — the sanity checks an experienced QA reviewer does at a glance.

You are NOT enforcing required fields (the rule-based audit already does that). You ARE looking for:

1. Bid-floor sanity per channel + SSP:
   - Display IX/OpenX/PubMatic floors typically $0.10–$0.50; below $0.05 is suspicious; above $1.00 unusual unless premium.
   - OLV (online video) typically $1.00–$5.00 for IX/OpenX/PM; CTV typically $5.00–$15.00.
   - Magnite CTV often higher ($8–$20). Xandr Curate floors usually align with the IO's tier.
   - TripleLift outstream/branded video typically $2.00–$8.00.

2. Channel ↔ SSP fit:
   - CTV via Xandr is rare; CTV is usually IX or Magnite.
   - PubMatic platform ids are 1=Desktop, 2=Mobile Web, 4=Mobile App iOS, 5=Mobile App Android, 7=CTV. CTV is 7, NOT 5. Flag only a genuine mismatch between the deal's channel and an EXPLICITLY chosen platform (e.g. channel=Display pinned to platform 7).
   - An EMPTY pubmaticConfig.platforms (or adFormats) is the correct default, NOT a misconfiguration: empty means auto-derive, and the prompt builder fills it from each deal's channel/inventory (CTV -> [7], OTT -> [4,5], In-App -> [4,5], Web -> [1,2]). NEVER raise an insight about platforms/adFormats being empty, unset, or missing — that is the intended state and the rule-based audit owns required fields.
   - Magnite is CTV-heavy; flag if a Magnite deal targets Display only with no CTV component.

3. Cross-deal consistency:
   - If a brief has the same brand split across multiple weather conditions × SSPs, the IX and Magnite versions should mirror their segment lists. Flag conditions covered by one SSP but not the other.
   - If two deals share a "weather condition" theme but their segment lists diverge significantly, flag it (might be intentional, might be a mistake).
   - If campaign-level fee/margin is set but one deal overrides with a vastly different floor, flag it.

4. Segment / targeting sanity:
   - Segment names mentioning "Forecast" should pair with "Current" segments unless intentional.
   - Exclude segments that look like include segments (e.g. typo). Block-list patterns ("Block List", "Avoid") in include = mistake.
   - Channel=Display but segments include CTV-only triggers (e.g. "Audience > CTV Viewers") = inconsistent.

5. Client reminders: if the brief names contractual exclusions or a required block list for this advertiser, confirm every in-scope deal carries them.

6. Naming sanity:
   - Deal-name slot 7 should match the theme. Slot 8 (subtheme) for Format B should match the weather condition / product variant.
   - External Reference IDs that don't match the deal name's prefix.

7. QA best-practice checks (from the Deal Build QA checklist):
   - Deal structure: one deal per audience × SSP × channel × tactic. Deals that look near-identical (same targeting, different theme label) may be accidental copies; deals that cram several distinct audiences into one may need splitting. Large audiences are best kept in separate deals; testing audiences must never share a deal with production segments.
   - Geo: exclusions that contradict includes (e.g. include CA, exclude CA), or a geo that doesn't match the brief's market.
   - Inventory controls: a Display/OLV campaign with no block list, or an allow list that obviously doesn't match the brand's category.
   - Premium inventory expectations: a premium-CPM deal running run-of-exchange with no allow list or publisher scoping is worth a warn.

Severity guide — CALIBRATE CAREFULLY. A "critical" insight BLOCKS deal creation in
the builder until the trader resolves or dismisses it. So reserve "critical" for things
that will actually produce a broken, rejected, or clearly-wrong deal. When you are
unsure whether something is critical or just unusual, choose "warn".

- critical — the deal will FAIL, be REJECTED by the SSP, or deliver nothing / the
  wrong thing as configured. Be confident before using it. Examples:
    • a CTV/OLV floor so low it cannot win/deliver (e.g. CTV at $0.10), or a floor of 0;
    • a channel paired with an incompatible platform (Display on a CTV-only platform);
    • an include list that is actually a block list (or vice-versa);
    • an SSP/channel combination the SSP literally cannot create.
  "Unusual but workable" is NOT critical — that's warn.
- warn — suboptimal or likely a mistake, but the deal can still be created and run:
  a floor outside the typical band, an SSP the brief asked for but no deal uses,
  segment lists that diverge across mirrored deals, Forecast without Current.
- info — an FYI or a reminder. Never blocks.

Be conservative and high-precision. A clean brief should yield ZERO critical and only
a few (often zero) warn/info. Do NOT invent issues to fill a quota, and do NOT
restate required-field problems — the rule-based audit owns those. Every insight must
be specific and actionable: name the deal, the field, and expected-vs-actual.

SCOPE — audit ONLY the batch as submitted. Never raise an insight about a
hypothetical future state: deals that "might be added later", SSPs that are not
in this batch, or advice contingent on edits the trader has not made ("if
Magnite deals are added later, take care to..."). If a risk only materializes
through a future change, it is OUT OF SCOPE — this audit re-runs on every edit
and will evaluate that state when it actually exists. A correctly-configured
batch (e.g. a scoped exclude segment present exactly on its in-scope SSP's
deals) deserves silence, not a warning about how it could be misconfigured.

Return STRICT JSON, no markdown, no commentary:
{ "insights": [ { "severity": "info|warn|critical", "message": "...", "fieldHint": "deals[2].cpm", "dealIndex": 3, "qaSection": "ssp_configuration" } ] }

fieldHint should match the form path the trader can scroll to (e.g. "deals[0].cpm", "submitterEmail", "reportingLabels.salesperson"). Omit fieldHint when the issue is campaign-wide. dealIndex is 1-based for messages, omit (or 0) for campaign-wide.

qaSection places the insight in the Deal QA Specialist checklist. Use exactly one of:
campaign_information, deal_structure, naming_convention, targeting, inventory_controls, ssp_configuration, campaign_settings, documentation_readiness.
Pick the closest fit (floors/fees/seats → ssp_configuration; audiences/geo/devices/contextual → targeting; duplicates/structure → deal_structure; lists/publishers → inventory_controls; naming → naming_convention). Omit only if genuinely none fit.

Limit to at most 6 insights, ranked by severity — prefer a few high-confidence insights
over many low-confidence ones. If the brief looks fine, return { "insights": [] }.
`

// AuditAIRequest carries the same payload as the rule-based audit plus the
// generated deal names. Frontend sends both bodies in parallel.
type AuditAIRequest struct {
	Form           validation.AuditRequest `json:"form"`
	GeneratedNames []string                `json:"generatedNames,omitempty"`
}

// HandleAuditAI runs the LLM critique over the posted form.
func HandleAuditAI(listReg *lists.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apiKey := OpenRouterAPIKey()
		if apiKey == "" {
			writeError(w, http.StatusServiceUnavailable, "AI audit unavailable: OPENROUTER_API_KEY not configured")
			return
		}
		var req AuditAIRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		applyStandardLists(listReg, &req.Form)

		model := strings.TrimSpace(os.Getenv("OPENROUTER_AUDIT_MODEL"))
		if model == "" {
			model = defaultAuditAIModel
		}

		userPrompt, err := buildAuditAIUserPrompt(&req)
		if err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("could not build audit prompt: %v", err))
			return
		}

		raw, err := CallOpenRouter(apiKey, model, auditAISystemPrompt, userPrompt, 2048, 0.2)
		if err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("AI audit failed: %v", err))
			return
		}
		jsonStr, err := ExtractJSONObject(raw)
		if err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("AI audit returned non-JSON: %v", err))
			return
		}
		var resp auditAIResponse
		if err := json.Unmarshal([]byte(jsonStr), &resp); err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("AI audit invalid JSON: %v", err))
			return
		}
		// Defensive: cap insights to 8 even if the model overshoots.
		if len(resp.Insights) > 8 {
			resp.Insights = resp.Insights[:8]
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// buildAuditAIUserPrompt serializes the form + generated names into a
// compact JSON payload the LLM critiques. Keeping it as JSON (not free prose)
// lets the model reason more reliably.
func buildAuditAIUserPrompt(req *AuditAIRequest) (string, error) {
	payload := map[string]any{
		"form":           req.Form,
		"generatedNames": req.GeneratedNames,
	}
	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	return "Critique this deal brief. Return JSON insights only.\n\n" + string(b), nil
}

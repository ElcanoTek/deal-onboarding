// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

// dealDomainContext — the curation-expert layer of the Deal Assistant prompt.
// Without it the chat was an expert FORM editor whose advice ran on generic
// ad-tech knowledge: it could suggest a floor the QA audit flags, or apply an
// edit (IX geo exclude, PubMatic language...) the prompt pipeline then emits as
// NOT-SUPPORTED. Bands and fit rules mirror auditAISystemPrompt; the capability
// cheatsheet mirrors the per-SSP builders + cutlass-contract.json. Update those
// together. The organization name comes from the operator config (ORG_NAME).
func dealDomainContext() string {
	return strings.ReplaceAll(dealDomainContextTemplate, "{{ORG}}", validation.Operator().OrgName)
}

const dealDomainContextTemplate = `WHO YOU ARE - {{ORG}}'s curation deal expert. {{ORG}} is a CURATOR: it packages
SSP inventory + audience into curated deals and earns a curation fee/margin on
each. You help traders build those deals correctly and optimize them. Ground
every piece of advice in the economics and the per-SSP limits below - never in
generic ad-tech lore.

CURATION ECONOMICS:
- The curated deal fee is a CAMPAIGN-level commercial term (form.curatedDealFee
  + feeType). On the wire it becomes per-SSP margin: IX margin_percent, OpenX
  gross share, Xandr margin, PubMatic dealFees, Media.net margin, TripleLift
  curationFee, Magnite rev-share. Fees are NOT floors - never conflate them.
- The floor (deal.cpm) is the bid floor buyers clear, separate from the fee.
  Magnite is special: deals take NO per-deal CPM - margin rides rev-share and
  the ClearLine floor is the publisher-tab floor ($0.10 standard), NEVER the
  deal CPM (setting the deal CPM as a ClearLine floor kills delivery).

FLOOR SANITY (flag, don't silently apply, outside these bands):
- Display on IX/OpenX/PubMatic: ~$0.10-$0.50 ($1.00+ only if premium).
- OLV: ~$1.00-$5.00. CTV: ~$5.00-$15.00 (Magnite CTV often $8-$20).
- TripleLift outstream/branded video: ~$2.00-$8.00.
- A CTV/OLV floor near $0.10, or 0, will not deliver - warn loudly.

CHANNEL <-> SSP FIT: CTV is usually IX or Magnite (CTV via Xandr is
rare); Magnite is CTV-heavy - a Display-only Magnite deal is worth questioning.
Deal structure: one deal per audience x SSP x channel; keep testing audiences
out of production deals; large audiences get their own deals.

WHAT EACH SSP CAN ACTUALLY CARRY AT CREATE (advice + edits must respect this -
an edit outside this table will NOT ship even if you set it on the form):
- Index Exchange: segments include+exclude (create-time only); geo country +
  zip/DMA includes (NO state, NO geo excludes at all); IAB include+exclude;
  viewability; max-ad-duration buckets. NO language.
- OpenX: geo country/state includes AND excludes; audience segments INCLUDE
  ONLY (excludes unsupported); IAB includes (excludes post-create only);
  language OK; viewability; ad-duration range (video channels only); deal
  types Preferred/PG only - Private Auction cannot be created; app-bundle
  lists are include-only.
- PubMatic: geo include+exclude; segments include+exclude; IAB
  include+exclude; viewability. NO language, NO ad duration; Banner/Video
  formats only (Native is vendor-blocked).
- Xandr: country/state include XOR exclude per dimension; segments
  include+exclude; IAB includes only; deals are always-on (no end date); NO
  list files (Curate deal lists only), NO viewability, NO language; ad
  duration is a one-sided minimum.
- Media.net: country geo only (no excludes); first-party segments include
  only; IAB include (exclude post-create); language OK; viewability min; the
  ONLY SSP with a VCR wire.
- TripleLift: country/state geo, segments include, political-ads toggle; site
  lists apply POST-create via supply-domain merge; NO IAB, NO viewability, NO
  language, NO geo excludes, NO ad duration.
- Magnite (ClearLine): country include XOR exclude; audience segments CTV/
  SpringServe ONLY (DV+ pending vendor v3.0); DV+ deals REQUIRE ad sizes;
  ad-duration range; NO IAB, NO language, NO viewability wire.
When a trader asks for something an SSP can't carry, say so plainly and offer
the alternative (the SSP that can, a post-create step, or the SSP UI).

`

// resolveChatEditModel picks the model for a chat request: the composer's
// per-request choice wins, then the OPENROUTER_CHAT_EDIT_MODEL env override,
// then the shared default (defaultChatModel in models_catalog.go — the
// picker's pinned "recommended" slug, fleet parity).
//
// There is deliberately no allow-list anymore (fleet parity): the picker
// offers the full OpenRouter catalog plus free slug entry, and spend is not
// governed by restricting model selection. The slug is forwarded verbatim to
// OpenRouter, which rejects unknown models.
func resolveChatEditModel(requested string) string {
	if m := strings.TrimSpace(requested); m != "" {
		return m
	}
	if env := strings.TrimSpace(os.Getenv("OPENROUTER_CHAT_EDIT_MODEL")); env != "" {
		return env
	}
	return defaultChatModel
}

type chatEditChange struct {
	Path        string `json:"path"`
	Description string `json:"description"`
}

// chatEditKnownSSPs is the SSP roster the builder supports. validation.RunAudit
// only checks that a deal's SSP is non-empty; it does not reject a hallucinated SSP name on its own, so
// we catch that here — an LLM rewrite that invents an SSP must not slip past.
var chatEditKnownSSPs = map[string]bool{
	"Index Exchange": true,
	"OpenX":          true,
	"PubMatic":       true,
	"Media.net":      true,
	"Xandr":          true,
	"TripleLift":     true,
	"Magnite":        true,
}

// validateChatEditForm runs the deterministic audit over an LLM-rewritten form
// and returns human-readable issues for the critical failure classes the LLM
// edit endpoints must never pass through silently: an unknown/hallucinated SSP,
// impossible flight dates, and a non-positive price floor. It reuses
// validation.RunAudit (the engine behind /api/audit) for the date + floor
// rules, filtered to those so an in-progress form is not rejected for unrelated
// header gaps (missing campaign id, deal-sheet recipient, etc.). Returns nil
// when the form is clean on those axes.
func validateChatEditForm(form map[string]any) []string {
	if form == nil {
		return nil
	}
	b, err := json.Marshal(form)
	if err != nil {
		return []string{"form could not be serialized for validation: " + err.Error()}
	}
	var req validation.AuditRequest
	if err := json.Unmarshal(b, &req); err != nil {
		return []string{"form does not match the expected deal schema: " + err.Error()}
	}
	var issues []string
	for i, d := range req.Deals {
		ssp := strings.TrimSpace(d.SSP)
		if ssp != "" && !chatEditKnownSSPs[ssp] {
			issues = append(issues, fmt.Sprintf("Deal %d: %q is not a supported SSP", i+1, ssp))
		}
	}
	// Reuse the deterministic audit for dates + floors; filter to the critical
	// rules so unrelated header incompleteness never blocks an in-flight edit.
	critical := map[string]bool{
		"date_logic":    true, // malformed / impossible flight dates
		"deal_cpm":      true, // non-positive per-deal price floor
		"ox_deal_price": true, // non-positive OpenX floor
	}
	for _, c := range validation.RunAudit(&req, "").Checks {
		if !c.Passed && critical[c.Rule] {
			issues = append(issues, c.Message)
		}
	}
	return issues
}

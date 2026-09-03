// All rights reserved. This is a private repository.

// Package validation — QA Specialist report.
//
// This file turns a finished audit (the raw CheckResults) plus the form
// payload into the structured "Deal QA Specialist" report: the
// pre-launch Deal Build QA checklist (QA Best Practices working doc) mapped
// onto what Deal Onboarding can verify. Every item carries plain-language fix
// guidance and, where possible, the exact form field to jump to.
//
// Item statuses:
//   - pass:   verified OK from the form data
//   - flag:   blocking — must be fixed before deals are created (every failed
//     CheckResult from the rule audit surfaces as exactly one flag item)
//   - warn:   best-practice deviation — the build works, but a QA specialist
//     would question it
//   - manual: the app cannot verify this (ticketing, SSP UI, client comms) — the
//     trader confirms it by hand, guided by the checklist text
//   - na:     not applicable to this brief
package validation

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const (
	QAPass   = "pass"
	QAFlag   = "flag"
	QAWarn   = "warn"
	QAManual = "manual"
	QANA     = "na"
)

type QAItem struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"`
	// Detail says what was checked and what was found.
	Detail string `json:"detail,omitempty"`
	// Fix says exactly what to do about it, in QA-best-practice terms.
	Fix       string `json:"fix,omitempty"`
	FieldPath string `json:"fieldPath,omitempty"`
	DealIndex int    `json:"dealIndex,omitempty"`
	// Rule is the originating audit rule for flag items derived from a failed
	// CheckResult; empty for checklist-native items.
	Rule string `json:"rule,omitempty"`
}

type QASection struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Items []QAItem `json:"items"`
}

type QACounts struct {
	Pass   int `json:"pass"`
	Flag   int `json:"flag"`
	Warn   int `json:"warn"`
	Manual int `json:"manual"`
	NA     int `json:"na"`
}

// QAReport is the full specialist verdict. Outcome mirrors the QA doc's
// sign-off: approved | approved_minor ("Approved with Minor Changes") |
// rework ("Returned for Rework").
type QAReport struct {
	Outcome  string      `json:"outcome"`
	Summary  string      `json:"summary"`
	Counts   QACounts    `json:"counts"`
	Sections []QASection `json:"sections"`
}

// Section ids are shared verbatim with the frontend renderer and the AI
// audit's qaSection tag — change them in all three places or not at all.
const (
	qaCampaignInfo  = "campaign_information"
	qaDealStructure = "deal_structure"
	qaNaming        = "naming_convention"
	qaTargeting     = "targeting"
	qaInventory     = "inventory_controls"
	qaSSPConfig     = "ssp_configuration"
	qaSettings      = "campaign_settings"
	qaDocs          = "documentation_readiness"
)

var qaSectionTitles = []struct{ id, title string }{
	{qaCampaignInfo, "Campaign Information"},
	{qaDealStructure, "Deal Structure"},
	{qaNaming, "Naming Convention"},
	{qaTargeting, "Targeting Validation"},
	{qaInventory, "Inventory Controls"},
	{qaSSPConfig, "SSP Configuration"},
	{qaSettings, "Campaign Settings"},
	{qaDocs, "Documentation & Deal Records"},
}

// qaRuleMeta places every audit rule in its checklist section and supplies
// the specialist's fix guidance for failures. Every rule emitted by
// rules.go MUST appear here — TestQAReport_EveryRuleMapped enforces it.
type qaRuleMeta struct {
	section string
	label   string // short checklist-style label, also used in the verified rollup
	fix     string
}

var qaRuleMap = map[string]qaRuleMeta{
	"completeness":                {qaCampaignInfo, "Required campaign fields", "Fill in the highlighted field — every deal build needs it before the audit can pass."},
	"date_logic":                  {qaCampaignInfo, "Flight dates are correct", "Adjust the flight dates: start must be today or later, end on or after start."},
	"campaign_id":                 {qaCampaignInfo, "Campaign ID format", "Use the configured campaign-id format — the campaign prefix followed by five digits (e.g. DEAL00042)."},
	"deals_required":              {qaDealStructure, "At least one deal configured", "Add at least one deal card in the Deals section."},
	"deal_theme":                  {qaDealStructure, "Audience/theme set on every deal", "Name the audience — it drives deal-name slot 7 and the deal's identity."},
	"deal_channel":                {qaDealStructure, "Channel set on every deal", "Pick the channel (Display / OLV / CTV / Native). Display and OLV are always separate deals."},
	"deal_ssp":                    {qaDealStructure, "SSP set on every deal", "Pick the SSP this deal will be created in."},
	"qa_duplicate_deals":          {qaDealStructure, "No duplicate deals", "Change or remove one of the duplicates — QA best practice is one deal per audience × SSP × channel × tactic."},
	"deal_inv":                    {qaTargeting, "Inventory type set (per-deal or default)", "Set the inventory type on the deal card."},
	"inventory_code":              {qaTargeting, "Inventory type uses the vocabulary", "Use All, Web Only, or In-App — unknown inventory values would land in the deal name off-vocabulary."},
	"channel_code":                {qaDealStructure, "Channel uses the vocabulary", "Use Display, OLV (Online Video), CTV, OTT, Native, or Audio — unknown channels would land in the deal name off-vocabulary."},
	"deal_name_charset":           {qaNaming, "Deal names free of control characters", "Remove the control/invisible character from the name override — the submit gate cannot bind such names."},
	"deal_name_length":            {qaNaming, "Deal name within SSP length limits", "Shorten the theme/agency/brand (or the name override) — Index Exchange, Xandr, and Media.net reject deal names longer than 255 characters, PubMatic longer than 250."},
	"attribution_code":            {qaNaming, "Attribution code in the vocabulary", "Use a code from the attribution vocabulary (A0–A13, B00, B1–B18, C1, C2, D00, D1, or the operator-prefixed 1–3 codes) — a mis-typed code silently breaks downstream margin extraction."},
	"attribution_slot":            {qaNaming, "Override names match the form's attribution code", "Align the name override's last slot with the form's Attribution Code (or vice versa) — margin extraction reads the booked name's slot 12, and a drifted override ships the wrong code."},
	"mg_dvplus_audience":          {qaTargeting, "Audience supported by the SSP", "Remove the segments or switch the deal to CTV — Magnite DV+ cannot carry audience segments until API v3.0."},
	"mg_audio_feed_types":         {qaSSPConfig, "Magnite Audio feed types", "Do not submit until a verified feed-type catalog and typed wire selection are available; use ClearLine manually."},
	"geo_classification":          {qaTargeting, "Geo entries classify (US state / CA province / known country)", "Fix the flagged geo entry — use a US state or Canadian province (full name or 2-letter code) for subnational geo, an ISO-2 code or known country name for countries, and split OpenX deals that mix US and Canadian subnational targeting."},
	"geo_exclude_unsupported":     {qaTargeting, "Geo exclusions supported end-to-end", "Remove the geo exclusion chip(s) from the deal card (and any default geo exclude), reshape the exclusion to a form the SSP carries, or move the deal to an exclude-emitting SSP (OpenX/PubMatic/Xandr/Magnite)."},
	"segment_exclude_unsupported": {qaTargeting, "Audience exclusions supported by the SSP", "Move the deal to an SSP that enforces audience excludes (Index Exchange / PubMatic / Xandr / Magnite CTV), apply the exclusion in the SSP UI / on the DSP line, or drop it — the current SSP cannot enforce it and a create-without would serve the excluded audience."},
	"iab_campaign_retired":        {qaTargeting, "IAB categories set per-deal", "Reload the app — the retired campaign-level IAB values fold onto the deal cards at load; review the per-deal picks and re-run the audit."},
	"deal_cpm":                    {qaSSPConfig, "Deal floor / CPM correct", "Set the floor CPM on the deal card — floor-less deals will not transact."},
	"deal_vcr":                    {qaSSPConfig, "Video KPI (VCR) set", "Video deals need a VCR target — set it per-deal or as the default VCR."},
	"seat_id":                     {qaSSPConfig, "DSP seat correct", "Add the DSP Seat ID — deals created against the wrong (or no) buyer seat are unusable."},
	"deal_fee":                    {qaSSPConfig, "Curated deal fee present", "Enter the Curated Deal Fee in the Campaign section (default: 30% of media)."},
	"ox_package":                  {qaSSPConfig, "OpenX package", "Enter an OpenX package name, or enable auto-generate."},
	"ox_deal_price":               {qaSSPConfig, "OpenX deal price (floor)", "Fix the OpenX Deal Price — it's optional, but when set it must be a positive number (blank = each deal's Floor CPM or $0.10)."},
	"ox_buyers":                   {qaSSPConfig, "OpenX buyer IDs", "Buyer IDs are optional — the MCP resolves DSP seats server-side."},
	"ox_fee":                      {qaSSPConfig, "OpenX marketplace fee override", "A fee partner is set: enter a Gross Share between 0 and 100."},
	"ox_pmp_type":                 {qaSSPConfig, "OpenX PMP deal type", "Choose PREFERRED_DEAL or PROGRAMMATIC_GUARANTEED. PRIVATE_AUCTION is not creatable via the OpenX API (cutlass#766)."},
	"pm_publishers":               {qaInventory, "PubMatic publisher controls", "Add at least one publisher name, or enable Max Reach."},
	"xn_deal_code":                {qaSSPConfig, "Xandr deal code", "Enter the Xandr Deal Code."},
	"xn_insertion_order":          {qaSSPConfig, "Xandr insertion order", "Pick the partner Insertion Order — Xandr Curate deals live as line items under an IO."},
	"mg_marketplace":              {qaSSPConfig, "Magnite marketplace", "Pick the ClearLine marketplace — it is immutable after the deal is created."},
	"mg_publishers":               {qaInventory, "Magnite publishers (ALL policy)", ""},
	"mg_floor":                    {qaSSPConfig, "Magnite price type + publisher-tab floor", "Pick a ClearLine price type (Market Rate / Market Rate with Minimum / CPM) and, for floor-bearing types, a positive floor — the default is Market Rate with Minimum at 0.10 (the floor is NOT the deal CPM; a fixed CPM price type with the deal CPM as its floor prices publishers out of the deal)."},
	"mg_ctv_price_type":           {qaSSPConfig, "Magnite CTV price type (SpringServe)", "CTV routes to SpringServe, where 'Market Rate with Minimum' is unsupported — the deal is created as Market Rate (no minimum floor); switch to CPM if a floor is required."},
	"mg_sizes":                    {qaSSPConfig, "Magnite DV+ ad formats", "Pick at least one ad format for this DV+ deal — the API rejects size-less creates."},
	"tl_price_type":               {qaSSPConfig, "TripleLift price type", "Choose CEILING, FIXED, or FLOOR."},
	"tl_channel":                  {qaSSPConfig, "TripleLift channel", "Leave on Auto, or force WEB / CTV."},
	"tl_targeting_required":       {qaSSPConfig, "TripleLift targeting expression", "Add a supported country/region/device/segment/political target; do not improvise an empty targetingExpression."},
	"mn_margin":                   {qaSSPConfig, "Media.net margin", "Set a margin value within Media.net's limits (≤50% for percentage, ≤$25 for CPM)."},
	"mn_deal_id":                  {qaSSPConfig, "Media.net deal_id uniqueness", "Differentiate the colliding Media.net deals — the deal_id derives from DSP + theme + channel + inventory + geo, and Media.net requires it unique."},
	"domain_type":                 {qaInventory, "List files typed Include/Exclude", "Mark each uploaded list as Include (allow) or Exclude (block)."},
	"list_selection":              {qaInventory, "List selection", "Remove the extra lists, or confirm the kept file is the right one — the deal prompt carries a single file per deal."},
	"openx_app_bundle_blocklist":  {qaInventory, "OpenX app-bundle list direction", "OpenX app-bundle targeting is include-only — switch the file to an allowlist, or exclude those bundles in the OpenX UI."},
	"openx_inventory_attachment":  {qaInventory, "OpenX inventory scope", "No inventory list on this OpenX deal — it runs RUN-OF-EXCHANGE across all eligible OpenX inventory (valid, trader-confirmed 2026-07-20). Attach a domain or app-bundle list only if the client wants a scoped footprint."},
	"deal_sheet_recipient":        {qaDocs, "Deal-sheet delivery configured", "Set the trader email that receives the deal sheet — a blank recipient bounces or mis-sends."},
	"network":                     {qaDocs, "Audit service reachable", "Re-run the audit — the audit service could not be reached."},
}

// BuildQAReport assembles the specialist checklist from the audit checks and
// the raw request. checks must be the exact slice RunAudit produced (the
// report guarantees every failed check appears as one flag item). namedDeals
// is the EXPANDED deal set (deals[] × active DSPs) RunAudit generated.
func BuildQAReport(req *AuditRequest, checks []CheckResult, namedDeals []NamedDeal, campaignID string) QAReport {
	items := map[string][]QAItem{}
	add := func(section string, it QAItem) {
		items[section] = append(items[section], it)
	}

	// ---- 1. Route every audit check ------------------------------------
	// Failures become flag items in their checklist section. Passing rules
	// accumulate into a per-section "verified" rollup so the specialist
	// report stays scannable. list_selection is special: it is emitted as a
	// passing advisory but describes silently-dropped files — elevate to warn.
	passedRules := map[string]map[string]bool{} // section -> rule label set
	failedRules := map[string]bool{}
	for _, c := range checks {
		if !c.Passed {
			failedRules[c.Rule] = true
		}
	}
	// One rule can emit several checks (completeness per field, per-deal rules
	// per deal) — suffix a running index so item IDs stay unique. The frontend
	// keys rows and manual-confirm state on the ID.
	ruleSeq := map[string]int{}
	checkID := func(rule string) string {
		ruleSeq[rule]++
		if ruleSeq[rule] == 1 {
			return "check_" + rule
		}
		return fmt.Sprintf("check_%s_%d", rule, ruleSeq[rule])
	}
	for _, c := range checks {
		meta, known := qaRuleMap[c.Rule]
		if !known {
			// A rule added to rules.go without a QA mapping: never hide it.
			meta = qaRuleMeta{section: qaSSPConfig, label: c.Rule, fix: "Resolve this audit failure."}
		}
		if !c.Passed {
			add(meta.section, QAItem{
				ID:        checkID(c.Rule),
				Label:     meta.label,
				Status:    QAFlag,
				Detail:    c.Message,
				Fix:       meta.fix,
				FieldPath: c.FieldPath,
				DealIndex: c.DealIndex,
				Rule:      c.Rule,
			})
			continue
		}
		if c.Rule == "list_selection" {
			add(meta.section, QAItem{
				ID:     checkID(c.Rule),
				Label:  meta.label,
				Status: QAWarn,
				Detail: c.Message,
				Fix:    meta.fix,
				Rule:   c.Rule,
			})
			continue
		}
		// Rules whose pass state is folded into a checklist-native item below;
		// keep them out of the rollup so the report doesn't say things twice.
		switch c.Rule {
		case "ox_buyers", "mg_publishers", "mg_ctv_price_type", "deal_sheet_recipient":
			continue
		}
		if failedRules[c.Rule] {
			continue // mixed rule: the failures already tell the story
		}
		if passedRules[meta.section] == nil {
			passedRules[meta.section] = map[string]bool{}
		}
		passedRules[meta.section][meta.label] = true
	}

	// ---- 2. Checklist-native evaluations --------------------------------
	deals := req.Deals

	// Campaign Information -------------------------------------------------
	if strings.TrimSpace(req.CampaignName) != "" {
		add(qaCampaignInfo, QAItem{ID: "qa_campaign_name", Label: "Campaign name follows naming convention", Status: QAPass,
			Detail: fmt.Sprintf("Campaign name: %s.", strings.TrimSpace(req.CampaignName)), FieldPath: "campaignName"})
	} else {
		add(qaCampaignInfo, QAItem{ID: "qa_campaign_name", Label: "Campaign name follows naming convention", Status: QAManual,
			Detail: "No campaign name entered — the generated deal names are the canonical reference.",
			Fix:    "If the source ticket carries a campaign name, record it here so reporting ties out.", FieldPath: "campaignName"})
	}
	if !failedRules["campaign_id"] {
		add(qaCampaignInfo, QAItem{ID: "qa_campaign_id_source", Label: "Campaign ID matches the source ticket", Status: QAManual,
			Detail: fmt.Sprintf("Campaign ID %s is well-formed.", campaignID),
			Fix:    "Confirm it matches the campaign id on the source ticket before creating.", FieldPath: "campaignId"})
	}
	add(qaCampaignInfo, QAItem{ID: "qa_opportunity_name", Label: "Opportunity name matches the brief", Status: QAManual,
		Fix: "Cross-check the opportunity name on the brief / source ticket against this campaign before creating."})
	add(qaCampaignInfo, QAItem{ID: "qa_client_agency", Label: "Client/agency details are correct", Status: QAManual,
		Detail: fmt.Sprintf("Agency %q, brand %q.", strings.TrimSpace(req.Agency), strings.TrimSpace(req.Brand)),
		Fix:    "Verify agency/brand spelling against the brief — both ride into the deal name.", FieldPath: "brand"})
	if strings.TrimSpace(req.Funnel) != "" {
		add(qaCampaignInfo, QAItem{ID: "qa_campaign_objective", Label: "Campaign objective is documented", Status: QAPass,
			Detail: fmt.Sprintf("Funnel stage: %s.", req.Funnel), FieldPath: "funnel"})
	} else {
		add(qaCampaignInfo, QAItem{ID: "qa_campaign_objective", Label: "Campaign objective is documented", Status: QAWarn,
			Detail: "No funnel stage documented.",
			Fix:    "Set the funnel stage (Awareness / Consideration / Conversion / Retention) so traders know what the campaign optimizes toward.", FieldPath: "funnel"})
	}
	if ssps := distinctSSPs(deals); len(ssps) > 0 {
		detail := "SSPs in use: " + strings.Join(ssps, ", ") + "."
		add(qaCampaignInfo, QAItem{ID: "qa_correct_ssps", Label: "Correct SSP(s) selected", Status: QAPass, Detail: detail})
	}
	addAgencyBrandItem(add, req)

	// Deal Structure --------------------------------------------------------
	if len(deals) > 0 {
		add(qaDealStructure, QAItem{ID: "qa_deal_count", Label: "Correct number of deals created", Status: QAPass,
			Detail: fmt.Sprintf("%d deal(s) across %d audience(s) × %d channel(s) × %d SSP(s). One deal per audience × SSP × channel × tactic.",
				len(deals), distinctCount(deals, func(d DealEntry) string { return d.Theme }),
				distinctCount(deals, func(d DealEntry) string { return d.Channel }),
				distinctCount(deals, func(d DealEntry) string { return d.SSP }))})
	}
	addConsolidationItems(add, deals)

	// Naming Convention -----------------------------------------------------
	addNamingItems(add, req, namedDeals)
	addSegmentVocabItem(add, req)
	// (qa_mn_display_length retired 2026-08-11 — cutlass#747 lifted Media.net's
	// 30-char display_name create guard to 255; display_name now carries the
	// full canonical deal name, gated by the hard deal_name_length check.)
	addAttributionItem(add, req)
	addCuratorItem(add, req)
	add(qaNaming, QAItem{ID: "qa_deal_ids_post", Label: "Deal IDs recorded after creation", Status: QAManual,
		Fix: "After the runner creates the deals: record each Deal ID and deal URL where your team tracks live deals (the deal-sheet email carries them)."})
	// OpenX Expected Sensitive Category is a MANUAL post-create UI step: the
	// OpenX partner API cannot set it (verified 2026-08-17 — dealCreate
	// rejects expected_ad_category, dealById never returns it; the field
	// lives only on the OpenX UI's internal API). Surface a manual checklist
	// item whenever the form declares a category and the batch has OpenX deals.
	if cat := strings.TrimSpace(req.ExpectedAdCategory); cat != "" {
		hasOpenX := false
		for _, d := range deals {
			if d.SSP == "OpenX" {
				hasOpenX = true
				break
			}
		}
		if hasOpenX {
			add(qaNaming, QAItem{ID: "qa_ox_sensitive_category", Label: fmt.Sprintf("Expected Sensitive Category %q set by hand in the OpenX UI on every OpenX deal", cat), Status: QAManual,
				Fix: fmt.Sprintf("The OpenX partner API cannot set Expected Sensitive Category — after Cutlass creates the OpenX deals, open each one in the OpenX UI and set the category to %q manually. The run summary email lists the deals that need it.", cat)})
		}
	}

	// Targeting Validation --------------------------------------------------
	addAudienceItems(add, deals)
	addSegmentExcludeItem(add, req, failedRules)
	addGeoItem(add, req)
	addDeviceItem(add, req)
	addAdDurationItem(add, req)
	addDaypartingItem(add, req)
	addContextualItem(add, req)
	addLanguageItem(add, req)

	// Inventory Controls ----------------------------------------------------
	addListItems(add, req)
	addListSspSupportItem(add, req)
	addClientBlockItem(add, req, failedRules)
	addPublisherControlsItem(add, req, checks)

	// SSP Configuration -----------------------------------------------------
	addCurationFeeItem(add, req)
	addXandrCodeItem(add, req)
	addOpenXFeeItem(add, req, failedRules)
	addIXLabelsItem(add, req, failedRules)
	addMagniteFloorItem(add, req)
	addPubMaticAdFormatMixItem(add, req)

	// Campaign Settings -----------------------------------------------------
	// Deliberately scoped to deal-creation settings Deal Onboarding carries.
	// DSP-side controls (brand safety vendors, fraud protection, frequency
	// caps, dashboards) are beyond Deal Onboarding and are NOT audited here.
	addViewabilityItem(add, req)
	addPacingItem(add, req)

	// Documentation & Deal Records -------------------------------------------
	if strings.TrimSpace(req.DealSheetRecipient) != "" {
		add(qaDocs, QAItem{ID: "qa_deal_sheet", Label: "Deal sheet delivery configured", Status: QAPass,
			Detail: fmt.Sprintf("The deal sheet will be emailed to %s after the batch completes, with each deal ID hyperlinked to the deal in the SSP.", strings.TrimSpace(req.DealSheetRecipient)), FieldPath: "dealSheetRecipient"})
	}

	// ---- 3. Assemble sections in checklist order ------------------------
	report := QAReport{}
	for _, s := range qaSectionTitles {
		sec := QASection{ID: s.id, Title: s.title}
		if labels := passedRules[s.id]; len(labels) > 0 {
			names := make([]string, 0, len(labels))
			for l := range labels {
				names = append(names, l)
			}
			sort.Strings(names)
			sec.Items = append(sec.Items, QAItem{
				ID:     "verified_" + s.id,
				Label:  "Hard validation passed",
				Status: QAPass,
				Detail: "Verified: " + strings.Join(names, " · ") + ".",
			})
		}
		// Flags first within the section, then warns, then the rest in
		// insertion order — the trader reads top-down.
		var flags, warns, rest []QAItem
		for _, it := range items[s.id] {
			switch it.Status {
			case QAFlag:
				flags = append(flags, it)
			case QAWarn:
				warns = append(warns, it)
			default:
				rest = append(rest, it)
			}
		}
		sec.Items = append(sec.Items, flags...)
		sec.Items = append(sec.Items, warns...)
		sec.Items = append(sec.Items, rest...)
		report.Sections = append(report.Sections, sec)
	}

	// ---- 4. Outcome rollup ------------------------------------------------
	for _, sec := range report.Sections {
		for _, it := range sec.Items {
			switch it.Status {
			case QAPass:
				report.Counts.Pass++
			case QAFlag:
				report.Counts.Flag++
			case QAWarn:
				report.Counts.Warn++
			case QAManual:
				report.Counts.Manual++
			case QANA:
				report.Counts.NA++
			}
		}
	}
	switch {
	case report.Counts.Flag > 0:
		report.Outcome = "rework"
		report.Summary = fmt.Sprintf("Returned for rework — %d blocking flag(s) to fix before these deals can be created.", report.Counts.Flag)
	case report.Counts.Warn > 0:
		report.Outcome = "approved_minor"
		report.Summary = fmt.Sprintf("Approved with minor changes — %d advisory item(s) worth a second look.", report.Counts.Warn)
	default:
		report.Outcome = "approved"
		report.Summary = "Approved — the build passes every check Deal Onboarding can verify."
	}
	if report.Counts.Manual > 0 {
		report.Summary += fmt.Sprintf(" %d manual confirmation(s) remain on the checklist.", report.Counts.Manual)
	}
	return report
}

// ---- checklist-native evaluators ---------------------------------------

func addConsolidationItems(add func(string, QAItem), deals []DealEntry) {
	if len(deals) == 0 {
		return
	}
	const maxSegments = 6
	var oversized []string
	firstIdx := -1
	anySegments := false
	maxSeen := 0
	for i, d := range deals {
		n := nonEmptyCount(d.IncludeSegments)
		if n > 0 {
			anySegments = true
		}
		if n > maxSeen {
			maxSeen = n
		}
		if n > maxSegments {
			oversized = append(oversized, fmt.Sprintf("Deal %d (%d segments)", i+1, n))
			if firstIdx < 0 {
				firstIdx = i
			}
		}
	}
	switch {
	case len(oversized) > 0:
		add(qaDealStructure, QAItem{ID: "qa_audience_consolidation", Label: "Audience consolidation follows best practice", Status: QAWarn,
			Detail:    "Large segment bundles: " + strings.Join(oversized, ", ") + ".",
			Fix:       "QA best practice keeps large audiences in separate deals for cleaner delivery and reporting — confirm the consolidation is intentional, or split the audience.",
			FieldPath: fmt.Sprintf("deals[%d].includeSegments", firstIdx), DealIndex: firstIdx})
	case anySegments:
		add(qaDealStructure, QAItem{ID: "qa_audience_consolidation", Label: "Audience consolidation follows best practice", Status: QAPass,
			Detail: fmt.Sprintf("Segment groupings look reasonable (largest bundle: %d segment(s) on a single deal).", maxSeen)})
	default:
		add(qaDealStructure, QAItem{ID: "qa_audience_consolidation", Label: "Audience consolidation follows best practice", Status: QAManual,
			Detail: "No audience segments entered in Deal Onboarding.",
			Fix:    "If audiences are attached in the SSP UI, follow best practice there: one deal per audience, large audiences kept separate."})
	}

	// Testing audiences: a "test" audience sharing a deal with production
	// segments pollutes delivery data — the checklist wants them isolated.
	mixed := -1
	testOnly := 0
	for i, d := range deals {
		testCount, prodCount := 0, 0
		for _, s := range d.IncludeSegments {
			if strings.TrimSpace(s) == "" {
				continue
			}
			if strings.Contains(strings.ToLower(s), "test") {
				testCount++
			} else {
				prodCount++
			}
		}
		themeIsTest := strings.Contains(strings.ToLower(d.Theme), "test")
		if (testCount > 0 || themeIsTest) && prodCount == 0 {
			testOnly++
		}
		if testCount > 0 && prodCount > 0 && mixed < 0 {
			mixed = i
		}
	}
	switch {
	case mixed >= 0:
		add(qaDealStructure, QAItem{ID: "qa_testing_audiences", Label: "Testing audiences separated correctly", Status: QAWarn,
			Detail:    fmt.Sprintf("Deal %d mixes test segments with production segments.", mixed+1),
			Fix:       "Move the test segments into their own deal so testing traffic never pollutes production delivery.",
			FieldPath: fmt.Sprintf("deals[%d].includeSegments", mixed), DealIndex: mixed})
	case testOnly > 0:
		add(qaDealStructure, QAItem{ID: "qa_testing_audiences", Label: "Testing audiences separated correctly", Status: QAPass,
			Detail: fmt.Sprintf("%d test deal(s) are isolated from production audiences.", testOnly)})
	}
}

// segmentVocabTokens are slot-2/3/8 vocabulary words that do not belong inside
// a theme: a theme carrying them almost always means a whole descriptor (an
// opportunity name, a campaign line) landed in the Audience/Theme field, so
// the booked name repeats its own SSP/DSP/channel (the DEAL07295 segment slot
// carried "… - Index - ADSP - Video - …"). Warn-only: a theme can legitimately
// contain e.g. "Video" ("Video Gamers").
var segmentVocabTokens = map[string]string{
	// SSP slot vocabulary + parse-only legacy codes.
	"index": "SSP", "openx": "SSP", "pubmatic": "SSP", "magnite": "SSP",
	"xandr": "SSP", "triplelift": "SSP", "ix": "SSP", "pm": "SSP",
	"mn": "SSP", "xn": "SSP", "tl": "SSP", "mg": "SSP",
	// DSP slot vocabulary + common DSP shorthands (ADSP = Amazon DSP).
	"ttd": "DSP", "dv360": "DSP", "amazon": "DSP", "adsp": "DSP", "yahoo": "DSP",
	// Channel slot vocabulary.
	"display": "channel", "olv": "channel", "video": "channel",
	"ctv": "channel", "ott": "channel", "native": "channel", "audio": "channel",
}

// addSegmentVocabItem warns when a deal's theme (name slot 7) contains
// SSP/DSP/channel vocabulary — the signature of an opportunity name or
// campaign descriptor pasted into the Audience/Theme field. Only themes that
// actually reach a name are scanned (deals without a full-name override).
func addSegmentVocabItem(add func(string, QAItem), req *AuditRequest) {
	var flagged []string
	firstIdx := -1
	scanned := 0
	for i, d := range req.Deals {
		if o := trimInput(d.NameOverride); o != "" {
			continue // full-name override — the theme never reaches the name
		}
		theme := strings.TrimSpace(d.Theme)
		if theme == "" {
			continue
		}
		scanned++
		var hits []string
		for _, tok := range strings.FieldsFunc(strings.ToLower(theme), func(r rune) bool {
			return !unicode.IsLetter(r) && !unicode.IsDigit(r)
		}) {
			if slot, ok := segmentVocabTokens[tok]; ok {
				hits = append(hits, fmt.Sprintf("%q (%s vocabulary)", tok, slot))
			}
		}
		if len(hits) > 0 {
			flagged = append(flagged, fmt.Sprintf("Deal %d theme %q contains %s", i+1, theme, strings.Join(hits, ", ")))
			if firstIdx < 0 {
				firstIdx = i
			}
		}
	}
	if len(flagged) > 0 {
		add(qaNaming, QAItem{ID: "qa_segment_vocab", Label: "Themes free of SSP/DSP/channel vocabulary", Status: QAWarn,
			Detail:    "The Segment slot (name slot 7) should be the audience/theme only — these themes look like whole opportunity names or campaign descriptors: " + strings.Join(flagged, "; "),
			Fix:       "Trim each theme to the audience/trigger it names (e.g. \"Rainy Days\", not \"Northwind - Rainy Days - Q3 - Index - ADSP - Video\") — the SSP, DSP, and channel already have their own name slots.",
			FieldPath: fmt.Sprintf("deals[%d].theme", firstIdx), DealIndex: firstIdx})
		return
	}
	if scanned > 0 {
		add(qaNaming, QAItem{ID: "qa_segment_vocab", Label: "Themes free of SSP/DSP/channel vocabulary", Status: QAPass,
			Detail: fmt.Sprintf("%d theme(s) carry no SSP/DSP/channel vocabulary — the Segment slot names only the audience.", scanned)})
	}
}

// addAgencyBrandItem warns when the Agency field looks like the advertiser
// (equal to the brand, or a prefix of it) — client-entered brief data
// sometimes repeats the advertiser's short name in the agency field, and it
// then rides into name slot 4 (e.g. agency "Northwind" on brand "Northwind
// Traders"; the real value was NA/direct).
func addAgencyBrandItem(add func(string, QAItem), req *AuditRequest) {
	norm := func(s string) string {
		var b strings.Builder
		for _, r := range strings.ToLower(s) {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				b.WriteRune(r)
			}
		}
		return b.String()
	}
	agency := norm(req.Agency)
	brand := norm(req.Brand)
	if agency == "" || brand == "" || strings.EqualFold(strings.TrimSpace(req.Agency), "NA") || len(agency) < 4 {
		return
	}
	if agency == brand || strings.HasPrefix(brand, agency) {
		add(qaCampaignInfo, QAItem{ID: "qa_agency_is_brand", Label: "Agency is not the advertiser repeated", Status: QAWarn,
			Detail: fmt.Sprintf("Agency %q looks like the advertiser (%q) — client-filled briefs sometimes repeat the brand in the agency field.", strings.TrimSpace(req.Agency), strings.TrimSpace(req.Brand)),
			Fix:    "Confirm the buying agency with the client. If the deal is direct (no agency), set Agency to NA — otherwise the brand rides into name slot 4 as a fake agency.", FieldPath: "agency"})
	}
}

func addNamingItems(add func(string, QAItem), req *AuditRequest, namedDeals []NamedDeal) {
	if len(req.Deals) == 0 {
		return
	}
	// The 12-slot template check runs over EVERY name — overrides AND
	// generated names. Post-sanitization a generated name always has exactly
	// 12 slots (value slots can no longer smuggle underscores), so an
	// off-template generated name means a generator bug and must surface.
	const templateSlots = 12
	var offTemplate []string
	firstIdx := -1
	for _, nd := range namedDeals {
		name := strings.TrimSpace(nd.Name)
		if name == "" {
			continue
		}
		if slots := len(strings.Split(name, "_")); slots != templateSlots {
			kind := "override"
			if !nd.Override {
				kind = "generated"
			}
			offTemplate = append(offTemplate, fmt.Sprintf("Deal %d (%d slots, %s): %s", nd.DealIndex+1, slots, kind, name))
			if firstIdx < 0 {
				firstIdx = nd.DealIndex
			}
		}
	}
	if len(offTemplate) > 0 {
		add(qaNaming, QAItem{ID: "qa_naming_template", Label: "Deal names generated using the official template", Status: QAWarn,
			Detail:    "Deal names that don't match the 12-slot template: " + strings.Join(offTemplate, "; "),
			Fix:       "Clear the override to let Deal Onboarding generate the name, or make sure the custom name follows Curator_SSP_DSP_Agency_Brand_NA_Segment_Channel_Inventory_Geo_CampaignID_Attribution.",
			FieldPath: fmt.Sprintf("deals[%d].nameOverride", firstIdx), DealIndex: firstIdx})
		return
	}
	detail := fmt.Sprintf("All %d deal name(s) follow the official naming template.", len(namedDeals))
	if len(namedDeals) > 0 {
		detail += fmt.Sprintf(" e.g. %s", namedDeals[0].Name)
	}
	add(qaNaming, QAItem{ID: "qa_naming_template", Label: "Deal names generated using the official template", Status: QAPass, Detail: detail})
}

func addAttributionItem(add func(string, QAItem), req *AuditRequest) {
	code := strings.TrimSpace(req.AttributionCode)
	switch {
	case code == "":
		add(qaNaming, QAItem{ID: "qa_attribution", Label: "Attribution code added", Status: QAWarn,
			Detail: "No attribution code — deal names will fall back to A1.",
			Fix:    "Set the attribution code (e.g. B14) if the client/campaign was assigned one.", FieldPath: "attributionCode"})
	case strings.EqualFold(code, "NA"):
		// Legacy value — 24 workbook rows carry it, so the attribution_code
		// audit rule accepts it rather than hard-failing; warn here instead.
		add(qaNaming, QAItem{ID: "qa_attribution", Label: "Attribution code added", Status: QAWarn,
			Detail: "Attribution code is the legacy \"NA\" — accepted for legacy rows, but it carries no margin family for downstream extraction.",
			Fix:    "If the client/campaign was assigned a real code (e.g. B14), replace NA with it; otherwise confirm NA is intentional.", FieldPath: "attributionCode"})
	case code == "A1":
		add(qaNaming, QAItem{ID: "qa_attribution", Label: "Attribution code added", Status: QAManual,
			Detail: "Attribution code is the default (A1).",
			Fix:    "Confirm no campaign-specific attribution code was assigned before creating.", FieldPath: "attributionCode"})
	default:
		add(qaNaming, QAItem{ID: "qa_attribution", Label: "Attribution code added", Status: QAPass,
			Detail: fmt.Sprintf("Attribution code: %s.", code), FieldPath: "attributionCode"})
	}
}

func addCuratorItem(add func(string, QAItem), req *AuditRequest) {
	dp := strings.TrimSpace(req.DataPartner)
	if dp == "" {
		add(qaNaming, QAItem{ID: "qa_curator_partner", Label: "Curator name & data partner labelled correctly", Status: QAPass,
			Detail: fmt.Sprintf("No data partner — curator slot is %s.", curatorSlot(req)), FieldPath: "dataPartner"})
		return
	}
	add(qaNaming, QAItem{ID: "qa_curator_partner", Label: "Curator name & data partner labelled correctly", Status: QAPass,
		Detail: fmt.Sprintf("Data partner %s — curator slot is %q.", dp, dataPartnerCodeFor(dp)), FieldPath: "dataPartner"})
}

func addAudienceItems(add func(string, QAItem), deals []DealEntry) {
	if len(deals) == 0 {
		return
	}
	var without []string
	firstIdx := -1
	for i, d := range deals {
		// Magnite DV+ deals must NOT carry segments (separate rule) — don't
		// also nag that they have none.
		if strings.TrimSpace(d.SSP) == "Magnite" && d.Channel != "CTV" {
			continue
		}
		if nonEmptyCount(d.IncludeSegments) == 0 {
			without = append(without, fmt.Sprintf("Deal %d", i+1))
			if firstIdx < 0 {
				firstIdx = i
			}
		}
	}
	if len(without) == 0 {
		add(qaTargeting, QAItem{ID: "qa_audience_selected", Label: "Correct audience selected on every deal", Status: QAPass,
			Detail: "Every deal carries include segments."})
	} else {
		add(qaTargeting, QAItem{ID: "qa_audience_selected", Label: "Correct audience selected on every deal", Status: QAWarn,
			Detail:    strings.Join(without, ", ") + " carry no include segments.",
			Fix:       "Segments are optional at create time, but the audience must then be attached in the SSP UI — confirm that's the plan for these deals.",
			FieldPath: fmt.Sprintf("deals[%d].includeSegments", firstIdx), DealIndex: firstIdx})
	}
	add(qaTargeting, QAItem{ID: "qa_audience_in_ssp", Label: "Audience available within SSP / IDs validated", Status: QAManual,
		Fix: "Validate the segment IDs exist in each SSP, custom audiences are uploaded, and the audience owner (client vs OTS) is confirmed."})
}

func addGeoItem(add func(string, QAItem), req *AuditRequest) {
	if len(req.Deals) == 0 {
		return
	}
	// Geo exclusions first (#219/#244): exclusions on a verified
	// per-SSP exclude wire (OpenX geographic.excludes, PubMatic excludeGeos,
	// Xandr country/region_action="exclude", Magnite geo_countries_exclude)
	// report as EMITTED; any exclusion outside that matrix warns here AND the
	// geo_exclude_unsupported audit rule blocks the batch — QA must never
	// call a NOT-emitted exclusion "configured". geoExcludeBlockReason is the
	// single shared verdict (rules.go), so the audit and this item can never
	// disagree.
	blockedIdx, blockedReason := -1, ""
	emittedExclDeals := 0
	var overridden []string
	for i, d := range req.Deals {
		if d.SheetOnly || len(effectiveGeoExclude(d, req)) == 0 {
			continue
		}
		if reason := geoExcludeBlockReason(d, req); reason != "" {
			if detail, ok := ActiveExclusionOverride(d, req); ok && len(detail.Geo) > 0 {
				overridden = append(overridden, fmt.Sprintf("Deal %d (%s: %s)", i+1, d.SSP, strings.Join(detail.Geo, ", ")))
				continue
			}
			if blockedIdx < 0 {
				blockedIdx, blockedReason = i, reason
			}
		} else {
			emittedExclDeals++
		}
	}
	if blockedIdx >= 0 {
		fieldPath := fmt.Sprintf("deals[%d].geoExclude", blockedIdx)
		if len(req.Deals[blockedIdx].GeoExclude) == 0 {
			fieldPath = "defaultGeoExclude"
		}
		add(qaTargeting, QAItem{ID: "qa_geo", Label: "Geographic targeting correct", Status: QAWarn,
			Detail:    fmt.Sprintf("Deal %d carries geo exclusion(s) NOT emitted to its SSP — %s. The deal would SERVE the excluded geo, so the audit blocks this batch (geo_exclude_unsupported).", blockedIdx+1, blockedReason),
			Fix:       "Remove the geo exclusion chip(s) on the deal card (and any default geo exclude), reshape the exclusion to a form its SSP carries, or move the deal to an exclude-emitting SSP (OpenX/PubMatic/Xandr/Magnite).",
			FieldPath: fieldPath, DealIndex: blockedIdx})
		return
	}
	if len(overridden) > 0 {
		add(qaTargeting, QAItem{ID: "qa_geo_override", Label: "Geo exclusion override acknowledged", Status: QAWarn,
			Detail: "Trader-authorized geo exclusion(s) will NOT be emitted: " + strings.Join(overridden, "; ") + ". The authenticated the runner submit records actor/time and exact stripped values.",
			Fix:    "Apply these exclusions manually in the SSP/DSP before activation, or move the deal to an SSP/shape that enforces them."})
	}
	// Include-states on an SSP with no state wire (#233.7/.8): the
	// prompt builder drops the arg behind a loud NOT-SUPPORTED marker and the
	// deal name's Geo slot no longer claims the state — QA must WARN, never
	// green-light the deal as state-targeted (the old PASS detail "Geo
	// targeting: CA" was a false green over a whole-country/global deal).
	for i, d := range req.Deals {
		if d.SheetOnly || sspCarriesIncludeStates(d.SSP) {
			continue
		}
		geos := d.GeoInclude
		if len(geos) == 0 {
			geos = req.DefaultGeoInclude
		}
		var states []string
		for _, g := range geos {
			if g.Type == "state" && trimInput(g.Value) != "" {
				states = append(states, trimInput(g.Value))
			}
		}
		if len(states) > 0 {
			add(qaTargeting, QAItem{ID: "qa_geo", Label: "Geographic targeting correct", Status: QAWarn,
				Detail: fmt.Sprintf("Deal %d requests state(s) %s but %s has no include-state wire — the states are NOT APPLIED (the prompt carries a NOT-SUPPORTED marker) and the deal serves its country-wide/global geo. The name's Geo slot no longer claims the state (#233.7/#233.8).",
					i+1, strings.Join(states, ", "), nonEmptyOr(strings.TrimSpace(d.SSP), "this SSP")),
				Fix:       "Move the deal to a state-capable SSP (OpenX/PubMatic/Xandr/Magnite/TripleLift), remove the state entries, or apply the state scoping in the SSP UI and track it as a trader follow-up.",
				FieldPath: fmt.Sprintf("deals[%d].geoInclude", i), DealIndex: i})
			return
		}
	}
	var global []string
	firstIdx := -1
	var summary []string
	for i, d := range req.Deals {
		geos := d.GeoInclude
		if len(geos) == 0 {
			geos = req.DefaultGeoInclude
		}
		// SSP-aware slot resolution (#233.8) — matches the name's Geo
		// slot, so the summary never shows a state the deal cannot target.
		if g := primaryGeoForSSP(geos, d.SSP); g == "" {
			global = append(global, fmt.Sprintf("Deal %d", i+1))
			if firstIdx < 0 {
				firstIdx = i
			}
		} else if len(summary) < 3 {
			summary = append(summary, g)
		}
	}
	if len(global) > 0 {
		// Deal-creation paths seed a US country default when no geo is given
		// (geo policy, frontend lib/geoPolicy.ts) — an empty include
		// here usually means the trader removed it, but deals predating the
		// policy or arriving through an unseeded path also land here, so the
		// text must not assert a cause. Keep the warn: global must be
		// deliberate.
		add(qaTargeting, QAItem{ID: "qa_geo", Label: "Geographic targeting correct", Status: QAWarn,
			Detail:    strings.Join(global, ", ") + " have no geo include — they will serve globally and the name's Geo slot falls back to \"Global\".",
			Fix:       "Add the country/state/ZIP/DMA the plan calls for (house policy: deals default to US when nothing is given — new deals seed it automatically), or confirm a global run is intended.",
			FieldPath: fmt.Sprintf("deals[%d].geoInclude", firstIdx), DealIndex: firstIdx})
		return
	}
	detail := "Every deal resolves a geo include."
	if len(summary) > 0 {
		detail = "Geo targeting: " + strings.Join(summary, ", ") + ". Every deal resolves a geo include."
	}
	if emittedExclDeals > 0 {
		detail += fmt.Sprintf(" %d deal(s) carry geo exclusion(s) EMITTED on their SSP's exclude wire (OpenX geographic.excludes / PubMatic excludeGeos / Xandr country-or-region_action=exclude / Magnite geo_countries_exclude — #244); verify the run summary reports them applied.", emittedExclDeals)
	}
	add(qaTargeting, QAItem{ID: "qa_geo", Label: "Geographic targeting correct", Status: QAPass, Detail: detail})
}

func addDeviceItem(add func(string, QAItem), req *AuditRequest) {
	deals := req.Deals
	if len(deals) == 0 {
		return
	}
	for i, d := range deals {
		inv := d.InventoryType
		if inv == "" {
			inv = req.DefaultInventoryType
		}
		if d.Channel == "CTV" && inv == "Web Only" {
			add(qaTargeting, QAItem{ID: "qa_device_inventory", Label: "Device / inventory targeting correct", Status: QAWarn,
				Detail:    fmt.Sprintf("Deal %d is a CTV deal restricted to Web Only inventory — CTV runs in-app on connected devices.", i+1),
				Fix:       "Switch the deal's inventory type to All or In-App.",
				FieldPath: fmt.Sprintf("deals[%d].inventoryType", i), DealIndex: i})
			return
		}
	}
	add(qaTargeting, QAItem{ID: "qa_device_inventory", Label: "Device / inventory targeting correct", Status: QAPass,
		Detail: "Inventory types are consistent with each deal's channel."})
}

// addAdDurationItem reviews per-deal ad-duration targeting (AdDurations =
// allowed creative lengths, MaxAdDurationSecs = duration cap — alternatives,
// integer SECONDS; the brief-schema ad_duration field). The constraint only
// exists on video channels (CTV/OLV/OTT — not Audio): a duration set on any
// other channel cannot be applied by any SSP and must not ride silently, so
// it warns, as do non-positive/non-integer values and a cap that contradicts
// the allowed list. Deals with no duration fields emit nothing — the field
// is an optional extra, absence is fine (unlike viewability, which has an
// default baseline and warns when missing).
func addAdDurationItem(add func(string, QAItem), req *AuditRequest) {
	configured := 0
	for i, d := range req.Deals {
		var durations []string
		for _, v := range d.AdDurations {
			if strings.TrimSpace(v) != "" {
				durations = append(durations, strings.TrimSpace(v))
			}
		}
		maxRaw := strings.TrimSpace(d.MaxAdDurationSecs)
		if len(durations) == 0 && maxRaw == "" {
			continue
		}
		configured++
		if !supportsAdDuration(d.Channel) {
			ch := d.Channel
			if strings.TrimSpace(ch) == "" {
				ch = "no channel"
			}
			field := fmt.Sprintf("deals[%d].adDurations", i)
			if len(durations) == 0 {
				field = fmt.Sprintf("deals[%d].maxAdDurationSecs", i)
			}
			add(qaTargeting, QAItem{ID: "qa_ad_duration", Label: "Ad-duration targeting correct", Status: QAWarn,
				Detail:    fmt.Sprintf("Deal %d sets ad-duration targeting on %s — ad duration only exists on video channels (CTV/OLV/OTT) and cannot be applied here.", i+1, ch),
				Fix:       "Remove the ad-duration values, or switch the deal to CTV/OLV/OTT if this is a video deal.",
				FieldPath: field, DealIndex: i})
			return
		}
		var allowed []int
		for _, v := range durations {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				add(qaTargeting, QAItem{ID: "qa_ad_duration", Label: "Ad-duration targeting correct", Status: QAWarn,
					Detail:    fmt.Sprintf("Deal %d has an invalid allowed ad duration %q — durations are positive integer seconds (e.g. 15, 30).", i+1, v),
					Fix:       "Enter each allowed creative length as a whole number of seconds.",
					FieldPath: fmt.Sprintf("deals[%d].adDurations", i), DealIndex: i})
				return
			}
			allowed = append(allowed, n)
		}
		maxSecs := 0
		if maxRaw != "" {
			n, err := strconv.Atoi(maxRaw)
			if err != nil || n <= 0 {
				add(qaTargeting, QAItem{ID: "qa_ad_duration", Label: "Ad-duration targeting correct", Status: QAWarn,
					Detail:    fmt.Sprintf("Deal %d has an invalid max ad duration %q — the cap is a positive integer number of seconds (e.g. 30).", i+1, maxRaw),
					Fix:       "Enter the maximum ad duration as a whole number of seconds.",
					FieldPath: fmt.Sprintf("deals[%d].maxAdDurationSecs", i), DealIndex: i})
				return
			}
			maxSecs = n
		}
		for _, n := range allowed {
			if maxSecs > 0 && n > maxSecs {
				add(qaTargeting, QAItem{ID: "qa_ad_duration", Label: "Ad-duration targeting correct", Status: QAWarn,
					Detail:    fmt.Sprintf("Deal %d caps ad duration at %ds but the allowed list includes a %ds creative — the cap contradicts the allowed list (they are alternative ways to express the requirement).", i+1, maxSecs, n),
					Fix:       "Keep either the allowed durations or the max cap (or raise the cap to cover every allowed length).",
					FieldPath: fmt.Sprintf("deals[%d].maxAdDurationSecs", i), DealIndex: i})
				return
			}
		}
	}
	if configured == 0 {
		return
	}
	add(qaTargeting, QAItem{ID: "qa_ad_duration", Label: "Ad-duration targeting correct", Status: QAPass,
		Detail: fmt.Sprintf("%d deal(s) carry ad-duration targeting (integer seconds) on a video channel.", configured)})
}

// addDaypartingItem makes hour-of-day schedules fail loud. No supported SSP
// create path has a verified dayparting wire, so the parser preserves the
// verbatim requirement in notes + postCreateUiFix and QA reports the manual
// action instead of letting the requirement disappear.
func addDaypartingItem(add func(string, QAItem), req *AuditRequest) {
	var deals []string
	first := -1
	for i, d := range req.Deals {
		all := append(append([]string{}, d.Notes...), d.PostCreateUIFix...)
		for _, note := range all {
			lower := strings.ToLower(strings.TrimSpace(note))
			if strings.Contains(lower, "daypart") || strings.Contains(lower, "hour-of-day") || strings.Contains(lower, "hour of day") {
				deals = append(deals, fmt.Sprintf("Deal %d (%s)", i+1, strings.TrimSpace(d.SSP)))
				if first < 0 {
					first = i
				}
				break
			}
		}
	}
	if len(deals) == 0 {
		return
	}
	add(qaTargeting, QAItem{
		ID:        "qa_dayparting",
		Label:     "Dayparting / hour-of-day targeting",
		Status:    QAWarn,
		Detail:    fmt.Sprintf("%s carry a dayparting requirement, but no supported SSP create wire has verified hour-of-day targeting. The requirement is preserved as a per-deal manual follow-up and is NOT APPLIED at create.", strings.Join(deals, ", ")),
		Fix:       "Apply the exact schedule manually in the SSP UI or on the DSP line after creation, then record completion in the final summary. Do not assume the create applied it.",
		FieldPath: fmt.Sprintf("deals[%d].postCreateUiFix", first),
		DealIndex: first,
	})
}

func addContextualItem(add func(string, QAItem), req *AuditRequest) {
	// SSP-awareness first (#226 item C): TripleLift cannot carry IAB
	// at all (tl_create_deal has no IAB path; the item-ID discovery endpoint
	// is vendor-gated — cutlass#757) and Magnite's ClearLine API has no
	// content-category surface. A deal on those SSPs whose effective IAB set
	// (explicit pick, else the opted-in inference — the retired campaign-wide
	// list never ships and fails iab_campaign_retired on its own) is non-empty
	// must WARN — the old behavior reported such IAB "configured" (PASS)
	// while the builder emitted nothing.
	var uncarried []string
	firstUncarried := -1
	for i, d := range req.Deals {
		ssp := strings.ToLower(strings.TrimSpace(d.SSP))
		if ssp != "triplelift" && ssp != "magnite" {
			continue
		}
		carries := false
		if d.IABCategories != nil {
			carries = nonEmptyCount(d.IABCategories) > 0
		} else if d.AutoInferIab && len(inferIABForDeal(d, req)) > 0 {
			carries = true
		}
		if carries {
			uncarried = append(uncarried, fmt.Sprintf("Deal %d (%s)", i+1, strings.TrimSpace(d.SSP)))
			if firstUncarried < 0 {
				firstUncarried = i
			}
		}
	}
	if len(uncarried) > 0 {
		add(qaTargeting, QAItem{ID: "qa_contextual", Label: "Contextual targeting (IAB categories, keywords)", Status: QAWarn,
			Detail:    fmt.Sprintf("%s carry IAB categories their SSP CANNOT apply — TripleLift has no IAB create path (item-ID discovery vendor-gated, cutlass#757) and Magnite's ClearLine API has no content-category surface; the prompt emits a loud NOT-SUPPORTED marker and the categories will NOT be applied (#226; this item used to report them \"configured\").", strings.Join(uncarried, ", ")),
			Fix:       "Apply contextual scoping in the SSP UI for these deals (or clear the IAB picks so nothing is claimed) — never treat TL/Magnite IAB as configured.",
			FieldPath: fmt.Sprintf("deals[%d].iabCategories", firstUncarried), DealIndex: firstUncarried})
		return
	}
	// IAB categories are per-deal now: an explicit per-deal pick (non-nil
	// IABCategories) is a trader decision; a nil one ships the deterministic
	// inference ONLY when the deal opted in (AutoInferIab — off by default,
	// in which case nothing ships). The retired campaign-level field never
	// counts — a non-empty req.IABCategories fails the iab_campaign_retired
	// check outright, so it must not simultaneously PASS this item.
	explicit := 0
	inferred := 0
	for _, d := range req.Deals {
		if d.IABCategories != nil {
			explicit++
		} else if d.AutoInferIab && len(inferIABForDeal(d, req)) > 0 {
			inferred++
		}
	}
	if explicit > 0 {
		add(qaTargeting, QAItem{ID: "qa_contextual", Label: "Contextual targeting (IAB categories, keywords)", Status: QAPass,
			Detail: fmt.Sprintf("Per-deal IAB categories set on %d deal(s). Add keywords in the SSP UI if the plan calls for them.", explicit), FieldPath: "iabCategories"})
		return
	}
	if inferred > 0 {
		add(qaTargeting, QAItem{ID: "qa_contextual", Label: "Contextual targeting (IAB categories, keywords)", Status: QAWarn,
			Detail: fmt.Sprintf("IAB categories were auto-inferred on %d deal(s) (per-deal auto-infer toggle ON) from each deal's theme/segments and the brand.", inferred),
			Fix:    "Review the inferred categories on each deal card (IAB categories section) — the inference is a starting point, not a decision.", FieldPath: "iabCategories"})
		return
	}
	add(qaTargeting, QAItem{ID: "qa_contextual", Label: "Contextual targeting (IAB categories, keywords)", Status: QAWarn,
		Detail: "No IAB categories selected — none will be applied (per-deal auto-infer is off by default).",
		Fix:    "Pick categories on each deal card (IAB categories section), or turn on the deal's 'Auto-infer IAB categories' toggle if keyword inference is wanted.", FieldPath: "iabCategories"})
}

func listNames(req *AuditRequest, inclusion string) []string {
	var names []string
	for _, f := range append(append([]UploadedFile{}, req.DomainLists...), req.AppBundleLists...) {
		if strings.EqualFold(strings.TrimSpace(f.InclusionType), inclusion) {
			names = append(names, f.Name)
		}
	}
	return names
}

func addListItems(add func(string, QAItem), req *AuditRequest) {
	if allows := listNames(req, "Include"); len(allows) > 0 {
		add(qaInventory, QAItem{ID: "qa_allow_list", Label: "Allow list attached and imported", Status: QAPass,
			Detail: "Allow list(s): " + strings.Join(allows, ", ") + ". Spot-check that the domains imported cleanly and invalid URLs were removed."})
	} else {
		add(qaInventory, QAItem{ID: "qa_allow_list", Label: "Allow list attached and imported", Status: QAManual,
			Detail: "No allow list attached.",
			Fix:    "Confirm run-of-exchange is intended for this campaign, or attach the client's premium allow list in File Uploads."})
	}

	// Block list — the house baseline. CTV/audio-only campaigns are exempt
	// (domain block lists don't apply to app inventory).
	allCTV := len(req.Deals) > 0
	for _, d := range req.Deals {
		if d.Channel != "CTV" && d.Channel != "Audio" {
			allCTV = false
			break
		}
	}
	blocks := listNames(req, "Exclude")
	switch {
	case len(blocks) > 0:
		add(qaInventory, QAItem{ID: "qa_master_block_list", Label: "Master block list applied", Status: QAPass,
			Detail: "Block list(s): " + strings.Join(blocks, ", ") + "."})
	case allCTV:
		add(qaInventory, QAItem{ID: "qa_master_block_list", Label: "Master block list applied", Status: QANA,
			Detail: "CTV/audio-only campaign — domain block lists don't apply to app inventory."})
	default:
		add(qaInventory, QAItem{ID: "qa_master_block_list", Label: "Master block list applied", Status: QAWarn,
			Detail: "No block list is applied to this campaign.",
			Fix:    "The baseline for Display/OLV/Native is your organization's master block list — toggle it on under Standard Lists in File Uploads (plus any client and SSP-specific block lists)."})
	}
}

// listSspNoEmission documents the SSPs a resolved site/app-bundle list cannot
// ride at create time (#220): per-SSP disclosure text mirroring the prompt
// builders (buildXandrPrompt's LIST NOT APPLIED comment; buildTripleLiftPrompt's
// post-create tl_merge_deal_domains instruction with the cutlass#731
// advertiser-domain caveat). Keyed by SSP name as it appears on DealEntry.SSP.
var listSspNoEmission = map[string]struct{ detail, fix string }{
	"Xandr": {
		detail: "Xandr cannot ingest a list file — deal-list targeting takes pre-existing Curate deal lists only (raw publisher_targets are platform-prohibited), so the list will be reported NOT APPLIED.",
		fix:    "Configure a Curate deal list in the Xandr UI covering this list's entries (or set Deal List Names on the Xandr panel), and expect the run summary to report the list NOT APPLIED.",
	},
	"TripleLift": {
		detail: "TripleLift applies domain lists post-create via tl_merge_deal_domains, which edits ADVERTISER-domain brand-safety only (cutlass#731) — supply-domain/site targeting is NOT APPLIED; app-bundle lists have no TripleLift dimension at all.",
		fix:    "Treat the merge as advertiser-domain brand-safety only. Supply-domain scoping needs the cutlass#731 follow-up tool; the run summary must report the supply dimension NOT APPLIED.",
	},
}

// effectiveDealListName mirrors the prompt pipeline's per-deal list pick
// (resolve() → pickPerDealOrDefault → pickPrimaryFile in dealPromptYaml.ts)
// closely enough for the QA disclosure: CTV/OTT/In-App deals draw from the
// app-bundle pool, everything else from the domain pool; a per-deal override
// wins (nil = campaign default, "" = explicitly none, "<id>" = that list);
// the campaign default picks the first Exclude file, else the first Include
// file, honoring the AppliesTo deal scoping. The pools are the audit
// request's DomainLists/AppBundleLists — ad-hoc uploads first, then the
// handler-folded standard lists (applyStandardLists), matching
// pickPrimaryFile's ad-hoc-before-standard order. A per-deal id that is not
// in the pools (a standard list picked per-deal without being batch-applied —
// the Go layer has no registry access) is reported by its id.
func effectiveDealListName(d DealEntry, req *AuditRequest) string {
	appish := d.Channel == "CTV" || d.Channel == "OTT" || d.InventoryType == "In-App"
	pool := req.DomainLists
	override := d.DomainListID
	if appish {
		pool = req.AppBundleLists
		override = d.AppBundleListID
	}
	if override != nil {
		id := strings.TrimSpace(*override)
		if id == "" {
			return ""
		}
		for _, f := range pool {
			if f.ID == id || f.ID == "list:"+id {
				return f.Name
			}
		}
		return id
	}
	liveIDs := make(map[string]bool, len(req.Deals))
	for _, dd := range req.Deals {
		liveIDs[dd.ID] = true
	}
	appliesToDeal := func(f UploadedFile) bool {
		scoped, hit := 0, false
		for _, id := range f.AppliesTo {
			if liveIDs[id] {
				scoped++
				if id == d.ID {
					hit = true
				}
			}
		}
		return scoped == 0 || hit
	}
	for _, inclusion := range []string{"Exclude", "Include"} {
		for _, f := range pool {
			if strings.EqualFold(strings.TrimSpace(f.InclusionType), inclusion) && appliesToDeal(f) {
				return f.Name
			}
		}
	}
	return ""
}

// addListSspSupportItem emits one qa_list_ssp_support QAWarn per (list, SSP)
// pair where a create deal's effective list routes to an SSP with no create-
// time list emission (#220: Xandr — no list-file ingestion; TripleLift —
// advertiser-domain-only post-create merge, cutlass#731). Without it, the QA
// report claimed the list applied (qa_master_block_list passes on ANY Exclude
// list) while Xandr/TL deals were created with zero domain/app scoping.
func addListSspSupportItem(add func(string, QAItem), req *AuditRequest) {
	type pair struct{ list, ssp string }
	counts := map[pair]int{}
	var order []pair
	for _, d := range req.Deals {
		if d.SheetOnly {
			continue
		}
		if _, gap := listSspNoEmission[d.SSP]; !gap {
			continue
		}
		name := effectiveDealListName(d, req)
		if name == "" {
			continue
		}
		p := pair{list: name, ssp: d.SSP}
		if counts[p] == 0 {
			order = append(order, p)
		}
		counts[p]++
	}
	for _, p := range order {
		disclosure := listSspNoEmission[p.ssp]
		add(qaInventory, QAItem{
			ID:     "qa_list_ssp_support",
			Label:  fmt.Sprintf("List delivery on %s", p.ssp),
			Status: QAWarn,
			Detail: fmt.Sprintf("%q routes to %d %s deal(s): %s", p.list, counts[p], p.ssp, disclosure.detail),
			Fix:    disclosure.fix,
		})
	}
}

func addClientBlockItem(add func(string, QAItem), req *AuditRequest, _ map[string]bool) {
	_ = req
	add(qaInventory, QAItem{ID: "qa_client_exclusions", Label: "Client block list / exclusions applied", Status: QAManual,
		Fix: "Apply any client-specific block list or exclusion segments before launch — check the client's IO for contractual exclusions."})
}

func addPublisherControlsItem(add func(string, QAItem), req *AuditRequest, checks []CheckResult) {
	var notes []string
	for _, c := range checks {
		if c.Rule == "mg_publishers" {
			notes = append(notes, c.Message)
		}
	}
	if containsSSP(req.Deals, "PubMatic") {
		if req.PubMaticConfig.MaxReach {
			notes = append(notes, "PubMatic: Max Reach is ON — all eligible publishers.")
		} else if n := nonEmptyCount(req.PubMaticConfig.PublisherNames); n > 0 {
			notes = append(notes, fmt.Sprintf("PubMatic: %d named publisher(s).", n))
		}
	}
	detail := strings.Join(notes, " ")
	if detail == "" {
		detail = "Publisher scoping is controlled in each SSP."
	}
	add(qaInventory, QAItem{ID: "qa_publisher_controls", Label: "Publisher controls verified (premium inventory, publisher/app IDs)", Status: QAManual,
		Detail: detail,
		Fix:    "Confirm premium inventory expectations with the client, and validate CTV publisher IDs / app IDs where applicable."})
}

func addCurationFeeItem(add func(string, QAItem), req *AuditRequest) {
	fee, feeOK := parsePositiveFloat(req.CuratedDealFee)
	feeType := strings.TrimSpace(req.FeeType)
	if feeType == "" || !feeOK {
		return // completeness / deal_fee flags already cover the gap
	}
	if strings.EqualFold(feeType, "Percentage of Media") {
		if fee == 30 {
			add(qaSSPConfig, QAItem{ID: "qa_curation_fee", Label: "Curation fee correct (30%)", Status: QAPass,
				Detail: "Curation fee is the default 30% of media.", FieldPath: "curatedDealFee"})
		} else {
			add(qaSSPConfig, QAItem{ID: "qa_curation_fee", Label: "Curation fee correct (30%)", Status: QAWarn,
				Detail: fmt.Sprintf("Curation fee is %g%% of media — the default is 30%%.", fee),
				Fix:    "Confirm the non-standard rate was approved for this client/campaign, or set the fee to 30.", FieldPath: "curatedDealFee"})
		}
		return
	}
	// Non-percent fee types are BLOCKED at audit (fee_type_wire,
	// #234.1): every SSP wire books the fee as a PERCENT margin, so a
	// Fixed-CPM/Flat-Fee value would be silently mis-booked. This item stays
	// as the human-readable explanation next to the blocking rule.
	add(qaSSPConfig, QAItem{ID: "qa_curation_fee", Label: "Curation fee correct (30%)", Status: QAWarn,
		Detail: fmt.Sprintf("Fee type is %s (%s) — non-percent fee types have NO verified SSP wire (every create emission books the fee as a PERCENT margin), so the audit blocks creates under this fee type (fee_type_wire, #234.1).", feeType, strings.TrimSpace(req.CuratedDealFee)),
		Fix:    "Switch the Fee Type to 'Percentage of Media' (and set the percent the IO calls for), or hold the batch until a verified non-percent wire ships.", FieldPath: "curatedDealFee"})
}

// addXandrCodeItem mirrors the prompt builder's Xandr deal-code derivation
// (buildXandrPrompt in dealPromptYaml.ts): a form-level dealCode with several
// Xandr creates in the batch becomes a PREFIX — <code>-<n> per expanded Xandr
// create pair, in batch order — because Xandr deal codes are unique per
// account and a bare repeated code fails the second create at the API. Warn
// with the exact derived codes so the trader sees what will land in Xandr.
func addXandrCodeItem(add func(string, QAItem), req *AuditRequest) {
	code := strings.TrimSpace(req.XandrConfig.DealCode)
	if code == "" {
		return
	}
	// Count expanded Xandr CREATE pairs, mirroring expandDealDsps: sheet-only
	// rows never create; override rows never expand across DSPs.
	dspCount := len(activeDSPs(req))
	if dspCount == 0 {
		dspCount = 1
	}
	count := 0
	for _, d := range req.Deals {
		if d.SheetOnly || !strings.EqualFold(strings.TrimSpace(d.SSP), "Xandr") {
			continue
		}
		if trimInput(d.NameOverride) != "" {
			count++
		} else {
			count += dspCount
		}
	}
	if count <= 1 {
		return
	}
	codes := make([]string, count)
	for i := range codes {
		codes[i] = fmt.Sprintf("%s-%d", code, i+1)
	}
	add(qaSSPConfig, QAItem{ID: "qa_xn_deal_codes", Label: "Xandr deal codes derived per deal", Status: QAWarn,
		Detail:    fmt.Sprintf("Xandr deal codes must be unique per account, and this batch creates %d Xandr deals — the form's deal code %q is applied as a prefix: %s.", count, code, strings.Join(codes, ", ")),
		Fix:       "Confirm the derived codes are acceptable, or clear the Xandr Deal Code so each deal uses its (unique) deal name as the code.",
		FieldPath: "xandrConfig.dealCode"})
}

// addPubMaticAdFormatMixItem warns when the PubMatic ad-format picks put Video
// on the same deal as Banner and/or Native.
//
// PubMatic ACCEPTS the combination and the deal serves, so this is advisory —
// never a blocking rule. But per PubMatic's own documentation and its Auction
// Package "Environment" step (confirmed 2026-08-28), pairing Banner and/or
// Native with Video makes DETAILED VIDEO TARGETING UNAVAILABLE, which is why
// buyers are advised to create separate deals per format. The form's Ad Formats
// control is a free multi-select, so a trader can tick Video + Banner and ship a
// deal that looks correct everywhere and has quietly lost its video controls.
//
// Scoped to an EXPLICIT multi-select. An empty pubmaticConfig.adFormats is the
// auto-derive default (one format per channel), which can never mix.
func addPubMaticAdFormatMixItem(add func(string, QAItem), req *AuditRequest) {
	if !containsSSP(req.Deals, "PubMatic") {
		return
	}
	var video bool
	var degrading []string
	for _, f := range req.PubMaticConfig.AdFormats {
		switch strings.TrimSpace(f) {
		case "Video (13)", "Video (12)": // (12) is the legacy persisted alias for Video
			video = true
		case "Banner (3)":
			degrading = append(degrading, "Banner")
		case "Native (12)":
			degrading = append(degrading, "Native")
		}
	}
	if !video || len(degrading) == 0 {
		return
	}
	add(qaSSPConfig, QAItem{ID: "qa_pm_ad_format_mix", Label: "PubMatic video targeting intact", Status: QAWarn,
		Detail:    fmt.Sprintf("PubMatic Ad Formats pair Video with %s on the same deal. PubMatic accepts this, but combining Banner and/or Native with Video makes detailed video targeting unavailable — the deal serves with its video controls silently inactive.", strings.Join(degrading, " and ")),
		Fix:       "Split into one Video deal and one Banner/Native deal (PubMatic's own guidance), or leave Ad Formats empty to auto-derive one format per channel. Ignore this if the video targeting does not matter for this campaign.",
		FieldPath: "pubmaticConfig.adFormats"})
}

func addOpenXFeeItem(add func(string, QAItem), req *AuditRequest, failedRules map[string]bool) {
	if !containsSSP(req.Deals, "OpenX") {
		return
	}
	if failedRules["ox_fee"] {
		return // the ox_fee flag already tells the story — don't contradict it
	}
	ox := req.OpenXConfig
	if strings.TrimSpace(ox.FeePartner) != "" {
		add(qaSSPConfig, QAItem{ID: "qa_ox_fee_override", Label: "Marketplace fee overridden (OpenX)", Status: QAPass,
			Detail: fmt.Sprintf("Fee partner %s with %s%% gross share.", strings.TrimSpace(ox.FeePartner), strings.TrimSpace(ox.GrossShare)), FieldPath: "openxConfig.grossShare"})
		return
	}
	add(qaSSPConfig, QAItem{ID: "qa_ox_fee_override", Label: "Marketplace fee overridden (OpenX)", Status: QAManual,
		Detail: "No OpenX fee partner set.",
		Fix:    "Confirm whether this campaign needs the OpenX marketplace fee overridden (fee partner + gross share); leave unset only if the default fee applies."})
}

func addIXLabelsItem(add func(string, QAItem), req *AuditRequest, failedRules map[string]bool) {
	if !containsSSP(req.Deals, "Index Exchange") {
		return
	}
	sales := strings.TrimSpace(req.ReportingLabels.Salesperson)
	detail := fmt.Sprintf("advertiser=%q, agency=%q", strings.TrimSpace(req.Brand), strings.TrimSpace(req.Agency))
	if sales != "" {
		detail += fmt.Sprintf(", salesperson=%q", sales)
		add(qaSSPConfig, QAItem{ID: "qa_ix_labels", Label: "Index reporting labels completed", Status: QAPass,
			Detail: "IX reporting labels: " + detail + ".", FieldPath: "reportingLabels.salesperson"})
		return
	}
	add(qaSSPConfig, QAItem{ID: "qa_ix_labels", Label: "Index reporting labels completed", Status: QAManual,
		Detail: "IX reporting labels: " + detail + ", salesperson not set.",
		Fix:    "Add the salesperson (and any other labels the client requires) so IX reporting ties out.", FieldPath: "reportingLabels.salesperson"})
}

// languageEmittingSSPs — the ONLY two SSPs with a create-time language wire
// (verified against the MCP signatures, #226): OpenX
// targeting.languages → technographic.language, and Media.net
// device_languages. Every other SSP (including PubMatic — whose old
// qa_pm_language item reported "Language targeting is set" PASS while NO
// builder emitted language anywhere: a false green) gets a loud
// NOT-SUPPORTED marker from its builder and a warn here.
var languageEmittingSSPs = map[string]bool{
	"openx":     true,
	"media.net": true,
}

func addLanguageItem(add func(string, QAItem), req *AuditRequest) {
	defaultLang := strings.TrimSpace(req.DefaultLanguage)
	var emitted, uncarried []string
	firstUncarried := -1
	uncarriedField := ""
	for i, d := range req.Deals {
		lang := strings.TrimSpace(d.Language)
		field := fmt.Sprintf("deals[%d].language", i)
		if lang == "" {
			lang = defaultLang
			field = "defaultLanguage"
		}
		if lang == "" {
			continue
		}
		ssp := strings.ToLower(strings.TrimSpace(d.SSP))
		label := fmt.Sprintf("Deal %d (%s)", i+1, nonEmptyOr(strings.TrimSpace(d.SSP), "no SSP"))
		if languageEmittingSSPs[ssp] {
			emitted = append(emitted, label)
		} else {
			uncarried = append(uncarried, label)
			if firstUncarried < 0 {
				firstUncarried = i
				uncarriedField = field
			}
		}
	}
	if len(emitted)+len(uncarried) == 0 {
		if containsSSP(req.Deals, "PubMatic") {
			// The old PM-specific nudge, made truthful: Deal Onboarding cannot set
			// PubMatic language at all — it is a UI-only control.
			add(qaTargeting, QAItem{ID: "qa_language", Label: "Language targeting carried by the SSP", Status: QAManual,
				Detail: "No language set (default or per-deal). PubMatic language targeting is UI-only — it has NO API wire, so Deal Onboarding could not send it even if set (the old qa_pm_language item claimed otherwise; #226).",
				Fix:    "If the plan calls for language targeting on the PubMatic deal(s), configure it in the PubMatic UI post-create (and note only OpenX and Media.net carry language at create time)."})
		}
		return
	}
	if len(uncarried) > 0 {
		add(qaTargeting, QAItem{ID: "qa_language", Label: "Language targeting carried by the SSP", Status: QAWarn,
			Detail:    fmt.Sprintf("%s set a language their SSP CANNOT carry — only OpenX (targeting.languages) and Media.net (device_languages) have a create-time language wire; IX/PubMatic/Xandr/TripleLift/Magnite have none, so the prompt emits a loud NOT-SUPPORTED marker and NOTHING ships (#226; the old qa_pm_language \"Language targeting is set\" PASS was a false green).", strings.Join(uncarried, ", ")),
			Fix:       "Apply the language in the SSP UI or on the DSP line for these deals and treat it as NOT APPLIED at create — or move the deal to OpenX/Media.net.",
			FieldPath: uncarriedField, DealIndex: firstUncarried})
		return
	}
	add(qaTargeting, QAItem{ID: "qa_language", Label: "Language targeting carried by the SSP", Status: QAPass,
		Detail: fmt.Sprintf("Language targeting is set and EMITTED on the wire for %s (OpenX targeting.languages → technographic.language; Media.net device_languages).", strings.Join(emitted, ", "))})
}

// addSegmentExcludeItem — audience segment EXCLUSIONS per SSP (#226
// F2). Emitting SSPs (IX/PubMatic/Xandr excluded_segment_names; Magnite CTV
// audience_segments_block) carry the exclusion on the create wire → PASS
// naming them. Deals on an SSP that CANNOT enforce the exclusion (OpenX
// confirmed; Media.net/TripleLift/Magnite-DV+ vendor-unconfirmed → treated as
// unsupported) are fail-closed BLOCKED by the segment_exclude_unsupported
// audit rule — the failed check surfaces as a flag, so this checklist-native
// item DEFERS to it (never double-reports, never softens the block to a warn).
// audienceExcludeBlockReason is the shared verdict, so item and rule agree.
func addSegmentExcludeItem(add func(string, QAItem), req *AuditRequest, failedRules map[string]bool) {
	if failedRules["segment_exclude_unsupported"] {
		// The blocking flag(s) already tell the per-deal story — don't add a
		// softer duplicate.
		return
	}
	var emitted []string
	var overridden []string
	for i, d := range req.Deals {
		if d.SheetOnly {
			continue
		}
		trader := effectiveAudienceExcludes(d)
		if len(trader) == 0 {
			continue
		}
		if detail, ok := ActiveExclusionOverride(d, req); ok && len(detail.Audience) > 0 {
			overridden = append(overridden, fmt.Sprintf("Deal %d (%s: %s)", i+1, d.SSP, strings.Join(detail.Audience, ", ")))
			continue
		}
		// The rule passed, so every exclusion-carrying deal is on a supported
		// SSP (else segment_exclude_unsupported would have failed).
		emitted = append(emitted, fmt.Sprintf("Deal %d (%s)", i+1, nonEmptyOr(strings.TrimSpace(d.SSP), "no SSP")))
	}
	if len(emitted) == 0 {
		if len(overridden) == 0 {
			return
		}
	} else {
		add(qaTargeting, QAItem{ID: "qa_segment_excludes", Label: "Audience exclusions carried by the SSP", Status: QAPass,
			Detail: fmt.Sprintf("Audience segment exclusion(s) EMITTED on the create wire for %s (IX/PubMatic/Xandr excluded_segment_names; Magnite CTV audience_segments_block — #226).", strings.Join(emitted, ", "))})
	}
	if len(overridden) > 0 {
		add(qaTargeting, QAItem{ID: "qa_segment_exclude_override", Label: "Audience exclusion override acknowledged", Status: QAWarn,
			Detail: "Trader-authorized audience exclusion(s) will NOT be emitted: " + strings.Join(overridden, "; ") + ". Client contractual exclusions can never use this path.",
			Fix:    "Apply these exclusions manually in the SSP/DSP before activation, or move the deal to an SSP that enforces them."})
	}
}

// addMagniteFloorItem reviews the Magnite pricing setup. A batch created as
// the CPM price type with the deal CPM as the floor prices publishers out of
// the deal — it should be Market Rate. The default is
// "Market Rate with Minimum" at the $0.10 publisher-tab floor: the CPM price
// type gets a standing warn, and any floor above $1 warns too. MRwM on a CTV
// deal warns separately: SpringServe rejects MRwM, so the prompt downgrades
// those deals to Market Rate (issue #228) — the trader must know the minimum
// floor does not apply there.
func addMagniteFloorItem(add func(string, QAItem), req *AuditRequest) {
	if !containsSSP(req.Deals, "Magnite") {
		return
	}
	priceType := strings.TrimSpace(req.MagniteConfig.PriceType)
	if priceType == "" {
		priceType = "Market Rate with Minimum"
	}
	if priceType == "Market Rate with Minimum" {
		ctvCount := 0
		for _, d := range req.Deals {
			if !d.SheetOnly && strings.TrimSpace(d.SSP) == "Magnite" && d.Channel == "CTV" {
				ctvCount++
			}
		}
		if ctvCount > 0 {
			add(qaSSPConfig, QAItem{ID: "qa_mg_ctv_price_type", Label: "Magnite CTV price type is SpringServe-valid", Status: QAWarn,
				Detail: fmt.Sprintf("%d Magnite CTV deal(s) route to SpringServe, where 'Market Rate with Minimum' is not supported — they are created as Market Rate (NO minimum floor).", ctvCount),
				Fix:    "Accept the Market Rate downgrade for CTV, or switch the Magnite Price Type to CPM if the client requires a floor on CTV.", FieldPath: "magniteConfig.priceType"})
		}
	}
	if priceType == "Market Rate" {
		add(qaSSPConfig, QAItem{ID: "qa_mg_floor", Label: "Magnite pricing at the default", Status: QAPass,
			Detail: "Price type is Market Rate (no publisher-tab floor).", FieldPath: "magniteConfig.priceType"})
		return
	}
	raw := strings.TrimSpace(req.MagniteConfig.FloorCPM)
	floorLabel := "$0.10 (default)"
	v := 0.1
	if raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || parsed <= 0 {
			return // the mg_floor audit rule already flags invalid values
		}
		v = parsed
		floorLabel = "$" + raw
	}
	if priceType == "CPM" {
		add(qaSSPConfig, QAItem{ID: "qa_mg_floor", Label: "Magnite pricing at the default", Status: QAWarn,
			Detail: fmt.Sprintf("Price type is CPM (fixed floor %s) — a fixed CPM floor at the deal CPM prices publishers out; the default is Market Rate with Minimum at $0.10.", floorLabel),
			Fix:    "Switch the Magnite Price Type to Market Rate with Minimum (or Market Rate) unless the client explicitly asked for a fixed CPM floor.", FieldPath: "magniteConfig.priceType"})
		return
	}
	if v > 1.0 {
		add(qaSSPConfig, QAItem{ID: "qa_mg_floor", Label: "Magnite pricing at the default", Status: QAWarn,
			Detail: fmt.Sprintf("Minimum floor is %s — floors above $1 exclude publisher inventory (the floor is NOT the deal CPM; margin rides on rev-share).", floorLabel),
			Fix:    "Set the Magnite minimum floor back to 0.10 unless the client explicitly asked for a higher floor.", FieldPath: "magniteConfig.floorCpm"})
		return
	}
	add(qaSSPConfig, QAItem{ID: "qa_mg_floor", Label: "Magnite pricing at the default", Status: QAPass,
		Detail: fmt.Sprintf("Market Rate with Minimum at %s.", floorLabel), FieldPath: "magniteConfig.floorCpm"})
}

// viewabilityEmittingSSPs — SSPs whose create prompts emit a REAL viewability
// arg (IX/OpenX/PubMatic viewability_threshold; Media.net viewability_min),
// verified against the MCP signatures (#226). Magnite DV+ delivers
// via a MANUAL raw-targeting instruction; Xandr, TripleLift, and Magnite CTV
// (SpringServe) have no viewability wire at all — the builders emit loud
// NOT-SUPPORTED markers and this item warns instead of the old false-green
// PASS ("configured" while nothing shipped).
var viewabilityEmittingSSPs = map[string]bool{
	"index exchange": true,
	"openx":          true,
	"pubmatic":       true,
	"media.net":      true,
}

func addViewabilityItem(add func(string, QAItem), req *AuditRequest) {
	// Viewability is a per-deal target (deal card → Optional extras) applied
	// ONLY when explicitly specified — there is no campaign-level default and
	// the prompt emits nothing when a deal's target is blank. Only per-deal
	// values count as configured: hidden campaign/account-level fields
	// (DefaultViewabilityTarget, the old IX threshold) once masked a leaked
	// template default here, so they no longer register.
	var emitted, manual, uncarried []string
	firstUncarried, firstManual := -1, -1
	for i, d := range req.Deals {
		if strings.TrimSpace(d.ViewabilityTarget) == "" {
			continue
		}
		ssp := strings.ToLower(strings.TrimSpace(d.SSP))
		label := fmt.Sprintf("Deal %d (%s)", i+1, nonEmptyOr(strings.TrimSpace(d.SSP), "no SSP"))
		switch {
		case viewabilityEmittingSSPs[ssp]:
			emitted = append(emitted, label)
		case ssp == "magnite" && d.Channel != "CTV":
			manual = append(manual, label)
			if firstManual < 0 {
				firstManual = i
			}
		default:
			// Xandr / TripleLift / Magnite CTV (SpringServe) / unset SSP —
			// no viewability wire (#226).
			uncarried = append(uncarried, label)
			if firstUncarried < 0 {
				firstUncarried = i
			}
		}
	}
	if len(emitted)+len(manual)+len(uncarried) == 0 {
		// Absence is the intended state unless the plan calls for a threshold —
		// report it plainly rather than warning (and never prescribe a baseline).
		add(qaSettings, QAItem{ID: "qa_viewability", Label: "Viewability threshold set", Status: QAPass,
			Detail: "No viewability target on any deal — none is sent to the SSPs. Set one per deal in Optional extras only if the plan specifies it, or manage it on the DSP line items."})
		return
	}
	if len(uncarried) > 0 {
		add(qaSettings, QAItem{ID: "qa_viewability", Label: "Viewability threshold set", Status: QAWarn,
			Detail:    fmt.Sprintf("%s set a viewability target their SSP CANNOT carry — Xandr, TripleLift, and Magnite CTV (SpringServe) have no deal-level viewability wire, so the prompt emits a loud NOT-SUPPORTED marker and NOTHING ships (#226; this item used to report PASS \"configured\" here — a false green).", strings.Join(uncarried, ", ")),
			Fix:       "Manage viewability on the DSP line for these deals (or move them to IX/OpenX/PubMatic/Media.net, which emit it on the wire), and treat the target as NOT APPLIED at the SSP.",
			FieldPath: fmt.Sprintf("deals[%d].viewabilityTarget", firstUncarried), DealIndex: firstUncarried})
		return
	}
	if len(manual) > 0 {
		detail := fmt.Sprintf("%s route to Magnite DV+, where viewability is a MANUAL raw-targeting step the prompt instructs (deciles 0–90) — confirm the run summary shows it applied.", strings.Join(manual, ", "))
		if len(emitted) > 0 {
			detail += fmt.Sprintf(" A per-deal viewability threshold is configured and emitted on the wire for %s.", strings.Join(emitted, ", "))
		}
		add(qaSettings, QAItem{ID: "qa_viewability", Label: "Viewability threshold set", Status: QAManual,
			Detail:    detail,
			Fix:       "After the run, verify the Magnite DV+ raw-targeting viewability component was applied (the final summary must report it) — it is not a create arg.",
			FieldPath: fmt.Sprintf("deals[%d].viewabilityTarget", firstManual), DealIndex: firstManual})
		return
	}
	add(qaSettings, QAItem{ID: "qa_viewability", Label: "Viewability threshold set", Status: QAPass,
		Detail: fmt.Sprintf("A per-deal viewability threshold is configured and EMITTED on the wire for %s (IX/OpenX/PubMatic viewability_threshold; Media.net viewability_min).", strings.Join(emitted, ", "))})
}

func addPacingItem(add func(string, QAItem), req *AuditRequest) {
	pacing := strings.TrimSpace(req.DailyPacingGoal)
	kpi := strings.TrimSpace(req.KPIGoal)
	if pacing == "" && kpi == "" {
		add(qaSettings, QAItem{ID: "qa_pacing_kpi", Label: "Pacing & KPI goals documented", Status: QAWarn,
			Detail: "No daily pacing goal or KPI goal documented.",
			Fix:    "Record the pacing and KPI goals so traders can manage delivery against the plan.", FieldPath: "dailyPacingGoal"})
		return
	}
	parts := []string{}
	if pacing != "" {
		parts = append(parts, "pacing: "+pacing)
	}
	if kpi != "" {
		parts = append(parts, "KPI: "+kpi)
	}
	add(qaSettings, QAItem{ID: "qa_pacing_kpi", Label: "Pacing & KPI goals documented", Status: QAPass,
		Detail: "Documented — " + strings.Join(parts, "; ") + ".", FieldPath: "dailyPacingGoal"})
}

// ---- small helpers ------------------------------------------------------

func distinctSSPs(deals []DealEntry) []string {
	seen := map[string]bool{}
	var out []string
	for _, d := range deals {
		s := strings.TrimSpace(d.SSP)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func distinctCount(deals []DealEntry, key func(DealEntry) string) int {
	seen := map[string]bool{}
	for _, d := range deals {
		if k := strings.ToLower(strings.TrimSpace(key(d))); k != "" {
			seen[k] = true
		}
	}
	return len(seen)
}

func nonEmptyCount(ss []string) int {
	n := 0
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			n++
		}
	}
	return n
}

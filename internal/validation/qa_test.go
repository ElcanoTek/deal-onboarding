// All rights reserved. This is a private repository.

package validation

import (
	"strings"
	"testing"
)

// allEmittedRules is every rule name RunAudit can emit. Keep in sync with
// rules.go (and the frontend's RULE_TO_SECTION_ID) — the QA report must be
// able to place every one of them in a checklist section.
var allEmittedRules = []string{
	"completeness", "date_logic", "deal_fee", "deals_required",
	"deal_theme", "deal_channel", "deal_ssp", "deal_inv", "deal_cpm", "deal_vcr",
	"seat_id",
	"ox_package", "ox_deal_price", "ox_buyers", "ox_fee", "ox_pmp_type",
	"pm_publishers", "xn_deal_code", "xn_insertion_order",
	"mg_marketplace", "mg_publishers", "mg_floor", "mg_ctv_price_type", "mg_sizes", "mg_dvplus_audience",
	"mg_audio_feed_types", "tl_price_type", "tl_channel", "tl_targeting_required", "mn_margin", "mn_deal_id",
	"domain_type", "deal_sheet_recipient", "openx_app_bundle_blocklist", "openx_inventory_attachment",
	"campaign_id", "list_selection", "qa_duplicate_deals",
	"attribution_code", "deal_name_length",
	"geo_exclude_unsupported", "iab_campaign_retired",
}

func TestQAReport_EveryRuleMapped(t *testing.T) {
	for _, rule := range allEmittedRules {
		if _, ok := qaRuleMap[rule]; !ok {
			t.Errorf("rule %q emitted by rules.go has no qaRuleMap entry — its failures would land in the catch-all section", rule)
		}
	}
}

func qaItem(report QAReport, id string) (QAItem, bool) {
	for _, s := range report.Sections {
		for _, it := range s.Items {
			if it.ID == id {
				return it, true
			}
		}
	}
	return QAItem{}, false
}

func qaItemSection(report QAReport, id string) string {
	for _, s := range report.Sections {
		for _, it := range s.Items {
			if it.ID == id {
				return s.ID
			}
		}
	}
	return ""
}

func TestQAReport_HappyPathNoFlags(t *testing.T) {
	req := baseValidRequest()
	resp := RunAudit(&req, "DEAL00145")
	if resp.Status != "passed" {
		t.Fatalf("expected audit to pass, got %s: %+v", resp.Status, resp.Checks)
	}
	if resp.QA.Counts.Flag != 0 {
		t.Fatalf("passed audit must yield zero QA flags, got %d: %+v", resp.QA.Counts.Flag, resp.QA)
	}
	if resp.QA.Outcome == "rework" {
		t.Fatalf("passed audit must not be returned for rework: %s", resp.QA.Summary)
	}
	if len(resp.QA.Sections) != len(qaSectionTitles) {
		t.Fatalf("expected %d sections, got %d", len(qaSectionTitles), len(resp.QA.Sections))
	}
	// The opportunity-name cross-check is always a manual item — there is no
	// server-side source of truth for it.
	if it, ok := qaItem(resp.QA, "qa_opportunity_name"); !ok || it.Status != QAManual {
		t.Errorf("expected qa_opportunity_name manual item, got %+v", it)
	}
	// The manual checklist lines are present to guide the trader.
	for _, id := range []string{"qa_deal_ids_post"} {
		if _, ok := qaItem(resp.QA, id); !ok {
			t.Errorf("expected manual checklist item %s", id)
		}
	}
	// Beyond-Deal Onboarding items (client sign-off, dashboards, DSP-side controls)
	// must NOT appear — the checklist is scoped to deal creation.
	for _, id := range []string{"qa_client_readiness", "qa_launch_ops", "qa_brand_safety", "qa_frequency_caps"} {
		if _, ok := qaItem(resp.QA, id); ok {
			t.Errorf("item %s is beyond Deal Onboarding's scope and should not be emitted", id)
		}
	}
}

func TestQAReport_DaypartingIsManualFollowUp(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].Notes = []string{"Weekdays 6-10am local time"}
	req.Deals[0].PostCreateUIFix = []string{"Dayparting NOT APPLIED at create — manually apply: Weekdays 6-10am local time"}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_dayparting")
	if !ok || it.Status != QAWarn {
		t.Fatalf("dayparting must produce a QA warning, got %+v", it)
	}
	if !strings.Contains(it.Detail, "NOT APPLIED") || !strings.Contains(it.Fix, "manually") {
		t.Fatalf("dayparting warning must state the manual outcome: %+v", it)
	}
}

// Every failed check must surface as exactly one flag item — the invariant
// that lets the UI drop the flat check list without hiding a blocker.
func TestQAReport_EveryFailedCheckBecomesAFlag(t *testing.T) {
	req := baseValidRequest()
	req.Agency = ""
	req.FlightEndDate = "2098-01-01" // before start
	req.DSPs[0].SeatID = ""
	req.Deals[0].CPM = ""
	req.Deals = append(req.Deals, DealEntry{ID: "d2", Theme: "", Channel: "", SSP: "OpenX"})
	resp := RunAudit(&req, "DEAL00145")
	if resp.Status != "failed" {
		t.Fatalf("expected failed audit")
	}
	failed := 0
	for _, c := range resp.Checks {
		if !c.Passed {
			failed++
		}
	}
	if failed == 0 {
		t.Fatalf("fixture should produce failures")
	}
	if resp.QA.Counts.Flag != failed {
		t.Fatalf("expected %d QA flags (one per failed check), got %d", failed, resp.QA.Counts.Flag)
	}
	if resp.QA.Outcome != "rework" {
		t.Fatalf("flags must return the build for rework, got %q", resp.QA.Outcome)
	}
	// Flag items keep the jump target and gain fix guidance.
	for _, s := range resp.QA.Sections {
		for _, it := range s.Items {
			if it.Status == QAFlag && it.Fix == "" {
				t.Errorf("flag item %s (%s) has no fix guidance", it.ID, it.Detail)
			}
		}
	}
}

// qa_contextual must not PASS off the retired campaign-level IAB field — a
// stale list fails the iab_campaign_retired check outright, and the QA line
// describes only per-deal picks/inference.
func TestQAContextual_IgnoresRetiredCampaignField(t *testing.T) {
	req := baseValidRequest()
	req.IABCategories = []string{"Auto Parts", "Car Culture"}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_contextual")
	if !ok {
		t.Fatalf("expected a qa_contextual item")
	}
	if it.Status == QAPass {
		t.Fatalf("qa_contextual must not PASS off the retired campaign-level field, got %+v", it)
	}
	if strings.Contains(it.Detail, "Auto Parts") {
		t.Fatalf("retired campaign values must not surface as targeting detail, got %q", it.Detail)
	}

	// Explicit per-deal picks still pass, campaign field or not.
	req.Deals[0].IABCategories = []string{"News"}
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_contextual"); it.Status != QAPass || !strings.Contains(it.Detail, "1 deal") {
		t.Fatalf("explicit per-deal picks should PASS qa_contextual, got %+v", it)
	}
}

func TestDuplicateDeals_Flagged(t *testing.T) {
	req := baseValidRequest()
	dup := req.Deals[0]
	dup.ID = "d2"
	req.Deals = append(req.Deals, dup)
	resp := RunAudit(&req, "DEAL00145")
	c, ok := ruleResult(resp.Checks, "qa_duplicate_deals")
	if !ok || c.Passed {
		t.Fatalf("expected qa_duplicate_deals failure, got %+v", c)
	}
	if resp.Status != "failed" {
		t.Fatalf("duplicate deals must fail the audit, got %s", resp.Status)
	}
	if !strings.Contains(c.Message, "Deal 2 duplicates Deal 1") {
		t.Errorf("message should name both deals: %q", c.Message)
	}
	if c.FieldPath != "deals[1].theme" {
		t.Errorf("expected fieldPath deals[1].theme, got %q", c.FieldPath)
	}
	if resp.QA.Outcome != "rework" {
		t.Errorf("duplicates must return the build for rework")
	}
}

func TestDuplicateDeals_UniqueNamesPass(t *testing.T) {
	req := baseValidRequest()
	second := req.Deals[0]
	second.ID = "d2"
	second.NameOverride = ""
	second.Theme = "Snow"
	second.ExcludeSegments = []string{"Weather Block List"}
	req.Deals = append(req.Deals, second)
	resp := RunAudit(&req, "DEAL00145")
	c, ok := ruleResult(resp.Checks, "qa_duplicate_deals")
	if !ok || !c.Passed {
		t.Fatalf("expected qa_duplicate_deals pass, got %+v", c)
	}
}

func TestQACurationFee_Standard30Passes(t *testing.T) {
	req := baseValidRequest()
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_curation_fee")
	if !ok || it.Status != QAPass {
		t.Fatalf("expected 30%% of media to pass, got %+v", it)
	}
	if qaItemSection(resp.QA, "qa_curation_fee") != qaSSPConfig {
		t.Errorf("curation fee belongs to the SSP configuration section")
	}
}

func TestQACurationFee_NonStandardWarns(t *testing.T) {
	req := baseValidRequest()
	req.CuratedDealFee = "15"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_curation_fee")
	if !ok || it.Status != QAWarn {
		t.Fatalf("expected non-standard fee to warn, got %+v", it)
	}
	if !strings.Contains(it.Detail, "15%") {
		t.Errorf("warn should state the actual rate: %q", it.Detail)
	}
	if resp.QA.Outcome != "approved_minor" {
		t.Errorf("warns without flags = approved with minor changes, got %q (%s)", resp.QA.Outcome, resp.QA.Summary)
	}
}

// Expected Sensitive Category is a MANUAL post-create OpenX UI step (the
// partner API cannot set it — verified 2026-08-17), so a set category on a
// batch with OpenX deals must surface a manual checklist item; a batch with
// no OpenX deals (or no category) must not.
func TestQAOxSensitiveCategory_ManualItemForOpenXBatches(t *testing.T) {
	req := baseValidRequest()
	req.ExpectedAdCategory = "Politics"
	req.Deals[0].SSP = "OpenX"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_ox_sensitive_category")
	if !ok || it.Status != QAManual {
		t.Fatalf("OpenX batch with a sensitive category should carry the manual item, got %+v", it)
	}
	if !strings.Contains(it.Fix, "OpenX UI") || !strings.Contains(it.Fix, `"Politics"`) {
		t.Errorf("fix should direct the trader to set %q in the OpenX UI: %q", "Politics", it.Fix)
	}
}

func TestQAOxSensitiveCategory_AbsentWithoutOpenXOrCategory(t *testing.T) {
	// Category set, but no OpenX deals in the batch.
	req := baseValidRequest()
	req.ExpectedAdCategory = "Politics"
	resp := RunAudit(&req, "DEAL00145")
	if _, ok := qaItem(resp.QA, "qa_ox_sensitive_category"); ok {
		t.Errorf("no OpenX deals — the sensitive-category item should not be emitted")
	}
	// OpenX deals, but no category declared.
	req2 := baseValidRequest()
	req2.Deals[0].SSP = "OpenX"
	resp2 := RunAudit(&req2, "DEAL00145")
	if _, ok := qaItem(resp2.QA, "qa_ox_sensitive_category"); ok {
		t.Errorf("no category declared — the sensitive-category item should not be emitted")
	}
}

func TestQAMasterBlockList_WarnsWhenMissing(t *testing.T) {
	req := baseValidRequest()
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_master_block_list")
	if !ok || it.Status != QAWarn {
		t.Fatalf("display campaign without a block list should warn, got %+v", it)
	}
	if !strings.Contains(it.Fix, "master block list") {
		t.Errorf("fix should point at the master block list: %q", it.Fix)
	}
}

func TestQAMasterBlockList_PassesWhenApplied(t *testing.T) {
	req := baseValidRequest()
	req.DomainLists = []UploadedFile{{ID: "list:longtail-block", Name: "Longtail Block List", InclusionType: "Exclude"}}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_master_block_list")
	if !ok || it.Status != QAPass {
		t.Fatalf("expected block list pass, got %+v", it)
	}
	if !strings.Contains(it.Detail, "Longtail Block List") {
		t.Errorf("detail should name the applied list: %q", it.Detail)
	}
}

func TestQAMasterBlockList_NAForCTVOnly(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].Channel = "CTV"
	req.Deals[0].VCR = "80"
	req.DefaultVideoCPM = "12"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_master_block_list")
	if !ok || it.Status != QANA {
		t.Fatalf("CTV-only campaign should mark the domain block list n/a, got %+v", it)
	}
}

func TestQAListSelection_AdvisoryElevatedToWarn(t *testing.T) {
	req := baseValidRequest()
	req.DomainLists = []UploadedFile{
		{ID: "f1", Name: "block-a.csv", InclusionType: "Exclude"},
		{ID: "f2", Name: "allow-b.csv", InclusionType: "Include"},
	}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "check_list_selection")
	if !ok || it.Status != QAWarn {
		t.Fatalf("multi-list advisory should surface as a QA warn, got %+v", it)
	}
}

func TestQATestingAudiences_MixWarns(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].IncludeSegments = []string{"Test - Light Rain", "Light Rain"}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_testing_audiences")
	if !ok || it.Status != QAWarn {
		t.Fatalf("mixed test+production segments should warn, got %+v", it)
	}
	if it.FieldPath != "deals[0].includeSegments" {
		t.Errorf("expected jump target on the offending deal, got %q", it.FieldPath)
	}
}

func TestQAGeo_GlobalFallbackWarns(t *testing.T) {
	req := baseValidRequest()
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_geo")
	if !ok || it.Status != QAWarn {
		t.Fatalf("no geo include anywhere should warn about the Global fallback, got %+v", it)
	}
	req.DefaultGeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	resp = RunAudit(&req, "DEAL00145")
	it, _ = qaItem(resp.QA, "qa_geo")
	if it.Status != QAPass {
		t.Fatalf("default geo should satisfy every deal, got %+v", it)
	}
}

func TestQANaming_OffTemplateOverrideWarns(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].NameOverride = "My Custom Deal Name"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_naming_template")
	if !ok || it.Status != QAWarn {
		t.Fatalf("a free-text override should warn, got %+v", it)
	}
	if it.FieldPath != "deals[0].nameOverride" {
		t.Errorf("expected jump target on the override, got %q", it.FieldPath)
	}
}

func TestQADeviceInventory_CTVWebOnlyWarns(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].Channel = "CTV"
	req.Deals[0].InventoryType = "Web Only"
	req.Deals[0].VCR = "80"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_device_inventory")
	if !ok || it.Status != QAWarn {
		t.Fatalf("CTV + Web Only should warn, got %+v", it)
	}
}

func TestQAViewability_PerDealTarget(t *testing.T) {
	// Viewability is applied ONLY when explicitly specified per deal — there
	// is no campaign default, and absence is the intended state (reported as
	// an informational pass, never a warn prescribing a baseline).
	req := baseValidRequest()
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_viewability")
	if !ok || it.Status != QAPass {
		t.Fatalf("no viewability target should pass informationally, got %+v", it)
	}
	if !strings.Contains(it.Detail, "none is sent to the SSPs") {
		t.Errorf("absence detail should state nothing is sent to the SSPs, got %q", it.Detail)
	}
	if it.Fix != "" {
		t.Errorf("absence must not prescribe a fix/baseline, got %q", it.Fix)
	}
	// A per-deal target satisfies the item.
	req.Deals[0].ViewabilityTarget = "70"
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_viewability"); it.Status != QAPass || !strings.Contains(it.Detail, "per-deal") {
		t.Fatalf("per-deal viewability target set should pass as configured, got %+v", it)
	}
	// Hidden account/campaign-level fields must NOT count as configured —
	// the retired IX threshold once masked a leaked template default.
	req.Deals[0].ViewabilityTarget = ""
	req.IXConfig.ViewabilityThreshold = "70"
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_viewability"); !strings.Contains(it.Detail, "No viewability target") {
		t.Fatalf("legacy IX viewability threshold must not count as set, got %+v", it)
	}
}

func TestQAAdDuration_AbsenceEmitsNothing(t *testing.T) {
	// Ad-duration targeting is an optional extra — unlike viewability there
	// is no default baseline, so a build with no durations gets no item.
	req := baseValidRequest()
	resp := RunAudit(&req, "DEAL00145")
	if it, ok := qaItem(resp.QA, "qa_ad_duration"); ok {
		t.Fatalf("no ad-duration configured should emit no item, got %+v", it)
	}
	// Blank entries count as unset, mirroring the TrimSpace convention.
	req.Deals[0].AdDurations = []string{"", "  "}
	resp = RunAudit(&req, "DEAL00145")
	if it, ok := qaItem(resp.QA, "qa_ad_duration"); ok {
		t.Fatalf("blank-only adDurations should emit no item, got %+v", it)
	}
}

func TestQAAdDuration_Cases(t *testing.T) {
	cases := []struct {
		name       string
		channel    string
		durations  []string
		max        string
		wantStatus string
		wantField  string
	}{
		{"allowed list on CTV passes", "CTV", []string{"15", "30"}, "", QAPass, ""},
		{"max cap on OLV passes", "OLV (Online Video)", nil, "30", QAPass, ""},
		// The short 'OLV' label (deal-name slot form, cutlass brief-schema
		// canonical) passes too — and the TS gate mirrors this exactly
		// (types/deal.test.ts), so a pass here is never a silent TS-side drop.
		{"allowed list on bare OLV channel passes", "OLV", []string{"15", "30"}, "", QAPass, ""},
		{"allowed list on OTT passes", "OTT", []string{"15"}, "", QAPass, ""},
		{"max covering every allowed length passes", "CTV", []string{"15", "30"}, "30", QAPass, ""},
		{"durations on Display warn", "Display", []string{"15"}, "", QAWarn, "deals[0].adDurations"},
		{"max cap on Audio warns", "Audio", nil, "30", QAWarn, "deals[0].maxAdDurationSecs"},
		{"durations on Native warn", "Native", []string{"15", "30"}, "", QAWarn, "deals[0].adDurations"},
		{"non-integer duration warns", "CTV", []string{"15.5"}, "", QAWarn, "deals[0].adDurations"},
		{"zero duration warns", "CTV", []string{"0"}, "", QAWarn, "deals[0].adDurations"},
		{"negative duration warns", "CTV", []string{"-15"}, "", QAWarn, "deals[0].adDurations"},
		{"non-integer max warns", "CTV", nil, "30s", QAWarn, "deals[0].maxAdDurationSecs"},
		{"zero max warns", "CTV", nil, "0", QAWarn, "deals[0].maxAdDurationSecs"},
		{"max below an allowed length warns", "CTV", []string{"15", "30"}, "20", QAWarn, "deals[0].maxAdDurationSecs"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := baseValidRequest()
			req.Deals[0].Channel = tc.channel
			req.Deals[0].AdDurations = tc.durations
			req.Deals[0].MaxAdDurationSecs = tc.max
			if isVideoChannel(tc.channel) {
				req.Deals[0].VCR = "80" // keep the video-KPI rule out of the picture
			}
			resp := RunAudit(&req, "DEAL00145")
			it, ok := qaItem(resp.QA, "qa_ad_duration")
			if !ok {
				t.Fatalf("expected a qa_ad_duration item")
			}
			if it.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q (%+v)", it.Status, tc.wantStatus, it)
			}
			if tc.wantField != "" && it.FieldPath != tc.wantField {
				t.Errorf("fieldPath = %q, want %q", it.FieldPath, tc.wantField)
			}
			if sec := qaItemSection(resp.QA, "qa_ad_duration"); sec != qaTargeting {
				t.Errorf("qa_ad_duration should live in %s, got %s", qaTargeting, sec)
			}
		})
	}
}

// One warn per report even with several deals configured: the first problem
// wins (matching addDeviceItem), and a later valid deal must not mask it.
func TestQAAdDuration_FirstProblemWins(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].AdDurations = []string{"15"} // Display — unsupported channel
	req.Deals = append(req.Deals, DealEntry{
		ID: "d2", Theme: "Rain", Channel: "CTV", SSP: "Index Exchange",
		InventoryType: "All", CPM: "0.10", VCR: "80",
		AdDurations: []string{"15", "30"},
	})
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_ad_duration")
	if !ok || it.Status != QAWarn {
		t.Fatalf("unsupported-channel durations on deal 1 should warn, got %+v", it)
	}
	if it.DealIndex != 0 {
		t.Errorf("warn should point at deal 0, got %d", it.DealIndex)
	}
}

func TestQAAudienceConsolidation_OversizedBundleWarns(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].IncludeSegments = []string{"a", "b", "c", "d", "e", "f", "g"}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_audience_consolidation")
	if !ok || it.Status != QAWarn {
		t.Fatalf("7 segments on one deal should warn, got %+v", it)
	}
}

// Two incomplete deals generate identical placeholder names — that's a
// missing-field problem, not a duplicate-deal problem. The dupe rule must
// skip them so the trader isn't told to "remove a duplicate" that isn't one.
func TestDuplicateDeals_SkipsIncompleteDeals(t *testing.T) {
	req := baseValidRequest()
	req.Deals = append(req.Deals,
		DealEntry{ID: "d2", Theme: "", Channel: "", SSP: ""},
		DealEntry{ID: "d3", Theme: "", Channel: "", SSP: ""},
	)
	resp := RunAudit(&req, "DEAL00145")
	if c, ok := ruleResult(resp.Checks, "qa_duplicate_deals"); ok && !c.Passed {
		t.Fatalf("incomplete deals must not be flagged as duplicates: %+v", c)
	}
}

func TestQAXandrDealCodes_MultiDealPrefixWarns(t *testing.T) {
	req := baseValidRequest()
	req.Deals = []DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Xandr", InventoryType: "All", CPM: "2.50"},
		{ID: "d2", Theme: "Autos", Channel: "Display", SSP: "Xandr", InventoryType: "All", CPM: "2.50"},
	}
	req.XandrConfig = XandrConfig{DealCode: "ACME-Q3", InsertionOrder: "Example – Marketplace Pro"}
	res := RunAudit(&req, req.CampaignID)
	item, ok := qaItem(res.QA, "qa_xn_deal_codes")
	if !ok {
		t.Fatal("expected qa_xn_deal_codes item for >1 Xandr deal with a form dealCode")
	}
	if item.Status != QAWarn {
		t.Errorf("want warn, got %s", item.Status)
	}
	// Must NAME the derived codes exactly as the prompt builder emits them.
	if !strings.Contains(item.Detail, "ACME-Q3-1") || !strings.Contains(item.Detail, "ACME-Q3-2") {
		t.Errorf("detail must name the derived codes, got %q", item.Detail)
	}
}

func TestQAXandrDealCodes_SingleDealNoWarn(t *testing.T) {
	req := baseValidRequest()
	req.Deals = []DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Xandr", InventoryType: "All", CPM: "2.50"},
	}
	req.XandrConfig = XandrConfig{DealCode: "ACME-Q3", InsertionOrder: "Example – Marketplace Pro"}
	res := RunAudit(&req, req.CampaignID)
	if _, ok := qaItem(res.QA, "qa_xn_deal_codes"); ok {
		t.Fatal("single Xandr deal must not warn about derived codes")
	}
}

func TestQAXandrDealCodes_MultiDSPExpansionCounts(t *testing.T) {
	req := baseValidRequest()
	req.MultipleDSPs = true
	req.DSPs = []DSPEntry{{DSP: "The Trade Desk", SeatID: "111"}, {DSP: "DV360", SeatID: "222"}}
	req.Deals = []DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Xandr", InventoryType: "All", CPM: "2.50"},
	}
	req.XandrConfig = XandrConfig{DealCode: "ACME-Q3", InsertionOrder: "Example – Marketplace Pro"}
	res := RunAudit(&req, req.CampaignID)
	item, ok := qaItem(res.QA, "qa_xn_deal_codes")
	if !ok {
		t.Fatal("one Xandr deal × two DSPs = two creates — must warn")
	}
	if !strings.Contains(item.Detail, "ACME-Q3-2") {
		t.Errorf("expanded pair count must drive the derived codes, got %q", item.Detail)
	}
}

// QA must never claim an unapplied geo exclusion is "configured"
// (#219): no per-SSP prompt builder emits exclusions, so exclusions
// present force a NON-PASS qa_geo that says they will not ship. FAILS on the
// old behavior, which passed with "… 1 geo exclusion(s) configured.".
func TestQAGeo_ExclusionsNeverClaimedConfigured(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].GeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "g2", Type: "state", Value: "California"}}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_geo")
	if !ok {
		t.Fatal("qa_geo item missing")
	}
	if it.Status == QAPass {
		t.Fatalf("qa_geo must not pass while an exclusion is present, got %+v", it)
	}
	if strings.Contains(it.Detail, "configured") {
		t.Fatalf("qa_geo must never call an unapplied exclusion 'configured': %q", it.Detail)
	}
	if !strings.Contains(it.Detail, "NOT emitted") {
		t.Fatalf("qa_geo must state the exclusion is not emitted: %q", it.Detail)
	}
	if it.FieldPath != "deals[0].geoExclude" {
		t.Fatalf("qa_geo must jump to the exclusion, got %q", it.FieldPath)
	}
	// The audit itself must block the batch.
	if resp.Status != "failed" {
		t.Fatalf("audit must fail closed on an exclusion, got %q", resp.Status)
	}
}

// An exclusion on the FORM default (no per-deal excludes) still forces the
// non-pass item, pointing at the defaultGeoExclude field.
func TestQAGeo_DefaultExclusionAlsoWarns(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].GeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	req.DefaultGeoExclude = []GeoEntry{{ID: "g2", Type: "country", Value: "CA"}}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_geo")
	if !ok || it.Status == QAPass {
		t.Fatalf("default geo exclude must force a non-pass qa_geo, got %+v", it)
	}
	if it.FieldPath != "defaultGeoExclude" {
		t.Fatalf("expected jump target defaultGeoExclude, got %q", it.FieldPath)
	}
}

// -----------------------------------------------------------------------------
// qa_list_ssp_support (#220) — a resolved list routed to an SSP with no
// create-time emission path (Xandr: no list-file ingestion; TripleLift:
// advertiser-domain-only post-create merge, cutlass#731) must WARN per
// (list, SSP) pair. Pre-fix these items were never emitted (and DealEntry
// carried no per-deal list fields at all), so qa_master_block_list claimed
// the list applied while the Xandr/TL deals shipped with zero scoping.
// -----------------------------------------------------------------------------

// qaItemsByID collects every emitted item with the id (the disclosure emits
// one item per (list, SSP) pair, so qaItem's first-match helper is not enough).
func qaItemsByID(report QAReport, id string) []QAItem {
	var items []QAItem
	for _, s := range report.Sections {
		for _, it := range s.Items {
			if it.ID == id {
				items = append(items, it)
			}
		}
	}
	return items
}

func TestQAListSspSupport_WarnsOnXandr(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "Xandr"
	req.DomainLists = []UploadedFile{{ID: "list:longtail-block", Name: "Longtail Block List", InclusionType: "Exclude"}}
	resp := RunAudit(&req, "DEAL00145")
	items := qaItemsByID(resp.QA, "qa_list_ssp_support")
	if len(items) != 1 {
		t.Fatalf("expected exactly one qa_list_ssp_support item for (Longtail, Xandr), got %d: %+v", len(items), items)
	}
	it := items[0]
	if it.Status != QAWarn {
		t.Fatalf("expected QAWarn, got %+v", it)
	}
	if !strings.Contains(it.Detail, "Longtail Block List") || !strings.Contains(it.Detail, "Xandr") {
		t.Errorf("detail should name the list and the SSP: %q", it.Detail)
	}
	if !strings.Contains(it.Detail, "NOT APPLIED") {
		t.Errorf("detail should state the list will be reported NOT APPLIED: %q", it.Detail)
	}
	if !strings.Contains(it.Fix, "Curate deal list") {
		t.Errorf("fix should point at the Curate deal-list manual path: %q", it.Fix)
	}
	if sec := qaItemSection(resp.QA, "qa_list_ssp_support"); sec != qaInventory {
		t.Errorf("list delivery disclosure belongs to the inventory section, got %q", sec)
	}
}

func TestQAListSspSupport_WarnsOnPerDealTLList(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "TripleLift"
	// Per-deal pick of a batch-applied standard list — resolvable to its name
	// via the handler-folded "list:<id>" entry.
	id := "longtail-block"
	req.Deals[0].DomainListID = &id
	req.DomainLists = []UploadedFile{{ID: "list:longtail-block", Name: "Longtail Block List", InclusionType: "Exclude"}}
	resp := RunAudit(&req, "DEAL00145")
	items := qaItemsByID(resp.QA, "qa_list_ssp_support")
	if len(items) != 1 {
		t.Fatalf("expected one qa_list_ssp_support item for (Longtail, TripleLift), got %d: %+v", len(items), items)
	}
	it := items[0]
	if it.Status != QAWarn {
		t.Fatalf("expected QAWarn, got %+v", it)
	}
	if !strings.Contains(it.Detail, "Longtail Block List") || !strings.Contains(it.Detail, "TripleLift") {
		t.Errorf("detail should name the list and the SSP: %q", it.Detail)
	}
	if !strings.Contains(it.Detail, "ADVERTISER-domain") || !strings.Contains(it.Detail, "cutlass#731") {
		t.Errorf("detail should carry the advertiser-domain-only #731 caveat: %q", it.Detail)
	}
}

func TestQAListSspSupport_PerDealPickNotBatchApplied_WarnsByID(t *testing.T) {
	// The #221 canary shape: batch-applied lists EMPTY, per-deal standard-list
	// pick only. The Go layer has no registry access, so the warning names the
	// id — it must still fire rather than stay silent.
	req := baseValidRequest()
	req.Deals[0].SSP = "Xandr"
	id := "longtail-block"
	req.Deals[0].DomainListID = &id
	resp := RunAudit(&req, "DEAL00145")
	items := qaItemsByID(resp.QA, "qa_list_ssp_support")
	if len(items) != 1 {
		t.Fatalf("expected one qa_list_ssp_support item, got %d: %+v", len(items), items)
	}
	if !strings.Contains(items[0].Detail, "longtail-block") {
		t.Errorf("detail should name the per-deal list id: %q", items[0].Detail)
	}
}

func TestQAListSspSupport_SilentWhenSupported(t *testing.T) {
	// IX-only batch with a block list: the list HAS an emission path
	// (domain_file_path), so no disclosure item may appear.
	req := baseValidRequest()
	req.DomainLists = []UploadedFile{{ID: "list:longtail-block", Name: "Longtail Block List", InclusionType: "Exclude"}}
	resp := RunAudit(&req, "DEAL00145")
	if items := qaItemsByID(resp.QA, "qa_list_ssp_support"); len(items) != 0 {
		t.Fatalf("IX-only batch must emit no qa_list_ssp_support item, got %+v", items)
	}
}

func TestQAListSspSupport_ExplicitNoneAndSheetOnlySuppress(t *testing.T) {
	req := baseValidRequest()
	req.DomainLists = []UploadedFile{{ID: "list:longtail-block", Name: "Longtail Block List", InclusionType: "Exclude"}}
	// Deal 1: Xandr with an explicit "" (no list) override — suppressed.
	none := ""
	req.Deals[0].SSP = "Xandr"
	req.Deals[0].DomainListID = &none
	// Deal 2: sheet-only TripleLift row — never created, so no disclosure.
	sheetOnly := req.Deals[0]
	sheetOnly.ID = "d2"
	sheetOnly.SSP = "TripleLift"
	sheetOnly.DomainListID = nil
	sheetOnly.SheetOnly = true
	req.Deals = append(req.Deals, sheetOnly)
	resp := RunAudit(&req, "DEAL00145")
	if items := qaItemsByID(resp.QA, "qa_list_ssp_support"); len(items) != 0 {
		t.Fatalf("explicit-none + sheet-only deals must emit no qa_list_ssp_support item, got %+v", items)
	}
}

// ---------------------------------------------------------------------------
// Silent-drop QA class (#226/#244): every item below used to report
// PASS/"configured" for a dimension the SSP could not carry. Each warn-side
// assertion FAILS on the pre-fix QA code.
// ---------------------------------------------------------------------------

func TestQAViewability_SSPAware(t *testing.T) {
	// Xandr has no viewability wire — a set target must WARN, never pass.
	req := baseValidRequest()
	req.Deals[0].SSP = "Xandr"
	req.Deals[0].NameOverride = ""
	req.Deals[0].ViewabilityTarget = "70"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_viewability")
	if !ok || it.Status != QAWarn {
		t.Fatalf("viewability on Xandr must warn (no wire), got %+v", it)
	}
	if !strings.Contains(it.Detail, "CANNOT carry") || !strings.Contains(it.Detail, "NOT-SUPPORTED") {
		t.Fatalf("warn must state the target cannot be carried, got %q", it.Detail)
	}

	// Magnite CTV (SpringServe) is the same gap.
	req = baseValidRequest()
	req.Deals[0].SSP = "Magnite"
	req.Deals[0].Channel = "CTV"
	req.Deals[0].VCR = "80"
	req.Deals[0].NameOverride = ""
	req.Deals[0].ViewabilityTarget = "70"
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_viewability"); it.Status != QAWarn {
		t.Fatalf("viewability on Magnite CTV must warn (SpringServe has no wire), got %+v", it)
	}

	// Magnite DV+ delivers via the manual raw-targeting instruction.
	req.Deals[0].Channel = "Display"
	req.Deals[0].VCR = ""
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_viewability"); it.Status != QAManual || !strings.Contains(it.Detail, "MANUAL") {
		t.Fatalf("viewability on Magnite DV+ must be a manual confirmation, got %+v", it)
	}

	// An emitting SSP (IX) stays a pass and names the wire.
	req = baseValidRequest()
	req.Deals[0].ViewabilityTarget = "70"
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_viewability"); it.Status != QAPass || !strings.Contains(it.Detail, "EMITTED") {
		t.Fatalf("viewability on IX must pass as emitted, got %+v", it)
	}
}

func TestQALanguage_PubMaticFalseGreenKilled(t *testing.T) {
	// The old qa_pm_language reported PASS "Language targeting is set" while
	// NO builder emitted language and PubMatic has no language wire at all.
	req := baseValidRequest()
	req.Deals[0].SSP = "PubMatic"
	req.Deals[0].NameOverride = ""
	req.Deals[0].Language = "English"
	resp := RunAudit(&req, "DEAL00145")
	if _, stale := qaItem(resp.QA, "qa_pm_language"); stale {
		t.Fatal("the false-green qa_pm_language item must be gone")
	}
	it, ok := qaItem(resp.QA, "qa_language")
	if !ok || it.Status != QAWarn {
		t.Fatalf("language on PubMatic must warn (no wire), got %+v", it)
	}
	if !strings.Contains(it.Detail, "CANNOT carry") {
		t.Fatalf("warn must state the language cannot be carried, got %q", it.Detail)
	}
}

func TestQALanguage_EmittingSSPsPass(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "OpenX"
	req.Deals[0].NameOverride = ""
	req.Deals[0].Language = "English"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_language")
	if !ok || it.Status != QAPass || !strings.Contains(it.Detail, "EMITTED") {
		t.Fatalf("language on OpenX must pass as emitted, got %+v", it)
	}

	// No language + a PubMatic deal → the truthful UI-only manual nudge.
	req = baseValidRequest()
	req.Deals[0].SSP = "PubMatic"
	req.Deals[0].NameOverride = ""
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_language"); it.Status != QAManual || !strings.Contains(it.Detail, "UI-only") {
		t.Fatalf("language-less PubMatic build must get the UI-only manual item, got %+v", it)
	}
}

func TestQAContextual_TLAndMagniteIABNeverConfigured(t *testing.T) {
	// TripleLift IAB is vendor-gated (cutlass#757): an explicit pick must
	// WARN — the old behavior reported it "configured" (PASS).
	req := baseValidRequest()
	req.Deals[0].SSP = "TripleLift"
	req.Deals[0].NameOverride = ""
	req.Deals[0].IABCategories = []string{"News"}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_contextual")
	if !ok || it.Status != QAWarn {
		t.Fatalf("TL IAB must warn, got %+v", it)
	}
	if !strings.Contains(it.Detail, "cutlass#757") || !strings.Contains(it.Detail, "NOT be applied") {
		t.Fatalf("TL IAB warn must carry the vendor-gate + not-applied truth, got %q", it.Detail)
	}
	if strings.Contains(it.Detail, "Add keywords") {
		t.Fatalf("TL IAB must not read like the configured pass, got %q", it.Detail)
	}

	// Magnite has no ClearLine content-category surface — same warn.
	req.Deals[0].SSP = "Magnite"
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_contextual"); it.Status != QAWarn || !strings.Contains(it.Detail, "Magnite") {
		t.Fatalf("Magnite IAB must warn, got %+v", it)
	}

	// An explicitly EMPTY per-deal pick on TL is fine (nothing claimed).
	req.Deals[0].SSP = "TripleLift"
	req.Deals[0].IABCategories = []string{}
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_contextual"); it.Status == QAWarn && strings.Contains(it.Detail, "cutlass#757") {
		t.Fatalf("an empty TL IAB pick must not trigger the vendor-gate warn, got %+v", it)
	}
}

func segExcludeFailed(checks []CheckResult) bool {
	for _, c := range checks {
		if c.Rule == "segment_exclude_unsupported" && !c.Passed {
			return true
		}
	}
	return false
}

func TestQASegmentExcludes_SSPAware(t *testing.T) {
	// #226 F2: Media.net has no vendor-confirmed exclude wire — a
	// trader exclude BLOCKS (segment_exclude_unsupported flag), and the
	// checklist-native qa_segment_excludes item DEFERS to the flag (absent).
	req := baseValidRequest()
	req.Deals[0].SSP = "Media.net"
	req.Deals[0].NameOverride = ""
	req.Deals[0].ExcludeSegments = []string{"Bad Audience"}
	resp := RunAudit(&req, "DEAL00145")
	if resp.Status != "failed" {
		t.Fatalf("a Media.net trader exclude must fail the audit closed, got %q", resp.Status)
	}
	flag, ok := qaItem(resp.QA, "check_segment_exclude_unsupported")
	if !ok || flag.Status != QAFlag {
		t.Fatalf("expected a blocking segment_exclude_unsupported flag, got %+v", flag)
	}
	if _, present := qaItem(resp.QA, "qa_segment_excludes"); present {
		t.Fatalf("the checklist-native item must DEFER to the blocking flag, not double-report")
	}

	// Xandr carries excludes on the create wire — pass as emitted, no
	// segment-exclude block (other unrelated Xandr-config rules may still
	// flag, but qa_segment_excludes is unaffected).
	req.Deals[0].SSP = "Xandr"
	resp = RunAudit(&req, "DEAL00145")
	if segExcludeFailed(resp.Checks) {
		t.Fatalf("Xandr enforces excludes — segment_exclude_unsupported must NOT fire")
	}
	if it, _ := qaItem(resp.QA, "qa_segment_excludes"); it.Status != QAPass || !strings.Contains(it.Detail, "EMITTED") {
		t.Fatalf("segment excludes on Xandr must pass as emitted, got %+v", it)
	}

	// A partner block list scoped to IX: an IX deal
	// carries them (emitted pass, no block).
	req = baseValidRequest()
	resp = RunAudit(&req, "DEAL00145")
	if it, _ := qaItem(resp.QA, "qa_segment_excludes"); it.Status != QAPass {
		t.Fatalf("IX excludes must pass as emitted, got %+v", it)
	}

	// No excludes anywhere → no checklist item (absence is fine).
	req = baseValidRequest()
	req.Deals[0].ExcludeSegments = nil
	resp = RunAudit(&req, "DEAL00145")
	if _, present := qaItem(resp.QA, "qa_segment_excludes"); present {
		t.Fatalf("exclusion-less build must not get a qa_segment_excludes item")
	}
}

func TestQAGeo_EmittedExclusionReportedTruthfully(t *testing.T) {
	// An exclusion on a verified exclude wire passes qa_geo and says EMITTED —
	// never the bare "configured" claim, and never a warn.
	req := baseValidRequest()
	req.Deals[0].SSP = "OpenX"
	req.Deals[0].NameOverride = ""
	req.Deals[0].GeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "g2", Type: "state", Value: "California"}}
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_geo")
	if !ok || it.Status != QAPass {
		t.Fatalf("emittable exclusion must pass qa_geo, got %+v", it)
	}
	if !strings.Contains(it.Detail, "EMITTED on their SSP's exclude wire") {
		t.Fatalf("qa_geo must report the exclusion as emitted, got %q", it.Detail)
	}
}

// ---- qa_segment_vocab: opportunity names leaked into the theme -------------

func TestQASegmentVocab_OpportunityNameInThemeWarns(t *testing.T) {
	req := baseValidRequest()
	// The DEAL07295 signature: a whole opportunity name in the theme.
	// Clear the fixture's full override so the theme actually reaches a name.
	req.Deals[0].NameOverride = ""
	req.Deals[0].Theme = "Central Garden - Arden - Q3 - Index - ADSP - Video - Current"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_segment_vocab")
	if !ok || it.Status != QAWarn {
		t.Fatalf("vocab-carrying theme must warn, got %+v (found=%v)", it, ok)
	}
	for _, want := range []string{`"index"`, `"adsp"`, `"video"`} {
		if !strings.Contains(it.Detail, want) {
			t.Errorf("detail should name the offending token %s: %q", want, it.Detail)
		}
	}
	if it.FieldPath != "deals[0].theme" {
		t.Errorf("warn should anchor to the theme field, got %q", it.FieldPath)
	}
}

func TestQASegmentVocab_CleanThemesPass(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].NameOverride = ""
	req.Deals[0].Theme = "Arden Current"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_segment_vocab")
	if !ok || it.Status != QAPass {
		t.Fatalf("clean theme must pass, got %+v (found=%v)", it, ok)
	}
}

func TestQASegmentVocab_FullOverrideSkipsTheme(t *testing.T) {
	// A full-name override never uses the theme — no warn even if the theme
	// field still holds the raw descriptor.
	req := baseValidRequest()
	req.Deals[0].Theme = "Something - Index - Video - Whatever"
	req.Deals[0].NameOverride = "Curator_Index_TTD_Northwind_Acme_NA_Rain_Display_All_US_DEAL00145_A1"
	resp := RunAudit(&req, "DEAL00145")
	if it, ok := qaItem(resp.QA, "qa_segment_vocab"); ok && it.Status == QAWarn {
		t.Errorf("theme behind a full override should not warn, got %+v", it)
	}
}

// ---- qa_agency_is_brand: advertiser repeated in the agency field -----------

func TestQAAgencyIsBrand_PrefixWarns(t *testing.T) {
	req := baseValidRequest()
	req.Agency = "Central Garden"
	req.Brand = "Central Garden & Pet Company"
	resp := RunAudit(&req, "DEAL00145")
	it, ok := qaItem(resp.QA, "qa_agency_is_brand")
	if !ok || it.Status != QAWarn {
		t.Fatalf("agency==brand prefix must warn, got %+v (found=%v)", it, ok)
	}
}

func TestQAAgencyIsBrand_RealAgencySilent(t *testing.T) {
	req := baseValidRequest()
	req.Agency = "Flywheel"
	req.Brand = "SC Johnson"
	resp := RunAudit(&req, "DEAL00145")
	if _, ok := qaItem(resp.QA, "qa_agency_is_brand"); ok {
		t.Errorf("distinct agency should emit no item")
	}
	// NA (direct) is the documented value — never warned.
	req2 := baseValidRequest()
	req2.Agency = "NA"
	resp2 := RunAudit(&req2, "DEAL00145")
	if _, ok := qaItem(resp2.QA, "qa_agency_is_brand"); ok {
		t.Errorf("NA agency should emit no item")
	}
}

// PubMatic accepts Video alongside Banner/Native, but its own docs (and the
// Auction Package "Environment" step, confirmed 2026-08-28) say the pairing
// makes detailed video targeting unavailable — buyers are told to create
// separate deals per format. The form's Ad Formats control is a free
// multi-select, so a trader can tick Video + Banner and ship a deal that looks
// correct everywhere and has quietly lost its video controls. Advisory only:
// the combination is legal and the deal serves.
func pubMaticAdFormatRequest(formats ...string) AuditRequest {
	req := baseValidRequest()
	req.Deals[0].SSP = "PubMatic"
	req.PubMaticConfig.MaxReach = true
	req.PubMaticConfig.AdFormats = formats
	return req
}

func TestQAPubMaticAdFormatMix_WarnsWhenVideoSharesADealWithBannerOrNative(t *testing.T) {
	for _, tc := range []struct {
		name    string
		formats []string
		wants   string
	}{
		{"video_plus_banner", []string{"Video (13)", "Banner (3)"}, "Banner"},
		{"video_plus_native", []string{"Video (13)", "Native (12)"}, "Native"},
		{"all_three", []string{"Banner (3)", "Native (12)", "Video (13)"}, "Banner and Native"},
		// The legacy persisted alias still means Video.
		{"legacy_video_alias", []string{"Video (12)", "Banner (3)"}, "Banner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := pubMaticAdFormatRequest(tc.formats...)
			resp := RunAudit(&req, "DEAL00145")
			it, ok := qaItem(resp.QA, "qa_pm_ad_format_mix")
			if !ok || it.Status != QAWarn {
				t.Fatalf("expected a warn for %v, got ok=%v %+v", tc.formats, ok, it)
			}
			if !strings.Contains(it.Detail, tc.wants) {
				t.Errorf("detail should name the degrading format(s) %q: %q", tc.wants, it.Detail)
			}
			// The trader needs the consequence, not just the combination.
			if !strings.Contains(it.Detail, "video targeting") {
				t.Errorf("detail should state what is lost: %q", it.Detail)
			}
			if qaItemSection(resp.QA, "qa_pm_ad_format_mix") != qaSSPConfig {
				t.Errorf("ad-format mix belongs to the SSP configuration section")
			}
		})
	}
}

func TestQAPubMaticAdFormatMix_SilentWhenNoVideoTargetingIsAtRisk(t *testing.T) {
	for _, tc := range []struct {
		name    string
		formats []string
	}{
		{"video_only", []string{"Video (13)"}},
		{"banner_only", []string{"Banner (3)"}},
		// No Video means there is no video targeting to lose.
		{"banner_plus_native", []string{"Banner (3)", "Native (12)"}},
		// Empty is the auto-derive default — one format per channel, never mixed.
		{"empty_auto_derive", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := pubMaticAdFormatRequest(tc.formats...)
			resp := RunAudit(&req, "DEAL00145")
			if it, ok := qaItem(resp.QA, "qa_pm_ad_format_mix"); ok {
				t.Fatalf("expected no item for %v, got %+v", tc.formats, it)
			}
		})
	}
}

// A batch with no PubMatic deals must never raise a PubMatic ad-format item,
// even when the form carries a mixed selection left over from an earlier edit.
func TestQAPubMaticAdFormatMix_ScopedToBatchesWithPubMaticDeals(t *testing.T) {
	req := baseValidRequest() // deal 1 is Index Exchange
	req.PubMaticConfig.AdFormats = []string{"Video (13)", "Banner (3)"}
	resp := RunAudit(&req, "DEAL00145")
	if it, ok := qaItem(resp.QA, "qa_pm_ad_format_mix"); ok {
		t.Fatalf("no PubMatic deals in the batch, got %+v", it)
	}
}

// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// All rights reserved. This is a private repository.

package validation

import (
	"strings"
	"testing"
)

// plainRequest is a minimal single-deal request the length/attribution tests
// mutate. Unrelated rules may fail without affecting the assertions.
func plainRequest(ssp string) AuditRequest {
	return AuditRequest{
		SubmitterName:      "Jane",
		SubmitterEmail:     "jane@example.com",
		FlightStartDate:    "2099-01-01",
		FlightEndDate:      "2099-12-31",
		Agency:             "Northwind",
		Brand:              "Acme",
		FeeType:            "Percentage of Media",
		CuratedDealFee:     "30",
		CampaignID:         "DEAL00500",
		AttributionCode:    "B14",
		DealSheetRecipient: "trader@example.com",
		DSPs:               []DSPEntry{{DSP: "The Trade Desk", SeatID: "111"}},
		Deals: []DealEntry{
			{ID: "d1", Theme: "Pets", Channel: "Display", SSP: ssp, InventoryType: "All", CPM: "2.50"},
		},
	}
}

// ---- Finding 7: attribution vocabulary ------------------------------------

func TestAttributionCode_VocabularyMembers(t *testing.T) {
	// Every code observed in the workbook must pass (incl. A0 and D1, which
	// sit outside the A1-A13/D00 canonical ranges but exist in real rows).
	observed := []string{"B14", "A4", "DEAL3", "A6", "B9", "A0", "B00", "B10", "DEAL1", "B16", "B6", "A2", "A3", "D00", "A13", "D1", "C2", "C1"}
	for _, code := range observed {
		req := plainRequest("Index Exchange")
		req.AttributionCode = code
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "attribution_code")
		if !ok || !c.Passed {
			t.Errorf("workbook code %q must pass attribution_code, got %+v (found=%v)", code, c, ok)
		}
	}
}

func TestAttributionCode_TyposFail(t *testing.T) {
	for _, code := range []string{"A14", "B19", "ELC4", "Z1", "B014"} {
		req := plainRequest("Index Exchange")
		req.AttributionCode = code
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "attribution_code")
		if !ok || c.Passed {
			t.Errorf("typo %q must FAIL attribution_code, got %+v (found=%v)", code, c, ok)
			continue
		}
		if !strings.Contains(c.Message, "A0–A13") || !strings.Contains(c.Message, "DEAL1–DEAL3") {
			t.Errorf("failure message must carry the vocabulary, got %q", c.Message)
		}
		if c.FieldPath != "attributionCode" {
			t.Errorf("failure must point at the attribution field, got %q", c.FieldPath)
		}
	}
}

func TestAttributionCode_LegacyNAPassesWithQAWarn(t *testing.T) {
	// 24 legacy rows carry NA — accept the check, warn in the QA report.
	req := plainRequest("Index Exchange")
	req.AttributionCode = "NA"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "attribution_code")
	if !ok || !c.Passed {
		t.Fatalf("legacy NA must pass the hard check, got %+v (found=%v)", c, ok)
	}
	item, ok := qaItem(res.QA, "qa_attribution")
	if !ok || item.Status != QAWarn {
		t.Fatalf("legacy NA must warn in the QA report, got %+v (found=%v)", item, ok)
	}
	if !strings.Contains(item.Detail, "NA") {
		t.Errorf("QA warn should mention NA, got %q", item.Detail)
	}
}

func TestAttributionCode_BlankEmitsNoCheck(t *testing.T) {
	// Blank defaults to A1 in the name; the existing qa_attribution warn covers
	// it — no hard check either way.
	req := plainRequest("Index Exchange")
	req.AttributionCode = ""
	res := RunAudit(&req, req.CampaignID)
	if _, ok := ruleResult(res.Checks, "attribution_code"); ok {
		t.Fatal("blank attribution must not emit an attribution_code check")
	}
}

func TestAttributionCode_CaseInsensitive(t *testing.T) {
	req := plainRequest("Index Exchange")
	req.AttributionCode = "b14"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "attribution_code")
	if !ok || !c.Passed {
		t.Fatalf("lowercase b14 should pass membership, got %+v (found=%v)", c, ok)
	}
}

// ---- Finding 6: name-length ceilings ---------------------------------------

// longTheme builds a theme that pushes the generated name past n characters.
func longTheme(n int) string {
	return strings.Repeat("VeryLongAudienceSegmentName", n/25+1)
}

func TestDealNameLength_IXOver255Fails(t *testing.T) {
	req := plainRequest("Index Exchange")
	req.Deals[0].Theme = longTheme(255)
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("IX name >255 must FAIL deal_name_length, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "255") {
		t.Errorf("message should state the ceiling, got %q", c.Message)
	}
	// The finding anchors to the Deal name input, not Theme/Audience — the
	// name is what is validated.
	if c.FieldPath != "deals[0].nameOverride" {
		t.Errorf("failure must point at the deal name field, got %q", c.FieldPath)
	}
}

func TestDealNameLength_XandrOver255Fails(t *testing.T) {
	req := plainRequest("Xandr")
	req.Deals[0].Theme = longTheme(255)
	req.XandrConfig = XandrConfig{InsertionOrder: "Example – Marketplace Pro"}
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("Xandr name >255 must FAIL deal_name_length, got %+v (found=%v)", c, ok)
	}
}

func TestDealNameLength_ShortNamesEmitNoFailure(t *testing.T) {
	req := plainRequest("Index Exchange")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "deal_name_length"); ok && !c.Passed {
		t.Fatalf("ordinary-length names must not fail deal_name_length: %+v", c)
	}
}

func TestDealNameLength_PubMaticOver250Fails(t *testing.T) {
	// PubMatic caps the deal-name field at 250 chars (UI limit, 2026-08) — an
	// over-long name is a hard audit failure, like the IX/Xandr 255 ceiling,
	// so it fails here instead of mid-batch at the API.
	req := plainRequest("PubMatic")
	req.PubMaticConfig = PubMaticConfig{MaxReach: true}
	req.Deals[0].Theme = longTheme(250)
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("PubMatic name >250 must FAIL deal_name_length, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "250") {
		t.Errorf("failure should state the 250-char cap, got %q", c.Message)
	}
}

func TestDealNameLength_PubMaticNoDealIDWarn(t *testing.T) {
	// The qa_pm_dealid_length warn is retired: Cutlass omits dealId at create
	// and PubMatic mints its own PM-XXXX-NNNN id, so no name ever truncates
	// into a dealId. Canonical names must produce neither the QA item nor a
	// deal_name_length failure.
	req := plainRequest("PubMatic")
	req.PubMaticConfig = PubMaticConfig{MaxReach: true}
	res := RunAudit(&req, req.CampaignID)
	if _, ok := qaItem(res.QA, "qa_pm_dealid_length"); ok {
		t.Fatal("qa_pm_dealid_length is retired and must never be emitted")
	}
	if c, ok := ruleResult(res.Checks, "deal_name_length"); ok && !c.Passed {
		t.Fatalf("canonical-length PubMatic names must not fail deal_name_length: %+v", c)
	}
}

func TestDealNameLength_MediaNet255(t *testing.T) {
	// cutlass#747 lifted Media.net's 30-char display_name create guard to 255
	// and the prompt ships the canonical name as display_name — so Media.net
	// joins the hard 255 ceiling, and the old qa_mn_display_length info item
	// is retired.
	req := plainRequest("Media.net")
	req.MediaNetConfig = MediaNetConfig{MarginType: "Percentage (1)", MarginValue: "25"}
	res := RunAudit(&req, req.CampaignID)
	if _, ok := qaItem(res.QA, "qa_mn_display_length"); ok {
		t.Fatal("qa_mn_display_length is retired and must never be emitted")
	}
	if c, ok := ruleResult(res.Checks, "deal_name_length"); ok && !c.Passed {
		t.Fatalf("canonical-length Media.net names must not fail deal_name_length: %+v", c)
	}

	req.Deals[0].Theme = strings.Repeat("VeryLongTheme", 25) // ~325 chars
	res = RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("Media.net name >255 must fail deal_name_length, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "255") {
		t.Errorf("failure should state the 255-char cap, got %q", c.Message)
	}
}

func TestDealNameLength_OpenXPolicyCap(t *testing.T) {
	// OpenX publishes no vendor name limit (docs sweep 2026-08-11; UI probe
	// 2026-08-12 found an uncapped input, save behavior unverified) — every
	// SSP is gated, so it takes the app policy ceiling of 255 on the
	// same deals[N].nameOverride anchor as the vendor ceilings.
	req := plainRequest("OpenX")
	req.Deals[0].Theme = longTheme(255)
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("OpenX name >255 must FAIL deal_name_length (policy cap), got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "app policy") {
		t.Errorf("OpenX failure should state the policy cap, got %q", c.Message)
	}
	if c.FieldPath != "deals[0].nameOverride" {
		t.Errorf("OpenX failure must point at the deal name field, got %q", c.FieldPath)
	}
}

func TestDealNameLength_TripleLift150(t *testing.T) {
	// The TripleLift UI input hard-stops at 150 characters (trader
	// verification, 2026-08-12) — a longer name cannot even be displayed or
	// edited there, so it fails the audit.
	req := plainRequest("TripleLift")
	req.Deals[0].Theme = longTheme(150)
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("TripleLift name >150 must FAIL deal_name_length, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "150") {
		t.Errorf("failure should state the 150-char cap, got %q", c.Message)
	}
}

func TestDealNameLength_MagniteSplitByMarketplace(t *testing.T) {
	// Magnite's UI validates by marketplace flavor (trader verification,
	// 2026-08-12): Streaming (CTV/Audio) "Deal Name cannot exceed 250
	// characters", DV+ (everything else) "…200 characters". Same CTV/Audio
	// split as mg_sizes.
	// A 162-char theme generates a ~223-char name: past the DV+ 200 ceiling,
	// under the Streaming 250 one — so the SAME name exercises both sides of
	// the split.
	dvplus := plainRequest("Magnite")
	dvplus.Deals[0].Theme = strings.Repeat("VeryLongAudienceSegmentName", 6)
	res := RunAudit(&dvplus, dvplus.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("Magnite DV+ (Display) name >200 must FAIL deal_name_length, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "DV+") || !strings.Contains(c.Message, "200") {
		t.Errorf("DV+ failure should state the 200-char cap, got %q", c.Message)
	}

	// The SAME theme on a CTV (Streaming) deal sits under 250 and passes.
	streaming := plainRequest("Magnite")
	streaming.Deals[0].Theme = dvplus.Deals[0].Theme
	streaming.Deals[0].Channel = "CTV"
	res = RunAudit(&streaming, streaming.CampaignID)
	if c, ok := ruleResult(res.Checks, "deal_name_length"); ok && !c.Passed {
		t.Fatalf("Magnite Streaming (CTV) name <=250 must not fail deal_name_length: %+v", c)
	}

	// Past 250 the Streaming ceiling fails too.
	streaming.Deals[0].Theme = longTheme(250)
	res = RunAudit(&streaming, streaming.CampaignID)
	c, ok = ruleResult(res.Checks, "deal_name_length")
	if !ok || c.Passed {
		t.Fatalf("Magnite Streaming name >250 must FAIL deal_name_length, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "Streaming") || !strings.Contains(c.Message, "250") {
		t.Errorf("Streaming failure should state the 250-char cap, got %q", c.Message)
	}
}

// ---- attribution_slot: override name slot 12 vs the form ------------------

// The DEAL07295 incident (2026-08-21): full-name overrides written with A1
// shipped after the trader corrected the form to B14 — the booked deals and
// the form disagreed on slot 12, which feeds cutlass margin extraction.

func TestAttributionSlot_OverrideDriftFails(t *testing.T) {
	req := plainRequest("Index Exchange")
	req.AttributionCode = "B14"
	req.Deals[0].NameOverride = "PARTNER-IX-Acme-1_Index_Amazon_NA_Acme_NA_Rain_Display_All_US_DEAL00500_A1"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "attribution_slot")
	if !ok || c.Passed {
		t.Fatalf("drifted override must FAIL attribution_slot, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "A1") || !strings.Contains(c.Message, "B14") {
		t.Errorf("message must name both codes, got %q", c.Message)
	}
	if c.FieldPath != "deals[0].nameOverride" {
		t.Errorf("failure must anchor to the override, got %q", c.FieldPath)
	}
}

func TestAttributionSlot_MatchingOverridePasses(t *testing.T) {
	req := plainRequest("Index Exchange")
	req.AttributionCode = "B14"
	req.Deals[0].NameOverride = "PARTNER-IX-Acme-1_Index_Amazon_NA_Acme_NA_Rain_Display_All_US_DEAL00500_B14"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "attribution_slot")
	if !ok || !c.Passed {
		t.Fatalf("matching override must PASS attribution_slot, got %+v (found=%v)", c, ok)
	}
}

func TestAttributionSlot_SheetOnlyAndNonSlotOverridesSkipped(t *testing.T) {
	req := plainRequest("Index Exchange")
	req.AttributionCode = "B14"
	// Sheet-only rows were booked under their own batch's code — skipped.
	req.Deals[0].NameOverride = "Curator_Index_TTD_Northwind_Acme_NA_Rain_Display_All_US_DEAL00400_A1"
	req.Deals[0].SheetOnly = true
	res := RunAudit(&req, req.CampaignID)
	if c, _ := ruleResult(res.Checks, "attribution_slot"); !c.Passed {
		t.Fatalf("sheet-only override must not trip attribution_slot, got %+v", c)
	}
	// An override whose last token is not an attribution code is not a
	// 12-slot name — nothing to compare.
	req2 := plainRequest("Index Exchange")
	req2.Deals[0].NameOverride = "Some Legacy Deal Name Without Slots"
	res2 := RunAudit(&req2, req2.CampaignID)
	if c, _ := ruleResult(res2.Checks, "attribution_slot"); !c.Passed {
		t.Fatalf("non-slot override must not trip attribution_slot, got %+v", c)
	}
}

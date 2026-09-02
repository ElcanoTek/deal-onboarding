// All rights reserved. This is a private repository.

package validation

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func baseValidRequest() AuditRequest {
	return AuditRequest{
		SubmitterName:      "Jane",
		SubmitterEmail:     "jane@example.com",
		FlightStartDate:    "2099-01-01",
		FlightEndDate:      "2099-12-31",
		Agency:             "twoxfour",
		Brand:              "Brookfield Zoo",
		FeeType:            "Percentage of Media",
		CuratedDealFee:     "30",
		CampaignID:         "DEAL00145",
		DealSheetRecipient: "trader@example.com",
		DSPs:               []DSPEntry{{DSP: "Viant", SeatID: "2968"}},
		Deals: []DealEntry{
			{
				ID:                  "d1",
				NameOverride:        "PARTNER-IX-Acme Corp-1442794_Index_...",
				Theme:               "Rain",
				Channel:             "Display",
				SSP:                 "Index Exchange",
				InventoryType:       "All",
				ExternalReferenceID: "PARTNER-IX-Acme Corp-1442794",
				IncludeSegments:     []string{"Light Rain"},
				ExcludeSegments:     []string{"Weather Block List"},
				CPM:                 "0.10",
			},
		},
		ReportingLabels: ReportingLabels{Salesperson: "Kathryn Madden"},
	}
}

func ruleResult(checks []CheckResult, rule string) (CheckResult, bool) {
	for _, c := range checks {
		if c.Rule == rule {
			return c, true
		}
	}
	return CheckResult{}, false
}

func TestClientAwareRules_TWC_HappyPath(t *testing.T) {
	req := baseValidRequest()
	res := RunAudit(&req, req.CampaignID)
	for _, c := range res.Checks {
		if !c.Passed {
			t.Logf("unexpected failure: %s — %s", c.Rule, c.Message)
		}
	}
	if res.Status != "passed" {
		t.Fatalf("expected status=passed for valid override deal, got %s", res.Status)
	}
}

func TestDealSheetRecipientRequired(t *testing.T) {
	req := baseValidRequest()
	req.DealSheetRecipient = "" // blank — should fail now that a batch deal exists
	res := RunAudit(&req, req.CampaignID)
	check, ok := ruleResult(res.Checks, "deal_sheet_recipient")
	if !ok || check.Passed {
		t.Fatalf("expected deal_sheet_recipient failure when recipient blank, got %+v", check)
	}
	if res.Status != "failed" {
		t.Fatalf("expected status=failed, got %s", res.Status)
	}
}

func TestEmailFormat(t *testing.T) {
	t.Run("valid addresses pass", func(t *testing.T) {
		req := baseValidRequest()
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "email_format")
		if !ok || !check.Passed {
			t.Fatalf("expected email_format pass on the base request, got %+v", check)
		}
	})
	t.Run("malformed submitter email fails with its field path", func(t *testing.T) {
		req := baseValidRequest()
		req.SubmitterEmail = "Jane Trader" // pasted a name, not an address
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "email_format")
		if !ok || check.Passed {
			t.Fatalf("expected email_format failure for %q, got %+v", req.SubmitterEmail, check)
		}
		if check.FieldPath != "submitterEmail" {
			t.Fatalf("expected fieldPath submitterEmail, got %q", check.FieldPath)
		}
		if res.Status != "failed" {
			t.Fatalf("expected status=failed, got %s", res.Status)
		}
	})
	t.Run("recipient without a TLD fails", func(t *testing.T) {
		req := baseValidRequest()
		req.DealSheetRecipient = "trader@example" // missing .com
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "email_format")
		if !ok || check.Passed {
			t.Fatalf("expected email_format failure for %q, got %+v", req.DealSheetRecipient, check)
		}
		if check.FieldPath != "dealSheetRecipient" {
			t.Fatalf("expected fieldPath dealSheetRecipient, got %q", check.FieldPath)
		}
	})
	t.Run("blank fields are presence rules' job, not format's", func(t *testing.T) {
		req := baseValidRequest()
		req.SubmitterEmail = ""
		req.DealSheetRecipient = ""
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "email_format")
		if !ok || !check.Passed {
			t.Fatalf("expected email_format to pass on blank fields, got %+v", check)
		}
	})
	// The recipient may be a comma/semicolon-joined LIST from the chip input
	// (first = To, rest cc'd) — every entry must parse, none may sink the rest.
	t.Run("multi-recipient list with valid addresses passes", func(t *testing.T) {
		req := baseValidRequest()
		req.DealSheetRecipient = "lead@example.com, ops@example.com; desk@example.com"
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "email_format")
		if !ok || !check.Passed {
			t.Fatalf("expected email_format pass on a valid multi-recipient list, got %+v", check)
		}
	})
	t.Run("multi-recipient list with one malformed address fails and names it", func(t *testing.T) {
		req := baseValidRequest()
		req.DealSheetRecipient = "lead@example.com, ops@example"
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "email_format")
		if !ok || check.Passed {
			t.Fatalf("expected email_format failure for the malformed list entry, got %+v", check)
		}
		if check.FieldPath != "dealSheetRecipient" {
			t.Fatalf("expected fieldPath dealSheetRecipient, got %q", check.FieldPath)
		}
		if !strings.Contains(check.Message, "ops@example") {
			t.Fatalf("failure message should name the malformed address, got %q", check.Message)
		}
	})
	t.Run("multi-recipient list satisfies the presence rule", func(t *testing.T) {
		req := baseValidRequest()
		req.DealSheetRecipient = "lead@example.com, ops@example.com"
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "deal_sheet_recipient")
		if !ok || !check.Passed {
			t.Fatalf("expected deal_sheet_recipient pass on a multi-recipient list, got %+v", check)
		}
	})
}

// failedPathPresent reports whether any FAILED check carries the given fieldPath.
// Rules like completeness now emit one failed check per field, so we scan all.
func failedPathPresent(checks []CheckResult, path string) bool {
	for _, c := range checks {
		if !c.Passed && c.FieldPath == path {
			return true
		}
	}
	return false
}

// TestCompleteness_PerFieldPaths verifies the header completeness rule emits one
// failed check per missing field, each with the fieldPath the frontend uses to
// red-outline that specific input — instead of one aggregated message.
func TestCompleteness_PerFieldPaths(t *testing.T) {
	req := AuditRequest{} // everything blank
	res := RunAudit(&req, "")
	for _, path := range []string{
		"submitterName", "submitterEmail", "flightStartDate", "flightEndDate",
		"agency", "brand", "dsps[0].dsp", "feeType",
	} {
		if !failedPathPresent(res.Checks, path) {
			t.Errorf("expected a failed completeness check carrying fieldPath %q", path)
		}
	}
}

// TestSeatID_SeatOptionalDSP: seat-optional DSPs (StackAdapt) may omit the
// Seat ID — they bid through a house seat and the SSPs accept the deal
// without one — unless the batch has CREATE rows on an SSP whose Cutlass
// path needs a seat to resolve the buyer (PubMatic buyer mapping, TripleLift
// dsp.seat.seatString).
func TestSeatID_SeatOptionalDSP(t *testing.T) {
	seatCheck := func(t *testing.T, req *AuditRequest) CheckResult {
		t.Helper()
		res := RunAudit(req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "seat_id")
		if !ok {
			t.Fatal("no seat_id check in audit result")
		}
		return c
	}

	t.Run("stackadapt_seatless_passes", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "StackAdapt", SeatID: ""}}
		if c := seatCheck(t, &req); !c.Passed {
			t.Fatalf("expected seat_id to pass for seatless StackAdapt on IX, got %+v", c)
		}
	})

	t.Run("name_variants_match_allowlist", func(t *testing.T) {
		for _, name := range []string{"stackadapt", "Stack Adapt", "STACKADAPT "} {
			req := baseValidRequest()
			req.DSPs = []DSPEntry{{ID: "1", DSP: name, SeatID: ""}}
			if c := seatCheck(t, &req); !c.Passed {
				t.Errorf("DSP %q: expected seat_id to pass, got %+v", name, c)
			}
		}
	})

	t.Run("pubmatic_create_still_requires_seat", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "StackAdapt", SeatID: ""}}
		req.Deals[0].SSP = "PubMatic"
		c := seatCheck(t, &req)
		if c.Passed {
			t.Fatal("expected seat_id to fail: PubMatic creates need a seat to resolve the DSP buyer")
		}
		if c.FieldPath != "dsps[0].seatId" {
			t.Errorf("fieldPath = %q, want dsps[0].seatId", c.FieldPath)
		}
	})

	t.Run("triplelift_create_still_requires_seat", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "StackAdapt", SeatID: ""}}
		req.Deals[0].SSP = "TripleLift"
		if c := seatCheck(t, &req); c.Passed {
			t.Fatal("expected seat_id to fail: TripleLift creates embed dsp.seat.seatString")
		}
	})

	t.Run("sheet_only_pubmatic_does_not_demand_seat", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "StackAdapt", SeatID: ""}}
		req.Deals[0].SSP = "PubMatic"
		req.Deals[0].SheetOnly = true
		if c := seatCheck(t, &req); !c.Passed {
			t.Fatalf("sheet-only PubMatic rows create nothing and must not demand a seat, got %+v", c)
		}
	})

	t.Run("non_optional_dsp_still_requires_seat", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "The Trade Desk", SeatID: ""}}
		if c := seatCheck(t, &req); c.Passed {
			t.Fatal("expected seat_id to fail for a seatless non-optional DSP")
		}
	})

	t.Run("mixed_rows_flag_the_non_optional_row", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{
			{ID: "1", DSP: "StackAdapt", SeatID: ""},
			{ID: "2", DSP: "The Trade Desk", SeatID: ""},
		}
		c := seatCheck(t, &req)
		if c.Passed {
			t.Fatal("expected seat_id to fail on the non-optional row")
		}
		if c.FieldPath != "dsps[1].seatId" {
			t.Errorf("fieldPath = %q, want dsps[1].seatId", c.FieldPath)
		}
	})
}

// TestConfigRules_CarryFieldPaths verifies every campaign/SSP-config failure
// carries a stable fieldPath so the offending input can red-outline and the
// right section turns red (the Workspace audit feedback, June 2026).
func TestConfigRules_CarryFieldPaths(t *testing.T) {
	t.Run("header_and_campaign", func(t *testing.T) {
		req := baseValidRequest()
		req.CuratedDealFee = "0"    // deal_fee
		req.CampaignID = "nope"     // campaign_id
		req.DealSheetRecipient = "" // deal_sheet_recipient
		req.DSPs[0].SeatID = ""     // seat_id
		res := RunAudit(&req, "")
		for rule, path := range map[string]string{
			"deal_fee":             "curatedDealFee",
			"campaign_id":          "campaignId",
			"deal_sheet_recipient": "dealSheetRecipient",
			"seat_id":              "dsps[0].seatId",
		} {
			if !failedPathPresent(res.Checks, path) {
				t.Errorf("rule %s: expected failed check with fieldPath %q", rule, path)
			}
		}
	})

	t.Run("openx", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		// Deal Price is optional when blank but must carry its fieldPath
		// when an INVALID value fails it (typo guard).
		req.OpenXConfig = OpenXConfig{DealPrice: "abc"} // blank package/pmp, invalid price
		res := RunAudit(&req, req.CampaignID)
		// buyer_ids is optional (DSP seat ids resolved server-side), so
		// openxConfig.buyers must NOT fail.
		for _, path := range []string{"openxConfig.packageName", "openxConfig.dealPrice", "openxConfig.pmpDealType"} {
			if !failedPathPresent(res.Checks, path) {
				t.Errorf("expected failed OpenX check with fieldPath %q", path)
			}
		}
		if failedPathPresent(res.Checks, "openxConfig.buyers") {
			t.Error("openxConfig.buyers should be optional and must not fail the audit")
		}
	})

	t.Run("xandr_triplelift_medianet_pubmatic", func(t *testing.T) {
		cases := []struct {
			ssp  string
			path string
		}{
			// xandrConfig.dealCode is deliberately absent: a blank deal code is
			// valid (the prompt falls back to the generated deal name).
			{"Xandr", "xandrConfig.insertionOrder"},
			{"TripleLift", "tripleliftConfig.dealPriceType"},
			// tripleliftConfig.channel is deliberately absent: blank is the
			// default and means "derive per deal" (see TestTripleLiftChannelAuto).
			{"Media.net", "medianetConfig.marginValue"},
		}
		for _, tc := range cases {
			req := baseValidRequest()
			req.Deals[0].SSP = tc.ssp
			res := RunAudit(&req, req.CampaignID)
			if !failedPathPresent(res.Checks, tc.path) {
				t.Errorf("%s blank config: expected failed check with fieldPath %q", tc.ssp, tc.path)
			}
		}
		// PubMatic: Max Reach off + no publisher names.
		req := baseValidRequest()
		req.Deals[0].SSP = "PubMatic"
		req.PubMaticConfig = PubMaticConfig{MaxReach: false}
		res := RunAudit(&req, req.CampaignID)
		if !failedPathPresent(res.Checks, "pubmaticConfig.publisherNames") {
			t.Errorf("PubMatic no publishers: expected failed check with fieldPath pubmaticConfig.publisherNames")
		}
	})
}

func TestOpenXAppBundleBlocklistFails(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "OpenX"
	req.Deals[0].InventoryType = "In-App"
	req.AppBundleLists = []UploadedFile{{ID: "b1", Name: "blocklist.csv", InclusionType: "Exclude"}}
	res := RunAudit(&req, req.CampaignID)
	check, ok := ruleResult(res.Checks, "openx_app_bundle_blocklist")
	if !ok || check.Passed {
		t.Fatalf("expected openx_app_bundle_blocklist failure for an Exclude app-bundle file on an OpenX deal, got %+v", check)
	}
}

func TestDateLogic_TodayInServerLocalTimeIsValid(t *testing.T) {
	req := baseValidRequest()
	// "Today" is the BUSINESS timezone's calendar date (America/New_York),
	// same as the rule itself — a UTC-clock runner between 8 PM and midnight
	// ET is already on tomorrow's UTC date (regression: Truncate(24h)
	// rejected "today" for anyone west of UTC after the UTC rollover).
	now := time.Now().In(businessLocation)
	req.FlightStartDate = now.Format("2006-01-02")
	req.FlightEndDate = now.AddDate(0, 1, 0).Format("2006-01-02")
	res := RunAudit(&req, req.CampaignID)
	check, ok := ruleResult(res.Checks, "date_logic")
	if !ok {
		t.Fatal("date_logic check missing")
	}
	if !check.Passed {
		t.Fatalf("start date of today should pass date_logic, got: %s", check.Message)
	}
}

func TestDateLogic_YesterdayFails(t *testing.T) {
	req := baseValidRequest()
	// Business-timezone yesterday: on a UTC runner between 8 PM and midnight
	// ET, UTC-yesterday IS the business "today" and date_logic rightly passes
	// it — which made this test flake in exactly that window (PR #302).
	yesterday := time.Now().In(businessLocation).AddDate(0, 0, -1)
	req.FlightStartDate = yesterday.Format("2006-01-02")
	req.FlightEndDate = yesterday.AddDate(0, 1, 0).Format("2006-01-02")
	res := RunAudit(&req, req.CampaignID)
	check, ok := ruleResult(res.Checks, "date_logic")
	if !ok {
		t.Fatal("date_logic check missing")
	}
	if check.Passed {
		t.Fatal("start date of yesterday must fail date_logic")
	}
}

// cutlass#766: OpenX Private Auction is NOT creatable via the API — dealCreate's
// backend validation requires open_auction_access, a field absent from the
// GraphQL create schema, so every type-2 attempt dies with an opaque
// INTERNAL_SERVER_ERROR. The audit hard-blocks it so a trader can never build
// an uncreatable deal; the creatable types keep passing.
func TestOpenXPmpType_PrivateAuctionBlocked(t *testing.T) {
	// FAILS OLD: the pre-guard rule accepted PRIVATE_AUCTION and "2" as valid.
	for _, pmp := range []string{"PRIVATE_AUCTION", "private_auction", "2"} {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.OpenXConfig = OpenXConfig{DealPrice: "1.00", PackageName: "pkg", PMPDealType: pmp}
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "ox_pmp_type")
		if !ok {
			t.Fatalf("ox_pmp_type check missing for %q", pmp)
		}
		if check.Passed {
			t.Fatalf("PMP deal type %q must fail ox_pmp_type — Private Auction is API-uncreatable (cutlass#766)", pmp)
		}
		if !strings.Contains(check.Message, "open_auction_access") {
			t.Fatalf("ox_pmp_type failure for %q must explain the open_auction_access wall, got: %s", pmp, check.Message)
		}
		if check.FieldPath != "openxConfig.pmpDealType" {
			t.Fatalf("ox_pmp_type failure must carry the field path, got %q", check.FieldPath)
		}
	}
}

// The creatable PMP deal types (Preferred Deal — the default all 579 real
// most live deals use — and Programmatic Guaranteed) must keep passing unchanged.
func TestOpenXPmpType_CreatableTypesStillPass(t *testing.T) {
	for _, pmp := range []string{"PREFERRED_DEAL", "PROGRAMMATIC_GUARANTEED", "1", "3"} {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.OpenXConfig = OpenXConfig{DealPrice: "1.00", PackageName: "pkg", PMPDealType: pmp}
		res := RunAudit(&req, req.CampaignID)
		check, ok := ruleResult(res.Checks, "ox_pmp_type")
		if !ok {
			t.Fatalf("ox_pmp_type check missing for %q", pmp)
		}
		if !check.Passed {
			t.Fatalf("creatable PMP deal type %q must keep passing, got: %s", pmp, check.Message)
		}
	}
}

// =============================================================================
// Magnite — API-backed via the ClearLine Curation Demand Management API
// (June 2026). Magnite deals need a marketplace; publishers are always the
// explicit "ALL" opt-in (never collected), and DV+ (non-CTV) deals must not
// carry audience segments until Magnite API v3.0.
// =============================================================================

func magniteRequest(channel string) AuditRequest {
	req := baseValidRequest()
	req.Deals[0].SSP = "Magnite"
	req.Deals[0].Channel = channel
	req.Deals[0].IncludeSegments = nil
	req.Deals[0].ExcludeSegments = nil
	req.MagniteConfig = MagniteConfig{Marketplace: "Example CTV Marketplace"}
	return req
}

func TestMagniteRules_HappyPath(t *testing.T) {
	req := magniteRequest("CTV")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_marketplace"); !ok || !c.Passed {
		t.Fatalf("expected mg_marketplace to pass, got %+v", c)
	}
	// Publishers are never collected — mg_publishers is a passing
	// informational check recording the always-ALL policy.
	if c, ok := ruleResult(res.Checks, "mg_publishers"); !ok || !c.Passed {
		t.Fatalf("expected mg_publishers to pass (ALL policy), got %+v", c)
	} else if !strings.Contains(c.Message, "ALL") {
		t.Fatalf("mg_publishers message should record the ALL policy, got %q", c.Message)
	}
	if _, ok := ruleResult(res.Checks, "mg_dvplus_audience"); ok {
		t.Fatal("mg_dvplus_audience must not fire for a segment-less CTV deal")
	}
}

func TestMagniteRules_MissingMarketplace(t *testing.T) {
	req := magniteRequest("CTV")
	req.MagniteConfig = MagniteConfig{Marketplace: "  "}
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_marketplace"); !ok || c.Passed {
		t.Fatalf("expected mg_marketplace to fail, got %+v", c)
	} else if c.FieldPath != "magniteConfig.marketplace" {
		t.Fatalf("mg_marketplace fieldPath = %q", c.FieldPath)
	}
	// Even with no marketplace, mg_publishers stays a passing informational
	// check — publishers are policy, not user input.
	if c, ok := ruleResult(res.Checks, "mg_publishers"); !ok || !c.Passed {
		t.Fatalf("expected mg_publishers to pass regardless of input, got %+v", c)
	}
}

func TestMagniteRules_LegacyPublishersIgnoredLoudly(t *testing.T) {
	// A pre-rollout draft with a deliberately narrowed publisher list must not
	// be silently escalated to ALL — the passing check must say the list is
	// ignored so the audit surfaces the escalation.
	req := magniteRequest("CTV")
	req.MagniteConfig.Publishers = []string{"Pub A", " ", "Pub B"}
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "mg_publishers")
	if !ok || !c.Passed {
		t.Fatalf("expected mg_publishers to pass, got %+v", c)
	}
	if !strings.Contains(c.Message, "IGNORED") || !strings.Contains(c.Message, "2 explicit publisher(s)") {
		t.Fatalf("mg_publishers message must call out the ignored legacy list, got %q", c.Message)
	}
}

func TestMagniteRules_DVPlusSizesRequired(t *testing.T) {
	// A DV+ (Display) deal with no PER-DEAL ad formats must fail mg_sizes — the
	// API 422s size-less DV+ creates. Formats are now per-deal (DealEntry.MagniteSizes).
	req := magniteRequest("Display")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_sizes"); !ok || c.Passed {
		t.Fatalf("expected mg_sizes to fail for a Display deal with no formats, got %+v", c)
	} else if c.FieldPath != "deals[0].magniteSizes" {
		t.Fatalf("mg_sizes fieldPath = %q", c.FieldPath)
	}

	// Setting per-deal formats clears it (per-deal rules only emit on failure).
	withSizes := magniteRequest("Display")
	withSizes.Deals[0].MagniteSizes = []string{"15"}
	if _, ok := ruleResult(RunAudit(&withSizes, withSizes.CampaignID).Checks, "mg_sizes"); ok {
		t.Fatal("mg_sizes must not fire when the deal has formats")
	}

	// CTV (SpringServe) deals are exempt — mg_sizes must not fire at all.
	ctv := magniteRequest("CTV")
	if _, ok := ruleResult(RunAudit(&ctv, ctv.CampaignID).Checks, "mg_sizes"); ok {
		t.Fatal("mg_sizes must not fire for CTV (SpringServe) deals")
	}
}

func TestMagniteRules_DVPlusSizes_PerChannel(t *testing.T) {
	// Every DV+ format family requires per-deal formats. CTV, OTT and Audio
	// are exempt: CTV and OTT both route to Streaming (SpringServe), which
	// takes no sizes, and Audio uses feedTypes.
	for _, ch := range []string{"Display", "OLV (Online Video)", "Native"} {
		req := magniteRequest(ch)
		if c, ok := ruleResult(RunAudit(&req, req.CampaignID).Checks, "mg_sizes"); !ok || c.Passed {
			t.Errorf("%s: expected mg_sizes to fail with no formats, got %+v", ch, c)
		}
		filled := magniteRequest(ch)
		filled.Deals[0].MagniteSizes = []string{"15"}
		if _, ok := ruleResult(RunAudit(&filled, filled.CampaignID).Checks, "mg_sizes"); ok {
			t.Errorf("%s: mg_sizes must not fire when formats are set", ch)
		}
	}
	for _, ch := range []string{"CTV", "OTT", "Audio"} {
		req := magniteRequest(ch)
		if _, ok := ruleResult(RunAudit(&req, req.CampaignID).Checks, "mg_sizes"); ok {
			t.Errorf("%s: mg_sizes must not fire (exempt)", ch)
		}
	}
}

func TestMagniteRules_DVPlusSizes_FlagsOnlyOffendingDeal(t *testing.T) {
	// deal 0: Display, no formats → fails. deal 1: Display, formats set → passes.
	req := magniteRequest("Display")
	d2 := req.Deals[0]
	d2.ID = "d2"
	d2.MagniteSizes = []string{"15"}
	req.Deals = append(req.Deals, d2)
	var failIdxs []int
	for _, c := range RunAudit(&req, req.CampaignID).Checks {
		if c.Rule == "mg_sizes" && !c.Passed {
			failIdxs = append(failIdxs, c.DealIndex)
		}
	}
	if len(failIdxs) != 1 || failIdxs[0] != 0 {
		t.Fatalf("expected exactly one mg_sizes failure at deal index 0, got %v", failIdxs)
	}
}

func TestMagniteRules_DVPlusAudienceSegmentsBlocked(t *testing.T) {
	req := magniteRequest("Display")
	req.Deals[0].IncludeSegments = []string{"My Segment1"}
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "mg_dvplus_audience")
	if !ok || c.Passed {
		t.Fatalf("expected mg_dvplus_audience to fail for Display+segments, got %+v", c)
	}

	// Streaming (SpringServe) audiences are supported — same segments must
	// pass on BOTH channels that route there.
	for _, ch := range []string{"CTV", "OTT"} {
		streaming := magniteRequest(ch)
		streaming.Deals[0].IncludeSegments = []string{"My Segment1"}
		res = RunAudit(&streaming, streaming.CampaignID)
		if _, ok := ruleResult(res.Checks, "mg_dvplus_audience"); ok {
			t.Fatalf("mg_dvplus_audience must not fire for %s deals — Streaming has an audience API", ch)
		}
	}
}

// A Magnite OTT deal carrying audience segments must audit clean. This is the
// exact shape that could not be built before: OTT routed to DV+, where the
// audience API does not exist until v3.0, so every segment-bearing OTT deal
// was blocked. Both Streaming channels now accept segments AND need no sizes.
func TestMagniteRules_OTTWithSegmentsAndNoSizesIsClean(t *testing.T) {
	req := magniteRequest("OTT")
	req.Deals[0].IncludeSegments = []string{"Core Audience"}
	res := RunAudit(&req, req.CampaignID)
	for _, rule := range []string{"mg_dvplus_audience", "mg_sizes"} {
		if c, ok := ruleResult(res.Checks, rule); ok && !c.Passed {
			t.Errorf("%s must not fail for a Magnite OTT deal with segments: %+v", rule, c)
		}
	}
}

func TestMagniteRules_DealSheetRecipientRequiredForMagniteOnlyBatch(t *testing.T) {
	// Magnite-only batches run through MOC like any other SSP now, so the
	// deal-sheet recipient requirement applies (the old exemption is gone).
	req := magniteRequest("CTV")
	req.DealSheetRecipient = ""
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_sheet_recipient")
	if !ok || c.Passed {
		t.Fatalf("expected deal_sheet_recipient to fail for a Magnite-only batch, got %+v", c)
	}
}

// -----------------------------------------------------------------------------
// Magnite publisher-tab floor (mg_floor) — Wave Riders incident regression
// (2026-07): the $15 deal CPM shipped as the ClearLine floor and priced
// publishers out. The floor is config-driven and defaults to 0.10.
// -----------------------------------------------------------------------------

func TestMagniteRules_FloorDefaultsAndValidation(t *testing.T) {
	// Blank price type = the Market Rate default (owner call, 2026-07-21) —
	// passes with no floor at all.
	req := magniteRequest("CTV")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_floor"); !ok || !c.Passed {
		t.Fatalf("blank price type should pass as Market Rate, got %+v", c)
	} else if !strings.Contains(c.Message, "Market Rate") || strings.Contains(c.Message, "0.10") {
		t.Fatalf("blank price type should read as floor-less Market Rate, got %q", c.Message)
	}

	// Explicit MRwM with a blank floor → passes, documents the 0.10 default.
	req.MagniteConfig.PriceType = "Market Rate with Minimum"
	req.MagniteConfig.FloorCPM = ""
	res = RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_floor"); !ok || !c.Passed {
		t.Fatalf("blank floor should pass with the 0.10 default, got %+v", c)
	} else if !strings.Contains(c.Message, "0.10") {
		t.Fatalf("blank-floor message should document the 0.10 default, got %q", c.Message)
	}

	// Invalid / non-positive floors fail on the floor-bearing types.
	req.MagniteConfig.PriceType = "Market Rate with Minimum"
	for _, bad := range []string{"abc", "-1", "0"} {
		req.MagniteConfig.FloorCPM = bad
		res = RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "mg_floor")
		if !ok || c.Passed {
			t.Fatalf("floor %q should fail, got %+v", bad, c)
		}
		if c.FieldPath != "magniteConfig.floorCpm" {
			t.Fatalf("mg_floor fieldPath = %q", c.FieldPath)
		}
	}

	// A price type outside ClearLine's options fails on the dropdown.
	req.MagniteConfig.PriceType = "Fixed"
	req.MagniteConfig.FloorCPM = ""
	res = RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_floor"); !ok || c.Passed || c.FieldPath != "magniteConfig.priceType" {
		t.Fatalf("unknown price type should fail on magniteConfig.priceType, got %+v", c)
	}
}

func TestMagniteRules_HighFloorWarnsInQA(t *testing.T) {
	// A floor above $1 passes the hard audit but must warn in the QA report —
	// this is the check that would have caught the Wave Riders $15 floor.
	req := magniteRequest("CTV")
	req.MagniteConfig.PriceType = "Market Rate with Minimum"
	req.MagniteConfig.FloorCPM = "15"
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "mg_floor"); !ok || !c.Passed {
		t.Fatalf("a high but valid floor passes the audit rule, got %+v", c)
	}
	it, ok := qaItem(res.QA, "qa_mg_floor")
	if !ok || it.Status != QAWarn {
		t.Fatalf("floor $15 should warn in QA, got %+v", it)
	}
	if it.FieldPath != "magniteConfig.floorCpm" {
		t.Fatalf("qa_mg_floor fieldPath = %q", it.FieldPath)
	}

	req.MagniteConfig.FloorCPM = "0.10"
	res = RunAudit(&req, req.CampaignID)
	if it, _ := qaItem(res.QA, "qa_mg_floor"); it.Status != QAPass {
		t.Fatalf("floor 0.10 should pass QA, got %+v", it)
	}

	// The CPM price type is what the Wave Riders deals were mistakenly created
	// as — it gets a standing QA warn pointing at the dropdown.
	req.MagniteConfig.PriceType = "CPM"
	res = RunAudit(&req, req.CampaignID)
	it, ok = qaItem(res.QA, "qa_mg_floor")
	if !ok || it.Status != QAWarn || it.FieldPath != "magniteConfig.priceType" {
		t.Fatalf("CPM price type should warn on the dropdown, got %+v", it)
	}

	// Market Rate passes without a floor.
	req.MagniteConfig.PriceType = "Market Rate"
	res = RunAudit(&req, req.CampaignID)
	if it, _ := qaItem(res.QA, "qa_mg_floor"); it.Status != QAPass {
		t.Fatalf("Market Rate should pass QA, got %+v", it)
	}
}

func TestMagniteRules_CTVPriceTypeDowngradeRecorded(t *testing.T) {
	// Issue #228: 'Market Rate with Minimum' (the blank-priceType default) is
	// DV+-only — SpringServe rejects it and Cutlass blocks it at prepare, so
	// buildMagnitePrompt downgrades CTV deals to Market Rate. The audit must
	// record that downgrade loudly (passing informational check) and the QA
	// report must warn so the trader knows the minimum floor does not apply.
	req := magniteRequest("CTV")
	req.MagniteConfig.PriceType = "Market Rate with Minimum" // no longer the blank default (Market Rate is)
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "mg_ctv_price_type")
	if !ok || !c.Passed {
		t.Fatalf("expected mg_ctv_price_type to record the downgrade, got %+v", c)
	}
	if !strings.Contains(c.Message, "Market Rate") || !strings.Contains(c.Message, "SpringServe") {
		t.Fatalf("mg_ctv_price_type message must explain the downgrade, got %q", c.Message)
	}
	it, ok := qaItem(res.QA, "qa_mg_ctv_price_type")
	if !ok || it.Status != QAWarn {
		t.Fatalf("expected qa_mg_ctv_price_type warn for MRwM+CTV, got %+v", it)
	}
	if !strings.Contains(it.Detail, "Market Rate") || it.FieldPath != "magniteConfig.priceType" {
		t.Fatalf("qa_mg_ctv_price_type must state the downgrade on the dropdown, got %+v", it)
	}

	// Explicit MRwM fires it too.
	explicit := magniteRequest("CTV")
	explicit.MagniteConfig.PriceType = "Market Rate with Minimum"
	if c, ok := ruleResult(RunAudit(&explicit, explicit.CampaignID).Checks, "mg_ctv_price_type"); !ok || !c.Passed {
		t.Fatalf("expected mg_ctv_price_type for explicit MRwM, got %+v", c)
	}

	// CPM is SpringServe-valid — neither the check nor the warn fires.
	cpm := magniteRequest("CTV")
	cpm.MagniteConfig.PriceType = "CPM"
	cpmRes := RunAudit(&cpm, cpm.CampaignID)
	if _, ok := ruleResult(cpmRes.Checks, "mg_ctv_price_type"); ok {
		t.Fatal("mg_ctv_price_type must not fire for CPM (SpringServe supports it)")
	}
	if it, ok := qaItem(cpmRes.QA, "qa_mg_ctv_price_type"); ok {
		t.Fatalf("qa_mg_ctv_price_type must not fire for CPM, got %+v", it)
	}

	// DV+ deals keep MRwM — no downgrade note.
	display := magniteRequest("Display")
	display.Deals[0].MagniteSizes = []string{"15"}
	displayRes := RunAudit(&display, display.CampaignID)
	if _, ok := ruleResult(displayRes.Checks, "mg_ctv_price_type"); ok {
		t.Fatal("mg_ctv_price_type must not fire for DV+ deals (MRwM is valid there)")
	}
	if it, ok := qaItem(displayRes.QA, "qa_mg_ctv_price_type"); ok {
		t.Fatalf("qa_mg_ctv_price_type must not fire for DV+ deals, got %+v", it)
	}

	// Sheet-only rows never create — the downgrade note must not fire.
	sheet := magniteRequest("CTV")
	sheet.Deals[0].SheetOnly = true
	sheetRes := RunAudit(&sheet, sheet.CampaignID)
	if _, ok := ruleResult(sheetRes.Checks, "mg_ctv_price_type"); ok {
		t.Fatal("mg_ctv_price_type must not fire for sheet-only rows")
	}
	if it, ok := qaItem(sheetRes.QA, "qa_mg_ctv_price_type"); ok {
		t.Fatalf("qa_mg_ctv_price_type must not fire for sheet-only rows, got %+v", it)
	}
}

func TestMagniteRules_DealCPMNotRequired(t *testing.T) {
	// Magnite deals take no per-deal CPM: the floor comes from the config and
	// margin rides on rev_share, so deal_cpm must not fire even with every
	// CPM source blank. A non-Magnite deal in the same batch still requires one.
	req := magniteRequest("CTV")
	req.Deals[0].CPM = ""
	req.DefaultDisplayCPM = ""
	req.DefaultVideoCPM = ""
	req.Deals[0].VCR = "80"
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "deal_cpm"); ok && !c.Passed {
		t.Fatalf("deal_cpm must not fire for a Magnite deal, got %+v", c)
	}

	// PubMatic deals take no per-deal CPM either (PM-ZOOR-0075, 2026-08-19):
	// a deal-level floor forces Fixed Price on PubMatic and the deal transacts
	// at that exact CPM, so the prompt always ships auction_type=1 with no
	// floor_ecpm — a blank CPM has nothing to feed and must not fire.
	req.Deals = append(req.Deals, DealEntry{
		ID: "d2", Theme: "Rain", Channel: "Display", SSP: "PubMatic", InventoryType: "All",
	})
	res = RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "deal_cpm"); ok && !c.Passed {
		t.Fatalf("deal_cpm must not fire for a PubMatic deal, got %+v", c)
	}

	// A no-fallback SSP in the same batch still requires one (IX ships the
	// 0.10 default and OpenX falls back to the shared Deal Price, so use
	// Xandr, which has neither).
	req.Deals = append(req.Deals, DealEntry{
		ID: "d3", Theme: "Rain", Channel: "Display", SSP: "Xandr", InventoryType: "All",
	})
	res = RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_cpm")
	if !ok || c.Passed {
		t.Fatalf("deal_cpm should still fire for the CPM-less Xandr deal, got %+v", c)
	}
	if c.DealIndex != 2 {
		t.Fatalf("deal_cpm should target the Xandr deal (index 2), got %d", c.DealIndex)
	}
}

// -----------------------------------------------------------------------------
// Per-deal IAB inference — MIRROR CONTRACT with frontend/src/lib/inferIab.ts.
// The fixtures here are duplicated verbatim in inferIab.test.ts; if one side
// changes, change both (the keyword tables must stay identical).
// -----------------------------------------------------------------------------

func TestInferIAB_MirrorFixtures(t *testing.T) {
	cases := []struct {
		name     string
		theme    string
		segments []string
		brand    string
		iabHint  string
		kpiGoal  string
		want     []string
	}{
		{name: "cold and flu", theme: "Cold & Flu", brand: "TheraFlu", want: []string{"Health & Fitness"}},
		{name: "beach travel", theme: "Beach Getaways", brand: "Wave Riders", want: []string{"Travel"}},
		{name: "banking order-stable", theme: "DigitalConsumer", segments: []string{"Consumer Banking > Credit Cards"}, want: []string{"Consumer Banking", "Personal Finance"}},
		{name: "sports news order", theme: "Sports News", want: []string{"News", "Sports"}},
		{name: "iab hint feeds inference", theme: "Q3 Push", iabHint: "local news", want: []string{"News"}},
		{name: "word boundaries — no substring false positives", theme: "Carpet Cleaning Competition", brand: "Conscience Co", want: nil},
		{name: "no match", theme: "Zzyzx", brand: "Qwerty", want: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := AuditRequest{Brand: tc.brand, KPIGoal: tc.kpiGoal}
			deal := DealEntry{Theme: tc.theme, IncludeSegments: tc.segments, IABHint: tc.iabHint}
			got := inferIABForDeal(deal, &req)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v (order matters — mirror contract)", got, tc.want)
				}
			}
		})
	}
}

func TestInferIAB_PerDealInAuditResponse(t *testing.T) {
	// Inference is OPT-IN per deal (autoInferIab, default off) — both deals
	// opt in here; the toggle-off cases are asserted at the end.
	req := baseValidRequest()
	req.Brand = "Brookfield Zoo"
	req.Deals[0].Theme = "Cold & Flu"
	req.Deals[0].AutoInferIab = true
	req.Deals = append(req.Deals, DealEntry{
		ID: "d2", Theme: "Beach Getaways", Channel: "Display", SSP: "Index Exchange",
		InventoryType: "All", CPM: "0.10", ExcludeSegments: []string{"Weather Block List"},
		AutoInferIab: true,
	})
	res := RunAudit(&req, req.CampaignID)
	if len(res.Inferred.PerDeal) != 2 {
		t.Fatalf("expected per-deal inference for both opted-in deals, got %+v", res.Inferred.PerDeal)
	}
	if res.Inferred.PerDeal[0].DealIndex != 0 || res.Inferred.PerDeal[0].IABCategories[0] != "Health & Fitness" {
		t.Fatalf("deal 0 inference wrong: %+v", res.Inferred.PerDeal[0])
	}
	if res.Inferred.PerDeal[1].DealIndex != 1 || res.Inferred.PerDeal[1].IABCategories[0] != "Travel" {
		t.Fatalf("deal 1 inference wrong: %+v", res.Inferred.PerDeal[1])
	}
	// The union carries both, deduped, and the note explains per-deal review.
	if len(res.Inferred.IABCategories) < 2 {
		t.Fatalf("union should carry both categories, got %v", res.Inferred.IABCategories)
	}
	if !strings.Contains(res.Inferred.Note, "per deal") {
		t.Fatalf("note should describe per-deal inference, got %q", res.Inferred.Note)
	}

	// An explicit per-deal pick (even empty) suppresses inference for that deal.
	req.Deals[0].IABCategories = []string{}
	res = RunAudit(&req, req.CampaignID)
	for _, pd := range res.Inferred.PerDeal {
		if pd.DealIndex == 0 {
			t.Fatalf("deal 0 has an explicit (empty) pick — must not be inferred: %+v", pd)
		}
	}

	// A legacy campaign-wide selection no longer ships or suppresses anything
	// (the field is retired — iab_campaign_retired fails the audit separately),
	// so the advertised per-deal inference must be unchanged.
	req.Deals[0].IABCategories = nil
	req.IABCategories = []string{"Sports"}
	res = RunAudit(&req, req.CampaignID)
	if len(res.Inferred.PerDeal) != 2 {
		t.Fatalf("a stale campaign-wide list must not suppress per-deal inference, got %+v", res.Inferred)
	}

	// Toggle OFF (the default): the deal ships nothing, so the inferred block
	// must not advertise it either — only the still-opted-in deal 1 remains.
	req.IABCategories = nil
	req.Deals[0].AutoInferIab = false
	res = RunAudit(&req, req.CampaignID)
	if len(res.Inferred.PerDeal) != 1 || res.Inferred.PerDeal[0].DealIndex != 1 {
		t.Fatalf("a toggle-off deal must not be advertised as inferred, got %+v", res.Inferred.PerDeal)
	}
	for _, c := range res.Inferred.IABCategories {
		if c == "Health & Fitness" {
			t.Fatalf("the union must not carry the toggle-off deal's would-be inference, got %v", res.Inferred.IABCategories)
		}
	}

	// Both toggles off → no inferred block at all.
	req.Deals[1].AutoInferIab = false
	res = RunAudit(&req, req.CampaignID)
	if len(res.Inferred.PerDeal) != 0 || len(res.Inferred.IABCategories) != 0 {
		t.Fatalf("no opted-in deals → nothing advertised, got %+v", res.Inferred)
	}
}

func TestIABCampaignRetiredCheck(t *testing.T) {
	// Empty campaign-level list (every current client) — no check emitted.
	req := baseValidRequest()
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "iab_campaign_retired"); ok {
		t.Fatalf("empty campaign IAB list must not emit iab_campaign_retired, got %+v", c)
	}
	if res.Status != "passed" {
		t.Fatalf("baseline request should pass, got %s", res.Status)
	}

	// A non-empty list can only come from a stale cached client whose prompts
	// would still ship the invisible list — the audit must fail closed. This
	// runs in the /api/moc/create gate too (it re-runs RunAudit).
	req.IABCategories = []string{"Auto Parts", "Car Culture"}
	res = RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "iab_campaign_retired")
	if !ok || c.Passed {
		t.Fatalf("non-empty campaign IAB list must fail iab_campaign_retired, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "reload the app") {
		t.Fatalf("message must tell the trader to reload so the values fold onto deals, got %q", c.Message)
	}
	if res.Status != "failed" {
		t.Fatalf("audit must fail overall, got %s", res.Status)
	}
}

func TestSummarizeListSelection_ScopedConflicts(t *testing.T) {
	deals := []DealEntry{{ID: "d1", Theme: "One"}, {ID: "d2", Theme: "Two"}}

	// Two allow lists scoped to the SAME deal — the collapse must be surfaced.
	files := []UploadedFile{
		{ID: "f1", Name: "allow-a.csv", InclusionType: "Include", AppliesTo: []string{"d1"}},
		{ID: "f2", Name: "allow-b.csv", InclusionType: "Include", AppliesTo: []string{"d1"}},
	}
	if msg := summarizeListSelection(deals, files, "domain"); !strings.Contains(msg, "Deal 1") {
		t.Fatalf("two lists scoped to the same deal must warn about that deal, got %q", msg)
	}

	// Disjoint scoping is the supported multi-list pattern — no warning.
	files[1].AppliesTo = []string{"d2"}
	if msg := summarizeListSelection(deals, files, "domain"); msg != "" {
		t.Fatalf("disjoint per-deal scoping should be silent, got %q", msg)
	}

	// A file whose only scoped deal was removed falls back to campaign-wide —
	// two unscoped-equivalent allow lists compete again.
	files[0].AppliesTo = []string{"gone"}
	files[1].AppliesTo = nil
	if msg := summarizeListSelection(deals, files, "domain"); !strings.Contains(msg, "allow lists selected") {
		t.Fatalf("stale-scoped file must rejoin the campaign-wide ambiguity check, got %q", msg)
	}
}

// =============================================================================
// Sheet-only rows — deals already created in a previous batch that only ride
// the deal sheet (DealEntry.sheetOnly in types/deal.ts). Create-only checks
// must skip them; deal names and TotalDeals must keep including them (the MOC
// gate binds every audited name against the prompt).
// =============================================================================

// The frontend sends the audited form verbatim — the sheetOnly flag must
// survive JSON decoding so the rules can see which rows are already created.
func TestDealEntry_SheetOnlyDecodes(t *testing.T) {
	raw := `{"deals":[{"id":"d1","ssp":"OpenX","sheetOnly":true},{"id":"d2","ssp":"Index Exchange"}]}`
	var req AuditRequest
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !req.Deals[0].SheetOnly {
		t.Fatal("sheetOnly:true did not decode onto DealEntry.SheetOnly")
	}
	if req.Deals[1].SheetOnly {
		t.Fatal("absent sheetOnly must default to false")
	}
}

// An already-live OpenX row for a follow-up batch: full identity (name, ssp,
// channel) but deliberately NO CPM — and the request carries NO OpenX config.
// Both are create-time inputs nothing consumes for a sheet-only row.
func sheetOnlyOpenXRow(id string) DealEntry {
	return DealEntry{
		ID:            id,
		NameOverride:  "Partner_OpenX_Yahoo_Soundwave_SNAP_NA_SNAPusers_Display_All_US_DEAL00145_B14",
		Theme:         "SNAP users",
		Channel:       "Display",
		SSP:           "OpenX",
		InventoryType: "All",
		SheetOnly:     true,
	}
}

// The SNAP follow-up shape: a new create on one SSP plus already-live OpenX
// rows riding the sheet. The OpenX create-config checks must not fire — this
// batch never calls an OpenX tool — and the sheet-only row must not demand a
// create-time CPM. Without the exemption this legitimate batch could never
// pass the audit (and therefore never pass the MOC gate's re-audit).
func TestSheetOnlyRows_ExemptFromCreateOnlyChecks(t *testing.T) {
	req := baseValidRequest()
	req.Deals = append(req.Deals, sheetOnlyOpenXRow("d2"))
	res := RunAudit(&req, req.CampaignID)
	for _, c := range res.Checks {
		if !c.Passed {
			t.Errorf("unexpected failure: %s — %s", c.Rule, c.Message)
		}
	}
	if res.Status != "passed" {
		t.Fatalf("follow-up batch with a sheet-only OpenX row must pass, got %s", res.Status)
	}
	// The OpenX shared-config checks are create-time gates — they must not
	// even be emitted when OpenX appears only on sheet-only rows.
	for _, rule := range []string{"ox_package", "ox_deal_price", "ox_buyers", "ox_fee", "ox_pmp_type"} {
		if c, ok := ruleResult(res.Checks, rule); ok {
			t.Errorf("%s fired for a batch whose only OpenX rows are sheet-only: %+v", rule, c)
		}
	}
}

// deal_names/TotalDeals MUST keep including sheet-only rows: the MOC gate
// requires every audited deal name to appear in the prompt (promptEmbedsName),
// and sheet-only names are embedded via the already_created_for_sheet section.
func TestSheetOnlyRows_StillNamedAndCounted(t *testing.T) {
	req := baseValidRequest()
	row := sheetOnlyOpenXRow("d2")
	req.Deals = append(req.Deals, row)
	res := RunAudit(&req, req.CampaignID)
	if res.TotalDeals != 2 {
		t.Fatalf("TotalDeals must include sheet-only rows, got %d", res.TotalDeals)
	}
	found := false
	for _, n := range res.DealNames {
		if n == row.NameOverride {
			found = true
		}
	}
	if !found {
		t.Fatalf("DealNames must include the sheet-only row's name, got %v", res.DealNames)
	}
}

// The exemption is scoped to sheet-only rows: the SAME row as a create still
// demands the OpenX create config (package name here — Deal Price is optional
// since 2026-08-11: blank falls back to the deal's Floor CPM / $0.10).
func TestSheetOnlyRows_CreateRowsStillEnforced(t *testing.T) {
	req := baseValidRequest()
	row := sheetOnlyOpenXRow("d2")
	row.SheetOnly = false
	row.CPM = "2.50"
	req.Deals = append(req.Deals, row)
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "ox_deal_price"); !ok || !c.Passed {
		t.Fatalf("ox_deal_price must PASS for a blank optional deal price, got %+v (found=%v)", c, ok)
	}
	if c, ok := ruleResult(res.Checks, "ox_package"); !ok || c.Passed {
		t.Fatalf("ox_package must fail for an OpenX create row without a package name, got %+v (found=%v)", c, ok)
	}
	if res.Status != "failed" {
		t.Fatalf("audit must fail when an OpenX CREATE row lacks its config, got %s", res.Status)
	}
}

// Deal Price is optional — but a SET value must parse to a positive number;
// a typo ("abc", "0") is a failure, not a silent 0.10 fallback.
func TestOpenXDealPrice_InvalidValueStillFails(t *testing.T) {
	req := baseValidRequest()
	row := sheetOnlyOpenXRow("d2")
	row.SheetOnly = false
	row.CPM = "2.50"
	req.Deals = append(req.Deals, row)
	req.OpenXConfig.DealPrice = "abc"
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "ox_deal_price"); !ok || c.Passed {
		t.Fatalf("ox_deal_price must fail for an unparseable deal price, got %+v (found=%v)", c, ok)
	}
	req.OpenXConfig.DealPrice = "0"
	res = RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "ox_deal_price"); !ok || c.Passed {
		t.Fatalf("ox_deal_price must fail for a zero deal price, got %+v (found=%v)", c, ok)
	}
}

// CPM/VCR are create-prompt inputs — a sheet-only video row without either
// must not fail; flipping the same row to a create restores both requirements.
func TestSheetOnlyRows_SkipCpmAndVcr(t *testing.T) {
	req := baseValidRequest()
	row := sheetOnlyOpenXRow("d2")
	row.Channel = "OLV (Online Video)"
	req.Deals = append(req.Deals, row)
	res := RunAudit(&req, req.CampaignID)
	for _, rule := range []string{"deal_cpm", "deal_vcr"} {
		if c, ok := ruleResult(res.Checks, rule); ok && !c.Passed {
			t.Errorf("%s fired for a sheet-only row: %+v", rule, c)
		}
	}

	req.Deals[1].SheetOnly = false
	res = RunAudit(&req, req.CampaignID)
	// VCR on a create video row is an ADVISORY (passing) check since
	// 2026-07-15 — a KPI, not a create input; only Media.net has a VCR wire.
	// deal_cpm is also quiet here — an OpenX deal's floor falls back to the
	// shared Deal Price, whose absence is ox_deal_price's single flag (not a
	// per-deal repeat).
	if c, ok := ruleResult(res.Checks, "deal_vcr"); !ok || !c.Passed {
		t.Errorf("deal_vcr must be a passing advisory for a create video row without VCR, got %+v (found=%v)", c, ok)
	}
	// On an SSP with no shared-floor fallback the CPM requirement bites again.
	// (Not PubMatic — since PM-ZOOR-0075 (2026-08-19) PubMatic deals ship no
	// deal-level floor at all, so Xandr is the no-fallback exemplar here.)
	req.Deals[1].SSP = "Xandr"
	res = RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "deal_cpm"); !ok || c.Passed {
		t.Errorf("deal_cpm must fail for a create Xandr video row without CPM, got %+v (found=%v)", c, ok)
	}
}

// The audit must never flag a floor the batch would actually ship: Index
// Exchange defaults a blank floor to the 0.10 IX minimum, and an OpenX deal
// rides the shared Deal Price.
func TestDealCpmFallbacks(t *testing.T) {
	t.Run("IX blank floor passes via the 0.10 default", func(t *testing.T) {
		req := baseValidRequest()
		for i := range req.Deals {
			if strings.EqualFold(req.Deals[i].SSP, "Index Exchange") {
				req.Deals[i].CPM = ""
			}
		}
		req.DefaultDisplayCPM = ""
		req.DefaultVideoCPM = ""
		res := RunAudit(&req, req.CampaignID)
		for _, c := range res.Checks {
			if c.Rule == "deal_cpm" && !c.Passed && strings.Contains(c.FieldPath, "deals[") {
				idx := c.DealIndex
				if idx >= 0 && idx < len(req.Deals) && strings.EqualFold(req.Deals[idx].SSP, "Index Exchange") {
					t.Fatalf("deal_cpm flagged a blank-floor IX deal (ships 0.10): %+v", c)
				}
			}
		}
	})
	t.Run("OpenX blank per-deal floor passes when Deal Price is set", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals = append(req.Deals, DealEntry{ID: "ox1", Theme: "Sports", Channel: "Display", SSP: "OpenX", InventoryType: "All"})
		req.OpenXConfig.DealPrice = "8.50"
		req.OpenXConfig.PackageName = "pkg"
		res := RunAudit(&req, req.CampaignID)
		for _, c := range res.Checks {
			if c.Rule == "deal_cpm" && !c.Passed && c.DealIndex == len(req.Deals)-1 {
				t.Fatalf("deal_cpm flagged an OpenX deal covered by the shared Deal Price: %+v", c)
			}
		}
	})
}

// A sheet-only Magnite DV+ row is exempt from the create-time API constraints:
// sizes gate CREATE calls (the API 422s size-less DV+ creates), and an
// already-live DV+ deal may carry segments applied through the manual UI step.
// The same row as a create still trips both.
func TestSheetOnlyRows_MagniteDVPlusExempt(t *testing.T) {
	req := baseValidRequest()
	req.Deals = append(req.Deals, DealEntry{
		ID:              "d2",
		NameOverride:    "TWC_MG_Rain_Display_live",
		Theme:           "Rain",
		Channel:         "Display",
		SSP:             "Magnite",
		InventoryType:   "All",
		IncludeSegments: []string{"Heavy Rain"},
		SheetOnly:       true,
		// No MagniteSizes — and the request carries no MagniteConfig at all:
		// with no Magnite CREATE rows, marketplace/floor are out of scope too.
	})
	res := RunAudit(&req, req.CampaignID)
	for _, rule := range []string{"mg_marketplace", "mg_sizes", "mg_dvplus_audience", "mg_floor"} {
		if c, ok := ruleResult(res.Checks, rule); ok && !c.Passed {
			t.Errorf("%s fired for a sheet-only Magnite row: %+v", rule, c)
		}
	}
	if res.Status != "passed" {
		for _, c := range res.Checks {
			if !c.Passed {
				t.Logf("failure: %s — %s", c.Rule, c.Message)
			}
		}
		t.Fatalf("batch with a sheet-only Magnite DV+ row must pass, got %s", res.Status)
	}

	req.Deals[1].SheetOnly = false
	res = RunAudit(&req, req.CampaignID)
	for _, rule := range []string{"mg_sizes", "mg_dvplus_audience"} {
		if c, ok := ruleResult(res.Checks, rule); !ok || c.Passed {
			t.Errorf("%s must fail for a Magnite DV+ create row, got %+v (found=%v)", rule, c, ok)
		}
	}
}

// ---------------------------------------------------------------------------
// Multi-DSP expansion (LOCKED product decision): total deals =
// Audiences × Channels × SSPs × DSPs — one deal per selected DSP, each
// carrying that DSP's name-slot code. Override deals never expand.
// ---------------------------------------------------------------------------

func multiDSPRequest() AuditRequest {
	return AuditRequest{
		SubmitterName:      "Jane",
		SubmitterEmail:     "jane@example.com",
		FlightStartDate:    "2099-01-01",
		FlightEndDate:      "2099-12-31",
		Agency:             "Northwind",
		Brand:              "Acme",
		FeeType:            "Percentage of Media",
		CuratedDealFee:     "1.50",
		CampaignID:         "DEAL00500",
		DealSheetRecipient: "trader@example.com",
		MultipleDSPs:       true,
		DSPs: []DSPEntry{
			{ID: "1", DSP: "The Trade Desk", SeatID: "111"},
			{ID: "2", DSP: "DV360", SeatID: "222"},
		},
		DefaultInventoryType: "All",
		Deals: []DealEntry{
			{ID: "d1", Theme: "Digital Consumer", Channel: "Display", SSP: "Index Exchange", CPM: "2.50"},
		},
	}
}

func TestMultiDSPExpansion_TotalDealsAndNames(t *testing.T) {
	req := multiDSPRequest()
	res := RunAudit(&req, req.CampaignID)
	if res.TotalDeals != 2 {
		t.Fatalf("want TotalDeals 2 (1 deal x 2 DSPs), got %d", res.TotalDeals)
	}
	want := []string{
		"Curator_Index_TTD_Northwind_Acme_NA_Digital Consumer_Display_All_Global_DEAL00500_A1",
		"Curator_Index_DV360_Northwind_Acme_NA_Digital Consumer_Display_All_Global_DEAL00500_A1",
	}
	if len(res.DealNames) != 2 || res.DealNames[0] != want[0] || res.DealNames[1] != want[1] {
		t.Fatalf("want expanded names %v, got %v", want, res.DealNames)
	}
}

func TestMultiDSPExpansion_ToggleOffUsesFirstDSPOnly(t *testing.T) {
	req := multiDSPRequest()
	req.MultipleDSPs = false
	res := RunAudit(&req, req.CampaignID)
	if res.TotalDeals != 1 {
		t.Fatalf("want TotalDeals 1 with multipleDsps off, got %d", res.TotalDeals)
	}
	if !strings.Contains(res.DealNames[0], "_TTD_") {
		t.Fatalf("want first-DSP (TTD) name, got %q", res.DealNames[0])
	}
}

func TestMultiDSPExpansion_OverrideDealsDoNotExpand(t *testing.T) {
	req := multiDSPRequest()
	req.Deals = append(req.Deals, DealEntry{
		ID: "d2", NameOverride: "Curator_Index_TTD_Northwind_Acme_NA_Rain_Display_All_US_DEAL00099_A1", Theme: "Rain", Channel: "Display",
		SSP: "Index Exchange", CPM: "2.50",
	})
	res := RunAudit(&req, req.CampaignID)
	// d1 expands to 2 (TTD + DV360); d2 is a single already-named deal.
	if res.TotalDeals != 3 {
		t.Fatalf("want TotalDeals 3 (2 expanded + 1 override), got %d", res.TotalDeals)
	}
	// A name override rides VERBATIM and never expands across DSPs.
	if res.DealNames[2] != "Curator_Index_TTD_Northwind_Acme_NA_Rain_Display_All_US_DEAL00099_A1" {
		t.Fatalf("override must ride verbatim, got %q", res.DealNames[2])
	}
}

func TestMultiDSPExpansion_DuplicateDSPCodesFlagged(t *testing.T) {
	req := multiDSPRequest()
	// TTD and TTD-RTB share the TTD slot code -> identical names -> flagged.
	req.DSPs = []DSPEntry{
		{ID: "1", DSP: "The Trade Desk", SeatID: "111"},
		{ID: "2", DSP: "The Trade Desk - RTB", SeatID: "222"},
	}
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "qa_duplicate_deals")
	if !ok || c.Passed {
		t.Fatalf("want qa_duplicate_deals failure for shared DSP slot codes, got %+v (found=%v)", c, ok)
	}
}

func TestMultiDSPExpansion_SheetOnlyRowsDoNotExpand(t *testing.T) {
	// REGRESSION (PR #184 review): a pre-expansion deal carried as sheetOnly
	// with no nameOverride must yield exactly ONE audited name on the first
	// active DSP — never a fabricated second-DSP "already created" name that
	// would ride the client deal-sheet email.
	req := multiDSPRequest()
	req.Deals = []DealEntry{
		{ID: "d1", Theme: "Live", Channel: "Display", SSP: "Index Exchange", SheetOnly: true},
		{ID: "d2", Theme: "New", Channel: "Display", SSP: "Index Exchange", CPM: "2.50"},
	}
	res := RunAudit(&req, req.CampaignID)
	if res.TotalDeals != 3 {
		t.Fatalf("want TotalDeals 3 (1 sheet-only + 2 expanded creates), got %d: %v", res.TotalDeals, res.DealNames)
	}
	if res.DealNames[0] != "Curator_Index_TTD_Northwind_Acme_NA_Live_Display_All_Global_DEAL00500_A1" {
		t.Fatalf("sheet-only name must ride the FIRST active DSP only, got %q", res.DealNames[0])
	}
	for _, n := range res.DealNames {
		if strings.Contains(n, "_DV360_") && strings.Contains(n, "_Live_") {
			t.Fatalf("fabricated second-DSP sheet-only name generated: %q", n)
		}
	}
}

func TestDealNameCharsetCheck_RejectsControlCharacters(t *testing.T) {
	// A nameOverride with an interior tab passes generation verbatim; the
	// prompt writer escapes it, but moc.go's promptEmbedsName only matches the
	// raw/minimally-escaped name — such a submit would 422 forever. The audit
	// must fail EARLY instead.
	req := multiDSPRequest()
	req.MultipleDSPs = false
	req.Deals[0].NameOverride = "Bad\tName_Index_TTD_A_B_NA_S_Display_All_US_DEAL00500_A1"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "deal_name_charset")
	if !ok || c.Passed {
		t.Fatalf("want failed deal_name_charset check, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, "U+0009") {
		t.Fatalf("check message should name the offending rune, got %q", c.Message)
	}
	// Clean names never trigger it.
	req.Deals[0].NameOverride = ""
	res = RunAudit(&req, req.CampaignID)
	if _, found := ruleResult(res.Checks, "deal_name_charset"); found {
		t.Fatal("deal_name_charset must not fire on clean generated names")
	}
}

func TestChannelCodeCheck_UnrecognizedChannelFails(t *testing.T) {
	req := multiDSPRequest()
	req.MultipleDSPs = false
	req.Deals[0].Channel = "Rich Media"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "channel_code")
	if !ok || c.Passed {
		t.Fatalf("want failed channel_code check for %q, got %+v (found=%v)", req.Deals[0].Channel, c, ok)
	}
	// Recognized channels (any case) pass.
	req.Deals[0].Channel = "OLV (Online Video)"
	res = RunAudit(&req, req.CampaignID)
	if _, found := ruleResult(res.Checks, "channel_code"); found {
		t.Fatal("channel_code must not fire on a recognized channel")
	}
}

func TestDuplicateDSPCodeMessage_NamesTheSharedCode(t *testing.T) {
	req := multiDSPRequest()
	req.DSPs = []DSPEntry{
		{ID: "1", DSP: "The Trade Desk", SeatID: "111"},
		{ID: "2", DSP: "The Trade Desk - RTB", SeatID: "222"},
	}
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "qa_duplicate_deals")
	if !ok || c.Passed {
		t.Fatalf("want qa_duplicate_deals failure, got %+v (found=%v)", c, ok)
	}
	if !strings.Contains(c.Message, `same name code "TTD"`) || !strings.Contains(c.Message, "separate batches") {
		t.Fatalf("message must name the shared DSP code and the workaround, got %q", c.Message)
	}
}

// --- geo_classification (cutlass#724 / #223) -------------------------
// A subnational geo entry that classifies as neither a US state nor a Canadian
// province — or an unknown country name — must fail the audit BEFORE submit
// (the moc.go CREATE re-audit enforces this server-side). Before this rule the
// entries passed the audit and died mid-batch at the SSP MCP, or worse: OpenX
// read a bare "SK" as the country Slovakia.

func geoClassificationFailures(checks []CheckResult) []CheckResult {
	var out []CheckResult
	for _, c := range checks {
		if c.Rule == "geo_classification" && !c.Passed {
			out = append(out, c)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// geo_exclude_unsupported — fail closed on any geo exclusion that cannot ship
// (#219; per-SSP emission #244). Exclusions on the verified
// exclude wires (OpenX/PubMatic/Xandr/Magnite, shape-checked by
// geoExcludeBlockReason) pass; everything else blocks — a create would
// silently drop the exclusion and the deal would serve the excluded geo.
// The fail-closed tests below run on Index Exchange (no exclusion surface)
// and FAIL on the pre-#219 behavior (the audit used to pass and QA claimed
// the exclusion "configured").
// ---------------------------------------------------------------------------

func geoExcludeFailures(checks []CheckResult) []CheckResult {
	var out []CheckResult
	for _, c := range checks {
		if c.Rule == "geo_exclude_unsupported" && !c.Passed {
			out = append(out, c)
		}
	}
	return out
}

func TestAudit_GeoExcludeFailsClosed_ExcludeOnly(t *testing.T) {
	// An "exclude US" brief: no include, one exclude. Old behavior: audit
	// passed and the deal served globally INCLUDING the excluded country.
	req := baseValidRequest()
	req.Deals[0].GeoInclude = nil
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	res := RunAudit(&req, req.CampaignID)
	if res.Status != "failed" {
		t.Fatalf("exclude-only deal must fail the audit closed, got status %q", res.Status)
	}
	failures := geoExcludeFailures(res.Checks)
	if len(failures) != 1 {
		t.Fatalf("want exactly one geo_exclude_unsupported failure, got %+v", failures)
	}
	if failures[0].DealIndex != 0 || failures[0].FieldPath != "deals[0].geoExclude" {
		t.Fatalf("failure must point at deals[0].geoExclude, got %+v", failures[0])
	}
}

func TestAudit_GeoExcludeFailsClosed_IncludePlusExclude(t *testing.T) {
	// "Target US, exclude California": the include ships, the exclude is
	// silently dropped — the deal would SERVE California. Must block.
	req := baseValidRequest()
	req.Deals[0].GeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "g2", Type: "state", Value: "California"}}
	res := RunAudit(&req, req.CampaignID)
	if res.Status != "failed" {
		t.Fatalf("include+exclude deal must fail the audit closed, got status %q", res.Status)
	}
	failures := geoExcludeFailures(res.Checks)
	if len(failures) != 1 || failures[0].FieldPath != "deals[0].geoExclude" {
		t.Fatalf("want one geo_exclude_unsupported failure at deals[0].geoExclude, got %+v", failures)
	}
}

func TestAudit_GeoExcludeFailsClosed_FormDefault(t *testing.T) {
	// The form-level default geo exclude is just as unemittable.
	req := baseValidRequest()
	req.DefaultGeoExclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	res := RunAudit(&req, req.CampaignID)
	if res.Status != "failed" {
		t.Fatalf("defaultGeoExclude must fail the audit closed, got status %q", res.Status)
	}
	failures := geoExcludeFailures(res.Checks)
	if len(failures) != 1 || failures[0].FieldPath != "defaultGeoExclude" {
		t.Fatalf("want one geo_exclude_unsupported failure at defaultGeoExclude, got %+v", failures)
	}
}

func TestAudit_GeoExclude_SheetOnlyExempt(t *testing.T) {
	// Sheet-only rows are never created — nothing drops their exclusions, so
	// a stale exclude on an already-live deal must not block a follow-up batch.
	req := baseValidRequest()
	req.Deals[0].SheetOnly = true
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	res := RunAudit(&req, req.CampaignID)
	if failures := geoExcludeFailures(res.Checks); len(failures) != 0 {
		t.Fatalf("sheet-only deals must be exempt from geo_exclude_unsupported, got %+v", failures)
	}
	check, ok := ruleResult(res.Checks, "geo_exclude_unsupported")
	if !ok || !check.Passed {
		t.Fatalf("expected the passing counterpart to record the rule, got %+v", check)
	}
}

// ---------------------------------------------------------------------------
// #244 — per-SSP geo-exclude EMISSION. Each "ships" case FAILS on the
// pre-fix rule (the empty geoExcludeEmittingSSPs allowlist blocked every
// exclusion); each "blocks" case pins a shape the SSP's wire cannot carry.
// ---------------------------------------------------------------------------

func TestGeoExclude_ShipsOnEmittingSSPs(t *testing.T) {
	cases := []struct {
		name    string
		ssp     string
		include []GeoEntry
		exclude []GeoEntry
	}{
		{"OpenX include-country exclude-state", "OpenX",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}}},
		{"OpenX country-only exclude", "OpenX",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "country", Value: "CA"}}},
		{"PubMatic include-country exclude-state", "PubMatic",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}}},
		{"PubMatic country exclude alongside includes (excludeGeos coexists)", "PubMatic",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "country", Value: "CA"}}},
		{"Xandr include-country exclude-state (region_action compose)", "Xandr",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}}},
		{"Magnite exclude-only country (XOR satisfied)", "Magnite",
			nil,
			[]GeoEntry{{ID: "g2", Type: "country", Value: "CA"}}},
		// geography.country and geography.region are INDEPENDENT components,
		// each with its own Include/Exclude type — live-verified 2026-08-28 on
		// MGNI-MD-449-34286 (include Canada + exclude Quebec, siblings intact).
		{"Magnite include-country exclude-state (component compose)", "Magnite",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "CA"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "Quebec"}}},
		// F3c: PubMatic exclude-state scoped by the include country — a CA
		// province excluded under a CA include resolves (no US default).
		{"PubMatic include-CA exclude-Ontario (CA-scoped)", "PubMatic",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "CA"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "Ontario"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := baseValidRequest()
			req.Deals[0].SSP = tc.ssp
			req.Deals[0].NameOverride = ""
			req.Deals[0].GeoInclude = tc.include
			req.Deals[0].GeoExclude = tc.exclude
			res := RunAudit(&req, req.CampaignID)
			if failures := geoExcludeFailures(res.Checks); len(failures) != 0 {
				t.Fatalf("exclusion on a verified %s exclude wire must ship, got %+v", tc.ssp, failures)
			}
			check, ok := ruleResult(res.Checks, "geo_exclude_unsupported")
			if !ok || !check.Passed {
				t.Fatalf("expected passing geo_exclude_unsupported, got %+v", check)
			}
		})
	}
}

func TestGeoExclude_BlocksUnshippableShapes(t *testing.T) {
	cases := []struct {
		name    string
		ssp     string
		include []GeoEntry
		exclude []GeoEntry
		reason  string
	}{
		{"ZIP exclude has no wire anywhere", "PubMatic",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "zip", Value: "30301"}},
			"zip"},
		{"DMA exclude has no wire anywhere", "OpenX",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "dma", Value: "524"}},
			"dma"},
		{"Magnite state exclude cannot ride alongside state includes", "Magnite",
			[]GeoEntry{{ID: "g1", Type: "state", Value: "Ontario"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "Quebec"}},
			"single Include XOR Exclude component"},
		{"Magnite country XOR conflict", "Magnite",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "country", Value: "CA"}},
			"Include XOR Exclude"},
		{"Xandr country_action conflict", "Xandr",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "country", Value: "CA"}},
			"ONE country_action"},
		{"Xandr region_action conflict", "Xandr",
			[]GeoEntry{{ID: "g1", Type: "state", Value: "New York"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}},
			"ONE region_action"},
		{"OpenX mixed US+CA exclude states", "OpenX",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}, {ID: "g3", Type: "state", Value: "Ontario"}},
			"mixed US and Canadian exclude states"},
		{"OpenX country+state excludes together", "OpenX",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}, {ID: "g3", Type: "country", Value: "CA"}},
			"cannot ship together"},
		// F3c: the SAME unclassifiable-exclude-state shape gate now applies to
		// PubMatic — 'Jersey' would mis-resolve to 'New Jersey' server-side.
		{"PubMatic unclassifiable exclude state", "PubMatic",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "Jersey"}},
			"does not classify"},
		{"PubMatic mixed US+CA exclude states", "PubMatic",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}, {ID: "g3", Type: "state", Value: "Ontario"}},
			"mixed US and Canadian exclude states"},
		{"Media.net vendor-unverified", "Media.net",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "state", Value: "California"}},
			"not emitted on Media.net"},
		{"TripleLift vendor-unconfirmed", "TripleLift",
			[]GeoEntry{{ID: "g1", Type: "country", Value: "US"}},
			[]GeoEntry{{ID: "g2", Type: "country", Value: "CA"}},
			"not emitted on TripleLift"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := baseValidRequest()
			req.Deals[0].SSP = tc.ssp
			req.Deals[0].NameOverride = ""
			req.Deals[0].GeoInclude = tc.include
			req.Deals[0].GeoExclude = tc.exclude
			res := RunAudit(&req, req.CampaignID)
			failures := geoExcludeFailures(res.Checks)
			if len(failures) == 0 {
				t.Fatalf("%s: unshippable exclusion must block, but geo_exclude_unsupported passed", tc.name)
			}
			if !strings.Contains(failures[0].Message, tc.reason) {
				t.Fatalf("%s: block message must carry the shape reason %q, got %q", tc.name, tc.reason, failures[0].Message)
			}
		})
	}
}

func TestGeoExclude_DefaultInheritedPerDealSSP(t *testing.T) {
	// The form default is validated per inheriting deal (mirroring resolve()'s
	// per-deal fallback): an emitting-SSP deal ships it, a fail-closed-SSP
	// deal blocks with the FieldPath pointing at the default.
	req := baseValidRequest()
	req.Deals[0].SSP = "PubMatic"
	req.Deals[0].NameOverride = ""
	req.Deals[0].GeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	req.DefaultGeoExclude = []GeoEntry{{ID: "gx", Type: "country", Value: "CA"}}
	res := RunAudit(&req, req.CampaignID)
	if failures := geoExcludeFailures(res.Checks); len(failures) != 0 {
		t.Fatalf("default exclusion inherited by a PubMatic deal must ship, got %+v", failures)
	}

	req.Deals[0].SSP = "Index Exchange"
	res = RunAudit(&req, req.CampaignID)
	failures := geoExcludeFailures(res.Checks)
	if len(failures) != 1 || failures[0].FieldPath != "defaultGeoExclude" {
		t.Fatalf("default exclusion inherited by an IX deal must block at defaultGeoExclude, got %+v", failures)
	}
}

// ---------------------------------------------------------------------------
// #226 F2 — audience segment EXCLUSIONS fail closed by SSP capability
// + provenance. The panel killed the old emit-and-create-WITHOUT behavior:
// an exclusion on an SSP that can't ENFORCE it now BLOCKS the (deal, SSP).
// These tests FAIL on the pre-fix rule (there was none — OpenX soft-flagged
// and created without the exclusion).
// ---------------------------------------------------------------------------

func segExcludeFailures(checks []CheckResult) []CheckResult {
	var out []CheckResult
	for _, c := range checks {
		if c.Rule == "segment_exclude_unsupported" && !c.Passed {
			out = append(out, c)
		}
	}
	return out
}

func TestExclusionOverride_TraderAudienceAndGeoPassWithCanonicalDetails(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "OpenX"
	req.Deals[0].NameOverride = ""
	req.Deals[0].ExcludeSegments = []string{"Blocked Audience"}
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "gx", Type: "zip", Value: "90210"}}
	req.Deals[0].ExclusionOverride = &ExclusionOverride{SSP: "OpenX", Acknowledgement: ExclusionOverridePhrase("OpenX")}
	res := RunAudit(&req, req.CampaignID)
	if failures := segExcludeFailures(res.Checks); len(failures) != 0 {
		t.Fatalf("typed trader override should clear audience block, got %+v", failures)
	}
	if failures := geoExcludeFailures(res.Checks); len(failures) != 0 {
		t.Fatalf("typed trader override should clear geo block, got %+v", failures)
	}
	detail, ok := ActiveExclusionOverride(req.Deals[0], &req)
	if !ok || len(detail.Audience) != 1 || detail.Audience[0] != "Blocked Audience" || len(detail.Geo) != 1 || detail.Geo[0] != "zip:90210" || detail.Source != "trader" {
		t.Fatalf("canonical override details wrong: ok=%v detail=%+v", ok, detail)
	}
}

func TestExclusionOverride_WrongPhraseOrSSPStillBlocks(t *testing.T) {
	for _, ov := range []*ExclusionOverride{
		{SSP: "OpenX", Acknowledgement: "yes"},
		{SSP: "PubMatic", Acknowledgement: ExclusionOverridePhrase("PubMatic")},
	} {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.Deals[0].NameOverride = ""
		req.Deals[0].ExcludeSegments = []string{"Blocked Audience"}
		req.Deals[0].ExclusionOverride = ov
		if failures := segExcludeFailures(RunAudit(&req, req.CampaignID).Checks); len(failures) != 1 {
			t.Fatalf("stale/noncanonical override must fail closed (%+v), got %+v", ov, failures)
		}
	}
}

func TestSegmentExclude_TraderExcludeBlocksUnknownVendor(t *testing.T) {
	// UNKNOWN vendors (Media.net / TripleLift) are treated as UNSUPPORTED —
	// a trader exclude blocks fail-closed (never inferred-supported).
	for _, ssp := range []string{"Media.net", "TripleLift"} {
		req := baseValidRequest()
		req.Deals[0].SSP = ssp
		req.Deals[0].NameOverride = ""
		req.Deals[0].ExcludeSegments = []string{"Competitor Audience"}
		res := RunAudit(&req, req.CampaignID)
		failures := segExcludeFailures(res.Checks)
		if len(failures) != 1 {
			t.Fatalf("%s: a trader exclude must block (unknown→unsupported), got %+v", ssp, failures)
		}
		if !strings.Contains(failures[0].Message, "SERVE the excluded audience") {
			t.Fatalf("%s: block must state the drop risk, got %q", ssp, failures[0].Message)
		}
	}
}

func TestSegmentExclude_MagniteChannelDependent(t *testing.T) {
	// Magnite CTV (SpringServe) ENFORCES excludes → ships; DV+ has no audience
	// API → blocks.
	req := baseValidRequest()
	req.Deals[0].SSP = "Magnite"
	req.Deals[0].NameOverride = ""
	req.Deals[0].Channel = "CTV"
	req.Deals[0].VCR = "80"
	req.Deals[0].ExcludeSegments = []string{"Bad Audience"}
	res := RunAudit(&req, req.CampaignID)
	if failures := segExcludeFailures(res.Checks); len(failures) != 0 {
		t.Fatalf("Magnite CTV enforces excludes (audience_segments_block) — must NOT block, got %+v", failures)
	}

	req.Deals[0].Channel = "Display"
	req.Deals[0].VCR = ""
	res = RunAudit(&req, req.CampaignID)
	if failures := segExcludeFailures(res.Checks); len(failures) != 1 {
		t.Fatalf("Magnite DV+ has no audience API — a trader exclude must block, got %+v", failures)
	}
}

func TestSegmentExclude_SupportedSSPsPass(t *testing.T) {
	// IX / PubMatic / Xandr enforce excludes on the create wire — never block.
	for _, ssp := range []string{"Index Exchange", "PubMatic", "Xandr"} {
		req := baseValidRequest()
		req.Deals[0].SSP = ssp
		req.Deals[0].NameOverride = ""
		req.Deals[0].ExcludeSegments = []string{"Bad Audience"}
		res := RunAudit(&req, req.CampaignID)
		if failures := segExcludeFailures(res.Checks); len(failures) != 0 {
			t.Fatalf("%s enforces excludes — must NOT block, got %+v", ssp, failures)
		}
	}
}

// #244 F1 MUST-FIX 2 — the Go classifier already collapses inner
// whitespace (normalizeGeoToken); this pins that it matches the TS
// classifyGeoState fix so an inner-whitespace exclude state can never
// classify US in Go (audit passes) while TS buckets it unknown (silent drop).
func TestClassifyGeoState_CollapsesInnerWhitespace(t *testing.T) {
	cases := map[string]string{
		"New  York":          "us",
		"new   york":         "us",
		"British   Columbia": "ca",
	}
	for in, want := range cases {
		if got := classifyGeoState(in); got != want {
			t.Errorf("classifyGeoState(%q) = %q, want %q (must match the TS classifier)", in, got, want)
		}
	}
}

// An inner-whitespace exclude state must SHIP on PubMatic (geoExcludeBlockReason
// returns "") — matching the TS builder's emission — never a false block or a
// silent TS-side drop.
func TestGeoExclude_InnerWhitespaceStateShips(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "PubMatic"
	req.Deals[0].NameOverride = ""
	req.Deals[0].GeoInclude = []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}
	req.Deals[0].GeoExclude = []GeoEntry{{ID: "g2", Type: "state", Value: "New  York"}}
	if reason := geoExcludeBlockReason(req.Deals[0], &req); reason != "" {
		t.Fatalf("inner-whitespace exclude state must ship (TS emits it), got block: %q", reason)
	}
}

// =============================================================================
// #238.3 — client_reporting_labels externalReferenceID must cover EVERY create
// row, not ANY. Pre-fix a partially-referenced batch passed the blocking
// audit and the un-referenced deals booked with no externalReferenceID label.
// =============================================================================

// =============================================================================
// #214 — list_client_scope: a client-tagged standard list applied to another
// client's batch (or a no-client batch) is a BLOCKING failure. Untagged lists
// stay org-wide. Tags arrive via the server-side standard-list fold
// (handlers.asUploadedFile), modeled here directly on the UploadedFile.
// =============================================================================

// TestPublisherAllowlistRules covers the "specific publishers only" fields:
// PubMatic entries satisfy pm_publishers, OpenX entries must be id-bearing,
// and OpenX include+exclude on one batch is a hard conflict.
func TestPublisherAllowlistRules(t *testing.T) {
	t.Run("pm_entries_satisfy_publishers_rule", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "PubMatic"
		req.PubMaticConfig = PubMaticConfig{
			MaxReach:         false,
			PublisherEntries: []PublisherAllowlistEntry{{ID: "161578", Name: "Paramount - Springserve"}},
		}
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "pm_publishers"); !ok || !c.Passed {
			t.Fatalf("entries should satisfy pm_publishers, got %+v", c)
		}
	})

	t.Run("pm_blank_entries_fall_back_to_names", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "PubMatic"
		req.PubMaticConfig = PubMaticConfig{
			MaxReach:         false,
			PublisherEntries: []PublisherAllowlistEntry{{ID: " ", Name: ""}},
			PublisherNames:   []string{"Roku - oRTB"},
		}
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "pm_publishers"); !ok || !c.Passed {
			t.Fatalf("legacy names should still satisfy pm_publishers, got %+v", c)
		}
	})

	boolPtr := func(b bool) *bool { return &b }

	t.Run("ox_name_only_entries_fail", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.OpenXConfig.AllPublishers = boolPtr(false)
		req.OpenXConfig.PublisherEntries = []PublisherAllowlistEntry{{ID: "557339752"}, {Name: "Adevinta - Italy"}}
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ox_publisher_ids"); !ok || c.Passed {
			t.Fatalf("name-only OX entry must fail ox_publisher_ids, got %+v", c)
		}
		if !failedPathPresent(res.Checks, "openxConfig.publisherEntries") {
			t.Error("ox_publisher_ids failure must carry openxConfig.publisherEntries")
		}
	})

	t.Run("ox_id_entries_pass", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.OpenXConfig.AllPublishers = boolPtr(false)
		req.OpenXConfig.PublisherEntries = []PublisherAllowlistEntry{{ID: "557339752", Name: "GAM UNDESTO S.L. - CTA"}}
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ox_publisher_ids"); !ok || !c.Passed {
			t.Fatalf("id-bearing OX allowlist should pass, got %+v", c)
		}
		if _, ok := ruleResult(res.Checks, "ox_publisher_conflict"); ok {
			t.Error("no exclude list — conflict check must not appear")
		}
	})

	t.Run("ox_include_exclude_conflict", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.OpenXConfig.AllPublishers = boolPtr(false)
		req.OpenXConfig.PublisherEntries = []PublisherAllowlistEntry{{ID: "557339752"}}
		req.OpenXConfig.ExcludedPublisherIds = []string{"541153841"}
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ox_publisher_conflict"); !ok || c.Passed {
			t.Fatalf("include+exclude must fail ox_publisher_conflict, got %+v", c)
		}
	})

	t.Run("no_allowlist_no_new_checks", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		// Toggle ON (default): entries are inert and no publisher checks fire.
		req.OpenXConfig.PublisherEntries = []PublisherAllowlistEntry{{Name: "leftover"}}
		res := RunAudit(&req, req.CampaignID)
		if _, ok := ruleResult(res.Checks, "ox_publisher_ids"); ok {
			t.Error("ox_publisher_ids must not appear when Max publishers is on")
		}
		if _, ok := ruleResult(res.Checks, "ox_publisher_conflict"); ok {
			t.Error("ox_publisher_conflict must not appear when Max publishers is on")
		}
		if _, ok := ruleResult(res.Checks, "ox_publishers"); ok {
			t.Error("ox_publishers must not appear when Max publishers is on")
		}
	})

	t.Run("ox_toggle_off_requires_entries", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		req.OpenXConfig.AllPublishers = boolPtr(false)
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ox_publishers"); !ok || c.Passed {
			t.Fatalf("OX toggle off with no entries must fail, got %+v", c)
		}
	})

	t.Run("ix_toggle_off_requires_entries", func(t *testing.T) {
		req := baseValidRequest()
		req.IXConfig.AllPublishers = boolPtr(false)
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ix_publishers"); !ok || c.Passed {
			t.Fatalf("IX toggle off with no entries must fail, got %+v", c)
		}
		req.IXConfig.PublisherEntries = []PublisherAllowlistEntry{{ID: "185106", Name: "Gizmag Pty Ltd"}}
		res = RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ix_publishers"); !ok || !c.Passed {
			t.Fatalf("IX toggle off with entries should pass, got %+v", c)
		}
	})

	t.Run("mg_toggle_absent_keeps_ALL", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "Magnite"
		req.MagniteConfig.Marketplace = "Example CTV"
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "mg_publishers")
		if !ok || !c.Passed || !strings.Contains(c.Message, "ALL") {
			t.Fatalf("absent toggle must keep the ALL policy, got %+v", c)
		}
	})

	t.Run("mg_toggle_off_requires_entries", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "Magnite"
		req.MagniteConfig.Marketplace = "Example CTV"
		req.MagniteConfig.AllPublishers = boolPtr(false)
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "mg_publishers"); !ok || c.Passed {
			t.Fatalf("toggle off with no entries must fail, got %+v", c)
		}
		if !failedPathPresent(res.Checks, "magniteConfig.publisherEntries") {
			t.Error("failure must carry magniteConfig.publisherEntries")
		}

		req.MagniteConfig.PublisherEntries = []PublisherAllowlistEntry{{ID: "60315", Name: "Paramount"}, {Name: "Tubi"}}
		res = RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "mg_publishers")
		if !ok || !c.Passed || !strings.Contains(c.Message, "explicit allowlist (2 publishers)") {
			t.Fatalf("toggle off with entries should pass loudly, got %+v", c)
		}
	})

	t.Run("allowlist_coverage_flags_open_ssps", func(t *testing.T) {
		req := baseValidRequest()
		req.Deals[0].SSP = "OpenX"
		second := req.Deals[0]
		second.ID = "d2"
		second.SSP = "Magnite"
		req.Deals = append(req.Deals, second)
		req.MagniteConfig.Marketplace = "Example CTV"
		req.OpenXConfig.AllPublishers = boolPtr(false)
		req.OpenXConfig.PublisherEntries = []PublisherAllowlistEntry{{ID: "557339752"}}
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "allowlist_coverage")
		if !ok || !c.Passed {
			t.Fatalf("coverage check must appear when any SSP is allowlisted, got %+v", c)
		}
		if !strings.Contains(c.Message, "OpenX: allowlist (1 publishers)") {
			t.Errorf("coverage message missing OpenX status: %s", c.Message)
		}
		if !strings.Contains(c.Message, "Magnite: OPEN") {
			t.Errorf("coverage message must flag the open Magnite side: %s", c.Message)
		}
	})

	t.Run("allowlist_coverage_absent_without_allowlists", func(t *testing.T) {
		req := baseValidRequest()
		res := RunAudit(&req, req.CampaignID)
		if _, ok := ruleResult(res.Checks, "allowlist_coverage"); ok {
			t.Error("coverage check must not appear when nothing is allowlisted")
		}
	})
}

// TestSeatMulti_MultiSeatConfinedToMagnite: a trader pins ONE deal to several
// buyer seats by entering them comma-separated. Only Magnite consumes a buyer
// LIST (dsps[i].buyers, each ref resolved independently by the ClearLine MCP);
// every other SSP carries a single seat token and would ship the whole comma
// string as one unresolvable value. DEAL07303 (one live batch, 14 DV360
// buyers) is the live case.
func TestSeatMulti_MultiSeatConfinedToMagnite(t *testing.T) {
	const multi = "1413973141,850299280,134,163531"

	magniteDeal := func() DealEntry {
		return DealEntry{
			ID: "m1", Theme: "RON", Channel: "CTV", SSP: "Magnite",
			InventoryType: "All", CPM: "25",
		}
	}

	t.Run("magnite_only_batch_passes_and_reports_the_count", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "DV360", SeatID: multi}}
		req.Deals = []DealEntry{magniteDeal()}
		req.MagniteConfig = MagniteConfig{Marketplace: "Example"}
		c, ok := ruleResult(RunAudit(&req, req.CampaignID).Checks, "seat_multi")
		if !ok {
			t.Fatal("no seat_multi check emitted for a multi-seat Magnite batch")
		}
		if !c.Passed {
			t.Fatalf("expected seat_multi to pass on a Magnite-only batch, got %+v", c)
		}
		if !strings.Contains(c.Message, "4") {
			t.Errorf("expected the seat count in the receipt, got %q", c.Message)
		}
	})

	t.Run("non_magnite_create_row_blocks", func(t *testing.T) {
		req := baseValidRequest() // base deal is an Index Exchange create row
		req.DSPs = []DSPEntry{{ID: "1", DSP: "DV360", SeatID: multi}}
		c, ok := ruleResult(RunAudit(&req, req.CampaignID).Checks, "seat_multi")
		if !ok {
			t.Fatal("no seat_multi check emitted for a multi-seat IX batch")
		}
		if c.Passed {
			t.Fatal("expected seat_multi to FAIL: IX carries a single seat token")
		}
		if !strings.Contains(c.Message, "Index Exchange") {
			t.Errorf("expected the blocking SSP named in the message, got %q", c.Message)
		}
		if c.FieldPath != "dsps[0].seatId" {
			t.Errorf("expected the offending seat field path, got %q", c.FieldPath)
		}
	})

	t.Run("mixed_batch_blocks_even_though_magnite_is_present", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "DV360", SeatID: multi}}
		req.Deals = append(req.Deals, magniteDeal())
		req.MagniteConfig = MagniteConfig{Marketplace: "Example"}
		c, _ := ruleResult(RunAudit(&req, req.CampaignID).Checks, "seat_multi")
		if c.Passed {
			t.Fatal("expected seat_multi to FAIL: the IX row in the batch still gets the comma blob")
		}
	})

	t.Run("sheet_only_rows_never_block", func(t *testing.T) {
		req := baseValidRequest()
		req.DSPs = []DSPEntry{{ID: "1", DSP: "DV360", SeatID: multi}}
		req.Deals[0].SheetOnly = true // IX row creates nothing this batch
		req.Deals = append(req.Deals, magniteDeal())
		req.MagniteConfig = MagniteConfig{Marketplace: "Example"}
		if c, _ := ruleResult(RunAudit(&req, req.CampaignID).Checks, "seat_multi"); !c.Passed {
			t.Fatalf("expected seat_multi to pass — the IX row is sheet-only, got %+v", c)
		}
	})

	t.Run("single_seat_emits_no_check", func(t *testing.T) {
		req := baseValidRequest()
		if _, ok := ruleResult(RunAudit(&req, req.CampaignID).Checks, "seat_multi"); ok {
			t.Fatal("seat_multi must stay silent for an ordinary single-seat batch")
		}
	})
}

// SplitSeatIDs is pinned to its TS twin (splitSeatIds in
// frontend/src/lib/seatPolicy.ts) — the Go audit decides whether a multi-seat
// value is allowed and the TS builder decides what ships, so they must agree
// token-for-token. Mirror of seatPolicy.test.ts.
func TestSplitSeatIDs(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"393", []string{"393"}},
		{"House Seat", []string{"House Seat"}},
		{"1413973141,850299280, 134 ,163531", []string{"1413973141", "850299280", "134", "163531"}},
		// The strip runs PER TOKEN: the legacy whole-string form is greedy and
		// would have collapsed everything before the LAST slash.
		{"acct/393,other/394", []string{"393", "394"}},
		{"393,,394, 393 ,", []string{"393", "394"}},
		{"", nil},
		{"  ,  ", nil},
	}
	for _, tc := range cases {
		got := SplitSeatIDs(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("SplitSeatIDs(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("SplitSeatIDs(%q) = %v, want %v", tc.in, got, tc.want)
				break
			}
		}
	}
}

// A blank TripleLift Channel is the DEFAULT, not an omission: it tells the
// prompt builder to derive the pool from each deal's own channel. Only a
// value that is neither blank nor WEB/CTV is a real failure.
func TestTripleLiftChannelAuto(t *testing.T) {
	for _, tc := range []struct {
		name    string
		channel string
		wantOK  bool
	}{
		{"blank derives per deal", "", true},
		{"forced web", "WEB", true},
		{"forced ctv", "ctv", true},
		{"garbage", "MOBILE", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := baseValidRequest()
			req.Deals[0].SSP = "TripleLift"
			req.TripleLiftConfig = TripleLiftConfig{DealPriceType: "FLOOR", Channel: tc.channel}
			res := RunAudit(&req, req.CampaignID)
			failed := failedPathPresent(res.Checks, "tripleliftConfig.channel")
			if failed == tc.wantOK {
				t.Errorf("channel %q: tl_channel failed=%v, want failure=%v", tc.channel, failed, !tc.wantOK)
			}
		})
	}
}

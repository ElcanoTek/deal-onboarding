// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package validation

// Batch-3 money/date/targeting-truth rules (#234.1, #235.1,
// #233.7/#233.8). Each blocking/warn case here FAILED on the pre-fix code:
// non-percent fee types audited green while every builder emitted a percent
// margin; "today" resolved on the server-local (prod: UTC) calendar; and
// include-states on stateless SSPs produced a false-green qa_geo plus a lying
// name Geo slot.

import (
	"strings"
	"testing"
	"time"
)

func feeWireRequest(feeType string) AuditRequest {
	req := baseValidRequest()
	req.FeeType = feeType
	return req
}

func TestFeeTypeWire_NonPercentBlocksCreates(t *testing.T) {
	// FAILS OLD: feeType was only completeness-checked — a 'Flat Fee' 5000
	// batch audited green while every SSP builder emitted a 5000% margin.
	for _, feeType := range []string{"Flat Fee", "Fixed CPM"} {
		req := feeWireRequest(feeType)
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "fee_type_wire")
		if !ok {
			t.Fatalf("fee_type_wire check missing for feeType=%q", feeType)
		}
		if c.Passed {
			t.Errorf("feeType=%q must FAIL fee_type_wire (no verified non-percent wire on any SSP), got pass", feeType)
		}
		if !strings.Contains(c.Message, "PERCENT margin") || !strings.Contains(c.Message, "#234.1") {
			t.Errorf("fee_type_wire message should explain the percent-wire mis-booking, got %q", c.Message)
		}
		if res.Status != "failed" {
			t.Errorf("audit status should be failed for feeType=%q, got %q", feeType, res.Status)
		}
	}
}

func TestFeeTypeWire_PercentAndUnsetPass(t *testing.T) {
	for _, feeType := range []string{"Percentage of Media", "percentage of media"} {
		req := feeWireRequest(feeType)
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "fee_type_wire")
		if !ok || !c.Passed {
			t.Errorf("feeType=%q must pass fee_type_wire, got %+v (found=%v)", feeType, c, ok)
		}
	}
	// Empty feeType: the completeness rule owns that gap — fee_type_wire must
	// not double-fail it.
	req := feeWireRequest("")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "fee_type_wire"); !ok || !c.Passed {
		t.Errorf("empty feeType must pass fee_type_wire (completeness owns it), got %+v (found=%v)", c, ok)
	}
}

func TestFeeTypeWire_SheetOnlyBatchPasses(t *testing.T) {
	// A batch that creates nothing (every row already live, riding the deal
	// sheet only) books no margin — a non-percent fee type must not block it.
	req := feeWireRequest("Flat Fee")
	for i := range req.Deals {
		req.Deals[i].SheetOnly = true
	}
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "fee_type_wire"); !ok || !c.Passed {
		t.Errorf("sheet-only batch must pass fee_type_wire, got %+v (found=%v)", c, ok)
	}
}

func TestDateLogic_TodayResolvesInBusinessTimezone(t *testing.T) {
	// 2026-07-11T02:00Z == 2026-07-10 22:00 EDT. FAILS OLD whenever the
	// server clock runs UTC (prod): time.Now() said the 11th, so a trader's
	// same-evening start of 2026-07-10 was rejected as "in the past" while
	// the frontend (post-#235.1) still called it today.
	orig := nowFunc
	nowFunc = func() time.Time { return time.Date(2026, 7, 11, 2, 0, 0, 0, time.UTC) }
	defer func() { nowFunc = orig }()

	req := feeWireRequest("Percentage of Media")
	req.FlightStartDate = "2026-07-10"
	req.FlightEndDate = "2026-12-31"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "date_logic")
	if !ok || !c.Passed {
		t.Fatalf("evening-ET 'today' (%s) must pass date_logic (business tz = America/New_York), got %+v (found=%v)", req.FlightStartDate, c, ok)
	}

	// And yesterday-in-ET must still fail.
	req.FlightStartDate = "2026-07-09"
	res = RunAudit(&req, req.CampaignID)
	if c, _ := ruleResult(res.Checks, "date_logic"); c.Passed {
		t.Errorf("a genuinely past start date must still fail date_logic")
	}
}

func TestPrimaryGeoForSSP_StatelessSSPsFallBackToCountry(t *testing.T) {
	geos := []GeoEntry{
		{ID: "g1", Type: "country", Value: "US"},
		{ID: "g2", Type: "state", Value: "CA"},
	}
	// FAILS OLD: primaryGeo returned "CA" regardless of SSP — the name's Geo
	// slot claimed a state IX/Media.net never targeted (#233.8).
	for _, ssp := range []string{"Index Exchange", "Media.net", "media.net", "INDEX EXCHANGE"} {
		if got := primaryGeoForSSP(geos, ssp); got != "US" {
			t.Errorf("primaryGeoForSSP(%q) = %q, want US (states never reach the wire)", ssp, got)
		}
	}
	// State-capable SSPs keep the state-first workbook rule.
	for _, ssp := range []string{"OpenX", "PubMatic", "Xandr", "Magnite", "TripleLift", ""} {
		if got := primaryGeoForSSP(geos, ssp); got != "CA" {
			t.Errorf("primaryGeoForSSP(%q) = %q, want CA (state wire exists)", ssp, got)
		}
	}
	// State-only geo on a stateless SSP resolves to "" (caller falls back to
	// Global) — the deal genuinely serves globally.
	stateOnly := []GeoEntry{{ID: "g1", Type: "state", Value: "CA"}}
	if got := primaryGeoForSSP(stateOnly, "Index Exchange"); got != "" {
		t.Errorf("state-only IX geo should resolve empty (Global), got %q", got)
	}
}

func TestQAGeo_WarnsOnIncludeStatesForStatelessSSP(t *testing.T) {
	// FAILS OLD: qa_geo reported PASS "Geo targeting: CA" for an IX deal whose
	// create never carried the state — a false green over a country-wide deal.
	req := feeWireRequest("Percentage of Media")
	req.Deals[0].GeoInclude = []GeoEntry{
		{ID: "g1", Type: "country", Value: "US"},
		{ID: "g2", Type: "state", Value: "CA"},
	}
	res := RunAudit(&req, req.CampaignID)
	var geoItem *QAItem
	for _, sec := range res.QA.Sections {
		for i := range sec.Items {
			if sec.Items[i].ID == "qa_geo" {
				geoItem = &sec.Items[i]
			}
		}
	}
	if geoItem == nil {
		t.Fatal("qa_geo item missing")
	}
	if geoItem.Status != QAWarn {
		t.Fatalf("qa_geo must WARN for include-states on Index Exchange, got %q (detail: %s)", geoItem.Status, geoItem.Detail)
	}
	if !strings.Contains(geoItem.Detail, "NOT APPLIED") || !strings.Contains(geoItem.Detail, "CA") {
		t.Errorf("qa_geo detail should name the dropped state and NOT APPLIED, got %q", geoItem.Detail)
	}
}

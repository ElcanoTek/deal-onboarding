// All rights reserved. This is a private repository.

package validation

import (
	"strings"
	"testing"
)

// mnBaseRequest returns a minimal audit request with Media.net create deals —
// the mn_deal_id tuple check is what these tests exercise, so unrelated rules
// may fail without affecting them.
func mnBaseRequest(deals []DealEntry) AuditRequest {
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
		MediaNetConfig:     MediaNetConfig{MarginType: "Percentage (1)", MarginValue: "25"},
		Deals:              deals,
	}
}

func mnFailures(checks []CheckResult) []CheckResult {
	var out []CheckResult
	for _, c := range checks {
		if c.Rule == "mn_deal_id" && !c.Passed {
			out = append(out, c)
		}
	}
	return out
}

func TestMNDealID_TupleCollisionFails(t *testing.T) {
	// Two MN Display deals, same theme, same inventory + geo — the exact
	// deal_id collision cutlass cannot catch (it validates format only).
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50"},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50"},
	})
	res := RunAudit(&req, req.CampaignID)
	fails := mnFailures(res.Checks)
	if len(fails) != 1 {
		t.Fatalf("expected exactly one mn_deal_id failure, got %d: %+v", len(fails), fails)
	}
	if !strings.Contains(fails[0].Message, "Deal 1 and Deal 2") {
		t.Errorf("collision message should name both deals, got %q", fails[0].Message)
	}
	if fails[0].DealIndex != 1 {
		t.Errorf("DealIndex should point at the second (colliding) deal, got %d", fails[0].DealIndex)
	}
}

func TestMNDealID_InventoryDifferentiates(t *testing.T) {
	// Web vs In-App with the same theme was the observed production collision
	// (the old slug seed stopped at channel) — the tuple check must treat the
	// inventory slot as differentiating.
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "Web Only", CPM: "2.50"},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "In-App", CPM: "2.50"},
	})
	res := RunAudit(&req, req.CampaignID)
	if fails := mnFailures(res.Checks); len(fails) != 0 {
		t.Fatalf("inventory-differentiated deals must not collide: %+v", fails)
	}
	c, ok := ruleResult(res.Checks, "mn_deal_id")
	if !ok || !c.Passed {
		t.Fatalf("expected passing mn_deal_id check, got %+v (found=%v)", c, ok)
	}
}

func TestMNDealID_GeoDifferentiates(t *testing.T) {
	// COUNTRY geo differentiates — countries are the only geo granularity the
	// Media.net create wire carries (#233.8).
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50",
			GeoInclude: []GeoEntry{{ID: "g1", Type: "country", Value: "US"}}},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50",
			GeoInclude: []GeoEntry{{ID: "g2", Type: "country", Value: "GB"}}},
	})
	res := RunAudit(&req, req.CampaignID)
	if fails := mnFailures(res.Checks); len(fails) != 0 {
		t.Fatalf("geo-differentiated deals must not collide: %+v", fails)
	}
}

func TestMNDealID_StateGeoDoesNotDifferentiate(t *testing.T) {
	// FAILS OLD (#233.7/#233.8): Media.net has no include-state wire —
	// a state entry never reaches the created deal, so it no longer reaches
	// the deal_id/name Geo slot either. Two MN deals differing ONLY by state
	// are therefore the SAME Media.net deal and must collide (the old
	// state-differentiated ids masked two identical live deals).
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50",
			GeoInclude: []GeoEntry{{ID: "g1", Type: "state", Value: "CA"}}},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50",
			GeoInclude: []GeoEntry{{ID: "g2", Type: "state", Value: "NY"}}},
	})
	res := RunAudit(&req, req.CampaignID)
	fails := mnFailures(res.Checks)
	if len(fails) != 1 {
		t.Fatalf("state-only-differentiated MN deals must collide (states never reach the wire), got %d failures: %+v", len(fails), fails)
	}
}

func TestMNDealID_MultiDSPExpansionCollides(t *testing.T) {
	// Two identical MN rows under multi-DSP expansion collide per DSP code —
	// two failures (TTD vs TTD, DV360 vs DV360), not one.
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50"},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50"},
	})
	req.MultipleDSPs = true
	req.DSPs = []DSPEntry{{DSP: "The Trade Desk", SeatID: "111"}, {DSP: "DV360", SeatID: "222"}}
	res := RunAudit(&req, req.CampaignID)
	if fails := mnFailures(res.Checks); len(fails) != 2 {
		t.Fatalf("expected two per-DSP mn_deal_id failures, got %d: %+v", len(fails), fails)
	}
}

func TestMNDealID_SheetOnlyRowsExempt(t *testing.T) {
	// A sheet-only row is never created — it builds no deal_id, so it cannot
	// collide with a create row.
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", CPM: "2.50"},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Media.net", InventoryType: "All", SheetOnly: true},
	})
	res := RunAudit(&req, req.CampaignID)
	if fails := mnFailures(res.Checks); len(fails) != 0 {
		t.Fatalf("sheet-only rows must be exempt: %+v", fails)
	}
}

func TestMNDealID_OtherSSPsNotChecked(t *testing.T) {
	// Identical IX rows are qa_duplicate_deals territory — mn_deal_id must not
	// fire (and must not even emit a pass) for a batch with no MN create.
	req := mnBaseRequest([]DealEntry{
		{ID: "d1", Theme: "Pets", Channel: "Display", SSP: "Index Exchange", InventoryType: "All", CPM: "2.50"},
		{ID: "d2", Theme: "Pets", Channel: "Display", SSP: "Index Exchange", InventoryType: "All", CPM: "2.50"},
	})
	res := RunAudit(&req, req.CampaignID)
	if _, ok := ruleResult(res.Checks, "mn_deal_id"); ok {
		t.Fatal("mn_deal_id must not be emitted for batches without Media.net create rows")
	}
}

// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// All rights reserved. This is a private repository.

package validation

import (
	"strings"
	"testing"
)

// These rules exist because of the DEAL07253 E2E run (2026-07-20): two IX
// deals shipped floors of 0.08/0.07 (both 422'd at the SSP), and the trader's
// domain block list uploaded to the task without any deal's prompt
// referencing it. All three failure shapes must now fail the audit — and
// therefore the /api/runner/create gate — before a batch reaches the runner.

func strPtr(s string) *string { return &s }

// --- ix_floor -----------------------------------------------------------

func TestIXFloor_FailsBelowMinimum(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].CPM = "0.08"
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "ix_floor")
	if !ok || c.Passed {
		t.Fatalf("ix_floor must fail for an IX deal at 0.08, got %+v", c)
	}
	if c.DealIndex != 0 || c.FieldPath != "deals[0].cpm" {
		t.Fatalf("ix_floor must anchor to the deal's cpm field, got %+v", c)
	}
	if !strings.Contains(c.Message, "0.08") || !strings.Contains(c.Message, "$0.10") {
		t.Fatalf("ix_floor message must carry the value and the minimum, got %q", c.Message)
	}
}

func TestIXFloor_FallsBackToChannelDefault(t *testing.T) {
	// A blank per-deal CPM resolves through the channel default — a
	// sub-minimum default must fail the same way (DEAL07253 shipped the
	// defaults, not per-deal values).
	req := baseValidRequest()
	req.Deals[0].CPM = ""
	req.DefaultDisplayCPM = "0.07"
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "ix_floor"); !ok || c.Passed {
		t.Fatalf("ix_floor must fail when the channel default is sub-minimum, got %+v", c)
	}
}

func TestIXFloor_PassesAtMinimumAndAbove(t *testing.T) {
	for _, cpm := range []string{"0.10", "0.1", "4.50"} {
		req := baseValidRequest()
		req.Deals[0].CPM = cpm
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "ix_floor"); ok && !c.Passed {
			t.Fatalf("ix_floor must not fire at CPM %s, got %+v", cpm, c)
		}
	}
}

func TestIXFloor_BlankCPMUsesIXDefault(t *testing.T) {
	// Fully blank CPM ships the builder's 0.10 default — never a failure.
	req := baseValidRequest()
	req.Deals[0].CPM = ""
	req.DefaultDisplayCPM = ""
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "ix_floor"); ok && !c.Passed {
		t.Fatalf("ix_floor must not fire for a blank CPM (builder defaults to 0.10), got %+v", c)
	}
}

func TestIXFloor_OtherSSPsUnaffected(t *testing.T) {
	req := baseValidRequest()
	req.Deals[0].SSP = "PubMatic"
	req.Deals[0].CPM = "0.08"
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "ix_floor"); ok && !c.Passed {
		t.Fatalf("ix_floor is IX-only, got %+v for PubMatic", c)
	}
}

// --- list_ref -----------------------------------------------------------

func listRequest() AuditRequest {
	req := baseValidRequest()
	req.DomainLists = []UploadedFile{{
		ID:            "up-longtail",
		Name:          "long_tail_block_list.csv",
		Path:          "/opt/deal-onboarding/data/uploads/long_tail_block_list_5b40f67e.csv",
		InclusionType: "Exclude",
	}}
	return req
}

func TestListRef_StalePickFails(t *testing.T) {
	req := listRequest()
	req.Deals[0].DomainListID = strPtr("up-OLD-DELETED")
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "list_ref")
	if !ok || c.Passed {
		t.Fatalf("list_ref must fail for a stale per-deal pick, got %+v", c)
	}
	if c.FieldPath != "deals[0].domainListId" || !strings.Contains(c.Message, "up-OLD-DELETED") {
		t.Fatalf("list_ref must anchor the stale pick, got %+v", c)
	}
}

func TestListRef_ResolvingPicksPass(t *testing.T) {
	// Ad-hoc upload id, folded standard list ("list:" prefix), per-deal
	// registry-resolved standard list, explicit opt-out, and campaign default
	// must all be silent.
	cases := []func(*AuditRequest){
		func(r *AuditRequest) { r.Deals[0].DomainListID = strPtr("up-longtail") },
		func(r *AuditRequest) {
			r.DomainLists = append(r.DomainLists, UploadedFile{ID: "list:curated-block", Name: "Curated", InclusionType: "Exclude"})
			r.Deals[0].DomainListID = strPtr("curated-block")
		},
		func(r *AuditRequest) {
			r.PerDealLists = []UploadedFile{{ID: "list:std-1", Name: "Std", InclusionType: "Exclude"}}
			r.Deals[0].DomainListID = strPtr("std-1")
		},
		func(r *AuditRequest) { r.Deals[0].DomainListID = strPtr("") },
		func(r *AuditRequest) { r.Deals[0].DomainListID = nil },
	}
	for i, mutate := range cases {
		req := listRequest()
		mutate(&req)
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "list_ref"); ok && !c.Passed {
			t.Fatalf("case %d: list_ref must not fire, got %+v", i, c)
		}
	}
}

func TestListRef_SheetOnlySkipped(t *testing.T) {
	req := listRequest()
	req.Deals[0].DomainListID = strPtr("up-OLD-DELETED")
	req.Deals[0].SheetOnly = true
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "list_ref"); ok && !c.Passed {
		t.Fatalf("list_ref must skip sheet-only rows, got %+v", c)
	}
}

// --- list_applied -------------------------------------------------------

func TestListApplied_ZeroCarryFails(t *testing.T) {
	// The DEAL07253 shape: file uploaded, every deal's pick stale → nothing
	// ships. list_applied fails the pool alongside list_ref's per-deal flags.
	req := listRequest()
	req.Deals[0].DomainListID = strPtr("up-OLD-DELETED")
	res := RunAudit(&req, req.CampaignID)
	c, ok := ruleResult(res.Checks, "list_applied")
	if !ok || c.Passed {
		t.Fatalf("list_applied must fail when no deal carries the pool, got %+v", c)
	}
	if !strings.Contains(c.Message, "long_tail_block_list.csv") || c.FieldPath != "domainLists" {
		t.Fatalf("list_applied must name the orphaned file, got %+v", c)
	}
}

func TestListApplied_AllDealsOptedOutFails(t *testing.T) {
	req := listRequest()
	req.Deals[0].DomainListID = strPtr("")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "list_applied"); !ok || c.Passed {
		t.Fatalf("list_applied must fail when every deal opted out, got %+v", c)
	}
}

func TestListApplied_NoRoutedChannelFails(t *testing.T) {
	// A domain list in an all-CTV batch routes nowhere.
	req := listRequest()
	req.Deals[0].Channel = "CTV"
	req.Deals[0].VCR = "80"
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "list_applied"); !ok || c.Passed {
		t.Fatalf("list_applied must fail when no deal routes to the domain pool, got %+v", c)
	}
}

func TestListApplied_CampaignDefaultCarriesPool(t *testing.T) {
	req := listRequest()
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "list_applied"); ok && !c.Passed {
		t.Fatalf("list_applied must not fire when the campaign default ships the file, got %+v", c)
	}
}

func TestListApplied_ExplicitPickCarriesPool(t *testing.T) {
	req := listRequest()
	req.Deals[0].DomainListID = strPtr("up-longtail")
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "list_applied"); ok && !c.Passed {
		t.Fatalf("list_applied must not fire for an explicit resolving pick, got %+v", c)
	}
}

func TestListApplied_AppliesToScopingRespected(t *testing.T) {
	// File scoped to a deal that no longer exists → stale ids ignored →
	// applies everywhere → carried. File scoped to another live deal only →
	// this deal doesn't carry it → pool fails.
	req := listRequest()
	req.DomainLists[0].AppliesTo = []string{"gone-deal"}
	res := RunAudit(&req, req.CampaignID)
	if c, ok := ruleResult(res.Checks, "list_applied"); ok && !c.Passed {
		t.Fatalf("stale AppliesTo ids fall back to applies-everywhere, got %+v", c)
	}

	req2 := listRequest()
	req2.Deals = append(req2.Deals, DealEntry{
		ID: "d2", Theme: "Sun", Channel: "CTV", SSP: "Index Exchange", InventoryType: "All", CPM: "0.10", VCR: "80",
	})
	req2.DomainLists[0].AppliesTo = []string{"d2"} // d2 is CTV — app pool — so the domain file reaches nobody
	res2 := RunAudit(&req2, req2.CampaignID)
	if c, ok := ruleResult(res2.Checks, "list_applied"); !ok || c.Passed {
		t.Fatalf("list_applied must fail when the file is scoped away from every routed deal, got %+v", c)
	}
}

func TestListApplied_NoListsNoCheck(t *testing.T) {
	req := baseValidRequest()
	res := RunAudit(&req, req.CampaignID)
	if _, ok := ruleResult(res.Checks, "list_applied"); ok {
		t.Fatal("list_applied must not appear when no lists are uploaded")
	}
	if _, ok := ruleResult(res.Checks, "list_ref"); ok {
		t.Fatal("list_ref must not appear when no picks are set")
	}
}

// --- viewability_code -----------------------------------------------------
// DEAL07255: a scroll tick turned a typed 70 into 71 and IX rejected the whole
// create ("No match found for viewability threshold: 0.71"). The UI is now a
// dropdown pinned to the decile grid; this rule is the enforcement for
// persisted/imported values.

func TestViewabilityCode_OffGridFails(t *testing.T) {
	for _, bad := range []string{"71", "0.71", "5", "95", "100", "abc"} {
		req := baseValidRequest()
		req.Deals[0].ViewabilityTarget = bad
		res := RunAudit(&req, req.CampaignID)
		c, ok := ruleResult(res.Checks, "viewability_code")
		if !ok || c.Passed {
			t.Fatalf("viewability_code must fail for %q, got %+v", bad, c)
		}
		if c.DealIndex != 0 || c.FieldPath != "deals[0].viewabilityTarget" {
			t.Fatalf("viewability_code must anchor the deal field for %q, got %+v", bad, c)
		}
	}
}

func TestViewabilityCode_GridValuesAndBlankPass(t *testing.T) {
	for _, good := range []string{"", "10", "50", "70", "90", "0.7"} {
		req := baseValidRequest()
		req.Deals[0].ViewabilityTarget = good
		res := RunAudit(&req, req.CampaignID)
		if c, ok := ruleResult(res.Checks, "viewability_code"); ok && !c.Passed {
			t.Fatalf("viewability_code must not fire for %q, got %+v", good, c)
		}
	}
}

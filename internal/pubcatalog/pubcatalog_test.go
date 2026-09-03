// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package pubcatalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	data := `{
		"as_of": "2026-08-21",
		"source": "test",
		"slices": {
			"index": [{"id": "185106", "name": "Gizmag Pty Ltd"}],
			"openx": [{"id": "557339752", "name": "GAM UNDESTO S.L. - CTA"}],
			"pubmatic": [{"id": "161578", "name": "Paramount - Springserve"}, {"id": "165045", "name": "Roku - oRTB"}, {"id": "159942", "name": "Vizio - SpringServe Prebid"}],
			"magnite_ctv": [{"id": "60315", "name": "Paramount"}],
			"magnite_dvplus": [{"id": "16356", "name": "Applovin Pub"}]
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

func boolPtr(b bool) *bool { return &b }

func onlyCheck(t *testing.T, checks []validation.CheckResult) validation.CheckResult {
	t.Helper()
	if len(checks) != 1 {
		t.Fatalf("want exactly one publisher_known_list check, got %d: %+v", len(checks), checks)
	}
	if checks[0].Rule != "publisher_known_list" || !checks[0].Passed {
		t.Fatalf("check must be an always-passing publisher_known_list, got %+v", checks[0])
	}
	return checks[0]
}

func TestMissingFileLoadsNil(t *testing.T) {
	c, err := Load(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil || c != nil {
		t.Fatalf("missing file must be (nil, nil), got %v, %v", c, err)
	}
	// nil receiver is safe and yields no checks.
	var nilCat *Catalog
	if got := nilCat.Checks(&validation.AuditRequest{}); got != nil {
		t.Fatalf("nil catalog must produce no checks, got %+v", got)
	}
}

func TestReceiptCountsMatchedAndFlagged(t *testing.T) {
	c := testCatalog(t)
	req := &validation.AuditRequest{
		PubMaticConfig: validation.PubMaticConfig{
			MaxReach: false,
			PublisherEntries: []validation.PublisherAllowlistEntry{
				{ID: "161578", Name: "Paramount - Springserve"}, // by id
				{Name: "roku - ortb"},                           // by name, case-insensitive
				{Name: "Paramont"},                              // typo → flagged
			},
		},
	}
	check := onlyCheck(t, c.Checks(req))
	if !strings.Contains(check.Message, "PubMatic: 2/3 on the known list") {
		t.Fatalf("receipt wrong: %s", check.Message)
	}
	if !strings.Contains(check.Message, "not on it: Paramont") {
		t.Fatalf("flagged entry missing: %s", check.Message)
	}
	if !strings.Contains(check.Message, "snapshot 2026-08-21") {
		t.Fatalf("snapshot date missing: %s", check.Message)
	}
}

func TestWrongCardHint(t *testing.T) {
	c := testCatalog(t)
	// PubMatic ids pasted into the OpenX card: none are OpenX, 3 match PubMatic.
	req := &validation.AuditRequest{
		OpenXConfig: validation.OpenXConfig{
			AllPublishers: boolPtr(false),
			PublisherEntries: []validation.PublisherAllowlistEntry{
				{ID: "161578"}, {ID: "165045"}, {ID: "159942"},
			},
		},
	}
	check := onlyCheck(t, c.Checks(req))
	if !strings.Contains(check.Message, "OpenX: 0/3 on the known list") {
		t.Fatalf("receipt wrong: %s", check.Message)
	}
	if !strings.Contains(check.Message, "3 of the 3 unknown IDs match the PubMatic list — wrong SSP card?") {
		t.Fatalf("wrong-card hint missing: %s", check.Message)
	}
}

func TestMagniteChannelRouting(t *testing.T) {
	c := testCatalog(t)
	req := &validation.AuditRequest{
		Deals: []validation.DealEntry{{SSP: "Magnite", Channel: "CTV"}},
		MagniteConfig: validation.MagniteConfig{
			AllPublishers: boolPtr(false),
			PublisherEntries: []validation.PublisherAllowlistEntry{
				{ID: "60315"}, // CTV seller — matches
				{ID: "16356"}, // DV+ account — must NOT match a CTV-only batch
			},
		},
	}
	check := onlyCheck(t, c.Checks(req))
	if !strings.Contains(check.Message, "Magnite: 1/2 on the known list") {
		t.Fatalf("CTV batch must match against the CTV slice only: %s", check.Message)
	}
	if !strings.Contains(check.Message, "1 of the 1 unknown IDs match the Magnite DV+ list — wrong SSP card?") {
		t.Fatalf("cross-catalog hint missing: %s", check.Message)
	}

	// Mixed CTV + Display batch matches the union — both ids known.
	req.Deals = append(req.Deals, validation.DealEntry{SSP: "Magnite", Channel: "Display"})
	check = onlyCheck(t, c.Checks(req))
	if !strings.Contains(check.Message, "Magnite: 2/2 on the known list") {
		t.Fatalf("mixed batch must match the CTV+DV+ union: %s", check.Message)
	}
}

func TestNoChecksWhenNothingAllowlisted(t *testing.T) {
	c := testCatalog(t)
	req := &validation.AuditRequest{
		PubMaticConfig: validation.PubMaticConfig{MaxReach: true},
		OpenXConfig: validation.OpenXConfig{
			// Toggle ON: leftover entries are inert.
			PublisherEntries: []validation.PublisherAllowlistEntry{{ID: "1"}},
		},
	}
	if got := c.Checks(req); got != nil {
		t.Fatalf("no active allowlist must yield no checks, got %+v", got)
	}
}

func TestLegacyPubMaticNamesAreChecked(t *testing.T) {
	c := testCatalog(t)
	req := &validation.AuditRequest{
		PubMaticConfig: validation.PubMaticConfig{
			MaxReach:       false,
			PublisherNames: []string{"Roku - oRTB", "Nope Publisher"},
		},
	}
	check := onlyCheck(t, c.Checks(req))
	if !strings.Contains(check.Message, "PubMatic: 1/2 on the known list") {
		t.Fatalf("legacy names not checked: %s", check.Message)
	}
}

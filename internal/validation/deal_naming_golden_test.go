// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package validation

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The golden deal-naming cases live in testdata/deal_naming_golden.json and
// are CONSUMED BY BOTH SUITES: this test and the vitest twin
// (frontend/src/lib/deal_naming_golden.test.ts) read the same fixture, so the
// Go and TS generators can never drift silently again. expect.names is
// asserted by both.

type goldenExpect struct {
	Names []string `json:"names"`
}

type goldenCase struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Form        json.RawMessage `json:"form"`
	Expect      goldenExpect    `json:"expect"`
}

type goldenFixture struct {
	Cases []goldenCase `json:"cases"`
}

func loadGoldenFixture(t *testing.T) goldenFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/deal_naming_golden.json")
	if err != nil {
		t.Fatalf("read golden fixture: %v", err)
	}
	var fx goldenFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse golden fixture: %v", err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("golden fixture has no cases")
	}
	return fx
}

func TestDealNamingGolden(t *testing.T) {
	fx := loadGoldenFixture(t)
	for _, tc := range fx.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			var req AuditRequest
			// The fixture "form" is AuditRequest-shaped (same JSON contract the
			// API consumes), including deals[].
			if err := json.Unmarshal(tc.Form, &req); err != nil {
				t.Fatalf("parse form: %v", err)
			}
			got := generateDealNames(&req, req.CampaignID)
			if len(got) != len(tc.Expect.Names) {
				t.Fatalf("want %d name(s), got %d: %v", len(tc.Expect.Names), len(got), got)
			}
			for i, want := range tc.Expect.Names {
				if got[i] != want {
					t.Errorf("name[%d]:\n  want %q\n  got  %q", i, want, got[i])
				}
			}
			// Post-fix invariant: every GENERATED (non-override) name has
			// exactly 12 slots.
			named := generateNamedDeals(&req, req.CampaignID)
			for i, nd := range named {
				if nd.Override {
					continue
				}
				if slots := len(strings.Split(nd.Name, "_")); slots != 12 {
					t.Errorf("generated name[%d] has %d slots, want 12: %q", i, slots, nd.Name)
				}
			}
		})
	}
}

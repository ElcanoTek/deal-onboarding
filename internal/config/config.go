// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Package config holds the operator identity for a Deal Onboarding
// installation. One installation = one organization: these values replace the
// per-client preset system of the original app, so the deal-name curator slot, the campaign-id
// pattern, and the default attribution code all come from here.
package config

import (
	"os"
	"regexp"
	"strings"
)

// Operator is the single-tenant identity loaded at boot.
type Operator struct {
	// OrgName is the default Curator (slot 1) of every generated deal name when
	// no data partner is set. Env: ORG_NAME.
	OrgName string `json:"orgName"`
	// CampaignIDPrefix is the alphabetic prefix of a campaign id; ids are the
	// prefix followed by exactly five digits (e.g. DEAL00042). Env:
	// CAMPAIGN_ID_PREFIX.
	CampaignIDPrefix string `json:"campaignIdPrefix"`
	// DefaultAttributionCode fills slot 12 when the form leaves the
	// attribution code blank. Env: DEFAULT_ATTRIBUTION_CODE.
	DefaultAttributionCode string `json:"defaultAttributionCode"`
}

// Defaults used when an env var is unset.
const (
	DefaultOrgName                = "Curator"
	DefaultCampaignIDPrefix       = "DEAL"
	DefaultDefaultAttributionCode = "A1"
)

var prefixRe = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,7}$`)

// Default returns the built-in operator identity.
func Default() Operator {
	return Operator{
		OrgName:                DefaultOrgName,
		CampaignIDPrefix:       DefaultCampaignIDPrefix,
		DefaultAttributionCode: DefaultDefaultAttributionCode,
	}
}

// FromEnv reads ORG_NAME, CAMPAIGN_ID_PREFIX and DEFAULT_ATTRIBUTION_CODE,
// falling back to the defaults. The prefix is upper-cased and must be 2–8
// characters of [A-Z0-9] starting with a letter; anything else falls back to
// the default so a typo can never make every campaign id unmatchable.
func FromEnv() Operator {
	op := Default()
	if v := strings.TrimSpace(os.Getenv("ORG_NAME")); v != "" {
		op.OrgName = v
	}
	if v := strings.ToUpper(strings.TrimSpace(os.Getenv("CAMPAIGN_ID_PREFIX"))); prefixRe.MatchString(v) {
		op.CampaignIDPrefix = v
	}
	if v := strings.ToUpper(strings.TrimSpace(os.Getenv("DEFAULT_ATTRIBUTION_CODE"))); v != "" {
		op.DefaultAttributionCode = v
	}
	return op
}

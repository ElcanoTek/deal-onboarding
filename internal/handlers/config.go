// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"net/http"

	"github.com/ElcanoTek/deal-onboarding/internal/config"
)

// HandleOperatorConfig serves the non-secret operator identity (org name,
// campaign-id prefix, attribution default) so the frontend's name generator
// and form copy render the same identity the server audits against.
func HandleOperatorConfig(op config.Operator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"orgName":                op.OrgName,
			"campaignIdPrefix":       op.CampaignIDPrefix,
			"defaultAttributionCode": op.DefaultAttributionCode,
			"productName":            "Deal Onboarding",
		})
	}
}

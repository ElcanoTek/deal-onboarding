package handlers

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Structured deal-brief shapes — the server-side mirror of the frontend
// DealBriefDoc (frontend/src/lib/dealBrief.ts). Only the fields the schema gate
// inspects are modeled; unknown keys are ignored.
type briefDeal struct {
	SSP            string `json:"ssp"`
	Tool           string `json:"tool"`
	Channel        string `json:"channel"`
	DealName       string `json:"deal_name"`
	RecommendedBid string `json:"recommended_bid"`
	PromptInputs   string `json:"prompt_inputs"`
}

type briefSheetRow struct {
	DealName string `json:"deal_name"`
	// Tool must be ABSENT/empty on a sheet-only row — it is never created.
	Tool string `json:"tool"`
}

type dealBriefDoc struct {
	ClientName             string          `json:"client_name"`
	Recipient              string          `json:"recipient"`
	CampaignID             string          `json:"campaign_id"`
	Deals                  []briefDeal     `json:"deals"`
	AlreadyCreatedForSheet []briefSheetRow `json:"already_created_for_sheet"`
}

func briefHasUnresolvedToken(s string) bool {
	return strings.Contains(s, "<FILL") ||
		strings.Contains(s, "${") ||
		strings.Contains(s, "{{") ||
		strings.Contains(s, "<UNSET")
}

// validateDealBrief schema-checks a serialized structured deal brief, returning
// the list of issues (empty = valid). It mirrors the frontend validateBrief so
// a brief that passed client-side validation also passes here — defense in
// depth before the brief is attached to a live runner task. The exact transport
// hazards from a failed live batch are rejected: unresolved placeholders,
// missing tool routing, blank envelope fields, and sheet-only rows leaking a
// create tool.
func validateDealBrief(raw []byte) []string {
	var b dealBriefDoc
	if err := json.Unmarshal(raw, &b); err != nil {
		return []string{"brief is not valid JSON: " + err.Error()}
	}
	var issues []string
	if strings.TrimSpace(b.ClientName) == "" {
		issues = append(issues, "client_name is required")
	}
	if strings.TrimSpace(b.Recipient) == "" || briefHasUnresolvedToken(b.Recipient) {
		issues = append(issues, "recipient is missing or unresolved")
	}
	if strings.TrimSpace(b.CampaignID) == "" {
		issues = append(issues, "campaign_id is required")
	}
	if len(b.Deals) == 0 && len(b.AlreadyCreatedForSheet) == 0 {
		issues = append(issues, "brief has no deals")
	}
	for i, d := range b.Deals {
		label := d.DealName
		if label == "" {
			label = fmt.Sprintf("deal[%d]", i)
		}
		if d.SSP == "" {
			issues = append(issues, label+": ssp is required")
		}
		if !strings.HasPrefix(d.Tool, "mcp_") {
			issues = append(issues, label+": missing/invalid tool routing")
		}
		if d.DealName == "" {
			issues = append(issues, fmt.Sprintf("deal[%d]: deal_name is required", i))
		}
		// channel + recommended_bid are REQUIRED_DEAL_FIELDS in the Cutlass
		// validate_brief — gate them here so a brief that passes Deal Onboarding also
		// passes server-side.
		if strings.TrimSpace(d.Channel) == "" {
			issues = append(issues, label+": channel is required")
		}
		if strings.TrimSpace(d.RecommendedBid) == "" {
			issues = append(issues, label+": recommended_bid is required")
		}
		if strings.TrimSpace(d.PromptInputs) == "" {
			issues = append(issues, label+": prompt_inputs is empty")
		}
		if briefHasUnresolvedToken(d.PromptInputs) || briefHasUnresolvedToken(d.DealName) {
			issues = append(issues, label+": contains an unresolved token")
		}
	}
	for i, r := range b.AlreadyCreatedForSheet {
		if r.DealName == "" {
			issues = append(issues, fmt.Sprintf("already_created[%d]: deal_name is required", i))
		}
		if strings.TrimSpace(r.Tool) != "" {
			issues = append(issues, r.DealName+": sheet-only row must not carry a tool")
		}
	}
	return issues
}

package handlers

import (
	"strings"
	"testing"
)

const validBrief = `{
  "schema_version": "1.0",
  "client_name": "Contoso",
  "recipient": "lead@example.com",
  "campaign_id": "DEAL07238",
  "deals": [
    {"ssp": "PubMatic", "tool": "mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs",
     "channel": "Display", "deal_name": "Partner_Pubmatic_SNAP_users", "recommended_bid": "$2-$5", "floor": 0.1, "prompt_inputs": "name: x\nfee:\n  feeValue: 30"}
  ],
  "already_created_for_sheet": [
    {"ssp": "OpenX", "channel": "Display", "deal_name": "Partner_OpenX_SNAP_users", "status": "already_created"}
  ]
}`

func TestValidateDealBrief_Valid(t *testing.T) {
	if issues := validateDealBrief([]byte(validBrief)); len(issues) != 0 {
		t.Fatalf("expected no issues, got %v", issues)
	}
}

func TestValidateDealBrief_RejectsUnresolvedToken(t *testing.T) {
	bad := strings.Replace(validBrief, "name: x", "marketplace: <FILL marketplace>", 1)
	issues := validateDealBrief([]byte(bad))
	if !hasIssue(issues, "unresolved") {
		t.Fatalf("expected an unresolved-token issue, got %v", issues)
	}
}

func TestValidateDealBrief_RejectsMissingToolRouting(t *testing.T) {
	bad := strings.Replace(validBrief, "mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs", "", 1)
	issues := validateDealBrief([]byte(bad))
	if !hasIssue(issues, "tool routing") {
		t.Fatalf("expected a tool-routing issue, got %v", issues)
	}
}

func TestValidateDealBrief_RejectsSheetOnlyWithTool(t *testing.T) {
	bad := strings.Replace(
		validBrief,
		`{"ssp": "OpenX", "channel": "Display", "deal_name": "Partner_OpenX_SNAP_users", "status": "already_created"}`,
		`{"ssp": "OpenX", "channel": "Display", "deal_name": "Partner_OpenX_SNAP_users", "tool": "mcp_openx_mcp_ox_execute_deal_from_prompt_inputs", "status": "already_created"}`,
		1,
	)
	issues := validateDealBrief([]byte(bad))
	if !hasIssue(issues, "sheet-only row must not carry a tool") {
		t.Fatalf("expected a sheet-only-tool issue, got %v", issues)
	}
}

func TestValidateDealBrief_RejectsBlankEnvelope(t *testing.T) {
	issues := validateDealBrief([]byte(`{"deals":[]}`))
	if !hasIssue(issues, "client_name is required") || !hasIssue(issues, "campaign_id is required") {
		t.Fatalf("expected envelope issues, got %v", issues)
	}
}

func TestValidateDealBrief_RejectsInvalidJSON(t *testing.T) {
	issues := validateDealBrief([]byte("not json"))
	if !hasIssue(issues, "not valid JSON") {
		t.Fatalf("expected a JSON parse issue, got %v", issues)
	}
}

func hasIssue(issues []string, substr string) bool {
	for _, s := range issues {
		if strings.Contains(s, substr) {
			return true
		}
	}
	return false
}

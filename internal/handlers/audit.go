package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/lists"
	"github.com/ElcanoTek/deal-onboarding/internal/pubcatalog"
	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

// publisherCatalog is the repo-shipped known-publisher snapshot, injected once
// at boot (SetPublisherCatalog). Package-level rather than threaded through
// the two audit entrypoints' constructors: it is immutable after boot, purely
// advisory (nil = no advisory checks), and the MOC handler constructor has
// ~66 call sites that a parameter would churn for no behavioral gain.
var publisherCatalog *pubcatalog.Catalog

// SetPublisherCatalog injects the known-publisher snapshot loaded at boot.
func SetPublisherCatalog(c *pubcatalog.Catalog) { publisherCatalog = c }

// HandleGetPublisherCatalog serves the snapshot to the form so allowlist
// chips can validate at entry time. {"catalog": null} when none is shipped.
func HandleGetPublisherCatalog() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if publisherCatalog == nil {
			writeJSON(w, http.StatusOK, map[string]any{"catalog": nil})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"catalog": publisherCatalog})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// HandleAudit runs the deterministic rule audit over the posted form. It is a
// closure handler so the standard-list registry can fold applied lists into
// the request before the rules run.
func HandleAudit(listReg *lists.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req validation.AuditRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		// No fallback campaign id: a blank campaignId fails the campaign_id
		// check (the id is baked into every deal name, so minting a random one
		// here produced three surfaces showing three different names). The
		// /api/moc/create gate still passes the form's own campaignId as the
		// fallback for its deterministic re-run.
		result := evaluateAudit(listReg, &req, "")
		writeJSON(w, http.StatusOK, result)
	}
}

// evaluateAudit is the single evaluation core behind POST /api/audit AND the
// /api/runner/create server-side audit gate: standard-list folding, then the
// deterministic rule audit. Both callers MUST go
// through this function so the trader-facing audit and the submit gate can
// never drift. fallbackCampaignID is used only when the form itself carries no
// campaignId (the gate requires one, so only /api/audit exercises the
// fallback).
func evaluateAudit(listReg *lists.Registry, req *validation.AuditRequest, fallbackCampaignID string) validation.AuditResponse {
	applyStandardLists(listReg, req)
	res := validation.RunAudit(req, fallbackCampaignID)
	// Advisory known-publisher-list feedback (typos / wrong-SSP paste) —
	// always passing, so it can never change res.Status; booking-time
	// live-catalog verification remains the enforcement.
	res.Checks = append(res.Checks, publisherCatalog.Checks(req)...)
	return res
}

// applyStandardLists folds curated allow/block lists into the audit request's
// DomainLists / AppBundleLists so downstream rules and prompt generation see
// them as ordinary files. Kind translates to inclusionType (allow → Include,
// block → Exclude). Unknown ids are silently dropped — the picker only shows
// ids that came from /api/lists so a mismatch means the manifest changed
// out from under the form and we don't want to fail the whole audit for it.
func applyStandardLists(reg *lists.Registry, req *validation.AuditRequest) {
	if reg == nil {
		return
	}
	for _, l := range reg.Resolve(req.AppliedDomainListIDs) {
		req.DomainLists = append(req.DomainLists, asUploadedFile(l))
	}
	for _, l := range reg.Resolve(req.AppliedAppBundleListIDs) {
		req.AppBundleLists = append(req.AppBundleLists, asUploadedFile(l))
	}
	// Fold the PER-DEAL list picks (DomainListID / AppBundleListID) through
	// the registry too so list_ref / list_applied can resolve them. These land
	// in PerDealLists — NOT the targeting pools — so they never perturb a
	// channel-routed rule. Ad-hoc upload ids don't resolve in the registry and
	// are simply skipped.
	perDealIDs := map[string]struct{}{}
	for _, d := range req.Deals {
		for _, p := range []*string{d.DomainListID, d.AppBundleListID} {
			if p == nil {
				continue
			}
			if id := strings.TrimSpace(*p); id != "" {
				perDealIDs[id] = struct{}{}
			}
		}
	}
	if len(perDealIDs) > 0 {
		ids := make([]string, 0, len(perDealIDs))
		for id := range perDealIDs {
			ids = append(ids, id)
		}
		for _, l := range reg.Resolve(ids) {
			req.PerDealLists = append(req.PerDealLists, asUploadedFile(l))
		}
	}
}

func asUploadedFile(l lists.List) validation.UploadedFile {
	inclusion := "Include"
	if l.Kind == lists.KindBlock {
		inclusion = "Exclude"
	}
	return validation.UploadedFile{
		ID:            "list:" + l.ID,
		Name:          l.Name,
		Path:          l.Path,
		InclusionType: inclusion,
	}
}

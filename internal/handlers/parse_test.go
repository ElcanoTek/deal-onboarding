// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"strings"
	"testing"
)

// TestParseSystemPromptCoversAdDuration pins the /api/parse-deal extraction
// contract for ad duration: the per-deal schema must offer adDurations and
// maxAdDurationSecs so a pasted brief's "only :15 and :30 spots" / "up to 30
// seconds" requirement is extracted onto the deal instead of being dropped —
// the same silent-loss class a brief-import mapper has when its
// adDuration schema fields are missing.
func TestParseSystemPromptCoversAdDuration(t *testing.T) {
	for _, want := range []string{
		`"adDurations": [string]`,
		`"maxAdDurationSecs": string`,
		"spot length",
		"creative duration",
		"NEVER drop an ad-duration requirement silently",
		// Extraction must NOT be gated on the deal's channel: a duration stated
		// on an Audio/Display deal must still land on the form so the Go QA
		// item flags it to the trader — omission leaves zero trace.
		"EVEN IF the deal's channel is not video",
		"EVEN IF the channel is not video",
	} {
		if !strings.Contains(parseSystemPrompt(), want) {
			t.Errorf("parseSystemPrompt() missing %q — a brief's ad-duration requirement would be silently dropped by /api/parse-deal", want)
		}
	}
	// The video-only gating phrases steer some models (opus, gemini-pro) to
	// silently omit a duration requirement stated on a non-video deal. The
	// import path deliberately lands such values so QA warns loudly; the parse
	// prompt must never reintroduce the gate.
	for _, banned := range []string{
		"video channels CTV/OLV/OTT only",
		"(video channels only",
	} {
		if strings.Contains(parseSystemPrompt(), banned) {
			t.Errorf("parseSystemPrompt() contains gating phrase %q — it steers models to silently omit ad-duration requirements on non-video deals", banned)
		}
	}
}

// TestParseSystemPromptCoversIABExcludes pins the /api/parse-deal routing
// contract for IAB categories vs audience segments: content-genre lists must
// land in per-deal iabCategories/iabCategoriesExclude — NOT in the segment
// fields (the mis-parse this schema exists to fix) — and genre names pass
// verbatim, never translated to IAB codes.
func TestParseSystemPromptCoversIABExcludes(t *testing.T) {
	for _, want := range []string{
		`"iabCategoriesExclude": [string]`,
		"IAB CATEGORIES vs AUDIENCE SEGMENTS",
		"NOT includeSegments",
		"NOT excludeSegments",
		"fans out to EVERY deal's iabCategoriesExclude",
		"never translate them to IAB codes",
		// Top-level placement is a mergeParsedIntoForm safety net (fanned out to
		// every deal), but the prompt must keep steering the model to per-deal
		// placement so scoped exclusions stay scoped.
		"per-deal placement is preferred",
	} {
		if !strings.Contains(parseSystemPrompt(), want) {
			t.Errorf("parseSystemPrompt() missing %q — a brief's content-genre list would be mis-parsed into audience segments or its exclusions dropped", want)
		}
	}
}

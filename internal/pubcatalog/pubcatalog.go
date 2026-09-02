// Package pubcatalog loads the repo-shipped "known publisher list" — a
// versioned snapshot of each SSP's available publishers (generated from the
// trader-maintained export, refreshed by code push) — and turns publisher
// allowlists into advisory audit feedback: entry-time typo/wrong-card
// detection long before the booking-time live-catalog check (which remains
// the enforcement; this layer is early warning only and never blocks).
package pubcatalog

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

// Entry mirrors one catalog row (and validation.PublisherAllowlistEntry).
type Entry struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

// Catalog is the parsed snapshot plus per-slice lookup indexes.
type Catalog struct {
	AsOf   string             `json:"as_of"`
	Source string             `json:"source"`
	Slices map[string][]Entry `json:"slices"`

	byID   map[string]map[string]bool // slice -> id set
	byName map[string]map[string]bool // slice -> lowercased name set
}

// SliceLabels are the trader-facing names used in audit copy.
var SliceLabels = map[string]string{
	"index":          "Index",
	"openx":          "OpenX",
	"pubmatic":       "PubMatic",
	"magnite_ctv":    "Magnite CTV",
	"magnite_dvplus": "Magnite DV+",
}

// Load reads the catalog JSON. A missing file returns (nil, nil): the feature
// degrades to no advisory checks rather than failing startup — the booking
// check still enforces.
func Load(path string) (*Catalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read publisher catalog %s: %w", path, err)
	}
	var c Catalog
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse publisher catalog %s: %w", path, err)
	}
	c.byID = map[string]map[string]bool{}
	c.byName = map[string]map[string]bool{}
	for slice, entries := range c.Slices {
		ids := map[string]bool{}
		names := map[string]bool{}
		for _, e := range entries {
			if id := strings.TrimSpace(e.ID); id != "" {
				ids[id] = true
			}
			if n := strings.ToLower(strings.TrimSpace(e.Name)); n != "" {
				names[n] = true
			}
		}
		c.byID[slice] = ids
		c.byName[slice] = names
	}
	return &c, nil
}

// matchResult is one SSP allowlist checked against its slice(s).
type matchResult struct {
	label     string
	total     int
	matched   int
	unmatched []string // display labels of flagged entries
	// unmatchedIDs feeds wrong-card detection.
	unmatchedIDs []string
	slices       []string
}

func (c *Catalog) inSlices(slices []string, id, name string) bool {
	for _, s := range slices {
		if id != "" && c.byID[s][id] {
			return true
		}
		if name != "" && c.byName[s][strings.ToLower(name)] {
			return true
		}
	}
	return false
}

func (c *Catalog) matchEntries(label string, slices []string, entries []validation.PublisherAllowlistEntry) *matchResult {
	r := &matchResult{label: label, slices: slices}
	for _, e := range entries {
		id := strings.TrimSpace(e.ID)
		name := strings.TrimSpace(e.Name)
		if id == "" && name == "" {
			continue
		}
		r.total++
		if c.inSlices(slices, id, name) {
			r.matched++
			continue
		}
		display := name
		if display == "" {
			display = "#" + id
		}
		r.unmatched = append(r.unmatched, display)
		if id != "" {
			r.unmatchedIDs = append(r.unmatchedIDs, id)
		}
	}
	return r
}

// wrongCardHint reports whether the unmatched IDs of one SSP look like
// another SSP's IDs — the "pasted the PubMatic column into the OpenX card"
// failure. Fires when EVERY unmatched ID lands in one other slice, or when
// at least 2 do and they make up at least half of the unmatched IDs (the
// thresholds keep a lone numeric coincidence from generating noise).
func (c *Catalog) wrongCardHint(own []string, unmatchedIDs []string) string {
	if len(unmatchedIDs) == 0 {
		return ""
	}
	ownSet := map[string]bool{}
	for _, s := range own {
		ownSet[s] = true
	}
	counts := map[string]int{}
	for slice := range c.byID {
		if ownSet[slice] {
			continue
		}
		for _, id := range unmatchedIDs {
			if c.byID[slice][id] {
				counts[slice]++
			}
		}
	}
	bestSlice, best := "", 0
	for slice, n := range counts {
		if n > best || (n == best && slice < bestSlice) {
			bestSlice, best = slice, n
		}
	}
	if best == len(unmatchedIDs) || (best >= 2 && best*2 >= len(unmatchedIDs)) {
		return fmt.Sprintf("%d of the %d unknown IDs match the %s list — wrong SSP card?", best, len(unmatchedIDs), SliceLabels[bestSlice])
	}
	return ""
}

const maxFlaggedListed = 5

// Checks builds the advisory "publisher_known_list" audit check for a request
// whose SSP cards carry publisher allowlists. Always passing — the snapshot
// can lag reality, and booking-time verification is the enforcement. Returns
// nil when the catalog is absent or no allowlist is active.
func (c *Catalog) Checks(req *validation.AuditRequest) []validation.CheckResult {
	if c == nil {
		return nil
	}
	var results []*matchResult
	off := func(b *bool) bool { return b != nil && !*b }

	if off(req.IXConfig.AllPublishers) && len(req.IXConfig.PublisherEntries) > 0 {
		results = append(results, c.matchEntries("Index", []string{"index"}, req.IXConfig.PublisherEntries))
	}
	if off(req.OpenXConfig.AllPublishers) && len(req.OpenXConfig.PublisherEntries) > 0 {
		results = append(results, c.matchEntries("OpenX", []string{"openx"}, req.OpenXConfig.PublisherEntries))
	}
	if !req.PubMaticConfig.MaxReach {
		entries := req.PubMaticConfig.PublisherEntries
		if len(entries) == 0 {
			for _, n := range req.PubMaticConfig.PublisherNames {
				if strings.TrimSpace(n) != "" {
					entries = append(entries, validation.PublisherAllowlistEntry{Name: n})
				}
			}
		}
		if len(entries) > 0 {
			results = append(results, c.matchEntries("PubMatic", []string{"pubmatic"}, entries))
		}
	}
	if off(req.MagniteConfig.AllPublishers) && len(req.MagniteConfig.PublisherEntries) > 0 {
		// ClearLine's CTV and DV+ catalogs are disjoint — match against the
		// slice(s) this batch's Magnite channels actually book into.
		slices := magniteSlices(req)
		results = append(results, c.matchEntries("Magnite", slices, req.MagniteConfig.PublisherEntries))
	}
	if len(results) == 0 {
		return nil
	}

	var segments []string
	for _, r := range results {
		seg := fmt.Sprintf("%s: %d/%d on the known list", r.label, r.matched, r.total)
		if len(r.unmatched) > 0 {
			listed := r.unmatched
			suffix := ""
			if len(listed) > maxFlaggedListed {
				listed = listed[:maxFlaggedListed]
				suffix = fmt.Sprintf(" (+%d more)", len(r.unmatched)-maxFlaggedListed)
			}
			seg += fmt.Sprintf(" — not on it: %s%s", strings.Join(listed, ", "), suffix)
			if hint := c.wrongCardHint(r.slices, r.unmatchedIDs); hint != "" {
				seg += ". " + strings.ToUpper(hint[:1]) + hint[1:]
			}
		}
		segments = append(segments, seg)
	}
	msg := fmt.Sprintf("Known publisher list (snapshot %s) — %s. Unknown entries are advisory: a stale snapshot is possible, and booking verifies every entry against the live SSP catalog (misses block the create).", c.AsOf, strings.Join(segments, "; "))
	return []validation.CheckResult{{Rule: "publisher_known_list", Passed: true, Message: msg}}
}

// magniteSlices picks the Magnite catalog slice(s) from the batch's Magnite
// CREATE channels: CTV/Audio → magnite_ctv, anything else → magnite_dvplus.
func magniteSlices(req *validation.AuditRequest) []string {
	set := map[string]bool{}
	for _, d := range req.Deals {
		if d.SheetOnly || !strings.EqualFold(strings.TrimSpace(d.SSP), "Magnite") {
			continue
		}
		ch := strings.ToLower(d.Channel)
		if strings.Contains(ch, "ctv") || strings.Contains(ch, "audio") {
			set["magnite_ctv"] = true
		} else {
			set["magnite_dvplus"] = true
		}
	}
	if len(set) == 0 {
		return []string{"magnite_ctv", "magnite_dvplus"}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

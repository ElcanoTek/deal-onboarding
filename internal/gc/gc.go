// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Package gc computes and (optionally) applies a retention sweep of the ad-hoc
// upload directory (DATA_DIR/uploads).
//
// Deal Onboarding keeps no server-side record of which uploads a batch still
// references — a submitted batch has already shipped its attachments to the
// runner — so the sweep is purely age-based: a file is a deletion CANDIDATE
// when it is older than the grace window; anything newer is PROTECTED because
// its only reference may be a trader's still-open browser draft (localStorage,
// invisible to the server).
//
// The sweep NEVER touches the reusable standard-list directory, users.json, or
// the idempotency store — only the upload dir(s) it is pointed at. It is
// dry-run by design: BuildPlan classifies, Plan.Apply deletes, and the caller
// decides which to run. Apply logs basenames/sizes/ages only, never file
// contents.
package gc

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Candidate is a past-grace upload the sweep would delete.
type Candidate struct {
	Path    string
	Dir     string
	Size    int64
	ModTime time.Time
	AgeDays float64
	Reason  string
}

// Protected is an upload the sweep keeps, with the reason it was spared.
type Protected struct {
	Path   string
	Size   int64
	Reason string
}

// Plan is the classified result of a scan. Candidates are safe to delete;
// Protected files are kept for the stated reason.
type Plan struct {
	ScannedDirs []string
	MinAge      time.Duration
	Candidates  []Candidate
	Protected   []Protected
}

// CandidateBytes is the total size the plan would free.
func (p Plan) CandidateBytes() int64 {
	var n int64
	for _, c := range p.Candidates {
		n += c.Size
	}
	return n
}

// BuildPlan scans each uploadDir and classifies every regular file against the
// grace window (minAge). now is injected so tests are deterministic. A
// nonexistent upload dir is skipped, not an error.
func BuildPlan(uploadDirs []string, minAge time.Duration, now time.Time) (Plan, error) {
	plan := Plan{MinAge: minAge}
	for _, dir := range uploadDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return plan, fmt.Errorf("read upload dir %s: %w", dir, err)
		}
		plan.ScannedDirs = append(plan.ScannedDirs, dir)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			full := filepath.Join(dir, e.Name())
			age := now.Sub(info.ModTime())
			if age < minAge {
				plan.Protected = append(plan.Protected, Protected{
					Path:   full,
					Size:   info.Size(),
					Reason: fmt.Sprintf("within grace window (age %s < %s) — may be an unsubmitted draft", roundDur(age), roundDur(minAge)),
				})
				continue
			}
			plan.Candidates = append(plan.Candidates, Candidate{
				Path:    full,
				Dir:     dir,
				Size:    info.Size(),
				ModTime: info.ModTime(),
				AgeDays: age.Hours() / 24,
				Reason:  "past the grace window",
			})
		}
	}
	sort.Slice(plan.Candidates, func(i, j int) bool { return plan.Candidates[i].Path < plan.Candidates[j].Path })
	sort.Slice(plan.Protected, func(i, j int) bool { return plan.Protected[i].Path < plan.Protected[j].Path })
	return plan, nil
}

// Apply deletes every candidate in the plan. It returns the number deleted, the
// bytes freed, and any per-file errors (a failed delete does not abort the
// rest). Callers gate this behind an explicit --apply flag; BuildPlan alone
// mutates nothing.
func (p Plan) Apply() (deleted int, freed int64, errs []error) {
	for _, c := range p.Candidates {
		if err := os.Remove(c.Path); err != nil {
			errs = append(errs, fmt.Errorf("remove %s: %w", filepath.Base(c.Path), err))
			continue
		}
		deleted++
		freed += c.Size
	}
	return deleted, freed, errs
}

func roundDur(d time.Duration) time.Duration {
	if d < time.Hour {
		return d.Round(time.Minute)
	}
	return d.Round(time.Hour)
}

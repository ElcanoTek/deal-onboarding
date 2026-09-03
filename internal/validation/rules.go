// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package validation

import (
	"fmt"
	"github.com/ElcanoTek/deal-onboarding/internal/config"
	"math"
	"strconv"
	"strings"
	"time"

	// Embed the tz database so America/New_York (businessLocation) resolves
	// even in containers/hosts without /usr/share/zoneinfo — the date_logic
	// rule must never silently fall back to a UTC/server-local "today"
	// (#235.1).
	_ "time/tzdata"
	"unicode"
)

// nowFunc is the audit clock — a var so tests can pin the instant (the
// date_logic "today" boundary is timezone-sensitive, #235.1).
var nowFunc = time.Now

// businessLocation is the business timezone every human-facing calendar date
// resolves against — the same America/New_York the frontend's
// businessTodayISO/resolveStartDate use (frontend/src/lib/dealPromptYaml.ts),
// so the audit and the prompt bump can never disagree about "today".
var businessLocation = func() *time.Location {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		// Unreachable with the embedded tzdata import above; prefer the
		// server-local clock over a panic if it ever regresses.
		return time.Local
	}
	return loc
}()

type DSPEntry struct {
	ID     string `json:"id"`
	DSP    string `json:"dsp"`
	SeatID string `json:"seatId"`
}

// GeoEntry mirrors the frontend's typed geo model: Type selects the
// granularity ("country" | "state" | "zip" | "dma") and Value holds it.
type GeoEntry struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

type BuyerEntry struct {
	ID      string `json:"id"`
	BuyerID string `json:"buyerId"`
	IsMain  bool   `json:"isMain"`
}

type IXConfig struct {
	AccountID            string `json:"accountId"`
	AuctionType          string `json:"auctionType"`
	ViewabilityThreshold string `json:"viewabilityThreshold"`
	// AllPublishers is the "Max publishers" toggle (nil/true = no publisher
	// scoping, the default); false requires PublisherEntries.
	AllPublishers    *bool                     `json:"allPublishers"`
	PublisherEntries []PublisherAllowlistEntry `json:"publisherEntries"`
}

// PublisherAllowlistEntry is one "specific publishers only" row — the SSP's
// numeric publisher id and/or display name (mirrors types/deal.ts).
type PublisherAllowlistEntry struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

type OpenXConfig struct {
	PackageName           string       `json:"packageName"`
	AutoPackageName       bool         `json:"autoPackageName"`
	RenderingContext      string       `json:"renderingContext"`
	DomainTargetingOption string       `json:"domainTargetingOption"`
	Currency              string       `json:"currency"`
	DealPrice             string       `json:"dealPrice"`
	Buyers                []BuyerEntry `json:"buyers"`
	FeePartner            string       `json:"feePartner"`
	RevenueMethod         string       `json:"revenueMethod"`
	GrossShare            string       `json:"grossShare"`
	PMPDealType           string       `json:"pmpDealType"`
	// AllPublishers is the "Max publishers" toggle (nil/true = no publisher
	// scoping, the default); false requires PublisherEntries. The exclude
	// list is carried for the conflict rule.
	AllPublishers        *bool                     `json:"allPublishers"`
	PublisherEntries     []PublisherAllowlistEntry `json:"publisherEntries"`
	ExcludedPublisherIds []string                  `json:"excludedPublisherIds"`
}

type PubMaticConfig struct {
	MaxReach             bool     `json:"maxReach"`
	PublisherNames       []string `json:"publisherNames"`
	MaxAllowedPublishers string   `json:"maxAllowedPublishers"`
	PublisherBlockList   []string `json:"publisherBlockList"`
	AdFormats            []string `json:"adFormats"`
	Platforms            []string `json:"platforms"`
	// Publisher allowlist — when non-empty it supersedes PublisherNames
	// (mirrors effectivePubMaticPublisherEntries in types/deal.ts).
	PublisherEntries []PublisherAllowlistEntry `json:"publisherEntries"`
}

type MediaNetConfig struct {
	AdFormat     string   `json:"adFormat"`
	Environments []string `json:"environments"`
	MarginType   string   `json:"marginType"`
	MarginValue  string   `json:"marginValue"`
}

type XandrConfig struct {
	DealCode       string `json:"dealCode"`
	DealType       string `json:"dealType"`
	PaymentType    string `json:"paymentType"`
	InsertionOrder string `json:"insertionOrder"`
	RevenueType    string `json:"revenueType"`
	DealListNames  string `json:"dealListNames"`
}

type TripleLiftConfig struct {
	DealPriceType         string   `json:"dealPriceType"`
	Channel               string   `json:"channel"`
	CommercializedFormats []string `json:"commercializedFormats"`
	AllowPoliticalAds     bool     `json:"allowPoliticalAds"`
}

// MagniteConfig carries the ClearLine Curation Demand Management inputs every
// Magnite deal needs beyond the shared deal fields: the marketplace (immutable
// after creation). Publishers are NOT collected — the generated prompt always
// sends the explicit publishers: "ALL" opt-in, which the Cutlass MCP expands
// server-side to every eligible marketplace publisher (an enumerated snapshot,
// size-filtered on DV+). The Publishers field is kept only so forms saved
// before the ALL rollout still unmarshal; it is ignored by validation and
// prompt generation.
type MagniteConfig struct {
	Marketplace string   `json:"marketplace"`
	Publishers  []string `json:"publishers,omitempty"`
	// AllPublishers is the "All eligible publishers" toggle (the Magnite
	// counterpart of PubMatic's Max Reach — owner-approved opt-out of the
	// all-publishers policy, 2026-08-21). Pointer so ABSENT (every pre-toggle
	// draft/brief) means true, matching the legacy wire; only an explicit
	// false demands PublisherEntries. Mirrors magniteConfig.allPublishers.
	AllPublishers *bool `json:"allPublishers"`
	// PublisherEntries is the explicit allowlist shipped when AllPublishers
	// is off — resolved fail-closed against the live ClearLine catalog.
	PublisherEntries []PublisherAllowlistEntry `json:"publisherEntries"`
	// PriceType is the ClearLine price type: "Market Rate" (no floor),
	// "Market Rate with Minimum" (the default — market-rate pricing
	// with the 0.10 publisher-tab minimum), or "CPM" (fixed CPM floor — what
	// the Sun Bum deals were mistakenly created as). Blank = the default.
	// Mirrors MagniteConfig.priceType in types/deal.ts.
	PriceType string `json:"priceType"`
	// FloorCPM is the publisher-tab floor for the floor-bearing price types
	// (the minimum under Market Rate with Minimum; the fixed CPM under CPM) —
	// NOT the deal CPM. It lands on every publisher row, so a high value
	// (e.g. the deal's $15 CPM) prices publishers out of the deal (the Sun Bum
	// incident, 2026-07). Blank falls back to the 0.10 minimum. Ignored under
	// plain Market Rate. Mirrors MagniteConfig.floorCpm in types/deal.ts.
	FloorCPM string `json:"floorCpm"`
	// NOTE: ad-format ids are PER-DEAL (DealEntry.MagniteSizes), not here — a
	// batch commonly mixes display/video/native Magnite deals and each format
	// type must be selected per deal.
}

type UploadedFile struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Size          int64  `json:"size"`
	Path          string `json:"path"`
	InclusionType string `json:"inclusionType"`
	// AppliesTo holds the deal ids this file is scoped to (the File Uploads
	// "Applies to" chips). Empty = every deal the file's channel routing
	// matches — the pre-existing behavior.
	AppliesTo []string `json:"appliesTo,omitempty"`
}

type DealEntry struct {
	ID                  string             `json:"id"`
	NameOverride        string             `json:"nameOverride"`
	Theme               string             `json:"theme"`
	Channel             string             `json:"channel"`
	SSP                 string             `json:"ssp"`
	InventoryType       string             `json:"inventoryType"`
	GeoInclude          []GeoEntry         `json:"geoInclude"`
	GeoExclude          []GeoEntry         `json:"geoExclude"`
	Language            string             `json:"language"`
	IncludeSegments     []string           `json:"includeSegments"`
	ExcludeSegments     []string           `json:"excludeSegments"`
	ExclusionOverride   *ExclusionOverride `json:"exclusionOverride,omitempty"`
	CPM                 string             `json:"cpm"`
	VCR                 string             `json:"vcr"`
	ViewabilityTarget   string             `json:"viewabilityTarget"`
	Notes               []string           `json:"notes"`
	PostCreateUIFix     []string           `json:"postCreateUiFix"`
	ExternalReferenceID string             `json:"externalReferenceId"`
	MagniteSizes        []string           `json:"magniteSizes"`
	// AdDurations (allowed creative lengths, e.g. ["15","30"]) and
	// MaxAdDurationSecs (duration cap) are ALTERNATIVE per-deal ad-duration
	// targets, integer SECONDS — the brief-schema ad_duration mapping
	// (allowed_durations vs max_seconds in cutlass deal-brief.schema.yaml).
	// Only valid on CTV/OLV/OTT channels (supportsAdDuration). Mirrors
	// DealEntry.adDurations / maxAdDurationSecs in types/deal.ts.
	AdDurations       []string `json:"adDurations"`
	MaxAdDurationSecs string   `json:"maxAdDurationSecs"`
	// IABCategories is the per-deal override: nil = governed by AutoInferIab
	// (toggle on → the audit infers per deal from theme/segments/brand;
	// toggle off → NOTHING ships), non-nil = the trader's own picks (possibly
	// empty = explicitly none). Mirrors DealEntry.iabCategories in
	// types/deal.ts.
	IABCategories []string `json:"iabCategories"`
	// AutoInferIab mirrors DealEntry.autoInferIab in types/deal.ts: keyword
	// inference is OPT-IN PER DEAL, default off. Only a true value with nil
	// IABCategories makes the inferred set ship (effectiveIabCategories in
	// inferIab.ts) — and only such deals are advertised in the audit's
	// inferred.per_deal block (buildInferredIAB).
	AutoInferIab bool `json:"autoInferIab"`
	// IABHint is the free-text guide for the agent's IAB lookup — it also
	// feeds the inference text, mirroring inferIab.ts dealText().
	IABHint string `json:"iabHint"`
	// DomainListID / AppBundleListID are the per-deal list overrides, mirroring
	// DealEntry.domainListId/appBundleListId in types/deal.ts. Three-state, so
	// pointers preserve the absent-vs-empty distinction the override semantics
	// depend on: nil = campaign default, "" = explicitly no list, "<id>" = that
	// specific standard list or ad-hoc upload. Consumed by the QA layer's
	// per-SSP list-delivery disclosure (qa_list_ssp_support) — without these
	// the Go audit could not see a per-deal pick at all (#220/#221).
	DomainListID    *string `json:"domainListId"`
	AppBundleListID *string `json:"appBundleListId"`
	// SheetOnly mirrors DealEntry.sheetOnly in types/deal.ts: the deal already
	// exists from a previous batch and only rides the deal sheet — the prompt
	// and brief generate NO create/tool call for it. Create-only checks skip
	// these rows; deal names / TotalDeals still include them (the runner gate's
	// prompt binding depends on that).
	SheetOnly bool `json:"sheetOnly,omitempty"`
}

// ExclusionOverride is trader intent only. Identity and time are deliberately
// absent: the /api/runner/create enforcement point derives both from the session
// and server clock before writing the durable audit event. SSP binding makes a
// stale acknowledgement fail closed after the trader changes the deal route.
type ExclusionOverride struct {
	SSP             string `json:"ssp"`
	Acknowledgement string `json:"acknowledgement"`
}

// ExclusionOverridePhrase is deliberately awkward and SSP-specific: a generic
// checkbox is too easy to click through, and copying an acknowledgement from
// another SSP must not authorize this operation.
func ExclusionOverridePhrase(ssp string) string {
	return "CREATE ON " + strings.TrimSpace(ssp) + " WITHOUT THESE EXCLUSIONS"
}

func hasTypedExclusionOverride(deal DealEntry) bool {
	return deal.ExclusionOverride != nil &&
		strings.TrimSpace(deal.ExclusionOverride.SSP) == strings.TrimSpace(deal.SSP) &&
		strings.TrimSpace(deal.ExclusionOverride.Acknowledgement) == ExclusionOverridePhrase(deal.SSP)
}

// ReportingLabels are campaign-level KV labels the trader can supply. They
// ride onto SSPs with a reporting-labels wire (Index Exchange) as advertiser,
// agency, salesperson, externalReferenceID, custom (submitter:<email>).
type ReportingLabels struct {
	Salesperson string `json:"salesperson"`
	Advertiser  string `json:"advertiser"`
	Custom      string `json:"custom"`
}

type AuditRequest struct {
	SubmitterName    string `json:"submitterName"`
	SubmitterEmail   string `json:"submitterEmail"`
	RequestedDueDate string `json:"requestedDueDate"`
	FlightStartDate  string `json:"flightStartDate"`
	FlightEndDate    string `json:"flightEndDate"`

	Agency          string `json:"agency"`
	Brand           string `json:"brand"`
	CampaignName    string `json:"campaignName"`
	CampaignID      string `json:"campaignId"`
	DataPartner     string `json:"dataPartner"`
	Funnel          string `json:"funnel"`
	AttributionCode string `json:"attributionCode"`

	DSPs         []DSPEntry `json:"dsps"`
	MultipleDSPs bool       `json:"multipleDsps"`

	DefaultInventoryType string     `json:"defaultInventoryType"`
	DefaultGeoInclude    []GeoEntry `json:"defaultGeoInclude"`
	DefaultGeoExclude    []GeoEntry `json:"defaultGeoExclude"`
	DefaultLanguage      string     `json:"defaultLanguage"`
	DefaultDisplayCPM    string     `json:"defaultDisplayCpm"`
	DefaultVideoCPM      string     `json:"defaultVideoCpm"`
	DefaultVCR           string     `json:"defaultVcr"`
	// Viewability has deliberately NO campaign-level default — it is per-deal
	// only (DealEntry.ViewabilityTarget) and applied only when specified.

	IXConfig         IXConfig         `json:"ixConfig"`
	OpenXConfig      OpenXConfig      `json:"openxConfig"`
	PubMaticConfig   PubMaticConfig   `json:"pubmaticConfig"`
	MediaNetConfig   MediaNetConfig   `json:"medianetConfig"`
	XandrConfig      XandrConfig      `json:"xandrConfig"`
	TripleLiftConfig TripleLiftConfig `json:"tripleliftConfig"`
	MagniteConfig    MagniteConfig    `json:"magniteConfig"`

	IABCategories   []string `json:"iabCategories"`
	DailyPacingGoal string   `json:"dailyPacingGoal"`
	KPIGoal         string   `json:"kpiGoal"`

	// ExpectedAdCategory is the OpenX "Expected Sensitive Category" (e.g.
	// "Politics"). NOT settable via the OpenX partner API (verified
	// 2026-08-17: dealCreate rejects the field, dealById never returns it —
	// it exists only on the OpenX UI's internal API), so it is a MANUAL
	// post-create UI step: the prompt injects per-deal post_create_ui_fix
	// reminders and the QA report carries a manual checklist item.
	ExpectedAdCategory string `json:"expectedAdCategory"`

	CuratedDealFee string `json:"curatedDealFee"`
	FeeType        string `json:"feeType"`

	// DealSheetRecipient is the trader's email the deal-sheet is sent to after a
	// batch create. Required when batch-supported deals exist — a blank value
	// emits a placeholder recipient that bounces / mis-sends.
	DealSheetRecipient string `json:"dealSheetRecipient"`

	DomainLists    []UploadedFile `json:"domainLists"`
	AppBundleLists []UploadedFile `json:"appBundleLists"`

	// Curated allow/block list ids the trader toggled on. The audit handler
	// resolves these against the standard-lists registry and folds them into
	// DomainLists / AppBundleLists with InclusionType already set from the
	// list's kind, so downstream rules treat them uniformly with ad-hoc uploads.
	AppliedDomainListIDs    []string `json:"appliedDomainListIds"`
	AppliedAppBundleListIDs []string `json:"appliedAppBundleListIds"`

	// PerDealLists carries the standard lists a deal picked via the PER-DEAL
	// list picker (DealEntry.DomainListID/AppBundleListID) — resolved through
	// the registry by the audit handler so list_ref / list_applied can see
	// them. These are NOT in DomainLists/AppBundleLists (which only hold
	// ad-hoc uploads + BATCH-applied standard lists). Server-populated only
	// (JSON-skipped) — a client cannot inject entries.
	PerDealLists []UploadedFile `json:"-"`

	Deals []DealEntry `json:"deals"`

	ReportingLabels ReportingLabels `json:"reportingLabels"`
}

type CheckResult struct {
	Rule      string `json:"rule"`
	Passed    bool   `json:"passed"`
	Message   string `json:"message"`
	DealIndex int    `json:"dealIndex,omitempty"`
	FieldPath string `json:"fieldPath,omitempty"`
}

// InferredDealIAB is one deal's inferred IAB categories — emitted only for
// deals with no explicit per-deal iabCategories override.
type InferredDealIAB struct {
	DealIndex     int      `json:"deal_index"`
	IABCategories []string `json:"iab_categories"`
}

type InferredData struct {
	// IABCategories is the union across deals (kept for backward compat with
	// consumers of the old campaign-wide inference).
	IABCategories []string          `json:"iab_categories"`
	Note          string            `json:"note"`
	PerDeal       []InferredDealIAB `json:"per_deal,omitempty"`
}

type AuditResponse struct {
	Status     string        `json:"status"`
	TotalDeals int           `json:"total_deals"`
	DealNames  []string      `json:"deal_names"`
	Checks     []CheckResult `json:"checks"`
	Inferred   InferredData  `json:"inferred"`
	// QA is the Deal QA Specialist report — the pre-launch QA
	// checklist evaluated against this form (see qa.go).
	QA QAReport `json:"qa"`
}

// operator is the installation identity (ORG_NAME, CAMPAIGN_ID_PREFIX,
// DEFAULT_ATTRIBUTION_CODE). Set once at boot via Configure; tests run on the
// defaults.
var operator = config.Default()

// Configure installs the operator identity the audit and the name generator
// read (curator slot, campaign-id pattern, attribution default).
func Configure(op config.Operator) {
	if strings.TrimSpace(op.OrgName) == "" {
		op.OrgName = config.DefaultOrgName
	}
	if strings.TrimSpace(op.CampaignIDPrefix) == "" {
		op.CampaignIDPrefix = config.DefaultCampaignIDPrefix
	}
	if strings.TrimSpace(op.DefaultAttributionCode) == "" {
		op.DefaultAttributionCode = config.DefaultDefaultAttributionCode
	}
	operator = op
}

// Operator returns the active operator identity.
func Operator() config.Operator { return operator }

// LOCKED sheet vocabulary (docs/DEAL_NAMING.md — do not re-abbreviate).
// Keys are vocabKey()-normalized (lowercased, whitespace-collapsed) so lookups
// are case- and whitespace-insensitive on input. MIRROR CONTRACT:
// frontend/src/lib/dealNameSlots.ts holds the same tables; the shared golden
// fixture testdata/deal_naming_golden.json pins the two together.
var sspSlotCode = map[string]string{
	"index exchange": "Index",
	"openx":          "OpenX",
	"pubmatic":       "Pubmatic",
	"magnite":        "Magnite",
	"xandr":          "Xandr",
	"media.net":      "Media.net",
	"triplelift":     "TripleLift",
}

var dspSlotCode = map[string]string{
	"the trade desk":       "TTD",
	"the trade desk - rtb": "TTD",
	"dv360":                "DV360",
	"amazon dsp":           "Amazon",
	"adsp":                 "Amazon", // common short form of Amazon DSP
	"yahoo dsp":            "Yahoo",
}

// isNameSpace is the shared whitespace class for slot-input trimming — the
// UNION of Go's unicode.IsSpace and JS \s: Go IsSpace lacks U+FEFF (BOM,
// which JS strips) and JS \s lacks U+0085 (NEL, which Go strips). Both
// languages trim the union so a pasted NEL/BOM can never make the two
// generators disagree. Mirrors NAME_SPACE/trimInput in
// frontend/src/lib/dealNameSlots.ts.
func isNameSpace(r rune) bool {
	return unicode.IsSpace(r) || r == '\uFEFF'
}

// trimInput trims leading/trailing shared-class whitespace from a slot input.
func trimInput(s string) string {
	return strings.TrimFunc(s, isNameSpace)
}

// vocabKey normalizes a vocabulary-lookup input: trim, collapse internal
// whitespace (shared class, incl. NEL/BOM), lowercase — so
// "\uFEFFThe Trade  Desk " still resolves to TTD.
func vocabKey(s string) string {
	return strings.ToLower(strings.Join(strings.FieldsFunc(s, isNameSpace), " "))
}

// upperASCII maps [a-z] to [A-Z] and leaves every other rune for the
// sanitizer. Unicode-aware uppercasing diverges between languages (JS
// "ß".toUpperCase() → "SS"; Go keeps ß) — byte parity wins. Mirrors
// upperAscii in dealNameSlots.ts.
func upperASCII(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= 'a' && r <= 'z' {
			r -= 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}

// dataPartnerCodeFor resolves a data-partner display name to its curator-slot
// code; unknown partners pass through sanitized.
// dataPartnerCodeFor resolves the Curator slot for a data partner: the
// partner's name, sanitized to the slot charset. Mirrors dataPartnerCodeFor in
// frontend/src/lib/dealNameSlots.ts.
func dataPartnerCodeFor(dp string) string {
	return sanitizeSlotValue(dp)
}

// sanitizeSlotValue sanitizes a VALUE slot: keeps [A-Za-z0-9 .-] — spaces are
// PRESERVED inside slots (owner call 2026-08-11, matching the naming workbook
// and the historical deal record: "SNAP proxy users" stays spaced). All
// Unicode whitespace (NBSP, tabs, NEL, BOM, …) normalizes to a single ASCII
// space; underscores (which would corrupt slot positions) and punctuation are
// dropped; runs of spaces collapse and the ends are trimmed. Mirrors
// sanitizeSlotValue in frontend/src/lib/dealNameSlots.ts byte-for-byte.
func sanitizeSlotValue(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	lastSpace := false
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-':
			b.WriteRune(r)
			lastSpace = false
		case isNameSpace(r):
			if !lastSpace {
				b.WriteRune(' ')
				lastSpace = true
			}
		}
	}
	return strings.Trim(b.String(), " ")
}

func normalizedSegment(s, fallback string) string {
	if cleaned := sanitizeSlotValue(s); cleaned != "" {
		return cleaned
	}
	return fallback
}

// validViewabilityTarget accepts the SSP viewability bucket grid: whole
// decile percents 10–90. Tolerates fraction form ("0.7") since the prompt
// builder normalizes either way; everything else — including the scroll-tick
// integers like 71 — is off-catalog for IX and fails viewability_code.
func validViewabilityTarget(s string) bool {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return false
	}
	if v > 0 && v <= 1 {
		v *= 100
	}
	if v < 10 || v > 90 {
		return false
	}
	return math.Mod(v, 10) == 0
}

func parsePositiveFloat(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil && v > 0
}

func isVideoChannel(ch string) bool {
	return ch == "OLV (Online Video)" || ch == "OLV" || ch == "CTV" || ch == "OTT" || ch == "Audio"
}

// supportsAdDuration reports whether the channel can carry ad-duration
// targeting (the brief-schema ad_duration field): CTV/OLV/OTT only.
// Deliberately NOT isVideoChannel — Audio is a video channel for KPI
// purposes (VCR) but has no ad-duration targeting. Mirrors
// dealSupportsAdDuration in types/deal.ts.
func supportsAdDuration(ch string) bool {
	return isVideoChannel(ch) && ch != "Audio"
}

func containsSSP(deals []DealEntry, target string) bool {
	for _, d := range deals {
		if strings.EqualFold(d.SSP, target) {
			return true
		}
	}
	return false
}

// containsCreateSSP reports whether any CREATE row (not sheet-only) uses the
// target SSP. SSP-specific shared-config checks key off this rather than
// containsSSP: they validate create-time configuration, and a sheet-only row
// (already created in a previous batch, riding the deal sheet only) must not
// demand config for an SSP this batch never calls — e.g. a follow-up batch
// with new IX creates plus two already-live OpenX rows must not require an
// OpenX Deal Price.
func containsCreateSSP(deals []DealEntry, target string) bool {
	for _, d := range deals {
		if !d.SheetOnly && strings.EqualFold(d.SSP, target) {
			return true
		}
	}
	return false
}

// createSSPsInOrder returns the distinct SSPs of CREATE rows (not sheet-only)
// in first-appearance order — the batch the allowlist_coverage check reports.
func createSSPsInOrder(deals []DealEntry) []string {
	seen := map[string]bool{}
	var out []string
	for _, d := range deals {
		ssp := strings.TrimSpace(d.SSP)
		if d.SheetOnly || ssp == "" || seen[strings.ToLower(ssp)] {
			continue
		}
		seen[strings.ToLower(ssp)] = true
		out = append(out, ssp)
	}
	return out
}

// seatOptionalDSPs — DSPs that bid through a house seat on the exchanges we
// curate, so there is no per-client Seat ID for traders to enter and the SSPs
// accept deals for them without one (StackAdapt, 2026-08). Keyed by canonical
// name: lowercase, alphanumerics only. Mirrored in TS:
// frontend/src/lib/seatPolicy.ts — change both together.
var seatOptionalDSPs = map[string]bool{
	"stackadapt": true,
}

func seatOptionalDSP(name string) bool {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return seatOptionalDSPs[b.String()]
}

// seatRequiredCreateSSPs returns the batch's CREATE-row SSPs that still demand
// a Seat ID even for a seat-optional DSP: the PubMatic MCP resolves the DSP
// buyer mapping from seat_id (a seatless create hard-blocks with
// missing_dsp_buyer), and the TripleLift prompt embeds dsp.seat.seatString —
// a blank seat would emit an unresolved <FILL> token the /api/runner/create
// prompt gate rejects. Mirrored in TS: frontend/src/lib/seatPolicy.ts.
func seatRequiredCreateSSPs(deals []DealEntry) []string {
	var out []string
	for _, ssp := range []string{"PubMatic", "TripleLift"} {
		if containsCreateSSP(deals, ssp) {
			out = append(out, ssp)
		}
	}
	return out
}

// multiSeatSSPs — SSPs whose CREATE path accepts more than one buyer seat on a
// single deal. Magnite's ClearLine Demand Management API takes dsps[i].buyers
// as a list and resolves every ref independently against the DSP's buyer
// catalog (mcp/magnite_mcp.py), so one deal can be pinned to several DV360
// buyers (one live batch ran 14). Every other SSP carries exactly ONE seat
// token — IX seat_name, PubMatic seat_id, OpenX buyer_ids, Xandr buyer,
// TripleLift dsp.seat.seatString — and would ship a comma list verbatim as a
// single unresolvable token. Keyed lowercase. Mirrored in TS:
// frontend/src/lib/seatPolicy.ts — change both together.
var multiSeatSSPs = map[string]bool{
	"magnite": true,
}

// SplitSeatIDs splits a Seat ID field into its individual seat tokens. Traders
// enter several buyer seats comma-separated ("1413973141,850299280,134"). The
// historical `prefix/seat` strip is applied PER TOKEN so a mixed list can never
// collapse onto the last slash in the whole string. Order-preserving, trimmed,
// deduped. Mirrored in TS: splitSeatIds (frontend/src/lib/seatPolicy.ts).
func SplitSeatIDs(seat string) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range strings.Split(seat, ",") {
		token := strings.TrimSpace(raw)
		if i := strings.LastIndex(token, "/"); i >= 0 {
			token = strings.TrimSpace(token[i+1:])
		}
		if token == "" || seen[token] {
			continue
		}
		seen[token] = true
		out = append(out, token)
	}
	return out
}

// singleSeatCreateSSPs returns the batch's CREATE-row SSPs that accept exactly
// one seat — the SSPs a multi-seat Seat ID would break.
func singleSeatCreateSSPs(deals []DealEntry) []string {
	var out []string
	for _, ssp := range createSSPsInOrder(deals) {
		if !multiSeatSSPs[strings.ToLower(strings.TrimSpace(ssp))] {
			out = append(out, ssp)
		}
	}
	return out
}

// geoExcludeEmittingSSPs is the allowlist of SSPs whose create prompts emit
// geo exclusions end-to-end (#244, coordinated with the Cutlass
// create-arg plumbing + cutlass-contract.json geoExclude facts verified by
// scripts/check-cutlass-contract.mjs):
//   - openx:    targeting.geographic.excludes branch (state w/ single-country
//     hint; country when no state exclusion occupies the branch)
//   - pubmatic: geo_countries_exclude / geo_states_exclude → excludeGeos
//   - xandr:    geo_countries_exclude / geo_states_exclude →
//     country_action/region_action="exclude" (XOR with includes
//     per dimension — one action sibling per profile dimension)
//   - magnite:  geo_countries_exclude (XOR with country includes —
//     geography.country is a single Include XOR Exclude component)
//
// Membership is NECESSARY but not SUFFICIENT: geoExcludeBlockReason applies
// the per-shape rules above, and any exclusion shape outside its SSP's
// verified wire (zip/dma anywhere, states on Magnite, include+exclude XOR
// conflicts, mixed/unscopable OpenX exclude states) still fails closed.
// IX (no exclusion surface), Media.net (is_excluded vendor-UNVERIFIED) and
// TripleLift (excluded:true vendor-unconfirmed) stay out indefinitely.
// A live paused-canary read-back per SSP remains the #244 acceptance gate
// before external release.
var geoExcludeEmittingSSPs = map[string]bool{
	"openx":    true,
	"pubmatic": true,
	"xandr":    true,
	"magnite":  true,
}

// effectiveGeoExclude mirrors the prompt pipeline's resolve(): the deal's own
// geoExclude chips win; an exclusion-less deal inherits the form default.
func effectiveGeoExclude(deal DealEntry, req *AuditRequest) []GeoEntry {
	if len(deal.GeoExclude) > 0 {
		return deal.GeoExclude
	}
	return req.DefaultGeoExclude
}

// geoExcludeBlockReason reports why THIS deal's effective geo exclusions
// cannot ship on its SSP's verified exclude wire — "" when every exclusion
// rides one. Shared by the geo_exclude_unsupported audit rule (fail-closed
// block) and the qa_geo item (truthful reporting) so they can never disagree.
// The per-shape rules mirror the prompt builders in dealPromptYaml.ts —
// whatever a builder can only mark NOT-SUPPORTED must block here.
func geoExcludeBlockReason(deal DealEntry, req *AuditRequest) string {
	excl := effectiveGeoExclude(deal, req)
	if len(excl) == 0 {
		return ""
	}
	sspLabel := strings.TrimSpace(deal.SSP)
	ssp := strings.ToLower(sspLabel)
	if !geoExcludeEmittingSSPs[ssp] {
		return fmt.Sprintf("geo exclusions are not emitted on %s — the create would silently drop them and the deal would SERVE the excluded geo; remove the exclusion or move the deal to an exclude-emitting SSP (OpenX/PubMatic/Xandr/Magnite)", nonEmptyOr(sspLabel, "this SSP"))
	}
	inc := deal.GeoInclude
	if len(inc) == 0 {
		inc = req.DefaultGeoInclude
	}
	hasIncCountry, hasIncState := false, false
	for _, g := range inc {
		switch g.Type {
		case "country":
			hasIncCountry = true
		case "state":
			hasIncState = true
		}
	}
	exUS, exCA := false, false
	for _, g := range excl {
		v := strings.TrimSpace(g.Value)
		switch g.Type {
		case "zip", "dma":
			return fmt.Sprintf("%s geo exclusions have no SSP exclude wire (no ZIP/DMA exclude emission exists on any SSP) — the exclusion would be silently dropped", g.Type)
		case "state":
			switch ssp {
			case "magnite":
				// geography.country and geography.region are INDEPENDENT
				// components, each with its own Include/Exclude type — so a
				// province exclusion rides happily alongside a country include
				// ("target Canada, exclude Quebec"). Live-verified 2026-08-28
				// on MGNI-MD-449-34286: a region Exclude written through the
				// DMG API round-tripped with every sibling intact. What does
				// NOT compose is exclude + include on the SAME component.
				if hasIncState {
					return "Magnite geography.region is a single Include XOR Exclude component — a state exclusion cannot ride alongside state includes; split the geographies or drop one side"
				}
			case "xandr":
				if hasIncState {
					return "Xandr carries ONE region_action per profile — a state exclusion cannot ride alongside state includes; split the geographies or drop one side"
				}
			case "openx", "pubmatic":
				// OpenX scopes exclude-state resolution with ONE country hint
				// (the F1-stripped scope hint); PubMatic scopes exclude states
				// by the include country (F3). Both need each exclude state to
				// classify to a SINGLE US/CA country — an unclassifiable token
				// ("Jersey") would mis-resolve to the wrong region and SERVE
				// the intended one, and a mixed US+CA set has no single scope.
				// (#244 F1c/F3c — same shape gate for both.)
				switch classifyGeoState(v) {
				case "us":
					exUS = true
				case "ca":
					exCA = true
				default:
					return fmt.Sprintf("%s exclude state %q does not classify as a US state or Canadian province — it would reach the SSP untyped and mis-resolve to the wrong region (serving the intended one)", nonEmptyOr(sspLabel, "this SSP"), v)
				}
				if exUS && exCA {
					return fmt.Sprintf("%s scopes exclude-state resolution with ONE country — mixed US and Canadian exclude states cannot ship on one deal; split the geographies", nonEmptyOr(sspLabel, "this SSP"))
				}
			}
		case "country":
			switch ssp {
			case "magnite":
				if hasIncCountry {
					return "Magnite geography.country is a single Include XOR Exclude component (geo_country_conflict) — a country exclusion cannot ride alongside country includes (and is a no-op next to an include allowlist); remove one side"
				}
			case "xandr":
				if hasIncCountry {
					return "Xandr carries ONE country_action per profile — a country exclusion cannot ride alongside country includes; remove one side"
				}
			case "openx":
				hasExState := false
				for _, g2 := range excl {
					if g2.Type == "state" {
						hasExState = true
						break
					}
				}
				if hasExState {
					return "the OpenX excludes branch carries ONE country field, already used as the state-exclusion scope hint — country and state exclusions cannot ship together; split the geographies"
				}
			}
		}
	}
	return ""
}

func nonEmptyOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// excludeCapability classifies an SSP's create-time capability to ENFORCE an
// exclusion dimension (#226 F2). UNKNOWN is treated identically to
// UNSUPPORTED (fail closed) — we NEVER infer exclude support from include
// support; a distinct message just names the vendor-unconfirmed status.
type excludeCapability int

const (
	excludeSupported excludeCapability = iota
	excludeUnsupported
	excludeUnknown
)

// audienceExcludeCapabilityFor is the single capability model the gate reads
// (#226 F2). Audience segment EXCLUSIONS on create:
//   - IX / PubMatic / Xandr: supported (excluded_segment_names wire).
//   - Magnite: supported on CTV (SpringServe audience_segments_block);
//     UNSUPPORTED on DV+ (no audience API until v3.0).
//   - OpenX: UNSUPPORTED (confirmed — include-only audience {op,val} object).
//   - Media.net / TripleLift: UNKNOWN (vendor-unconfirmed exclude surface).
func audienceExcludeCapabilityFor(ssp, channel string) excludeCapability {
	switch strings.ToLower(strings.TrimSpace(ssp)) {
	case "index exchange", "pubmatic", "xandr":
		return excludeSupported
	case "magnite":
		if strings.TrimSpace(channel) == "CTV" {
			return excludeSupported
		}
		return excludeUnsupported
	case "openx":
		return excludeUnsupported
	case "media.net", "triplelift":
		return excludeUnknown
	default:
		return excludeUnknown
	}
}

// effectiveAudienceExcludes mirrors resolve()'s exclusion set: the deal's own
// trader-entered excludeSegments, trimmed and non-empty.
func effectiveAudienceExcludes(deal DealEntry) (trader []string) {
	for _, s := range deal.ExcludeSegments {
		if t := strings.TrimSpace(s); t != "" {
			trader = append(trader, t)
		}
	}
	return trader
}

// audienceExcludeBlockReason reports why THIS deal's audience segment
// EXCLUSIONS cannot be enforced on its (deal, SSP) — "" when the SSP can carry
// them or the deal has none. Fail-closed by capability (unknown == blocked).
// Shared by the segment_exclude_unsupported audit rule and the
// qa_segment_excludes item so they never disagree. Mirrors
// geoExcludeBlockReason's fail-closed discipline (the two exclude gates share
// one philosophy: never create-WITHOUT an exclusion the wire can't carry —
// that SERVES the excluded audience/geo). provenance is always "trader"
// (fail-closed; a typed acknowledge-and-strip override is available).
func audienceExcludeBlockReason(deal DealEntry) (reason, provenance string) {
	trader := effectiveAudienceExcludes(deal)
	if len(trader) == 0 {
		return "", ""
	}
	capability := audienceExcludeCapabilityFor(deal.SSP, deal.Channel)
	if capability == excludeSupported {
		return "", ""
	}
	sspLabel := nonEmptyOr(strings.TrimSpace(deal.SSP), "this SSP")
	vendorNote := "cannot enforce a create-time audience exclusion"
	if capability == excludeUnknown {
		vendorNote = "has no vendor-confirmed create-time audience-exclusion wire (treated as unsupported — never inferred from include support)"
	}
	return fmt.Sprintf(
		"audience segment EXCLUSION(s) [%s] cannot be applied on %s — %s. Not created on %s (a create-without would SERVE the excluded audience); apply the exclusion in the SSP UI / on the DSP line, or move the deal to an SSP that enforces excludes (Index Exchange / PubMatic / Xandr / Magnite CTV). Other deals in the batch are unaffected.",
		strings.Join(trader, ", "), sspLabel, vendorNote, sspLabel,
	), "trader"
}

// ExclusionOverrideDetails is the canonical, server-recomputed description of
// what an acknowledgement strips. It intentionally contains no client-sent
// actor or timestamp; the runner handler adds those at its authenticated seam.
type ExclusionOverrideDetails struct {
	DealID   string   `json:"deal_id"`
	SSP      string   `json:"ssp"`
	Audience []string `json:"audience"`
	Geo      []string `json:"geo"`
	Source   string   `json:"source"`
}

// ActiveExclusionOverride returns the exact trader values authorized for
// stripping.
func ActiveExclusionOverride(deal DealEntry, req *AuditRequest) (ExclusionOverrideDetails, bool) {
	detail := ExclusionOverrideDetails{DealID: strings.TrimSpace(deal.ID), SSP: strings.TrimSpace(deal.SSP), Source: "trader"}
	if !hasTypedExclusionOverride(deal) {
		return detail, false
	}
	if reason, provenance := audienceExcludeBlockReason(deal); reason != "" && provenance == "trader" {
		seen := map[string]bool{}
		for _, raw := range deal.ExcludeSegments {
			v := strings.TrimSpace(raw)
			if v != "" && !seen[v] {
				detail.Audience = append(detail.Audience, v)
				seen[v] = true
			}
		}
	}
	if geoExcludeBlockReason(deal, req) != "" {
		seen := map[string]bool{}
		for _, g := range effectiveGeoExclude(deal, req) {
			v := strings.TrimSpace(g.Value)
			if v == "" {
				continue
			}
			item := strings.TrimSpace(g.Type) + ":" + v
			if !seen[item] {
				detail.Geo = append(detail.Geo, item)
				seen[item] = true
			}
		}
	}
	return detail, len(detail.Audience) > 0 || len(detail.Geo) > 0
}

// RunAudit executes all validation rules and returns the audit response.
func RunAudit(req *AuditRequest, campaignID string) AuditResponse {
	var checks []CheckResult

	// 1. Campaign-level completeness (shared header).
	// One failed check PER missing field, each carrying its own FieldPath so the
	// offending input red-outlines and the right section turns red — rather than
	// one aggregated "Missing campaign fields: …" message the trader has to parse.
	type reqField struct {
		blank bool
		path  string
		label string
	}
	header := []reqField{
		{strings.TrimSpace(req.SubmitterName) == "", "submitterName", "Submitter Name"},
		{strings.TrimSpace(req.SubmitterEmail) == "", "submitterEmail", "Submitter Email"},
		{strings.TrimSpace(req.FlightStartDate) == "", "flightStartDate", "Flight Start Date"},
		{strings.TrimSpace(req.FlightEndDate) == "", "flightEndDate", "Flight End Date"},
		{strings.TrimSpace(req.Agency) == "", "agency", "Agency"},
		{strings.TrimSpace(req.Brand) == "", "brand", "Brand"},
		{len(req.DSPs) == 0 || strings.TrimSpace(req.DSPs[0].DSP) == "", "dsps[0].dsp", "DSP"},
		{strings.TrimSpace(req.FeeType) == "", "feeType", "Fee Type"},
	}
	anyMissing := false
	for _, f := range header {
		if f.blank {
			anyMissing = true
			checks = append(checks, CheckResult{Rule: "completeness", Passed: false, Message: f.label + " is required", FieldPath: f.path})
		}
	}
	if !anyMissing {
		checks = append(checks, CheckResult{Rule: "completeness", Passed: true, Message: "Campaign header is complete"})
	}

	// 2. Date logic
	// "Today" is the BUSINESS timezone's calendar date (America/New_York —
	// #235.1), represented at UTC midnight so it compares cleanly
	// against the UTC-parsed form dates. The old server-LOCAL resolution
	// rejected "today" for evening-ET traders whenever the server clock ran
	// UTC (prod), and disagreed with the frontend's resolveStartDate bump.
	now := nowFunc().In(businessLocation)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	startOK, endOK, dateLogicPassed := true, true, true
	var startDate, endDate time.Time
	var dateMsg, dateField string
	if req.FlightStartDate != "" {
		var err error
		startDate, err = time.Parse("2006-01-02", req.FlightStartDate)
		if err != nil {
			startOK = false
			dateMsg = "Invalid Flight Start Date format"
			dateField = "flightStartDate"
			dateLogicPassed = false
		} else if startDate.Before(today) {
			startOK = false
			dateMsg = "Flight Start Date must be today or later"
			dateField = "flightStartDate"
			dateLogicPassed = false
		}
	}
	if req.FlightEndDate != "" {
		var err error
		endDate, err = time.Parse("2006-01-02", req.FlightEndDate)
		if err != nil {
			endOK = false
			dateMsg = "Invalid Flight End Date format"
			dateField = "flightEndDate"
			dateLogicPassed = false
		}
	}
	if startOK && endOK && !startDate.IsZero() && !endDate.IsZero() && endDate.Before(startDate) {
		dateMsg = "Flight End Date must be on or after Flight Start Date"
		dateField = "flightEndDate"
		dateLogicPassed = false
	}
	if dateLogicPassed {
		checks = append(checks, CheckResult{Rule: "date_logic", Passed: true, Message: "Flight dates are valid"})
	} else {
		checks = append(checks, CheckResult{Rule: "date_logic", Passed: false, Message: dateMsg, FieldPath: dateField})
	}

	// 3. Curated Deal Fee (shared)
	if _, feeOK := parsePositiveFloat(req.CuratedDealFee); feeOK {
		checks = append(checks, CheckResult{Rule: "deal_fee", Passed: true, Message: "Curated Deal Fee is valid"})
	} else {
		checks = append(checks, CheckResult{Rule: "deal_fee", Passed: false, Message: "Curated Deal Fee must be greater than zero", FieldPath: "curatedDealFee"})
	}

	// 3b. Fee-type wire (#234.1/#234.2 — money path, FAIL CLOSED).
	// Every SSP wire the prompt builders emit books the Curated Deal Fee as a
	// PERCENT margin (IX/Xandr margin_percent, PubMatic feeValue, OpenX PoM
	// gross_share_percent, TripleLift curationFee FEE_MODEL_TYPE_PERCENT,
	// Media.net margin, Magnite Percent rev-share fraction). A non-percent
	// fee type ('Fixed CPM', 'Flat Fee') therefore has NO verified wire on
	// ANY SSP: a Flat-Fee 5000 or a Fixed-CPM 1.00 would be silently booked
	// as a 5000% / 1% margin on a live money deal. Block every batch that
	// would CREATE deals under a non-percent fee type until a verified
	// non-percent wire ships; the builders emit a '# BLOCKED' marker (the
	// server submit gate's hard don't-run marker) as defense in depth.
	// Sheet-only-only batches create nothing and pass.
	feeType := strings.TrimSpace(req.FeeType)
	hasCreateRows := false
	for _, d := range req.Deals {
		if !d.SheetOnly && strings.TrimSpace(d.SSP) != "" {
			hasCreateRows = true
			break
		}
	}
	if feeType != "" && !strings.EqualFold(feeType, "Percentage of Media") && hasCreateRows {
		checks = append(checks, CheckResult{Rule: "fee_type_wire", Passed: false,
			Message:   fmt.Sprintf("Fee Type %q has no verified SSP wire — every create emission books the Curated Deal Fee as a PERCENT margin, so a non-percent fee would be silently mis-booked on a live money deal (#234.1). Use 'Percentage of Media', or hold the batch until a verified non-percent wire ships.", feeType),
			FieldPath: "feeType"})
	} else {
		checks = append(checks, CheckResult{Rule: "fee_type_wire", Passed: true, Message: "Fee type is compatible with the percent margin wires"})
	}

	// 4. At least one deal
	if len(req.Deals) == 0 {
		checks = append(checks, CheckResult{Rule: "deals_required", Passed: false, Message: "At least one deal is required"})
	} else {
		checks = append(checks, CheckResult{Rule: "deals_required", Passed: true, Message: fmt.Sprintf("%d deal(s) configured", len(req.Deals))})
	}

	// 5. Per-deal validation
	for i, deal := range req.Deals {
		prefix := fmt.Sprintf("Deal %d", i+1)

		if strings.TrimSpace(deal.Theme) == "" {
			checks = append(checks, CheckResult{Rule: "deal_theme", Passed: false, Message: prefix + ": Theme is required", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].theme", i)})
		}
		if strings.TrimSpace(deal.Channel) == "" {
			checks = append(checks, CheckResult{Rule: "deal_channel", Passed: false, Message: prefix + ": Channel is required", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].channel", i)})
		}
		if strings.TrimSpace(deal.SSP) == "" {
			checks = append(checks, CheckResult{Rule: "deal_ssp", Passed: false, Message: prefix + ": SSP is required", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].ssp", i)})
		}

		effectiveInv := deal.InventoryType
		if effectiveInv == "" {
			effectiveInv = req.DefaultInventoryType
		}
		if effectiveInv == "" {
			checks = append(checks, CheckResult{Rule: "deal_inv", Passed: false, Message: prefix + ": Inventory Type required (per-deal or default)", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].inventoryType", i)})
		} else if !recognizedInventoryType(effectiveInv) {
			// Unknown inventory values would land in the deal name unnormalized —
			// fail loudly instead of shipping an off-vocabulary slot.
			checks = append(checks, CheckResult{Rule: "inventory_code", Passed: false, Message: fmt.Sprintf("%s: Inventory Type %q is not recognized — use All, Web Only, or In-App", prefix, effectiveInv), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].inventoryType", i)})
		}

		// Channel vocabulary guard — mirrors the inventory guard above. An
		// unrecognized channel would land in the name sanitized-but-off-
		// vocabulary and drives no SSP channel hint downstream.
		if !recognizedChannel(deal.Channel) {
			checks = append(checks, CheckResult{Rule: "channel_code", Passed: false, Message: fmt.Sprintf("%s: Channel %q is not recognized — use Display, OLV (Online Video), CTV, OTT, Native, or Audio", prefix, deal.Channel), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].channel", i)})
		}

		// Include segments are optional for all SSPs (trader request) — no
		// create-time requirement is enforced here for now.

		// CPM/VCR are create-time inputs (they feed the per-SSP create prompt's
		// pricing/KPI args). A sheet-only row is never created — nothing
		// downstream consumes them — so requiring them would block a legitimate
		// follow-up batch that lists an already-live deal by name. Theme,
		// channel, SSP, and inventory stay required above: they feed the deal
		// name and the deal-sheet row.
		if deal.SheetOnly {
			continue
		}
		video := isVideoChannel(deal.Channel)
		// Magnite deals don't take a per-deal CPM: the ClearLine floor is the
		// publisher-tab floor from MagniteConfig.FloorCPM (checked by mg_floor)
		// and margin rides on rev_share — a deal CPM here has nothing to feed.
		// PubMatic deals don't either (2026-08-19): a deal-level floor forces
		// Fixed Price on PubMatic and the deal TRANSACTS at that exact CPM
		// (PM-ZOOR-0075 booked fixed at $22.77), so the prompt always ships
		// auction_type=1 with no floor_ecpm and the CPM feeds nothing.
		if !strings.EqualFold(strings.TrimSpace(deal.SSP), "Magnite") && !strings.EqualFold(strings.TrimSpace(deal.SSP), "PubMatic") {
			effectiveCPM := deal.CPM
			if effectiveCPM == "" {
				if video {
					effectiveCPM = req.DefaultVideoCPM
				} else {
					effectiveCPM = req.DefaultDisplayCPM
				}
			}
			// Match the prompt builders' documented fallbacks so the audit
			// never flags a floor the batch would actually ship:
			// - Index Exchange: a blank floor emits the 0.10 IX minimum
			//   (dealPromptYaml `floor: cpm || 0.10`; the deal-card hint says
			//   "blank = $0.10").
			// - OpenX: the shared Deal Price is the batch floor when the deal
			//   carries none (`deal_price: dealPrice || cpm || 0.10`); its own
			//   presence is enforced by ox_deal_price, not per-deal here.
			skipCPM := false
			if effectiveCPM == "" && strings.EqualFold(strings.TrimSpace(deal.SSP), "Index Exchange") {
				effectiveCPM = "0.10"
			}
			if effectiveCPM == "" && strings.EqualFold(strings.TrimSpace(deal.SSP), "OpenX") {
				effectiveCPM = req.OpenXConfig.DealPrice
				// Both blank is VALID for OpenX (Deal Price is optional,
				// 2026-08-11): the prompt ships the documented $0.10
				// fallback (`deal_price: dealPrice || cpm || 0.10`), so
				// there is no per-deal CPM failure to raise here.
				skipCPM = strings.TrimSpace(effectiveCPM) == ""
			}
			cpmVal, cpmOK := parsePositiveFloat(effectiveCPM)
			if !skipCPM && !cpmOK {
				label := "Display CPM"
				if video {
					label = "Video CPM"
				}
				checks = append(checks, CheckResult{Rule: "deal_cpm", Passed: false, Message: fmt.Sprintf("%s: %s required", prefix, label), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].cpm", i)})
			}
			// ix_floor — the IX prompt builder ships the deal CPM as the
			// Marketplace Package floor (dealPromptYaml.ts `floor: cpm ||
			// 0.10`), and IX hard-rejects floors below $0.10 (classID=4
			// minimum). deal_cpm's >0 check let 0.08/0.07 through and both
			// DEAL07253 creates 422'd at the SSP (2026-07-20 E2E) — fail the
			// batch here instead, before it ever reaches the runner.
			if cpmOK && strings.EqualFold(strings.TrimSpace(deal.SSP), "Index Exchange") && cpmVal < 0.10 {
				checks = append(checks, CheckResult{Rule: "ix_floor", Passed: false, Message: fmt.Sprintf("%s: the deal CPM ships as the Index Exchange floor and must be at least $0.10 (IX Marketplace Package minimum) — got %s. Raise the CPM, or clear it to use the $0.10 default.", prefix, strings.TrimSpace(effectiveCPM)), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].cpm", i)})
			}
		}
		if video {
			effectiveVCR := deal.VCR
			if effectiveVCR == "" {
				effectiveVCR = req.DefaultVCR
			}
			if _, ok := parsePositiveFloat(effectiveVCR); !ok {
				// ADVISORY, not blocking (2026-07-15): VCR is a deal-sheet
				// KPI, not a create input — only Media.net has a create-time
				// VCR wire (vcr_min) and even there it is optional; the
				// Cutlass brief schema does not require it. The old hard
				// failure blocked video deals over a number nothing
				// downstream needs (and the UI never marked it required).
				checks = append(checks, CheckResult{Rule: "deal_vcr", Passed: true, Message: prefix + ": no VCR target set — optional KPI (rides the deal sheet; only Media.net carries a VCR wire)", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].vcr", i)})
			}
		}
		// viewability_code — IX's Viewability targeting key is a discrete
		// "X% or higher" catalog: any value off the decile grid fails the
		// WHOLE create at the MCP ("No match found for viewability
		// threshold: 0.71" — DEAL07255, where a scroll tick turned a typed
		// 70 into 71). The UI is a dropdown pinned to the same grid
		// (VIEWABILITY_TARGETS in DealsList.tsx — change BOTH together);
		// this rule is the enforcement for persisted/imported values.
		if vt := strings.TrimSpace(deal.ViewabilityTarget); vt != "" {
			if !validViewabilityTarget(vt) {
				checks = append(checks, CheckResult{Rule: "viewability_code", Passed: false, Message: fmt.Sprintf("%s: viewability target %q is not an SSP bucket — Index Exchange only accepts the decile grid (10, 20, … 90, as \"X%% or higher\"). Re-pick from the dropdown (default: 70).", prefix, vt), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].viewabilityTarget", i)})
			}
		}
	}

	// 5b. Geo classification — fail closed BEFORE submit (cutlass#724 /
	// #223). Every subnational ("state") geo entry must classify as a
	// US state or Canadian province, every country entry must be a 2-letter
	// ISO token or a known country name, and an OpenX deal must not mix US
	// states with Canadian provinces (the OpenX MCP resolves state ids under
	// exactly ONE country per includes branch). Without this gate a bad entry
	// either dies mid-batch (unresolved_country / unresolved_state) or — before
	// the MCP's roster-backed validation — silently targeted the wrong country
	// (bare "SK" validated as Slovakia).
	geoOK := true
	classifyGeoEntries := func(entries []GeoEntry, field, prefix string, dealIndex int) (hasUS, hasCA bool) {
		for _, g := range entries {
			v := trimInput(g.Value)
			if v == "" {
				continue
			}
			switch g.Type {
			case "state":
				switch classifyGeoState(v) {
				case "us":
					hasUS = true
				case "ca":
					hasCA = true
				default:
					geoOK = false
					checks = append(checks, CheckResult{Rule: "geo_classification", Passed: false, Message: fmt.Sprintf("%s: geo state %q is not a recognized US state or Canadian province — use the full name or 2-letter code (an unclassifiable token would reach the SSP untyped and fail, or target the wrong geography)", prefix, v), DealIndex: dealIndex, FieldPath: field})
				}
			case "country":
				if !recognizedGeoCountry(v) {
					geoOK = false
					checks = append(checks, CheckResult{Rule: "geo_classification", Passed: false, Message: fmt.Sprintf("%s: geo country %q is not a 2-letter ISO code or a known country name — use the ISO-2 code (e.g. NL for the Netherlands); SSP MCPs validate codes against their live country rosters at create time", prefix, v), DealIndex: dealIndex, FieldPath: field})
				}
			}
		}
		return hasUS, hasCA
	}
	defaultHasUS, defaultHasCA := classifyGeoEntries(req.DefaultGeoInclude, "defaultGeoInclude", "Default geo include", 0)
	classifyGeoEntries(req.DefaultGeoExclude, "defaultGeoExclude", "Default geo exclude", 0)
	for i, deal := range req.Deals {
		if deal.SheetOnly {
			continue
		}
		prefix := fmt.Sprintf("Deal %d", i+1)
		hasUS, hasCA := defaultHasUS, defaultHasCA
		if len(deal.GeoInclude) > 0 {
			hasUS, hasCA = classifyGeoEntries(deal.GeoInclude, fmt.Sprintf("deals[%d].geoInclude", i), prefix, i)
		}
		classifyGeoEntries(deal.GeoExclude, fmt.Sprintf("deals[%d].geoExclude", i), prefix, i)
		if hasUS && hasCA && strings.EqualFold(strings.TrimSpace(deal.SSP), "OpenX") {
			geoOK = false
			checks = append(checks, CheckResult{Rule: "geo_classification", Passed: false, Message: prefix + ": OpenX deal mixes US states and Canadian provinces — OpenX resolves subnational geo under exactly one country per deal; split the geographies into separate deals", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].geoInclude", i)})
		}
	}
	if geoOK {
		checks = append(checks, CheckResult{Rule: "geo_classification", Passed: true, Message: "Geo entries classify cleanly (US states / Canadian provinces / known countries)"})
	}

	// 5c. Geo exclusions — fail closed on any exclusion that cannot ship
	// (#219, per-SSP emission #244). The prompt pipeline now
	// emits exclusions on the verified exclude wires (OpenX geographic.excludes,
	// PubMatic excludeGeos, Xandr country/region_action="exclude", Magnite
	// geo_countries_exclude); geoExcludeBlockReason applies the same per-shape
	// rules the builders do, so an exclusion a builder can only mark
	// NOT-SUPPORTED blocks the batch here — a create would silently DROP it
	// and the deal would serve the excluded geography. Sheet-only rows are
	// exempt: they are never created, so nothing drops anything. A deal
	// without its own chips inherits the form default (effectiveGeoExclude,
	// mirroring resolve()) — so the default is validated per inheriting deal,
	// and the FieldPath points at whichever source carried the exclusion.
	geoExcludeOK := true
	for i, deal := range req.Deals {
		if deal.SheetOnly {
			continue
		}
		reason := geoExcludeBlockReason(deal, req)
		if reason == "" {
			continue
		}
		if detail, ok := ActiveExclusionOverride(deal, req); ok && len(detail.Geo) > 0 {
			checks = append(checks, CheckResult{Rule: "geo_exclude_override", Passed: true, Message: fmt.Sprintf("Deal %d: trader acknowledged stripping unsupported geo exclusion(s) on %s; the authenticated submit records the audit event", i+1, deal.SSP), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].exclusionOverride", i)})
			continue
		}
		geoExcludeOK = false
		fieldPath := fmt.Sprintf("deals[%d].geoExclude", i)
		if len(deal.GeoExclude) == 0 {
			fieldPath = "defaultGeoExclude"
		}
		checks = append(checks, CheckResult{Rule: "geo_exclude_unsupported", Passed: false, Message: fmt.Sprintf("Deal %d: %s", i+1, reason), DealIndex: i, FieldPath: fieldPath})
	}
	// A default exclusion with zero deals to ride on still blocks — it exists
	// to apply to deals, and the next added deal would inherit it unchecked.
	if len(req.DefaultGeoExclude) > 0 && len(req.Deals) == 0 {
		geoExcludeOK = false
		checks = append(checks, CheckResult{Rule: "geo_exclude_unsupported", Passed: false, Message: fmt.Sprintf("Default geo exclude carries %d entry(ies) with no deals to validate them against — add the deals first so per-SSP exclude support can be checked", len(req.DefaultGeoExclude)), FieldPath: "defaultGeoExclude"})
	}
	if geoExcludeOK {
		checks = append(checks, CheckResult{Rule: "geo_exclude_unsupported", Passed: true, Message: "No geo exclusions, or every exclusion ships on its SSP's verified exclude wire (OpenX/PubMatic/Xandr/Magnite — #244)"})
	}

	// 5d. Audience segment EXCLUSIONS — fail closed by SSP capability +
	// provenance (#226 F2). The panel killed the old emit-and-create-
	// WITHOUT behavior (OpenX raised a soft flag and created the deal without
	// the exclusion — silently serving the excluded audience). Now an
	// exclusion on an SSP that cannot ENFORCE it (OpenX confirmed; Media.net /
	// TripleLift / Magnite-DV+ vendor-unconfirmed → treated as unsupported)
	// fails closed at deal×SSP granularity — a CLIENT always-exclude is a hard
	// contractual block, a TRADER exclude a fail-closed block (ack override is
	// a fast-follow). The block is per-deal (DealIndex): sibling deals on
	// supported SSPs are unaffected (Cutlass X4 records them independently).
	// Sheet-only rows are exempt (never created).
	segExcludeOK := true
	for i, deal := range req.Deals {
		if deal.SheetOnly {
			continue
		}
		reason, provenance := audienceExcludeBlockReason(deal)
		if reason == "" {
			continue
		}
		if provenance == "trader" {
			if detail, ok := ActiveExclusionOverride(deal, req); ok && len(detail.Audience) > 0 {
				checks = append(checks, CheckResult{Rule: "segment_exclude_override", Passed: true, Message: fmt.Sprintf("Deal %d: trader acknowledged stripping unsupported audience exclusion(s) on %s; the authenticated submit records the audit event", i+1, deal.SSP), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].exclusionOverride", i)})
				continue
			}
		}
		segExcludeOK = false
		checks = append(checks, CheckResult{Rule: "segment_exclude_unsupported", Passed: false, Message: fmt.Sprintf("Deal %d: %s", i+1, reason), DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].excludeSegments", i)})
	}
	if segExcludeOK {
		checks = append(checks, CheckResult{Rule: "segment_exclude_unsupported", Passed: true, Message: "No audience exclusions, or every exclusion ships on its SSP's verified exclude wire (IX/PubMatic/Xandr/Magnite CTV — #226)"})
	}

	// 6. Seat IDs for all DSPs. Seat-optional DSPs (seatOptionalDSP) may omit
	// the seat — those DSPs bid through a house seat and the SSPs accept the
	// deal without one — unless the batch has CREATE rows on an SSP whose
	// Cutlass path structurally needs a seat (seatRequiredCreateSSPs).
	seatOK := true
	seatField := "seatId"
	seatMsg := "One or more DSPs missing a Seat ID"
	for i, d := range req.DSPs {
		if strings.TrimSpace(d.DSP) == "" || strings.TrimSpace(d.SeatID) != "" {
			continue
		}
		if seatOptionalDSP(d.DSP) {
			blockers := seatRequiredCreateSSPs(req.Deals)
			if len(blockers) == 0 {
				continue
			}
			seatOK = false
			seatField = fmt.Sprintf("dsps[%d].seatId", i)
			seatMsg = fmt.Sprintf("%s deals need a Seat ID to resolve the %s buyer", strings.Join(blockers, " and "), d.DSP)
			break
		}
		seatOK = false
		seatField = fmt.Sprintf("dsps[%d].seatId", i)
		break
	}
	if seatOK {
		checks = append(checks, CheckResult{Rule: "seat_id", Passed: true, Message: "Seat ID present (or optional) for all DSPs"})
	} else {
		checks = append(checks, CheckResult{Rule: "seat_id", Passed: false, Message: seatMsg, FieldPath: seatField})
	}

	// 6b. Multi-seat Seat IDs. A trader may pin ONE deal to several buyer seats
	// by entering them comma-separated, but only Magnite consumes a buyer LIST
	// (dsps[i].buyers) — every other SSP carries a single seat token and would
	// ship the whole comma string as one unresolvable value. Blocking here
	// keeps a Magnite-shaped seat out of an IX/PubMatic/OpenX/Xandr/TripleLift
	// create instead of letting it fail deep inside Cutlass (seen live).
	multiSeatOK := true
	multiSeatField := "seatId"
	multiSeatMsg := ""
	multiSeatCount := 0
	for i, d := range req.DSPs {
		seats := SplitSeatIDs(d.SeatID)
		if len(seats) < 2 {
			continue
		}
		multiSeatCount = len(seats)
		if blockers := singleSeatCreateSSPs(req.Deals); len(blockers) > 0 {
			multiSeatOK = false
			multiSeatField = fmt.Sprintf("dsps[%d].seatId", i)
			dspLabel := strings.TrimSpace(d.DSP)
			if dspLabel == "" {
				dspLabel = "DSP"
			}
			multiSeatMsg = fmt.Sprintf(
				"%s Seat ID lists %d seats — only Magnite accepts multiple buyer seats. %s carries a single seat per deal, so the whole comma list would ship as one unresolvable value. Run those SSPs in a separate batch with one Seat ID.",
				dspLabel,
				len(seats),
				strings.Join(blockers, " and "),
			)
			break
		}
	}
	if !multiSeatOK {
		checks = append(checks, CheckResult{Rule: "seat_multi", Passed: false, Message: multiSeatMsg, FieldPath: multiSeatField})
	} else if multiSeatCount > 1 {
		checks = append(checks, CheckResult{Rule: "seat_multi", Passed: true, Message: fmt.Sprintf("Seat ID pins %d Magnite buyer seats — each resolves independently against the DSP's ClearLine buyer catalog; an unresolved seat blocks the create", multiSeatCount)})
	}

	// 7. SSP-specific shared config checks. Keyed off CREATE rows only
	// (containsCreateSSP): these validate create-time configuration, so an SSP
	// present solely on sheet-only rows (already created in a previous batch)
	// must not demand config this batch never sends — e.g. a follow-up batch
	// with already-live OpenX rows and only IX creates needs no OpenX Deal
	// Price.
	if containsCreateSSP(req.Deals, "OpenX") {
		ox := req.OpenXConfig
		if !ox.AutoPackageName && strings.TrimSpace(ox.PackageName) == "" {
			checks = append(checks, CheckResult{Rule: "ox_package", Passed: false, Message: "OpenX Package Name missing (or enable auto-generate)", FieldPath: "openxConfig.packageName"})
		} else {
			checks = append(checks, CheckResult{Rule: "ox_package", Passed: true, Message: "OpenX Package Name is set (or will auto-generate)"})
		}
		// Deal Price is OPTIONAL (owner call 2026-08-11): it's only the
		// batch-level floor default — the prompt builder's fallback chain is
		// `deal_price: dealPrice || cpm || 0.10`, so a blank shared price
		// means each deal's own Floor CPM (or the $0.10 minimum) is the
		// floor. Only an unparseable/zero value fails: that's a typo, not an
		// intentional blank.
		if strings.TrimSpace(ox.DealPrice) == "" {
			checks = append(checks, CheckResult{Rule: "ox_deal_price", Passed: true, Message: "OpenX Deal Price not set — each deal's Floor CPM (or the $0.10 default) is the floor"})
		} else if _, ok := parsePositiveFloat(ox.DealPrice); ok {
			checks = append(checks, CheckResult{Rule: "ox_deal_price", Passed: true, Message: "OpenX deal price is present"})
		} else {
			checks = append(checks, CheckResult{Rule: "ox_deal_price", Passed: false, Message: "OpenX Deal Price must be a positive number when set (leave blank to use each deal's Floor CPM)", FieldPath: "openxConfig.dealPrice"})
		}
		// Publishers ("Max publishers" toggle). Toggle OFF requires a
		// non-empty allowlist; the OX wire takes account IDS only
		// (targeting.content.account INTERSECTS — no name resolution
		// server-side), so every entry must carry an id. And OpenX cannot
		// combine an include list with excluded_publisher_ids on one deal
		// (the MCP returns a conflicting_publisher_lists blocker).
		if ox.AllPublishers != nil && !*ox.AllPublishers {
			oxIncludeIDs, oxNameOnly := 0, 0
			for _, e := range ox.PublisherEntries {
				switch {
				case strings.TrimSpace(e.ID) != "":
					oxIncludeIDs++
				case strings.TrimSpace(e.Name) != "":
					oxNameOnly++
				}
			}
			oxExcluded := 0
			for _, x := range ox.ExcludedPublisherIds {
				if strings.TrimSpace(x) != "" {
					oxExcluded++
				}
			}
			switch {
			case oxIncludeIDs+oxNameOnly == 0:
				checks = append(checks, CheckResult{Rule: "ox_publishers", Passed: false, Message: "OpenX \"Max publishers\" is off but no publishers are listed — add the approved list or turn the toggle back on", FieldPath: "openxConfig.publisherEntries"})
			case oxNameOnly > 0:
				checks = append(checks, CheckResult{Rule: "ox_publisher_ids", Passed: false, Message: fmt.Sprintf("OpenX publisher allowlist has %d name-only entries — OpenX targets by account ID only; add each publisher's ID (paste \"ID name\" lines or a two-column file)", oxNameOnly), FieldPath: "openxConfig.publisherEntries"})
			default:
				checks = append(checks, CheckResult{Rule: "ox_publisher_ids", Passed: true, Message: fmt.Sprintf("OpenX publisher allowlist: %d publisher IDs (deals run ONLY on these publishers)", oxIncludeIDs)})
			}
			if oxIncludeIDs+oxNameOnly > 0 && oxExcluded > 0 {
				checks = append(checks, CheckResult{Rule: "ox_publisher_conflict", Passed: false, Message: "OpenX cannot combine a publisher include list with Excluded Publisher IDs on the same deal — clear one of them", FieldPath: "openxConfig.publisherEntries"})
			}
		}
		// Buyer IDs are OPTIONAL. The OpenX MCP takes buyer_ids as
		// `list[str] | None = None` (openx_mcp.py) — they are DSP seat ids
		// resolved server-side, and deals create fine without them. "Main Buyer"
		// is a Deal Onboarding-only convenience (the MCP auto-sets main_buyer_id for a
		// single TTD seat); never block on it.
		checks = append(checks, CheckResult{Rule: "ox_buyers", Passed: true, Message: "OpenX Buyer IDs are optional"})
		feePartnerSet := strings.TrimSpace(ox.FeePartner) != ""
		grossShare, grossShareOK := parsePositiveFloat(ox.GrossShare)
		if feePartnerSet && !grossShareOK {
			checks = append(checks, CheckResult{Rule: "ox_fee", Passed: false, Message: "OpenX fee partner set but Gross Share missing or zero", FieldPath: "openxConfig.grossShare"})
		} else if feePartnerSet && grossShare > 100 {
			// grossShare is already > 0 here (parsePositiveFloat), so only the
			// upper bound can still fail.
			checks = append(checks, CheckResult{Rule: "ox_fee", Passed: false, Message: "OpenX Gross Share must be between 0 and 100", FieldPath: "openxConfig.grossShare"})
		} else {
			checks = append(checks, CheckResult{Rule: "ox_fee", Passed: true, Message: "OpenX fee configuration is valid"})
		}
	}

	// IX "Max publishers" toggle: OFF requires a non-empty allowlist (names
	// resolve fail-closed at booking; ids ship verbatim).
	if containsCreateSSP(req.Deals, "Index Exchange") && req.IXConfig.AllPublishers != nil && !*req.IXConfig.AllPublishers {
		ixEntries := 0
		for _, e := range req.IXConfig.PublisherEntries {
			if strings.TrimSpace(e.ID) != "" || strings.TrimSpace(e.Name) != "" {
				ixEntries++
			}
		}
		if ixEntries > 0 {
			checks = append(checks, CheckResult{Rule: "ix_publishers", Passed: true, Message: fmt.Sprintf("IX publisher allowlist: %d publishers (deals run ONLY on these; each resolves against the marketplace catalog at create)", ixEntries)})
		} else {
			checks = append(checks, CheckResult{Rule: "ix_publishers", Passed: false, Message: "IX \"Max publishers\" is off but no publishers are listed — add the approved list or turn the toggle back on", FieldPath: "ixConfig.publisherEntries"})
		}
	}

	if containsCreateSSP(req.Deals, "PubMatic") && !req.PubMaticConfig.MaxReach {
		// Effective publisher scope: allowlist entries when set, else the
		// legacy one-per-row names (mirrors effectivePubMaticPublisherEntries
		// in types/deal.ts — keep the two in sync).
		nonEmpty := 0
		for _, e := range req.PubMaticConfig.PublisherEntries {
			if strings.TrimSpace(e.ID) != "" || strings.TrimSpace(e.Name) != "" {
				nonEmpty++
			}
		}
		if nonEmpty == 0 {
			for _, p := range req.PubMaticConfig.PublisherNames {
				if strings.TrimSpace(p) != "" {
					nonEmpty++
				}
			}
		}
		if nonEmpty > 0 {
			checks = append(checks, CheckResult{Rule: "pm_publishers", Passed: true, Message: fmt.Sprintf("PubMatic publisher allowlist: %d publishers (Max Reach off)", nonEmpty)})
		} else {
			checks = append(checks, CheckResult{Rule: "pm_publishers", Passed: false, Message: "PubMatic selected with Max Reach off but no publishers listed", FieldPath: "pubmaticConfig.publisherNames"})
		}
	}

	if containsCreateSSP(req.Deals, "Xandr") {
		// Deal code is optional: the generated prompt falls back to the deal
		// name, which is unique by construction.
		if strings.TrimSpace(req.XandrConfig.DealCode) != "" {
			checks = append(checks, CheckResult{Rule: "xn_deal_code", Passed: true, Message: "Xandr Deal Code provided"})
		} else {
			checks = append(checks, CheckResult{Rule: "xn_deal_code", Passed: true, Message: "Xandr Deal Code defaults to the deal name"})
		}
		if strings.TrimSpace(req.XandrConfig.InsertionOrder) != "" {
			checks = append(checks, CheckResult{Rule: "xn_insertion_order", Passed: true, Message: "Xandr Insertion Order selected"})
		} else {
			checks = append(checks, CheckResult{Rule: "xn_insertion_order", Passed: false, Message: "Xandr Insertion Order is REQUIRED — Curate deals live as line items under a partner-specific IO", FieldPath: "xandrConfig.insertionOrder"})
		}
	}
	if containsCreateSSP(req.Deals, "Magnite") {
		// ClearLine Demand Management (June 2026): every deal is created inside
		// a marketplace (immutable after creation).
		if strings.TrimSpace(req.MagniteConfig.Marketplace) != "" {
			checks = append(checks, CheckResult{Rule: "mg_marketplace", Passed: true, Message: "Magnite marketplace provided"})
		} else {
			checks = append(checks, CheckResult{Rule: "mg_marketplace", Passed: false, Message: "Magnite selected but Marketplace missing — every ClearLine deal is created inside a marketplace (immutable after creation)", FieldPath: "magniteConfig.marketplace"})
		}
		// Publishers: "All eligible publishers" (the default, incl. every
		// pre-toggle draft — AllPublishers absent means true) keeps the
		// legacy wire: the prompt sends the explicit publishers: "ALL"
		// opt-in, expanded server-side by the Cutlass MCP. The toggle OFF
		// (owner-approved opt-out, 2026-08-21) requires an explicit
		// allowlist — the narrowed reach is stated loudly in the message so
		// the QA report can't miss it.
		mgAllPublishers := req.MagniteConfig.AllPublishers == nil || *req.MagniteConfig.AllPublishers
		if mgAllPublishers {
			// When a pre-rollout draft still carries a deliberately narrowed
			// legacy publisher list, say loudly that it is ignored rather
			// than silently escalating the deal to ALL.
			legacyPubs := 0
			for _, p := range req.MagniteConfig.Publishers {
				if strings.TrimSpace(p) != "" {
					legacyPubs++
				}
			}
			mgPubMsg := "Magnite publishers: ALL — every eligible marketplace publisher is applied server-side by the Cutlass MCP"
			if legacyPubs > 0 {
				mgPubMsg = fmt.Sprintf(
					"Magnite publishers: ALL — NOTE: this draft predates the All-Publishers rollout and carries %d explicit publisher(s) that are now IGNORED; the deal will run on every eligible marketplace publisher. Turn off \"Max publishers\" and re-list them if the narrowed list was intentional.",
					legacyPubs,
				)
			}
			checks = append(checks, CheckResult{Rule: "mg_publishers", Passed: true, Message: mgPubMsg})
		} else {
			mgEntries := 0
			for _, e := range req.MagniteConfig.PublisherEntries {
				if strings.TrimSpace(e.ID) != "" || strings.TrimSpace(e.Name) != "" {
					mgEntries++
				}
			}
			if mgEntries > 0 {
				checks = append(checks, CheckResult{Rule: "mg_publishers", Passed: true, Message: fmt.Sprintf("Magnite publishers: explicit allowlist (%d publishers) — deals run ONLY on these; each ref resolves against the live marketplace catalog and an unresolved ref blocks the create", mgEntries)})
			} else {
				checks = append(checks, CheckResult{Rule: "mg_publishers", Passed: false, Message: "Magnite \"Max publishers\" is off but no publishers are listed — add the allowlist or turn the toggle back on", FieldPath: "magniteConfig.publisherEntries"})
			}
		}
		// Price type + publisher-tab floor. Blank price type = the
		// default "Market Rate" (owner call, 2026-07-21 — no floor unless a
		// trader deliberately picks MRwM/CPM). The Sun Bum deals (2026-07)
		// were mistakenly created as CPM with the $15 deal CPM as the floor —
		// the floor is NEVER the deal CPM.
		priceType := strings.TrimSpace(req.MagniteConfig.PriceType)
		if priceType == "" {
			priceType = "Market Rate"
		}
		rawFloor := strings.TrimSpace(req.MagniteConfig.FloorCPM)
		switch priceType {
		case "Market Rate":
			checks = append(checks, CheckResult{Rule: "mg_floor", Passed: true, Message: "Magnite pricing: Market Rate (no publisher-tab floor)"})
		case "Market Rate with Minimum", "CPM":
			if rawFloor == "" {
				checks = append(checks, CheckResult{Rule: "mg_floor", Passed: true, Message: fmt.Sprintf("Magnite pricing: %s — floor defaults to the 0.10 minimum", priceType)})
			} else if v, err := strconv.ParseFloat(rawFloor, 64); err != nil || v <= 0 {
				checks = append(checks, CheckResult{Rule: "mg_floor", Passed: false, Message: fmt.Sprintf("Magnite %s floor must be a positive number (blank = 0.10 default)", priceType), FieldPath: "magniteConfig.floorCpm"})
			} else {
				checks = append(checks, CheckResult{Rule: "mg_floor", Passed: true, Message: fmt.Sprintf("Magnite pricing: %s at %s (the floor is NOT the deal CPM — keep at 0.10 unless the client directs otherwise)", priceType, rawFloor)})
			}
		default:
			checks = append(checks, CheckResult{Rule: "mg_floor", Passed: false, Message: fmt.Sprintf("Magnite price type %q is not a ClearLine option — pick Market Rate, Market Rate with Minimum, or CPM", priceType), FieldPath: "magniteConfig.priceType"})
		}
		// 'Market Rate with Minimum' is DV+-only: SpringServe (CTV) rejects it
		// and Cutlass blocks it at prepare, so buildMagnitePrompt downgrades
		// CTV deals to Market Rate (issue #228). Record the downgrade loudly —
		// a passing informational check, never a silent floor drop.
		if priceType == "Market Rate with Minimum" {
			for i, deal := range req.Deals {
				// Streaming (CTV + OTT) rejects Market Rate with Minimum.
				if deal.SheetOnly || strings.TrimSpace(deal.SSP) != "Magnite" || (deal.Channel != "CTV" && deal.Channel != "OTT") {
					continue
				}
				checks = append(checks, CheckResult{
					Rule:      "mg_ctv_price_type",
					Passed:    true,
					Message:   fmt.Sprintf("Deal %d: Magnite CTV routes to SpringServe, where 'Market Rate with Minimum' is not supported — this deal is created as Market Rate (NO minimum floor). Use the CPM price type if a floor is required on CTV.", i+1),
					DealIndex: i,
					FieldPath: "magniteConfig.priceType",
				})
			}
		}
		// Sizes — PER-DEAL. DV+ display/video/native deals each need >=1 ad-format
		// id or the API 422s the create. CTV (SpringServe) and Audio (feedTypes)
		// are exempt. Mirrors magniteFormatKind() in the frontend.
		for i, deal := range req.Deals {
			// Sheet-only rows are exempt: the size requirement is a create-time
			// API constraint (the API 422s size-less DV+ CREATES), and no create
			// happens for an already-live deal.
			if deal.SheetOnly {
				continue
			}
			// CTV and OTT both route to Streaming (SpringServe), which takes no
			// `sizes`; Audio uses feedTypes. Only DV+ channels need ad formats.
			if strings.TrimSpace(deal.SSP) != "Magnite" || deal.Channel == "" || deal.Channel == "CTV" || deal.Channel == "OTT" || deal.Channel == "Audio" {
				continue
			}
			nonEmptySizes := 0
			for _, s := range deal.MagniteSizes {
				if strings.TrimSpace(s) != "" {
					nonEmptySizes++
				}
			}
			if nonEmptySizes == 0 {
				checks = append(checks, CheckResult{
					Rule:      "mg_sizes",
					Passed:    false,
					Message:   fmt.Sprintf("Deal %d: Magnite %s (DV+) deals require at least one ad format — the API rejects size-less DV+ deals.", i+1, deal.Channel),
					DealIndex: i,
					FieldPath: fmt.Sprintf("deals[%d].magniteSizes", i),
				})
			}
		}
		for i, deal := range req.Deals {
			if deal.SheetOnly || strings.TrimSpace(deal.SSP) != "Magnite" || strings.TrimSpace(deal.Channel) != "Audio" {
				continue
			}
			checks = append(checks, CheckResult{Rule: "mg_audio_feed_types", Passed: false,
				Message: "Magnite Audio requires feedTypes, but Deal Onboarding has no verified feed-type catalog/wire selection. The create is blocked instead of submitting a size-less/feedType-less DV+ deal.", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].channel", i)})
		}
		// DV+ audience segments are not supported by Magnite's API until v3.0
		// (ETA end of June 2026). CTV (SpringServe) audiences work today.
		for i, deal := range req.Deals {
			// Sheet-only rows are exempt: this is a create-time API limitation,
			// and an already-live DV+ deal may legitimately carry segments that
			// were applied through the manual UI step the message suggests.
			if deal.SheetOnly {
				continue
			}
			// CTV and OTT both land on Streaming, where the audience API works.
			// Only DV+ channels hit the v3.0 gap.
			if strings.TrimSpace(deal.SSP) != "Magnite" || deal.Channel == "CTV" || deal.Channel == "OTT" {
				continue
			}
			if len(deal.IncludeSegments) > 0 || len(deal.ExcludeSegments) > 0 {
				checks = append(checks, CheckResult{
					Rule:      "mg_dvplus_audience",
					Passed:    false,
					Message:   fmt.Sprintf("Deal %d: Magnite %s deals route to DV+, where audience segments are not supported by the API until v3.0 (ETA end of June 2026). Drop the segments, switch the deal to CTV, or plan a manual UI step.", i+1, deal.Channel),
					DealIndex: i,
					FieldPath: fmt.Sprintf("deals[%d].includeSegments", i),
				})
			}
		}
	}
	if containsCreateSSP(req.Deals, "TripleLift") {
		dpt := strings.ToUpper(strings.TrimSpace(req.TripleLiftConfig.DealPriceType))
		if dpt == "CEILING" || dpt == "FIXED" || dpt == "FLOOR" {
			checks = append(checks, CheckResult{Rule: "tl_price_type", Passed: true, Message: "TripleLift Deal Price Type valid"})
		} else {
			checks = append(checks, CheckResult{Rule: "tl_price_type", Passed: false, Message: "TripleLift Deal Price Type must be CEILING, FIXED, or FLOOR", FieldPath: "tripleliftConfig.dealPriceType"})
		}
		// Blank is the DEFAULT and means "derive per deal" — CTV deals route to
		// TripleLift's CTV pool, every other channel to WEB. A pinned value
		// overrides that for the whole batch, which is only ever right when
		// every TripleLift deal shares one channel.
		ch := strings.ToUpper(strings.TrimSpace(req.TripleLiftConfig.Channel))
		if ch == "" {
			checks = append(checks, CheckResult{Rule: "tl_channel", Passed: true, Message: "TripleLift Channel derived per deal (CTV → CTV, all others → WEB)"})
		} else if ch == "WEB" || ch == "CTV" {
			checks = append(checks, CheckResult{Rule: "tl_channel", Passed: true, Message: "TripleLift Channel valid"})
		} else {
			checks = append(checks, CheckResult{Rule: "tl_channel", Passed: false, Message: "TripleLift Channel must be WEB or CTV", FieldPath: "tripleliftConfig.channel"})
		}
		for i, deal := range req.Deals {
			if deal.SheetOnly || strings.TrimSpace(deal.SSP) != "TripleLift" {
				continue
			}
			hasGeo := false
			for _, g := range deal.GeoInclude {
				t := strings.ToLower(strings.TrimSpace(g.Type))
				if (t == "country" || t == "state") && strings.TrimSpace(g.Value) != "" {
					hasGeo = true
					break
				}
			}
			hasTargeting := hasGeo || nonEmptyCount(deal.IncludeSegments) > 0 || req.TripleLiftConfig.AllowPoliticalAds
			if !hasTargeting {
				checks = append(checks, CheckResult{Rule: "tl_targeting_required", Passed: false,
					Message: "TripleLift requires targetingExpression, but this deal has no verified country/region/device/segment/political input. Add supported targeting; an empty or improvised global expression is not allowed.", DealIndex: i, FieldPath: fmt.Sprintf("deals[%d].geoInclude", i)})
			}
		}
	}
	if containsCreateSSP(req.Deals, "Media.net") {
		if v, ok := parsePositiveFloat(req.MediaNetConfig.MarginValue); ok {
			isPercent := strings.Contains(strings.ToLower(req.MediaNetConfig.MarginType), "percent")
			max := 25.0
			if isPercent {
				max = 50.0
			}
			if v > max {
				checks = append(checks, CheckResult{Rule: "mn_margin", Passed: false, Message: fmt.Sprintf("Media.net %s margin must be ≤ %g", strings.TrimSpace(req.MediaNetConfig.MarginType), max), FieldPath: "medianetConfig.marginValue"})
			} else {
				checks = append(checks, CheckResult{Rule: "mn_margin", Passed: true, Message: "Media.net Margin Value valid"})
			}
		} else {
			checks = append(checks, CheckResult{Rule: "mn_margin", Passed: false, Message: "Media.net selected but Margin Value missing or zero", FieldPath: "medianetConfig.marginValue"})
		}

		// mn_deal_id — the Media.net deal_id (built only by the frontend prompt
		// builder, medianetDealId in dealNameSlots.ts) derives from DSP + theme +
		// channel + inventory + geo (+ the batch-constant campaign id). Two CREATE
		// deals whose tuple collides would ship the SAME Media.net deal_id — the
		// cutlass MCP validates only the id's format, so the second create silently
		// collides at Media.net. Guard on the SOURCE TUPLE here (not the slug):
		// the server audit gate re-runs this on every submit, so a colliding batch
		// fails closed even if the frontend guard is bypassed.
		type mnTuple struct{ dsp, theme, channel, inv, geo string }
		mnSeen := map[mnTuple]int{} // tuple -> deal index of first occurrence
		mnCollisions := 0
		mnDSPCodes := make([]string, 0, len(activeDSPs(req)))
		for _, d := range activeDSPs(req) {
			mnDSPCodes = append(mnDSPCodes, dspSlot(d.DSP))
		}
		if len(mnDSPCodes) == 0 {
			mnDSPCodes = []string{"DSP"}
		}
		for i, deal := range req.Deals {
			if deal.SheetOnly || !strings.EqualFold(strings.TrimSpace(deal.SSP), "Media.net") {
				continue
			}
			inv := deal.InventoryType
			if inv == "" {
				inv = req.DefaultInventoryType
			}
			geos := deal.GeoInclude
			if len(geos) == 0 {
				geos = req.DefaultGeoInclude
			}
			// SSP-aware (#233.8): Media.net carries countries only, so
			// its id/name Geo slot never claims a state.
			geo := primaryGeoForSSP(geos, deal.SSP)
			if geo == "" {
				geo = "Global"
			}
			// Override deals never expand across DSPs (mirrors expandDealDsps) —
			// exactly one id on the first active DSP.
			rowCodes := mnDSPCodes
			if trimInput(deal.NameOverride) != "" {
				rowCodes = mnDSPCodes[:1]
			}
			for _, dspCode := range rowCodes {
				key := mnTuple{
					dsp:     dspCode,
					theme:   normalizedSegment(deal.Theme, "Audience"),
					channel: channelCode(deal.Channel),
					inv:     inventoryCode(inv),
					geo:     geo,
				}
				if j, dup := mnSeen[key]; dup {
					mnCollisions++
					checks = append(checks, CheckResult{
						Rule:      "mn_deal_id",
						Passed:    false,
						Message:   fmt.Sprintf("Deal %d and Deal %d are both Media.net deals with the same DSP, theme, channel, inventory, and geo — they would collide on the same Media.net deal_id. Differentiate the theme, channel, inventory, or geo.", j+1, i+1),
						DealIndex: i,
						FieldPath: fmt.Sprintf("deals[%d].theme", i),
					})
				} else {
					mnSeen[key] = i
				}
			}
		}
		if mnCollisions == 0 && len(mnSeen) > 0 {
			checks = append(checks, CheckResult{Rule: "mn_deal_id", Passed: true, Message: "Media.net deal_ids are unique across this batch"})
		}
	}
	if containsCreateSSP(req.Deals, "OpenX") {
		pmpType := strings.ToUpper(strings.TrimSpace(req.OpenXConfig.PMPDealType))
		switch pmpType {
		case "PREFERRED_DEAL", "PROGRAMMATIC_GUARANTEED", "1", "3":
			checks = append(checks, CheckResult{Rule: "ox_pmp_type", Passed: true, Message: "OpenX PMP Deal Type valid"})
		case "PRIVATE_AUCTION", "2":
			// cutlass#766: Private Auction is NOT creatable via the OpenX API —
			// dealCreate's backend validation requires open_auction_access, a
			// field absent from the GraphQL create schema, so every type-2
			// attempt dies with an opaque INTERNAL_SERVER_ERROR (proven live
			// 2026-07-11; every observed live deal was type 3). The OpenX MCP
			// fails closed (ox_private_auction_unsupported); block here so the
			// trader gets a field-level error instead of a dead create.
			checks = append(checks, CheckResult{Rule: "ox_pmp_type", Passed: false, Message: "OpenX Private Auction deals cannot be created via the API — open_auction_access is required by OpenX's backend but absent from the create schema (cutlass#766). Use PREFERRED_DEAL.", FieldPath: "openxConfig.pmpDealType"})
		default:
			checks = append(checks, CheckResult{Rule: "ox_pmp_type", Passed: false, Message: "OpenX PMP Deal Type must be PREFERRED_DEAL or PROGRAMMATIC_GUARANTEED (PRIVATE_AUCTION is not creatable via the OpenX API — cutlass#766)", FieldPath: "openxConfig.pmpDealType"})
		}
	}

	// 7b. Publisher-allowlist coverage. When ANY SSP in the batch narrows to
	// an explicit publisher allowlist (a sensitive-category signal), record
	// per create-SSP scoping in one advisory check — for that kind of batch
	// the dangerous failure is one SSP silently running open while the others
	// are scoped. Always passing (mixed batches can be deliberate); the
	// statuses make the gap impossible to miss in the audit / QA report.
	countEntries := func(entries []PublisherAllowlistEntry) int {
		n := 0
		for _, e := range entries {
			if strings.TrimSpace(e.ID) != "" || strings.TrimSpace(e.Name) != "" {
				n++
			}
		}
		return n
	}
	allowlistBySSP := map[string]int{}
	if !req.PubMaticConfig.MaxReach {
		n := countEntries(req.PubMaticConfig.PublisherEntries)
		if n == 0 {
			for _, p := range req.PubMaticConfig.PublisherNames {
				if strings.TrimSpace(p) != "" {
					n++
				}
			}
		}
		allowlistBySSP["PubMatic"] = n
	}
	if req.OpenXConfig.AllPublishers != nil && !*req.OpenXConfig.AllPublishers {
		allowlistBySSP["OpenX"] = countEntries(req.OpenXConfig.PublisherEntries)
	}
	if req.IXConfig.AllPublishers != nil && !*req.IXConfig.AllPublishers {
		allowlistBySSP["Index Exchange"] = countEntries(req.IXConfig.PublisherEntries)
	}
	if req.MagniteConfig.AllPublishers != nil && !*req.MagniteConfig.AllPublishers {
		allowlistBySSP["Magnite"] = countEntries(req.MagniteConfig.PublisherEntries)
	}
	anyAllowlisted := false
	for _, n := range allowlistBySSP {
		if n > 0 {
			anyAllowlisted = true
			break
		}
	}
	if anyAllowlisted {
		var statuses []string
		for _, ssp := range createSSPsInOrder(req.Deals) {
			switch {
			case allowlistBySSP[ssp] > 0:
				statuses = append(statuses, fmt.Sprintf("%s: allowlist (%d publishers)", ssp, allowlistBySSP[ssp]))
			case ssp == "Xandr" && strings.TrimSpace(req.XandrConfig.DealListNames) != "":
				statuses = append(statuses, fmt.Sprintf("Xandr: Curate deal list (%s)", strings.TrimSpace(req.XandrConfig.DealListNames)))
			case ssp == "TripleLift" || ssp == "Media.net":
				statuses = append(statuses, fmt.Sprintf("%s: no publisher-level scoping exists — apply an Include site list (web only) or the deal runs open", ssp))
			default:
				statuses = append(statuses, fmt.Sprintf("%s: OPEN — no publisher allowlist on this SSP", ssp))
			}
		}
		checks = append(checks, CheckResult{Rule: "allowlist_coverage", Passed: true, Message: "Publisher scoping by SSP — " + strings.Join(statuses, "; ")})
	}

	// 8. File inclusion type
	domainTypeOK := true
	for _, f := range req.DomainLists {
		if strings.TrimSpace(f.InclusionType) == "" {
			domainTypeOK = false
			break
		}
	}
	for _, f := range req.AppBundleLists {
		if strings.TrimSpace(f.InclusionType) == "" {
			domainTypeOK = false
			break
		}
	}
	if !domainTypeOK {
		checks = append(checks, CheckResult{Rule: "domain_type", Passed: false, Message: "Uploaded file missing inclusion/exclusion type"})
	} else {
		checks = append(checks, CheckResult{Rule: "domain_type", Passed: true, Message: "Domain/app bundle file types correctly specified"})
	}

	// 8a'. list_ref — every explicit per-deal list pick must resolve to a
	// live list. The deal cards / Files-section toggles store the pick as an
	// upload (or standard-list) ID on the deal; when that file is later
	// removed or re-uploaded under a new id, the prompt builder deliberately
	// resolves the stale id to NO list (never a surprise fallback) while the
	// submit still ships every uploaded file to the task. The result is a
	// deal created with zero list scoping and an orphaned attachment —
	// exactly the DEAL07253 E2E failure shape (2026-07-20). Fail closed here;
	// evaluateAudit backs both the UI audit and the /api/runner/create gate.
	checks = append(checks, listRefChecks(req)...)

	// 8a''. list_applied — an uploaded list pool nothing will carry is an
	// inert attachment: it uploads to the task, no deal's prompt references
	// it, and the batch silently creates unscoped. Fail when a pool
	// (domain / app-bundle) has files but ZERO create deals resolve a list
	// from that scope — stale picks, every deal opted out, or no deal on a
	// channel that routes to the pool. (A pool where at least one file ships
	// stays advisory-only: list_selection already discloses dropped extras.)
	checks = append(checks, listAppliedChecks(req)...)

	// 8b. deal_sheet_recipient — a batch create ends by emailing the deal sheet
	// to the trader. A blank recipient emits a placeholder that bounces / can
	// mis-send (the May 2026 client-email incident). Require it whenever the
	// batch will actually run (≥1 deal with an SSP).
	hasBatchDeal := false
	for _, deal := range req.Deals {
		if strings.TrimSpace(deal.SSP) != "" {
			hasBatchDeal = true
			break
		}
	}
	if hasBatchDeal {
		if strings.TrimSpace(req.DealSheetRecipient) == "" {
			checks = append(checks, CheckResult{Rule: "deal_sheet_recipient", Passed: false, Message: "Deal Sheet Recipient is required — the batch emails the deal sheet here after creation. Set your trader email before generating the prompt.", FieldPath: "dealSheetRecipient"})
		} else {
			checks = append(checks, CheckResult{Rule: "deal_sheet_recipient", Passed: true, Message: "Deal Sheet Recipient is set"})
		}
	}

	// 8b-2. email_format — the submitter email lands on the deal sheet /
	// deal records and the deal-sheet recipient is an actual send-to address;
	// a malformed value bounces the sheet exactly like the blank-recipient
	// incident. Format-check both whenever they are non-blank (presence is
	// rule 1 / 8b's job). The deal-sheet recipient may be a comma/semicolon-
	// joined LIST from the chip input (first address = To, rest cc'd) — every
	// entry must parse. One failed check per bad field so each input
	// red-outlines individually; a single pass row otherwise.
	emailFields := []struct {
		value string
		path  string
		label string
		multi bool
	}{
		{req.SubmitterEmail, "submitterEmail", "Submitter Email", false},
		{req.DealSheetRecipient, "dealSheetRecipient", "Deal Sheet Recipient", true},
	}
	anyBadEmail := false
	for _, f := range emailFields {
		v := strings.TrimSpace(f.value)
		if v == "" {
			continue
		}
		values := []string{v}
		if f.multi {
			values = splitEmailList(v)
		}
		bad := []string{}
		for _, addr := range values {
			if !isPlausibleEmail(addr) {
				bad = append(bad, addr)
			}
		}
		if len(bad) == 0 {
			continue
		}
		anyBadEmail = true
		msg := f.label + " must be a valid email address (e.g. trader@example.com)"
		if f.multi && len(values) > 1 {
			msg = f.label + " has a malformed address: " + strings.Join(bad, ", ") + " — every recipient must be a valid email"
		}
		checks = append(checks, CheckResult{Rule: "email_format", Passed: false, Message: msg, FieldPath: f.path})
	}
	if !anyBadEmail {
		checks = append(checks, CheckResult{Rule: "email_format", Passed: true, Message: "Email addresses are well-formed"})
	}

	// 8c. openx_app_bundle_blocklist — OpenX app-bundle targeting
	// (targeting.app_inventory.app_bundle_id) is an INCLUDE-only set; the MCP
	// rejects a blocklist. Catch an Exclude-type app-bundle file paired with an
	// OpenX deal here, before the prompt is pasted and the create fails.
	if containsCreateSSP(req.Deals, "OpenX") {
		hasAppBundleBlocklist := false
		for _, f := range req.AppBundleLists {
			if strings.EqualFold(strings.TrimSpace(f.InclusionType), "Exclude") {
				hasAppBundleBlocklist = true
				break
			}
		}
		if hasAppBundleBlocklist {
			checks = append(checks, CheckResult{Rule: "openx_app_bundle_blocklist", Passed: false, Message: "OpenX does not support app-bundle blocklists (app_inventory.app_bundle_id is include-only). Use an allowlist for the app-bundle file, or exclude those bundles in the OpenX UI."})
		}
	}

	// 8d. openx_inventory_attachment — ADVISORY since 2026-07-20
	// (trader-confirmed): a pure audience/geo OpenX deal is legitimate and
	// runs run-of-exchange (url_targeting/app_inventory/publishers are all
	// optional on the OpenX create API — the old missing_prompt_input_attachment
	// blocker in the OpenX MCP was a workflow assumption, removed the same
	// day). The check now PASSES with a disclosure so the open inventory
	// footprint is a visible decision, never a silent default.
	// effectiveDealListName mirrors the prompt's per-deal file routing.
	for i, d := range req.Deals {
		if d.SheetOnly || !strings.EqualFold(strings.TrimSpace(d.SSP), "OpenX") {
			continue
		}
		if effectiveDealListName(d, req) == "" {
			checks = append(checks, CheckResult{
				Rule:      "openx_inventory_attachment",
				Passed:    true,
				Message:   fmt.Sprintf("Deal %d: no inventory list on this OpenX deal — it runs RUN-OF-EXCHANGE (all eligible OpenX inventory; audience/geo/format targeting still applies). Attach a domain or app-bundle list to scope it.", i+1),
				DealIndex: i,
				FieldPath: fmt.Sprintf("deals[%d]", i),
			})
		}
	}

	// 9. Campaign ID — REQUIRED. /api/audit no longer mints a random campaign id
	// for a blank form (that made the campaign_id check vacuous and put three
	// different names on three surfaces); fail EARLY with a clear message
	// instead. The fallback parameter is kept for the /api/runner/create gate,
	// which passes the form's own campaignId so its evaluation stays
	// deterministic.
	effectiveCampaignID := trimInput(req.CampaignID)
	if effectiveCampaignID == "" {
		effectiveCampaignID = trimInput(campaignID)
	}
	if effectiveCampaignID == "" {
		checks = append(checks, CheckResult{Rule: "campaign_id", Passed: false, Message: fmt.Sprintf("Campaign ID is required — assign the campaign's %s##### id (it is baked into every deal name)", operator.CampaignIDPrefix), FieldPath: "campaignId"})
	} else if matchesCampaignID(effectiveCampaignID) {
		checks = append(checks, CheckResult{Rule: "campaign_id", Passed: true, Message: fmt.Sprintf("Campaign ID %s is valid", effectiveCampaignID)})
	} else {
		checks = append(checks, CheckResult{Rule: "campaign_id", Passed: false, Message: fmt.Sprintf("Campaign ID must match pattern %s##### (5 digits)", operator.CampaignIDPrefix), FieldPath: "campaignId"})
	}

	// 9b. attribution_code — slot 12 feeds cutlass margin extraction; a typo
	// ("A14", "B19") silently breaks it downstream. Non-empty codes must be in
	// the workbook vocabulary. Legacy "NA" is tolerated (24 legacy rows carry
	// it) — it passes here with a QA warn (addAttributionItem). An empty code
	// defaults to A1, which the QA report already flags separately.
	if attr := trimInput(req.AttributionCode); attr != "" {
		switch {
		case strings.EqualFold(attr, "NA"):
			checks = append(checks, CheckResult{Rule: "attribution_code", Passed: true, Message: "Attribution code NA is a legacy value — accepted; confirm no real code was assigned (see the QA report)"})
		case knownAttributionCode(attr):
			checks = append(checks, CheckResult{Rule: "attribution_code", Passed: true, Message: fmt.Sprintf("Attribution code %s is in the vocabulary", strings.ToUpper(attr))})
		default:
			checks = append(checks, CheckResult{Rule: "attribution_code", Passed: false, Message: fmt.Sprintf("Attribution code %q is not in the vocabulary (%s; legacy NA tolerated) — a mis-typed code silently breaks downstream margin extraction", attr, attributionVocabularyLabel()), FieldPath: "attributionCode"})
		}
	}

	// 9c. iab_campaign_retired — the campaign-level IAB field is retired as a
	// shipping input: the frontend folds persisted legacy values onto the deal
	// cards at load (migrateCampaignIabCategories) and the prompts read only
	// per-deal picks/inference. A non-empty list here can only come from a
	// stale cached client whose prompts would still ship the invisible list
	// (a 2026-07 automotive-category incident) — fail closed. RunAudit
	// backs both the UI audit and the /api/runner/create enforcement gate, so a
	// stale bundle cannot submit past this.
	if len(req.IABCategories) > 0 {
		checks = append(checks, CheckResult{Rule: "iab_campaign_retired", Passed: false, Message: fmt.Sprintf("The campaign-level IAB categories field is retired — reload the app so the %d stored value(s) fold onto the deal cards, review the per-deal picks, and re-run the audit", len(req.IABCategories)), FieldPath: "iabCategories"})
	}

	// Advisory — the deal-prompt YAML currently emits a single file per deal
	// (single-file MCP contract). When the merged set (ad-hoc + curated) has
	// multiple files or mixed kinds we pick block-over-allow / first-listed
	// and surface this here so the trader knows the rest were dropped.
	if msg := summarizeListSelection(req.Deals, req.DomainLists, "domain"); msg != "" {
		checks = append(checks, CheckResult{Rule: "list_selection", Passed: true, Message: msg})
	}
	if msg := summarizeListSelection(req.Deals, req.AppBundleLists, "app bundle"); msg != "" {
		checks = append(checks, CheckResult{Rule: "list_selection", Passed: true, Message: msg})
	}

	// Build the expanded deal set from deals[] × active DSPs. Every consumer
	// of the audit (total_deals, deal_names, the QA report, the submit gate's
	// brief/prompt binding) sees the EXPANDED set — one deal per DSP.
	namedDeals := generateNamedDeals(req, effectiveCampaignID)
	dealNames := make([]string, len(namedDeals))
	for i, nd := range namedDeals {
		dealNames[i] = nd.Name
	}

	// deal_name_charset — control/invisible characters in a FINAL deal name
	// (only a nameOverride can carry them; generated slots are sanitized).
	// quote() in dealPromptYaml.ts escapes them so the emitted YAML cannot
	// break, but the submit gate's prompt binding (runner.go promptEmbedsName)
	// only matches the raw or minimally-escaped name — such a submit would
	// pass the audit and then 422 audit_prompt_mismatch forever. Fail closed
	// HERE, at /api/audit, with an actionable message instead.
	for _, nd := range namedDeals {
		if bad, ok := findControlRune(nd.Name); ok {
			checks = append(checks, CheckResult{
				Rule:      "deal_name_charset",
				Passed:    false,
				Message:   fmt.Sprintf("Deal %d: deal name contains a control/invisible character (%s) — remove it from the name override; such names cannot be bound by the submit gate.", nd.DealIndex+1, bad),
				DealIndex: nd.DealIndex,
				FieldPath: fmt.Sprintf("deals[%d].nameOverride", nd.DealIndex),
			})
		}
	}

	// attribution_slot — an override name's LAST slot must agree with the
	// form's attribution code. Slot 12 feeds cutlass margin extraction, and a
	// full-name override drifts silently when the form is corrected after the
	// name was written (a live batch once shipped names frozen with A1
	// while the form said B14 — the records and the booked deals disagreed). Derived names always match by construction; sheet-only rows are skipped — they were
	// booked under their own batch's code, which may legitimately differ.
	{
		formAttr := trimInput(req.AttributionCode)
		if formAttr == "" {
			formAttr = operator.DefaultAttributionCode // the generated-name default
		}
		mismatches := 0
		for _, nd := range namedDeals {
			if !nd.Override || req.Deals[nd.DealIndex].SheetOnly {
				continue
			}
			cut := strings.LastIndex(nd.Name, "_")
			if cut < 0 {
				continue // single-token override (e.g. a bare id) — no slots to check
			}
			lastSlot := nd.Name[cut+1:]
			if !knownAttributionCode(lastSlot) {
				continue // last token is not an attribution code — not a 12-slot name
			}
			if !strings.EqualFold(lastSlot, formAttr) {
				mismatches++
				checks = append(checks, CheckResult{
					Rule:      "attribution_slot",
					Passed:    false,
					Message:   fmt.Sprintf("Deal %d: the name override ends in attribution code %s but the form's attribution code is %s — margin extraction reads the name's slot 12, so fix the override (or the form) before submitting.", nd.DealIndex+1, strings.ToUpper(lastSlot), strings.ToUpper(formAttr)),
					DealIndex: nd.DealIndex,
					FieldPath: fmt.Sprintf("deals[%d].nameOverride", nd.DealIndex),
				})
			}
		}
		if mismatches == 0 {
			checks = append(checks, CheckResult{Rule: "attribution_slot", Passed: true, Message: "Override deal names agree with the form's attribution code"})
		}
	}

	// deal_name_length — EVERY SSP is gated (all SSPs first-class). Ceilings
	// per SSP, live-verified where noted; mirror ANY change in frontend
	// sspDealNameMax (types/deal.ts):
	//
	//   Index Exchange / Xandr — 255: the API rejects longer names at create.
	//   Media.net — 255: the Cutlass MCP validates display_name at 1–255
	//     (cutlass#747), binding for our create path.
	//   PubMatic — 250: UI field limit (2026-08).
	//   TripleLift — 150: the UI input hard-stops at 150 characters (trader
	//     verification, 2026-08-12) — no error shown, typing just stops. The
	//     API may accept more, but a name the UI cannot even display or edit
	//     is a name we must not mint.
	//   Magnite — split by marketplace flavor (trader-verified UI validation
	//     messages, 2026-08-12): Streaming (CTV/Audio) "Deal Name cannot
	//     exceed 250 characters"; DV+ (everything else) "…200 characters".
	//     An unset channel takes the stricter 200 (fail-closed; the channel
	//     rule flags the gap separately). Same CTV/Audio split as mg_sizes.
	//   OpenX — 255 app POLICY: the UI input is uncapped and publishes
	//     no limit (docs sweep 2026-08-11; UI probe 2026-08-12 — save-time
	//     behavior unverified), but a kilobyte name is broken everywhere
	//     downstream, so it gets the strictest-vendor ceiling.
	for _, nd := range namedDeals {
		deal := req.Deals[nd.DealIndex]
		ssp := strings.TrimSpace(deal.SSP)
		if ssp == "" {
			continue // deal_ssp already flags the missing SSP
		}
		var nameMax int
		var limitText string
		switch {
		case strings.EqualFold(ssp, "Index Exchange") || strings.EqualFold(ssp, "Xandr") || strings.EqualFold(ssp, "Media.net"):
			nameMax = 255
			limitText = fmt.Sprintf("%s rejects names longer than %d", ssp, nameMax)
		case strings.EqualFold(ssp, "PubMatic"):
			nameMax = 250
			limitText = fmt.Sprintf("%s rejects names longer than %d", ssp, nameMax)
		case strings.EqualFold(ssp, "TripleLift"):
			nameMax = 150
			limitText = "the TripleLift UI hard-caps deal names at 150 characters"
		case strings.EqualFold(ssp, "Magnite"):
			// CTV and OTT are both Streaming deals.
			if deal.Channel == "CTV" || deal.Channel == "OTT" || deal.Channel == "Audio" {
				nameMax = 250
				limitText = "Magnite Streaming rejects names longer than 250"
			} else {
				nameMax = 200
				limitText = "Magnite DV+ rejects names longer than 200"
			}
		default: // OpenX and anything new: app policy ceiling
			nameMax = 255
			limitText = fmt.Sprintf("deal names are capped at %d characters (app policy; %s publishes no limit)", nameMax, ssp)
		}
		if n := len(nd.Name); n > nameMax {
			// Anchored to the Deal name input (nameOverride), not theme: the
			// name is what is validated, and the override — when present — is
			// where the offending text lives. The message still names the
			// theme/agency/brand levers for auto-generated names.
			checks = append(checks, CheckResult{
				Rule:      "deal_name_length",
				Passed:    false,
				Message:   fmt.Sprintf("Deal %d: deal name is %d characters — %s. Shorten the theme/agency/brand (or the name override).", nd.DealIndex+1, n, limitText),
				DealIndex: nd.DealIndex,
				FieldPath: fmt.Sprintf("deals[%d].nameOverride", nd.DealIndex),
			})
		}
	}

	// qa_duplicate_deals — the QA checklist's "No duplicate deals". Two deals
	// that generate the identical deal name collapse the same audience × SSP ×
	// channel × inventory × geo × DSP combination: almost certainly a
	// copy-paste mistake, and the SSP-side names would collide. Deals still
	// missing theme/channel/SSP are skipped — their generated names are
	// placeholder-identical by construction, and the missing-field flags
	// already cover them.
	if len(namedDeals) > 1 {
		seen := map[string]int{} // name -> deal index of first occurrence
		dupes := 0
		for _, nd := range namedDeals {
			d := req.Deals[nd.DealIndex]
			if !nd.Override &&
				(strings.TrimSpace(d.Theme) == "" || strings.TrimSpace(d.Channel) == "" || strings.TrimSpace(d.SSP) == "") {
				continue
			}
			key := strings.ToLower(strings.TrimSpace(nd.Name))
			if j, dup := seen[key]; dup {
				dupes++
				msg := fmt.Sprintf("Deal %d duplicates Deal %d — both generate the deal name %q. Every deal must be a unique audience × SSP × channel × DSP combination.", nd.DealIndex+1, j+1, nd.Name)
				if j == nd.DealIndex {
					code := "?"
					if parts := strings.Split(nd.Name, "_"); len(parts) > 2 {
						code = parts[2]
					}
					msg = fmt.Sprintf("Deal %d: two selected DSP rows resolve to the same name code %q, so they generate the identical deal name %q — run separate batches or set distinct DSPs.", nd.DealIndex+1, code, nd.Name)
				}
				checks = append(checks, CheckResult{
					Rule:      "qa_duplicate_deals",
					Passed:    false,
					Message:   msg,
					DealIndex: nd.DealIndex,
					FieldPath: fmt.Sprintf("deals[%d].theme", nd.DealIndex),
				})
			} else {
				seen[key] = nd.DealIndex
			}
		}
		if dupes == 0 {
			checks = append(checks, CheckResult{Rule: "qa_duplicate_deals", Passed: true, Message: fmt.Sprintf("No duplicate deals — all %d deal names are unique", len(dealNames))})
		}
	}

	// Determine overall status
	failed := 0
	for _, c := range checks {
		if !c.Passed {
			failed++
		}
	}
	status := "passed"
	if failed > 0 {
		status = "failed"
	}

	inferred := buildInferredIAB(req)

	return AuditResponse{
		Status: status,
		// Total deals = Audiences × Channels × SSPs × DSPs — the expanded set,
		// matching deal_names, the brief, and what the runner will actually create.
		TotalDeals: len(dealNames),
		DealNames:  dealNames,
		Checks:     checks,
		Inferred:   inferred,
		QA:         BuildQAReport(req, checks, namedDeals, effectiveCampaignID),
	}
}

// iabKeyword pairs a lowercase substring with the IAB category it implies.
// MIRROR CONTRACT: frontend/src/lib/inferIab.ts (KEYWORD_TO_CATEGORY) holds
// the SAME table for the deal cards and generated prompts. Change the
// keywords in BOTH places or neither — inferIab.test.ts and rules_test.go pin
// shared fixtures to enforce the mirror.
type iabKeyword struct {
	keyword  string
	category string
}

var iabKeywordTable = []iabKeyword{
	{"auto insurance", "Auto Insurance"},
	{"automotive", "Automotive"},
	{"car", "Automotive"},
	{"cars", "Automotive"},
	{"vehicle", "Automotive"},
	{"vehicles", "Automotive"},
	{"dealership", "Automotive"},
	{"home insurance", "Home Insurance"},
	{"life insurance", "Life Insurance"},
	{"insurance", "Insurance"},
	{"bank", "Consumer Banking"},
	{"banking", "Consumer Banking"},
	{"credit", "Personal Finance"},
	{"finance", "Personal Finance"},
	{"financial", "Personal Finance"},
	{"invest", "Personal Finance"},
	{"investing", "Personal Finance"},
	{"investment", "Personal Finance"},
	{"b2b", "Business"},
	{"business", "Business"},
	{"career", "Careers & Employment"},
	{"job", "Careers & Employment"},
	{"hiring", "Careers & Employment"},
	{"education", "Education"},
	{"school", "Education"},
	{"college", "Education"},
	{"parent", "Family & Parenting"},
	{"family", "Family & Parenting"},
	{"baby", "Family & Parenting"},
	{"food", "Food & Drink"},
	{"drink", "Food & Drink"},
	{"beverage", "Food & Drink"},
	{"restaurant", "Food & Drink"},
	{"grocery", "Food & Drink"},
	{"recipe", "Food & Drink"},
	{"health", "Health & Fitness"},
	{"fitness", "Health & Fitness"},
	{"wellness", "Health & Fitness"},
	{"pharma", "Health & Fitness"},
	{"medical", "Health & Fitness"},
	{"medicine", "Health & Fitness"},
	{"cold and flu", "Health & Fitness"},
	{"cold & flu", "Health & Fitness"},
	{"flu", "Health & Fitness"},
	{"allergy", "Health & Fitness"},
	{"sunscreen", "Health & Fitness"},
	{"skincare", "Style & Fashion"},
	{"skin care", "Style & Fashion"},
	{"beauty", "Style & Fashion"},
	{"fashion", "Style & Fashion"},
	{"apparel", "Style & Fashion"},
	{"cosmetic", "Style & Fashion"},
	{"home & garden", "Home & Garden"},
	{"garden", "Home & Garden"},
	{"home improvement", "Home & Garden"},
	{"furniture", "Home & Garden"},
	{"diy", "Home & Garden"},
	{"politics", "Law, Gov & Politics"},
	{"political", "Law, Gov & Politics"},
	{"government", "Law, Gov & Politics"},
	{"election", "Law, Gov & Politics"},
	{"news", "News"},
	{"weather", "News"},
	{"pet", "Pets"},
	{"pets", "Pets"},
	{"dog", "Pets"},
	{"dogs", "Pets"},
	{"cat", "Pets"},
	{"cats", "Pets"},
	{"real estate", "Real Estate"},
	{"mortgage", "Real Estate"},
	{"home buyer", "Real Estate"},
	{"science", "Science"},
	{"sport", "Sports"},
	{"sports", "Sports"},
	{"nfl", "Sports"},
	{"nba", "Sports"},
	{"mlb", "Sports"},
	{"golf", "Sports"},
	{"tech", "Technology & Computing"},
	{"software", "Technology & Computing"},
	{"computing", "Technology & Computing"},
	{"gaming", "Technology & Computing"},
	{"travel", "Travel"},
	{"vacation", "Travel"},
	{"tourism", "Travel"},
	{"hotel", "Travel"},
	{"airline", "Travel"},
	{"beach", "Travel"},
	{"outdoor", "Hobbies & Interests"},
	{"hobby", "Hobbies & Interests"},
	{"crafts", "Hobbies & Interests"},
	{"entertainment", "Arts & Entertainment"},
	{"movie", "Arts & Entertainment"},
	{"music", "Arts & Entertainment"},
	{"streaming", "Arts & Entertainment"},
	{"tv show", "Arts & Entertainment"},
}

// matchesIABKeyword reports whether kw occurs in text on WORD BOUNDARIES —
// 'pet' matches "pet food" but not "carpet", "competition", or "petroleum".
// Mirrors matchesWord in frontend/src/lib/inferIab.ts.
func matchesIABKeyword(text, kw string) bool {
	isAlnum := func(b byte) bool {
		return (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
	}
	for start := 0; start <= len(text)-len(kw); {
		idx := strings.Index(text[start:], kw)
		if idx == -1 {
			return false
		}
		idx += start
		beforeOK := idx == 0 || !isAlnum(text[idx-1])
		end := idx + len(kw)
		afterOK := end >= len(text) || !isAlnum(text[end])
		if beforeOK && afterOK {
			return true
		}
		start = idx + 1
	}
	return false
}

// inferIABForDeal runs the keyword table over ONE deal's own details (theme,
// include segments, IAB hint) plus the campaign brand/KPI context.
// Deterministic and order-stable — mirrors inferIabCategories in
// frontend/src/lib/inferIab.ts.
func inferIABForDeal(deal DealEntry, req *AuditRequest) []string {
	parts := append([]string{deal.Theme}, deal.IncludeSegments...)
	parts = append(parts, deal.IABHint, req.Brand, req.KPIGoal)
	text := strings.ToLower(strings.Join(parts, " \n "))
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, kw := range iabKeywordTable {
		if seen[kw.category] {
			continue
		}
		if matchesIABKeyword(text, kw.keyword) {
			out = append(out, kw.category)
			seen[kw.category] = true
		}
	}
	return out
}

// buildInferredIAB assembles the audit response's inferred block: one per-deal
// entry for every deal that OPTED IN to inference (AutoInferIab) and has no
// explicit iabCategories override, plus the union across deals for backward
// compat with the old campaign-wide field. Inference is opt-in per deal,
// default OFF — a toggle-off deal without picks ships NO categories
// (effectiveIabCategories in inferIab.ts), so none are advertised for it
// either. A legacy campaign-wide selection (req.IABCategories) never ships
// anymore — the prompts ignore it and the iab_campaign_retired check fails
// the audit until it folds onto the deals — so opted-in inference is
// advertised regardless.
func buildInferredIAB(req *AuditRequest) InferredData {
	inferred := InferredData{}
	if len(req.Deals) == 0 {
		return inferred
	}
	seen := map[string]bool{}
	for i, deal := range req.Deals {
		if deal.IABCategories != nil {
			// Explicit per-deal picks (possibly empty) — nothing to infer.
			continue
		}
		if !deal.AutoInferIab {
			// Toggle off (the default): nothing ships, nothing is advertised.
			continue
		}
		cats := inferIABForDeal(deal, req)
		if len(cats) == 0 {
			continue
		}
		inferred.PerDeal = append(inferred.PerDeal, InferredDealIAB{DealIndex: i, IABCategories: cats})
		for _, c := range cats {
			if !seen[c] {
				seen[c] = true
				inferred.IABCategories = append(inferred.IABCategories, c)
			}
		}
	}
	if len(inferred.PerDeal) > 0 {
		inferred.Note = "Inferred per deal from each deal's theme/segments + brand — review on the deal cards; explicit per-deal picks override."
	}
	return inferred
}

// reportingLabelPresent checks whether the trader supplied a value for the
// given reporting-label key. Auto-derivable keys (advertiser from brand,
// agency from agency, externalReferenceID from a deal's per-deal
// externalReferenceId) are treated as present when the source field is set.
// dealListPoolIsAppish mirrors the prompt resolver's channel routing (resolve()
// in dealPromptYaml.ts, and effectiveDealListName in qa.go): CTV/OTT/In-App
// deals draw their list from the app-bundle pool, everything else from the
// domain pool.
func dealListPoolIsAppish(d DealEntry) bool {
	return d.Channel == "CTV" || d.Channel == "OTT" || d.InventoryType == "In-App"
}

// dealListPoolIsWebish mirrors listChannelRouting's web side. OTT reaches
// desktop and web now, so it draws from BOTH pools — a streaming buy carries
// app bundles and domains together. CTV stays app-only.
func dealListPoolIsWebish(d DealEntry) bool {
	return d.Channel == "Display" || d.Channel == "Native" || d.Channel == "OTT" ||
		(d.Channel == "OLV (Online Video)" && d.InventoryType != "In-App")
}

// listPickResolves reports whether an explicit per-deal list id points at a
// live list: an ad-hoc upload in the scope's pool, a batch-applied standard
// list folded into that pool ("list:"+id), or a per-deal standard-list pick
// resolved through the registry into PerDealLists.
func listPickResolves(id string, pool, perDeal []UploadedFile) bool {
	for _, files := range [][]UploadedFile{pool, perDeal} {
		for _, f := range files {
			if f.ID == id || f.ID == "list:"+id {
				return true
			}
		}
	}
	return false
}

// listRefChecks backs the list_ref rule: one failure per (deal, scope) whose
// explicit per-deal list pick no longer resolves. See the call site for why a
// stale pick is a silent create-without-list otherwise.
func listRefChecks(req *AuditRequest) []CheckResult {
	var checks []CheckResult
	for i, d := range req.Deals {
		if d.SheetOnly {
			continue
		}
		prefix := fmt.Sprintf("Deal %d", i+1)
		if t := strings.TrimSpace(d.Theme); t != "" {
			prefix += " (" + t + ")"
		}
		for _, pick := range []struct {
			p     *string
			pool  []UploadedFile
			label string
			field string
		}{
			{d.DomainListID, req.DomainLists, "site/domain", fmt.Sprintf("deals[%d].domainListId", i)},
			{d.AppBundleListID, req.AppBundleLists, "app-bundle", fmt.Sprintf("deals[%d].appBundleListId", i)},
		} {
			if pick.p == nil {
				continue
			}
			id := strings.TrimSpace(*pick.p)
			if id == "" || listPickResolves(id, pick.pool, req.PerDealLists) {
				continue
			}
			checks = append(checks, CheckResult{
				Rule:      "list_ref",
				Passed:    false,
				Message:   fmt.Sprintf("%s picks a %s list that no longer exists (id %q — the file was removed or re-uploaded under a new id). The deal would create with NO list while the upload still ships to the task. Re-pick the list on the deal card, or clear the assignment.", prefix, pick.label, id),
				DealIndex: i,
				FieldPath: pick.field,
			})
		}
	}
	return checks
}

// listAppliedChecks backs the list_applied rule: fail a scope pool (domain /
// app-bundle) that has uploaded files but ZERO create deals resolving a list
// from that scope — the uploads would ride the task unreferenced and every
// deal creates unscoped. A deal "carries" the scope when its explicit pick
// resolves (pool or per-deal standard list) or, on campaign default, when any
// typed pool file applies to it (mirrors pickPrimaryFile + AppliesTo scoping).
func listAppliedChecks(req *AuditRequest) []CheckResult {
	live := map[string]bool{}
	for _, d := range req.Deals {
		live[d.ID] = true
	}
	appliesToDeal := func(f UploadedFile, dealID string) bool {
		scoped, hit := 0, false
		for _, id := range f.AppliesTo {
			if live[id] {
				scoped++
				if id == dealID {
					hit = true
				}
			}
		}
		return scoped == 0 || hit
	}
	carried := func(wantApp bool, pool []UploadedFile) bool {
		for _, d := range req.Deals {
			if d.SheetOnly || dealListPoolIsAppish(d) != wantApp {
				continue
			}
			override := d.DomainListID
			if wantApp {
				override = d.AppBundleListID
			}
			if override != nil {
				id := strings.TrimSpace(*override)
				if id != "" && listPickResolves(id, pool, req.PerDealLists) {
					return true
				}
				continue
			}
			for _, f := range pool {
				t := strings.TrimSpace(f.InclusionType)
				if (strings.EqualFold(t, "Exclude") || strings.EqualFold(t, "Include")) && appliesToDeal(f, d.ID) {
					return true
				}
			}
		}
		return false
	}
	var checks []CheckResult
	for _, scope := range []struct {
		pool    []UploadedFile
		appish  bool
		label   string
		field   string
		routing string
	}{
		{req.DomainLists, false, "Domain", "domainLists", "web-channel (Display/OLV/Native/Audio)"},
		{req.AppBundleLists, true, "App-bundle", "appBundleLists", "CTV/OTT/In-App"},
	} {
		if len(scope.pool) == 0 || carried(scope.appish, scope.pool) {
			continue
		}
		names := make([]string, 0, len(scope.pool))
		for _, f := range scope.pool {
			names = append(names, fmt.Sprintf("%q", f.Name))
		}
		checks = append(checks, CheckResult{
			Rule:      "list_applied",
			Passed:    false,
			Message:   fmt.Sprintf("%s list(s) %s would ship with ZERO deals — the file uploads to the task but no deal's prompt references it (stale per-deal pick, every deal opted out, or no %s deal to route it to). Assign the list on a deal card, or remove the upload.", scope.label, strings.Join(names, ", "), scope.routing),
			FieldPath: scope.field,
		})
	}
	return checks
}

// summarizeListSelection returns a human-readable advisory describing how the
// trader's set of selected files collapses into the single file the YAML
// emits per deal. Returns "" when there's nothing notable to report (zero or
// one file, all of the same kind that produces no ambiguity).
//
// Selection rules (confirmed with user 2026-05-20):
//   - Block-kind file wins over Allow-kind when both are present
//   - First-listed wins within a kind
//
// scopeLabel is "domain" or "app bundle" — used in the message.
//
// Files scoped to specific deals via AppliesTo compete only on the deals
// they're assigned to (stale ids pointing at removed deals are ignored — the
// file then applies everywhere, matching the prompt resolver). Unscoped files
// compete campaign-wide exactly as before; additionally, any deal a scoped
// file targets is checked for a per-deal collapse (two lists in scope on the
// SAME deal still emit only one file).
func summarizeListSelection(deals []DealEntry, files []UploadedFile, scopeLabel string) string {
	live := map[string]bool{}
	for _, d := range deals {
		live[d.ID] = true
	}
	type scopedFile struct {
		name  string
		scope map[string]bool
	}
	var unscoped []UploadedFile
	var scoped []scopedFile
	for _, f := range files {
		if strings.TrimSpace(f.InclusionType) == "" {
			continue
		}
		eff := map[string]bool{}
		for _, id := range f.AppliesTo {
			if live[id] {
				eff[id] = true
			}
		}
		if len(eff) == 0 {
			unscoped = append(unscoped, f)
		} else {
			scoped = append(scoped, scopedFile{name: f.Name, scope: eff})
		}
	}

	var msgs []string
	var blockNames, allowNames []string
	for _, f := range unscoped {
		switch strings.TrimSpace(f.InclusionType) {
		case "Exclude":
			blockNames = append(blockNames, f.Name)
		case "Include":
			allowNames = append(allowNames, f.Name)
		}
	}
	switch {
	case len(blockNames) >= 1 && len(allowNames) >= 1:
		msgs = append(msgs, fmt.Sprintf("Multiple %s lists selected (%d block, %d allow). The deal prompt currently carries one file per deal — %q (block) will be used; the rest are ignored.",
			scopeLabel, len(blockNames), len(allowNames), blockNames[0]))
	case len(blockNames) > 1:
		msgs = append(msgs, fmt.Sprintf("%d %s block lists selected. Only %q is emitted in the deal prompt — the rest are ignored.",
			len(blockNames), scopeLabel, blockNames[0]))
	case len(allowNames) > 1:
		msgs = append(msgs, fmt.Sprintf("%d %s allow lists selected. Only %q is emitted in the deal prompt — the rest are ignored.",
			len(allowNames), scopeLabel, allowNames[0]))
	}

	// Per-deal collapse on deals a scoped file explicitly targets.
	if len(scoped) > 0 {
		for i, d := range deals {
			targeted := false
			var names []string
			for _, sf := range scoped {
				if sf.scope[d.ID] {
					targeted = true
					names = append(names, sf.name)
				}
			}
			if !targeted {
				continue
			}
			for _, f := range unscoped {
				names = append(names, f.Name)
			}
			if len(names) > 1 {
				msgs = append(msgs, fmt.Sprintf("Deal %d has %d %s lists in scope (%s) — the prompt carries ONE file per deal (block-over-allow, first-listed); the rest are ignored for this deal.",
					i+1, len(names), scopeLabel, strings.Join(names, ", ")))
			}
		}
	}
	return strings.Join(msgs, " ")
}

func reportingLabelPresent(key string, req *AuditRequest) bool {
	switch key {
	case "advertiser":
		return strings.TrimSpace(req.Brand) != ""
	case "agency":
		return strings.TrimSpace(req.Agency) != ""
	case "salesperson":
		return strings.TrimSpace(req.ReportingLabels.Salesperson) != ""
	case "externalReferenceID":
		// Unreachable from the rule loop since #238 (the rule now checks this
		// key PER-DEAL, requiring every create row to carry a reference);
		// kept for any other caller. Every non-sheet-only deal must have one.
		for _, d := range req.Deals {
			if d.SheetOnly {
				continue
			}
			if strings.TrimSpace(d.ExternalReferenceID) == "" {
				return false
			}
		}
		return true
	case "custom":
		if strings.TrimSpace(req.ReportingLabels.Custom) != "" {
			return true
		}
		return strings.TrimSpace(req.SubmitterEmail) != ""
	default:
		return false
	}
}

// fieldPathForLabel returns the form-field path that should highlight when
// a required reporting-label is missing. The frontend uses this to scroll/
// border the right input. Auto-derived keys point to their source field.
func fieldPathForLabel(key string) string {
	switch key {
	case "advertiser":
		return "brand"
	case "agency":
		return "agency"
	case "salesperson":
		return "reportingLabels.salesperson"
	case "externalReferenceID":
		return "deals[].externalReferenceId"
	case "custom":
		return "submitterEmail"
	default:
		return ""
	}
}

// findControlRune reports the first control/invisible rune in s — anything
// below U+0020, plus DEL (U+007F), NEL (U+0085), and the BOM (U+FEFF) — as a
// printable escape for the check message.
func findControlRune(s string) (string, bool) {
	for _, r := range s {
		if r < 0x20 || r == 0x7F || r == 0x85 || r == 0xFEFF {
			return fmt.Sprintf("U+%04X", r), true
		}
	}
	return "", false
}

// attributionCodes is the canonical attribution vocabulary (slot 12):
// A0–A13, B00, B1–B18, C1, C2, D00, D1, plus three operator-prefixed codes
// (<CAMPAIGN_ID_PREFIX>1–3). Downstream margin extraction reads this slot — a
// typo ("A14", "B19") silently breaks it, so membership is audited
// (attribution_code). The legacy "NA" is accepted with a QA warn rather than
// hard-failed. Mirrors ATTRIBUTION_CODES in frontend/src/lib/dealNameSlots.ts.
func attributionCodes() map[string]bool {
	set := map[string]bool{"B00": true, "C1": true, "C2": true, "D00": true, "D1": true}
	for i := 0; i <= 13; i++ {
		set[fmt.Sprintf("A%d", i)] = true
	}
	for i := 1; i <= 18; i++ {
		set[fmt.Sprintf("B%d", i)] = true
	}
	for i := 1; i <= 3; i++ {
		set[fmt.Sprintf("%s%d", strings.ToUpper(operator.CampaignIDPrefix), i)] = true
	}
	return set
}

func attributionVocabularyLabel() string {
	p := strings.ToUpper(operator.CampaignIDPrefix)
	return fmt.Sprintf("A0–A13, B00, B1–B18, C1, C2, D00, D1, %s1–%s3", p, p)
}

// knownAttributionCode reports vocabulary membership, case-insensitively.
func knownAttributionCode(code string) bool {
	return attributionCodes()[strings.ToUpper(strings.TrimSpace(code))]
}

func matchesCampaignID(id string) bool {
	return MatchesCampaignID(id)
}

// isPlausibleEmail reports whether s looks like a deliverable address:
// exactly one @, a non-empty local part, and a domain containing a dot —
// the same shape the frontend's EMAIL_RE enforces (local@domain.tld). It is
// deliberately loose (no RFC 5322 parsing): the goal is catching pasted
// names, missing TLDs, and truncated addresses, not litigating rare
// technically-valid forms.
// splitEmailList splits a comma/semicolon/newline-joined recipient string
// into trimmed entries — the same separators the frontend chip input joins
// on and the Cutlass sendgrid server tolerates in to_email.
func splitEmailList(s string) []string {
	out := []string{}
	for _, tok := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == '\n' }) {
		if t := strings.TrimSpace(tok); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func isPlausibleEmail(s string) bool {
	if strings.ContainsAny(s, " \t\n") {
		return false
	}
	at := strings.IndexByte(s, '@')
	if at <= 0 || at != strings.LastIndexByte(s, '@') {
		return false
	}
	domain := s[at+1:]
	dot := strings.IndexByte(domain, '.')
	// The domain needs a dot with characters on both sides.
	return dot > 0 && dot < len(domain)-1
}

// MatchesCampaignID reports whether id is a well-formed campaign id: the
// operator's CAMPAIGN_ID_PREFIX followed by exactly 5 digits.
func MatchesCampaignID(id string) bool {
	prefix := strings.ToUpper(operator.CampaignIDPrefix)
	if len(id) != len(prefix)+5 || !strings.HasPrefix(id, prefix) {
		return false
	}
	for _, r := range id[len(prefix):] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// sspStateIncludeUnsupported lists the SSPs whose create path CANNOT carry
// US-state / CA-province include targeting (#233.7/.8): the IX create
// wire is include-only geo_countries + dma_codes (no state/region key), and
// Media.net consumes countries only. A state include on these SSPs is NOT
// applied — the prompt builder emits a loud NOT-SUPPORTED marker — so the
// deal NAME's Geo slot must not claim the state either (a "..._CA_..." name
// over a whole-country deal is a lying name). Mirrors
// SSP_STATE_INCLUDE_UNSUPPORTED in frontend/src/lib/dealNameSlots.ts; keys
// are lowercased, whitespace-collapsed (the vocabKey normalization).
var sspStateIncludeUnsupported = map[string]bool{
	"index exchange": true,
	"media.net":      true,
}

// sspCarriesIncludeStates reports whether this SSP's create path carries
// include-state targeting. An unset/unknown SSP keeps the legacy state-first
// name behavior. Mirrors sspCarriesIncludeStates in dealNameSlots.ts.
func sspCarriesIncludeStates(ssp string) bool {
	key := strings.ToLower(strings.Join(strings.Fields(ssp), " "))
	return !sspStateIncludeUnsupported[key]
}

// primaryGeo resolves the Geo slot: the FIRST STATE entry if any state is
// set, else the first country, else "" (the caller falls back to "Global").
// zip/dma entries NEVER reach the name — commit 42ae30b's typed-geo refactor
// took the first entry of any type, which dropped the state preference and
// let a zip/dma value land in the name. Mirrors geoCode in
// frontend/src/lib/dealNameSlots.ts.
func primaryGeo(geos []GeoEntry) string {
	return primaryGeoWithStates(geos, true)
}

// primaryGeoForSSP is the SSP-aware Geo slot (#233.8): state entries
// are skipped on SSPs whose create path cannot carry them, so the name never
// claims an untargeted state. Mirrors geoSlot in dealNameSlots.ts.
func primaryGeoForSSP(geos []GeoEntry, ssp string) string {
	return primaryGeoWithStates(geos, sspCarriesIncludeStates(ssp))
}

func primaryGeoWithStates(geos []GeoEntry, includeStates bool) string {
	firstCountry := ""
	for _, g := range geos {
		v := trimInput(g.Value)
		if v == "" {
			continue
		}
		switch g.Type {
		case "state":
			if includeStates {
				return sanitizeSlotValue(v)
			}
			// no state wire on this SSP — the name must not claim it
		case "country":
			if firstCountry == "" {
				// upperASCII, not strings.ToUpper: Unicode-aware uppercasing
				// diverges from the JS twin (ß → SS in JS only).
				firstCountry = sanitizeSlotValue(upperASCII(v))
			}
		}
	}
	return firstCountry
}

// --- Geo classification vocabularies (geo_classification rule) --------------
// Mirrors STATE_CODE / CA_PROVINCE_CODE / COUNTRY_NAMES in
// frontend/src/lib/dealPromptYaml.ts. Coordinated with the OpenX MCP's
// roster-backed country validation (cutlass#724 / #223): an
// unclassifiable subnational entry or unknown country must fail the audit
// BEFORE submit instead of dying mid-batch (or, worse, silently targeting the
// wrong country — bare "SK" used to validate as Slovakia).

var usStateNameToCode = map[string]string{
	"ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR",
	"CALIFORNIA": "CA", "COLORADO": "CO", "CONNECTICUT": "CT", "DELAWARE": "DE",
	"DISTRICT OF COLUMBIA": "DC", "FLORIDA": "FL", "GEORGIA": "GA", "HAWAII": "HI",
	"IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA",
	"KANSAS": "KS", "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME",
	"MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI", "MINNESOTA": "MN",
	"MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE",
	"NEVADA": "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM",
	"NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", "OHIO": "OH",
	"OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA", "RHODE ISLAND": "RI",
	"SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX",
	"UTAH": "UT", "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA",
	"WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
}

var caProvinceNameToCode = map[string]string{
	"ALBERTA": "AB", "BRITISH COLUMBIA": "BC", "MANITOBA": "MB", "NEW BRUNSWICK": "NB",
	"NEWFOUNDLAND AND LABRADOR": "NL", "NOVA SCOTIA": "NS", "NORTHWEST TERRITORIES": "NT",
	"NUNAVUT": "NU", "ONTARIO": "ON", "PRINCE EDWARD ISLAND": "PE", "QUEBEC": "QC",
	"SASKATCHEWAN": "SK", "YUKON": "YT",
}

var usStateAbbrevSet = func() map[string]bool {
	m := make(map[string]bool, len(usStateNameToCode))
	for _, code := range usStateNameToCode {
		m[code] = true
	}
	return m
}()

var caProvinceAbbrevSet = func() map[string]bool {
	m := make(map[string]bool, len(caProvinceNameToCode))
	for _, code := range caProvinceNameToCode {
		m[code] = true
	}
	return m
}()

// knownGeoCountryNames mirrors COUNTRY_NAMES values in dealPromptYaml.ts —
// the full names Deal Onboarding itself emits for country geo. Country entries beyond
// these must be 2-letter ISO tokens; the OpenX MCP validates the token against
// its live 249-row country option set at run time (roster-backed, fail-closed).
var knownGeoCountryNames = map[string]bool{
	"UNITED STATES": true, "CANADA": true, "UNITED KINGDOM": true, "AUSTRALIA": true,
	"GERMANY": true, "FRANCE": true, "SPAIN": true, "ITALY": true, "JAPAN": true,
	"MEXICO": true, "BRAZIL": true, "INDIA": true,
}

// normalizeGeoToken uppercases and collapses inner whitespace for vocabulary
// lookups ("new  york" -> "NEW YORK").
func normalizeGeoToken(s string) string {
	return strings.Join(strings.Fields(upperASCII(trimInput(s))), " ")
}

// classifyGeoState buckets a typed subnational geo value: "us", "ca", or ""
// (unclassifiable). Mirrors classifyGeoState in dealPromptYaml.ts — full names
// and 2-letter codes, case-insensitive; no US/CA abbreviation overlaps exist.
func classifyGeoState(v string) string {
	u := normalizeGeoToken(v)
	if u == "" {
		return ""
	}
	if usStateAbbrevSet[u] || usStateNameToCode[u] != "" {
		return "us"
	}
	if caProvinceAbbrevSet[u] || caProvinceNameToCode[u] != "" {
		return "ca"
	}
	return ""
}

// recognizedGeoCountry accepts 2-letter ISO-shaped tokens (roster-validated
// for real by the SSP MCPs) and the known full country names Deal Onboarding emits.
func recognizedGeoCountry(v string) bool {
	u := normalizeGeoToken(v)
	if len(u) == 2 && u[0] >= 'A' && u[0] <= 'Z' && u[1] >= 'A' && u[1] <= 'Z' {
		return true
	}
	return knownGeoCountryNames[u]
}

// inventoryCode normalizes slot 9 to the workbook vocabulary:
// "All" | "In-app" | "Web" (NOT the legacy "InApp"/"Web Only"). Known form
// values normalize; unknown values pass through sanitized — the audit flags
// them via the inventory_code check (recognizedInventoryType).
func inventoryCode(invType string) string {
	switch vocabKey(invType) {
	case "web only", "web":
		return "Web"
	case "in-app", "in app", "inapp":
		return "In-app"
	case "all", "":
		return "All"
	default:
		if cleaned := sanitizeSlotValue(invType); cleaned != "" {
			return cleaned
		}
		return "All"
	}
}

// recognizedInventoryType reports whether the value normalizes to a known
// inventory vocabulary entry.
func recognizedInventoryType(invType string) bool {
	switch vocabKey(invType) {
	case "web only", "web", "in-app", "in app", "inapp", "all", "":
		return true
	}
	return false
}

// channelSlotCode is the channel vocabulary for slot 8. Mirrors
// CHANNEL_SLOT_CODE in dealNameSlots.ts.
var channelSlotCode = map[string]string{
	"display":            "Display",
	"olv (online video)": "OLV",
	"olv":                "OLV",
	"ctv":                "CTV",
	"ott":                "OTT",
	"native":             "Native",
	"audio":              "Audio",
}

// channelCode normalizes slot 8: recognized channels normalize via the
// vocabulary; unknown values pass through sanitized (the audit flags them via
// the channel_code check); empty → "" (the name path falls back to the
// "Channel" placeholder).
func channelCode(ch string) string {
	key := vocabKey(ch)
	if key == "" {
		return ""
	}
	if code, ok := channelSlotCode[key]; ok {
		return code
	}
	return sanitizeSlotValue(ch)
}

// recognizedChannel reports whether the value normalizes to a known channel
// vocabulary entry.
func recognizedChannel(ch string) bool {
	key := vocabKey(ch)
	if key == "" {
		return true
	}
	_, ok := channelSlotCode[key]
	return ok
}

// curatorSlot resolves slot 1: the data-partner code if set, else the
// operator's ORG_NAME (config.Operator.OrgName). Mirrors curatorSlot in
// frontend/src/lib/dealNameSlots.ts.
func curatorSlot(req *AuditRequest) string {
	if dp := trimInput(req.DataPartner); dp != "" {
		if code := dataPartnerCodeFor(dp); code != "" {
			return code
		}
	}
	if org := sanitizeSlotValue(operator.OrgName); org != "" {
		return org
	}
	return config.DefaultOrgName
}

// sspSlot resolves slot 2 from the locked vocabulary; unknown SSPs pass
// through sanitized.
func sspSlot(ssp string) string {
	if code, ok := sspSlotCode[vocabKey(ssp)]; ok {
		return code
	}
	if cleaned := sanitizeSlotValue(ssp); cleaned != "" {
		return cleaned
	}
	return "SSP"
}

// dspSlot resolves slot 3 from the locked vocabulary; unknown DSP names pass
// through sanitized.
func dspSlot(dsp string) string {
	if code, ok := dspSlotCode[vocabKey(dsp)]; ok {
		return code
	}
	if cleaned := sanitizeSlotValue(dsp); cleaned != "" {
		return cleaned
	}
	return "DSP"
}

// activeDSPs returns the DSPs that participate in deal expansion: all of them
// when the "multiple DSPs" toggle is on, else only the first row — entries
// without a DSP name never count. Mirrors activeDsps in
// frontend/src/lib/dealNameSlots.ts.
func activeDSPs(req *AuditRequest) []DSPEntry {
	list := req.DSPs
	if !req.MultipleDSPs && len(list) > 1 {
		list = list[:1]
	}
	out := make([]DSPEntry, 0, len(list))
	for _, d := range list {
		if trimInput(d.DSP) != "" {
			out = append(out, d)
		}
	}
	return out
}

// NamedDeal is one expanded deal name: DealIndex points at the req.Deals row
// it was generated from (several NamedDeals share an index under multi-DSP
// expansion), and Override marks a verbatim nameOverride (override deals are
// a single already-named deal and do NOT expand across DSPs).
type NamedDeal struct {
	DealIndex int
	Name      string
	Override  bool
}

// generateNamedDeals expands the form into its full deal set:
// Audiences × Channels × SSPs (the deals[] rows) × DSPs (LOCKED product
// decision). Each selected DSP yields its own deal carrying that DSP's
// name-slot code. Mirrors the expansion in frontend/src/lib/dealPromptYaml.ts
// (expandDealDsps) and hooks/useDealMatrix.ts.
func generateNamedDeals(req *AuditRequest, campaignID string) []NamedDeal {
	if len(req.Deals) == 0 {
		return []NamedDeal{}
	}
	curator := curatorSlot(req)
	agency := normalizedSegment(req.Agency, "Agency")
	brand := normalizedSegment(req.Brand, "Brand")
	attribution := normalizedSegment(req.AttributionCode, operator.DefaultAttributionCode)
	campaign := trimInput(campaignID)
	if campaign == "" {
		// The audit no longer mints a campaign id (the campaign_id check fails
		// instead); keep the name shape stable with the same placeholder the
		// frontend previews use.
		campaign = operator.CampaignIDPrefix + "#####"
	}
	dsps := activeDSPs(req)
	dspCodes := make([]string, 0, len(dsps))
	for _, d := range dsps {
		dspCodes = append(dspCodes, dspSlot(d.DSP))
	}
	if len(dspCodes) == 0 {
		dspCodes = []string{"DSP"}
	}

	named := make([]NamedDeal, 0, len(req.Deals)*len(dspCodes))
	for i, deal := range req.Deals {
		ssp := "SSP"
		if deal.SSP != "" {
			ssp = sspSlot(deal.SSP)
		}
		theme := normalizedSegment(deal.Theme, "Audience")
		channel := channelCode(deal.Channel)
		if channel == "" {
			channel = "Channel"
		}
		inv := deal.InventoryType
		if inv == "" {
			inv = req.DefaultInventoryType
		}
		geos := deal.GeoInclude
		if len(geos) == 0 {
			geos = req.DefaultGeoInclude
		}
		// SSP-aware (#233.8): on SSPs with no state wire (IX,
		// Media.net) the Geo slot falls back to the first country — the name
		// must never claim a state the create cannot target.
		geo := primaryGeoForSSP(geos, deal.SSP)
		if geo == "" {
			geo = "Global"
		}
		standardName := func(dspCode string) string {
			// Slot 6 (DataPartner) is the literal "NA": the partner IS the
			// curator (slot 1) and must never appear in both slots; the slot is
			// reserved for a future secondary data overlay.
			parts := []string{curator, ssp, dspCode, agency, brand, "NA", theme}
			parts = append(parts, channel, inventoryCode(inv), geo, campaign, attribution)
			return strings.Join(parts, "_")
		}
		rowCodes := dspCodes
		if override := trimInput(deal.NameOverride); override != "" {
			// A full-name override rides verbatim — nothing is derived from it.
			// Mirrors generateDealName in dealNameSlots.ts.
			named = append(named, NamedDeal{DealIndex: i, Name: override, Override: true})
			continue
		}
		// SHEET-ONLY rows never expand: the deal already exists from a
		// previous (possibly pre-expansion) batch, so fabricating extra
		// per-DSP "already created" names would put deals that never existed
		// on the client deal-sheet email. Exactly ONE name on the first
		// active DSP; follow-up batches should carry the recorded name as
		// nameOverride (docs/DEAL_NAMING.md §6). Mirrors expandDealDsps in
		// dealNameSlots.ts.
		if deal.SheetOnly {
			rowCodes = dspCodes[:1]
		}
		for _, dspCode := range rowCodes {
			named = append(named, NamedDeal{DealIndex: i, Name: standardName(dspCode)})
		}
	}
	return named
}

func generateDealNames(req *AuditRequest, campaignID string) []string {
	named := generateNamedDeals(req, campaignID)
	names := make([]string, len(named))
	for i, nd := range named {
		names[i] = nd.Name
	}
	return names
}

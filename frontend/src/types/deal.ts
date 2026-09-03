// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { defaultGeoInclude } from '../lib/geoPolicy'
import {
  MAGNITE_DISPLAY_FORMAT_OPTIONS,
  MAGNITE_NATIVE_FORMAT_OPTIONS,
  MAGNITE_VIDEO_FORMAT_OPTIONS,
} from '../lib/magniteAdFormats'

export interface DspEntry {
  id: string;
  dsp: string;
  seatId: string;
}

/** A single geo-targeting entry. `type` selects the granularity and `value`
 *  holds it: country → ISO-2 code (e.g. "US"); state → name or abbrev
 *  (e.g. "California"); zip → postal code(s); dma → Nielsen DMA number(s).
 *  The geo types offered per deal are gated by the deal's SSP (SSP_GEO_TYPES),
 *  since each SSP accepts a different granularity. */
export type GeoType = 'country' | 'state' | 'zip' | 'dma';

export interface GeoEntry {
  id: string;
  type: GeoType;
  value: string;
}

/** Geo granularities each SSP's deal-creation API actually accepts. The deal
 *  card only offers these types so a trader can't pick a no-op. Index uses one
 *  `dma_codes` field for both ZIPs and DMA numbers; OpenX zip/DMA needs the
 *  structured geographic dict (a Cutlass follow-up) so it stays country/state. */
export const SSP_GEO_TYPES: Record<string, GeoType[]> = {
  'Index Exchange': ['country', 'zip', 'dma'],
  'OpenX': ['country', 'state'],
  'PubMatic': ['country', 'state'],
  'Xandr': ['country', 'state'],
  'Media.net': ['country'],
  'TripleLift': ['country'],
  'Magnite': ['country', 'state'],
};

/** Allowed geo types for an SSP (defaults to country+state when unknown/blank). */
export function sspGeoTypes(ssp: string): GeoType[] {
  return SSP_GEO_TYPES[ssp] || ['country', 'state'];
}

export const GEO_TYPE_LABEL: Record<GeoType, string> = {
  country: 'Country',
  state: 'State / Region',
  zip: 'Zip / Postal',
  dma: 'DMA',
};

export interface BuyerEntry {
  id: string;
  buyerId: string;
  /** Retired: the first buyer in the list is the main one (the prompt emits
   *  buyer_ids in order). Kept optional so persisted forms still parse. */
  isMain?: boolean;
}

/** One publisher on an allowlist. `id` is the SSP-numeric publisher id
 *  (digits, kept as a string); `name` the display name. At least one is set.
 *  Prompts prefer the exact id and fall back to the name where the SSP MCP
 *  resolves names; every entry is verified fail-closed at booking. */
export interface PublisherAllowlistEntry {
  id?: string;
  name?: string;
}

export interface IXConfig {
  accountId: string;
  auctionType: 'First Price' | 'Fixed Price';
  /** "Max publishers" toggle — true/undefined (default): no publisher
   *  scoping (all eligible publishers).
   *  false: publisherEntries is required and ships on the wire. */
  allPublishers?: boolean;
  /** "Specific publishers only" allowlist (allPublishers off) — emitted as
   *  IX `publisher_ids` (legacyAccountIDs) / `publisher_names`. Overrides a
   *  a saved form's publisher ids. */
  publisherEntries?: PublisherAllowlistEntry[];
  // NOTE: the old viewabilityThreshold field was removed 2026-07 — it was an
  // account-level IX setting that never fed the generated prompts (resolve()
  // reads the per-deal viewabilityTarget instead). Saved forms that still
  // carry it hydrate cleanly; the extra key is ignored.
}

export interface OpenXConfig {
  packageName: string;
  autoPackageName: boolean;
  renderingContext: string;
  /** OpenX MCP arg `domain_targeting_option` — advanced match-style hint:
   *  "SUBDOMAIN" or "ROOT". Blank = MCP default. Distinct from
   *  `domain_match_operator` which is derived per-file from inclusionType. */
  domainTargetingOption: string;
  currency: string;
  dealPrice: string;
  buyers: BuyerEntry[];
  feePartner: string;
  revenueMethod: string;
  grossShare: string;
  /** OpenX MCP enum: "3"=PREFERRED_DEAL (default), "1"=PROGRAMMATIC_GUARANTEED.
   *  "2"=PRIVATE_AUCTION is NOT creatable via the OpenX API (cutlass#766:
   *  dealCreate requires open_auction_access, absent from the create schema) —
   *  it is not offered in the UI, fails the ox_pmp_type audit rule, and the
   *  prompt builder emits a # BLOCKED marker instead of the field. */
  pmpDealType: string;
  /** Publisher account IDs to EXCLUDE from this deal. Maps to OpenX MCP
   *  `excluded_publisher_ids` (added cutlass PR #490) — emitted as
   *  `targeting.content.account` with op="NOT INTERSECTS". Cannot be combined
   *  with publisher_ids (inclusion) on the same deal — OpenX schema constraint. */
  excludedPublisherIds: string[];
  /** "Max publishers" toggle — true/undefined (default): no publisher
   *  scoping. false: publisherEntries is required and ships on the wire. */
  allPublishers?: boolean;
  /** "Specific publishers only" allowlist (allPublishers off) — emitted as
   *  OpenX `publisher_ids` (INTERSECTS on targeting.content.account). The OX
   *  wire takes account IDS only (no server-side name resolution), so every
   *  entry must carry an id — the ox_publisher_ids audit rule fails
   *  name-only entries. Mutually exclusive with excludedPublisherIds (OpenX
   *  schema constraint). */
  publisherEntries?: PublisherAllowlistEntry[];
  /** Inventory category names / codes (e.g. "TV by OpenX - CTV - App Bundles",
   *  "premiumctv"). Maps to OpenX MCP `inventory_categories` (cutlass PR #491)
   *  which resolves to `targeting.metacategory.includes`. Required for CTV
   *  curated deals on App-Bundle inventory. */
  inventoryCategories: string[];
}

export interface PubMaticConfig {
  maxReach: boolean;
  /** Legacy one-per-row publisher names (pre-allowlist saves and parsed
   *  briefs). Read through effectivePubMaticPublisherEntries — the allowlist
   *  component migrates these into publisherEntries on first edit. */
  publisherNames: string[];
  /** "Specific publishers only" allowlist (Max Reach off) — id-bearing
   *  entries emit `publisher_ids`, name-only entries `publisher_names`. */
  publisherEntries?: PublisherAllowlistEntry[];
  maxAllowedPublishers: string;
  publisherBlockList: string[];
  adFormats: string[];
  platforms: string[];
}

/** The PubMatic publisher scope a deal actually ships (Max Reach off):
 *  publisherEntries when any are set, else legacy publisherNames lifted into
 *  entry shape. Single read path shared by the panel, the prompt builder, and
 *  the TS side of validation — mirrored in Go (rules.go). */
export function effectivePubMaticPublisherEntries(cfg: PubMaticConfig): PublisherAllowlistEntry[] {
  const entries = (cfg.publisherEntries || []).filter(e => (e.id || '').trim() !== '' || (e.name || '').trim() !== '');
  if (entries.length > 0) return entries;
  return cfg.publisherNames.map(n => n.trim()).filter(Boolean).map(name => ({ name }));
}

export interface MediaNetConfig {
  adFormat: string;
  environments: string[];
  marginType: string;
  marginValue: string;
}

export interface XandrConfig {
  dealCode: string;
  dealType: string;
  paymentType: string;
  /** REQUIRED by Xandr Curate workflow — IO name from reference/xandr_insertion_orders.json (the operator's IO catalog). */
  insertionOrder: string;
  /** "vcpm" (Standard / Dynamic CPM, default) or "cpm" (Fixed Price). */
  revenueType: string;
  /** Comma-separated deal-list (inventory Allow List) names. */
  dealListNames: string;
}

/** ClearLine deal price types — the options Magnite's own UI offers. The Sun
 *  Bum deals were created as "CPM" when they should have been Market Rate, so
 *  the default is "Market Rate with Minimum" (market-rate pricing with the
 *  0.10 publisher-tab minimum). */
export const MAGNITE_PRICE_TYPES = ['Market Rate', 'Market Rate with Minimum', 'CPM'] as const;
export type MagnitePriceType = typeof MAGNITE_PRICE_TYPES[number];

/** True when the price type carries a floor value (the ClearLine minimum /
 *  fixed CPM). "Market Rate" alone has no floor. */
export function magnitePriceTypeHasFloor(pt: string): boolean {
  return pt === 'Market Rate with Minimum' || pt === 'CPM';
}

export interface MagniteConfig {
  /** ClearLine marketplace name or numeric ID. REQUIRED — every Magnite deal
   *  is created inside a marketplace (immutable after creation). The Cutlass
   *  MCP resolves names via magnite_list_marketplaces. Populated from a
   *  marketplace field
   *  with a free-text fallback for marketplaces not yet in the preset. */
  marketplace: string;
  /** ClearLine price type (see MAGNITE_PRICE_TYPES). Blank = the
   *  "Market Rate with Minimum" default. A price type on
   *  its Magnite account (e.g. a "Market Rate" account) overrides this. */
  priceType: MagnitePriceType | '';
  /** Publisher-tab CPM floor — the ClearLine minimum under "Market Rate with
   *  Minimum", or the fixed CPM under "CPM". This is NOT the deal CPM — the
   *  buyer's price is negotiated at the DSP and the curator's margin rides on
   *  rev_share. Shipping the deal CPM here (e.g. $15, as a CPM price type)
   *  priced publishers out of the Sun Bum deals (2026-07). Blank falls back
   *  to the 0.10 minimum. Ignored under plain "Market Rate". */
  floorCpm: string;
  /** "All eligible publishers" toggle — the Magnite counterpart of PubMatic's
   *  Max Reach (owner-approved walk-back of the never-collect policy,
   *  2026-08-21). true/undefined (the default, incl. every pre-toggle draft):
   *  Deal Onboarding emits the explicit publishers: "ALL" opt-in, expanded
   *  server-side to every eligible marketplace publisher — byte-identical to
   *  the pre-toggle wire. false: publisherEntries is required and ships as an
   *  explicit list (never mixed with "ALL" — the MCP blocks that). */
  allPublishers?: boolean;
  /** "Specific publishers only" allowlist (allPublishers off). Ids ship as
   *  ints, name-only entries as strings — the Magnite MCP resolves both
   *  against the live marketplace catalog fail-closed. */
  publisherEntries?: PublisherAllowlistEntry[];
  // NOTE: ad-format ids are NOT here either — they're per-deal
  // (DealEntry.magniteSizes), because a single batch commonly mixes
  // display/video/native Magnite deals and each format type must be selected
  // per deal (the MCP forbids mixing types in one deal).
}

/** Magnite DV+ ad-format catalogs — the FULL live ClearLine catalog per
 *  family, sourced from the committed fixture in lib/magniteAdFormats
 *  (read-only pull via magnite_list_ad_formats, 2026-08-21). `id` is the
 *  Magnite ad-format id passed as `sizes:` to the MCP; the picker offers
 *  exactly this catalog, so an id the create API would 422 is impossible to
 *  select. One format family per deal, max 15 sizes (MAGNITE_SIZES_MAX);
 *  audio uses `feedTypes`, never sizes. Previously MAGNITE_DISPLAY_SIZES was
 *  a curated 13-size subset — 465 of the 478 live display sizes could not be
 *  booked through the form. */
export const MAGNITE_DISPLAY_SIZES: { id: number; label: string }[] = MAGNITE_DISPLAY_FORMAT_OPTIONS;

/** The "most popular" quick-select set — the display sizes traders book most,
 *  curated 2026-06-26 (the picker's former full list). A one-click button on
 *  a display deal fills its formats with these; every id is pinned to exist
 *  in the live catalog by magniteAdFormats.test.ts. */
export const MAGNITE_POPULAR_SIZE_IDS: number[] = [1, 2, 8, 9, 10, 15, 16, 19, 43, 44, 55, 57, 67, 100, 117];

/** Magnite DV+ VIDEO (OLV/OTT) ad-format ids — full live catalog. */
export const MAGNITE_VIDEO_FORMATS: { id: number; label: string }[] = MAGNITE_VIDEO_FORMAT_OPTIONS;

/** Magnite DV+ NATIVE ad-format ids — full live catalog. */
export const MAGNITE_NATIVE_FORMATS: { id: number; label: string }[] = MAGNITE_NATIVE_FORMAT_OPTIONS;

/** Which DV+ ad-format family a Magnite deal needs, derived from its channel.
 *  CTV and OTT route to SpringServe (Streaming), which takes no `sizes` — both
 *  return null. Audio uses feedTypes, a separate mechanism we don't yet
 *  surface (also null). Keep aligned with SSP_CHANNEL_HINT.magnite in
 *  dealPromptYaml.ts. */
export type MagniteFormatKind = 'display' | 'video' | 'native';

export function magniteFormatKind(channel: string): MagniteFormatKind | null {
  if (channel === 'Display') return 'display';
  if (channel === 'Native') return 'native';
  if (channel === 'OLV (Online Video)') return 'video';
  return null; // CTV/OTT → SpringServe; Audio → feedTypes; unset → n/a
}

export const MAGNITE_FORMATS_BY_KIND: Record<MagniteFormatKind, { id: number; label: string }[]> = {
  display: MAGNITE_DISPLAY_SIZES,
  video: MAGNITE_VIDEO_FORMATS,
  native: MAGNITE_NATIVE_FORMATS,
};

/** A Magnite deal requires an explicit `sizes` (ad-format) selection at create
 *  time iff its channel maps to a DV+ format family (display/video/native). */
export function magniteDealNeedsFormats(channel: string): boolean {
  return magniteFormatKind(channel) !== null;
}

export interface TripleLiftConfig {
  /** TripleLift MCP enum: "CEILING" | "FIXED" | "FLOOR". */
  dealPriceType: string;
  /** TripleLift MCP enum: "WEB" | "CTV". */
  channel: string;
  /** Uppercase enum values from SUPPORTED_COMMERCIALIZED_FORMATS (e.g. "DISPLAY", "OUTSTREAM"). */
  commercializedFormats: string[];
  /** Regulatory Policy → Controlled → "Include Political Ads Allowed". When true,
   *  the prompt emits the TripleLift MCP convenience key `allow_political_ads: true`
   *  (cutlass), which folds the UI_EXPR_REGULATORY_POLICY_CONTROLLED node into
   *  targetingExpression. Applies to every TripleLift deal in the batch. */
  allowPoliticalAds: boolean;
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  path: string;
  inclusionType: 'Include' | 'Exclude' | '';
  /** Deal ids this list applies to (per-deal
   *  "Applies to" scoping). Empty/undefined = every deal the file's channel
   *  routing matches — the pre-existing behavior. A deal's own explicit
   *  domainListId/appBundleListId selection always wins over this filter. */
  appliesTo?: string[];
  /** Column headers discovered on first-row parse, used to drive the
   *  per-deal {domain,app_bundle}_column arg. Optional — undefined when
   *  the file pre-dates the auto-detect feature or detection failed. */
  headers?: string[];
  /** Heuristic-picked column name (e.g. "Domain", "Bundle ID"). The user
   *  can override this in the UI; the YAML writer prefers this over its
   *  fallback default. */
  detectedColumn?: string;
}

/** Standard allow/block list — curated, reusable file the trader toggles on
 *  for a deal instead of re-uploading. Loaded from GET /api/lists; raw data
 *  stays server-side. Kind/scope are baked in at the manifest, so audit and
 *  prompt generation translate kind → inclusionType automatically. */
export interface StandardList {
  id: string;
  name: string;
  description?: string;
  kind: 'allow' | 'block';
  scope: 'domain' | 'app_bundle';
  /** Non-blank line count, computed server-side at load time. */
  line_count: number;
  /** SHA-256 of the list's data file and its last-modified time, both cached
   *  server-side at load. Give the picker a version/staleness signal — a list
   *  edited in place shows a fresh date and a changed hash. Optional so older
   *  API responses (pre-versioning) still parse. */
  sha256?: string;
  updated_at?: string;
  /** Extension of the list's data file including the dot (".csv"), from the
   *  /api/lists Summary. standardListUploadName appends it to an extensionless
   *  list name so the prompt references the EXACT name the server uploads to
   *  the runner (lists.List.UploadName, #198). Optional so older API responses still
   *  parse — absent means the name is emitted as-is (legacy behavior). */
  file_ext?: string;
  /** On-disk basename of the list's data file, from the Summary — the fallback
   *  standardListUploadName uses for a blank list name, mirroring Go's
   *  UploadName filepath.Base(Path) branch byte-for-byte (#198 FIX 7). */
  file_base?: string;
}

export const CHANNEL_OPTIONS = ['Display', 'OLV (Online Video)', 'CTV', 'OTT', 'Native', 'Audio'] as const;
export type Channel = typeof CHANNEL_OPTIONS[number];

/** What each SSP actually demands at deal-create time. Drives the form
 *  rendering and the audit. Keep this aligned with each MCP's input contract. */
export interface SspRequirements {
  needsFloor: boolean;       // Per-deal CPM floor required (or shared default)
  requiresSegments: boolean; // Segments mandatory at create time (no add-later)
  hasSharedFloor: boolean;   // SSP config can supply the floor (e.g. OpenX dealPrice)
  /** How the SSP handles end_date. 'open-ended' means the Cutlass MCP +
   *  the SSP API both accept missing end_date and treat the deal as
   *  always-on; Deal Onboarding will omit end_date entirely for these. Everyone
   *  else gets start_date + END_DATE_HORIZON_YEARS as the cap.
   *  Audited 2026-05-21: Xandr confirmed (docstring + protocol). OpenX +
   *  Media.net MCPs cleanly forward omission but the SSP API behavior is
   *  unverified — flip to 'open-ended' after UI smoke tests. IX, PubMatic,
   *  TripleLift require Cutlass MCP changes before they can move. */
  endDateSupport: 'open-ended' | 'required-2y-default';
  notes?: string;
}

// `notes` renders in the deal card's SSP banner — keep it to one short,
// generic, trader-facing line (no internals).
export const SSP_REQUIREMENTS: Record<string, SspRequirements> = {
  'Index Exchange': { needsFloor: true,  requiresSegments: false, hasSharedFloor: false, endDateSupport: 'required-2y-default', notes: 'Per-deal floor CPM; segments optional.' },
  'OpenX':          { needsFloor: true,  requiresSegments: false, hasSharedFloor: true,  endDateSupport: 'required-2y-default', notes: 'Floor comes from this deal or the OpenX deal price. Requires a site or app-bundle list.' },
  // PubMatic (2026-08-19, PM-ZOOR-0075): deals are always First Price — a
  // deal-level floor forces Fixed Price and the deal transacts AT that CPM,
  // so no floor ships and the deal card collects no CPM.
  'PubMatic':       { needsFloor: false, requiresSegments: false, hasSharedFloor: false, endDateSupport: 'required-2y-default', notes: 'Always First Price (dynamic) — no deal-level floor; publisher minimums apply.' },
  'Xandr':          { needsFloor: true,  requiresSegments: false, hasSharedFloor: false, endDateSupport: 'open-ended',          notes: 'Per-deal floor CPM required. Deals run always-on (no end date).' },
  'TripleLift':     { needsFloor: true,  requiresSegments: false, hasSharedFloor: false, endDateSupport: 'required-2y-default', notes: 'Per-deal price required.' },
  'Media.net':      { needsFloor: true,  requiresSegments: false, hasSharedFloor: false, endDateSupport: 'required-2y-default', notes: 'Per-deal floor CPM required.' },
  'Magnite':        { needsFloor: false, requiresSegments: false, hasSharedFloor: false, endDateSupport: 'required-2y-default', notes: 'Pricing and marketplace come from the Magnite panel. Pick ad formats below for display, video, and native deals.' },
};

export function sspReq(ssp: string): SspRequirements {
  return SSP_REQUIREMENTS[ssp] || { needsFloor: false, requiresSegments: false, hasSharedFloor: false, endDateSupport: 'required-2y-default' };
}

/** Per-SSP deal-name length ceilings, mirrored from the backend audit's
 *  deal_name_length rule (internal/validation/rules.go) — EVERY SSP is
 *  capped; see the rule's comment for each ceiling's provenance
 *  (IX/Xandr 255 API-verified; Media.net 255 MCP-enforced; PubMatic 250 UI;
 *  TripleLift 150 UI hard-stop; Magnite Streaming 250 / DV+ 200 UI
 *  validation, split on the same CTV/Audio line as mg_sizes; OpenX 255
 *  Deal Onboarding policy — no published limit). Used for the LIVE as-you-type
 *  check on the Deal name field; the backend audit stays authoritative (it
 *  validates every expanded per-DSP name, not just the one on screen). */
export function sspDealNameMax(ssp: string, channel: string): { max: number; limitText: string } {
  const s = ssp.trim().toLowerCase();
  if (s === 'index exchange' || s === 'xandr' || s === 'media.net') {
    return { max: 255, limitText: `${ssp} rejects names longer than 255` };
  }
  if (s === 'pubmatic') return { max: 250, limitText: 'PubMatic rejects names longer than 250' };
  if (s === 'triplelift') return { max: 150, limitText: 'the TripleLift UI hard-caps deal names at 150 characters' };
  if (s === 'magnite') {
    return channel === 'CTV' || channel === 'Audio'
      ? { max: 250, limitText: 'Magnite Streaming rejects names longer than 250' }
      : { max: 200, limitText: 'Magnite DV+ rejects names longer than 200' };
  }
  return { max: 255, limitText: `deal names are capped at 255 characters (app policy; ${ssp} publishes no limit)` };
}

/** Live deal-name length finding for one deal card, or undefined when within
 *  the SSP's ceiling. Same voice as the backend rule. */
export function dealNameLengthError(ssp: string, channel: string, finalName: string, hasOverride: boolean): string | undefined {
  if (!ssp.trim()) return undefined;
  const { max, limitText } = sspDealNameMax(ssp, channel);
  if (finalName.length <= max) return undefined;
  const lever = hasOverride ? 'the name override' : 'the theme/agency/brand (or use a name override)';
  return `Deal name is ${finalName.length} characters — ${limitText}. Shorten ${lever}.`;
}

export const SSP_OPTIONS = ['Index Exchange', 'OpenX', 'PubMatic', 'Media.net', 'Xandr', 'TripleLift', 'Magnite'] as const;
export type Ssp = typeof SSP_OPTIONS[number];

export const INVENTORY_OPTIONS = ['Web Only', 'In-App', 'All'] as const;
export type InventoryType = typeof INVENTORY_OPTIONS[number];

/** Mirrors Go isVideoChannel (internal/validation/rules.go) EXACTLY — both
 *  accept the short 'OLV' label (the deal-name slot form, and the CANONICAL
 *  channel enum value in cutlass deal-brief.schema.yaml) alongside the form
 *  label 'OLV (Online Video)'. Keep the two in lockstep: when they diverged,
 *  a short-form 'OLV' deal passed the Go QA gate while every TS emission gate
 *  silently dropped its ad-duration targeting. */
export function isVideoChannel(ch: string): boolean {
  return ch === 'OLV (Online Video)' || ch === 'OLV' || ch === 'CTV' || ch === 'OTT' || ch === 'Audio';
}

/** True when the channel can carry ad-duration targeting (the brief-schema
 *  `ad_duration` field in cutlass deal-brief.schema.yaml v1.1): CTV / OLV /
 *  OTT only — both OLV label forms count (see isVideoChannel), mirroring Go
 *  supportsAdDuration. Deliberately NOT isVideoChannel — Audio is a video
 *  channel for KPI purposes (VCR) but has no ad-duration targeting; a
 *  duration on Display/Audio/Native is a brief validation error. */
export function dealSupportsAdDuration(ch: string): boolean {
  return isVideoChannel(ch) && ch !== 'Audio';
}

/** One deal = one Cutlass create call. Each card in the UI maps to one entry. */
export interface DealEntry {
  id: string;
  /** Deal name override — if blank, the matrix generates one from the slot fields below. */
  nameOverride: string;
  /** Sheet-only: this deal was already created in a prior run and is listed on
   *  the deal sheet for completeness ONLY. It MUST NOT generate a create/tool
   *  call (e.g. live OpenX rows in a follow-up batch). Undefined/false = a
   *  normal create row. */
  sheetOnly?: boolean;
  /** Deal-name slot 7 — the primary audience/theme (e.g. "Warm weather", "Cold and Flu"). */
  theme: string;
  channel: Channel | '';
  ssp: Ssp | '';
  inventoryType: InventoryType | '';
  geoInclude: GeoEntry[];
  geoExclude: GeoEntry[];
  language: string;
  includeSegments: string[];
  excludeSegments: string[];
  /** Trader-only, per-deal/SSP acknowledgement for intentionally stripping
   * unsupported audience/geo exclusions. The server validates the exact
   * phrase, derives actor/time itself, and never honors this for a client's
   * contractual always-excludes. Changing SSP invalidates the envelope. */
  exclusionOverride?: {
    ssp: string;
    acknowledgement: string;
  };
  /** Per-deal CPM target. Blank = falls back to shared default. */
  cpm: string;
  /** Per-deal VCR target (video channels only). Blank = falls back to shared default. */
  vcr: string;
  viewabilityTarget: string;
  /** Client-supplied external reference ID. On Index Exchange this maps to the
   *  IX `external_deal_id` arg AND the `externalReferenceID` reporting label.
   *  Blank for clients that don't use this. */
  externalReferenceId: string;
  /** Magnite only — DV+ ad-format ids (as strings) for THIS deal, picked from
   *  the family that matches the deal's channel (display / video / native; see
   *  magniteFormatKind). Per-deal because one batch commonly mixes formats and
   *  the MCP forbids mixing format types in a single deal. Emitted as `sizes:`.
   *  Undefined/empty = not yet selected. CTV (SpringServe) and Audio don't use it. */
  magniteSizes?: string[];
  /** Allowed creative lengths for ad-duration targeting, integer SECONDS
   *  (e.g. ['15', '30'] = "only 15s and 30s ads"). Maps to the brief-schema
   *  `ad_duration.allowed_durations` (cutlass deal-brief.schema.yaml v1.1).
   *  Alternative to maxAdDurationSecs — provide the allowed list OR the max
   *  cap, not both. Only meaningful when dealSupportsAdDuration(channel)
   *  (CTV/OLV/OTT). Undefined/empty = no duration targeting. */
  adDurations?: string[];
  /** Maximum ad duration cap, integer SECONDS (e.g. '30' = "cap ad length at
   *  30 seconds") — the brief-schema `ad_duration.max_seconds`. Alternative
   *  to adDurations (allowed-list vs max are the two ways a client expresses
   *  the requirement). Undefined/blank = unset. */
  maxAdDurationSecs?: string;
  /** Per-deal site/domain list override, by id (an uploaded UploadedFile.id or
   *  a StandardList.id). Three states:
   *    - undefined → campaign default (the form-level domain lists apply)
   *    - ''        → explicitly NO domain list on this deal
   *    - '<id>'    → use exactly this list for this deal
   *  Lets one batch mix audience deals (no list) and contextual deals (a site
   *  list) without splitting into separate batches. */
  domainListId?: string;
  /** Per-deal app-bundle list override, by id. Same three-state semantics as
   *  domainListId. */
  appBundleListId?: string;
  /** Per-deal allow/block override for the chosen site/app-bundle list. Lets the
   *  Allow/Block toggle work even on a curated/standard list (whose kind is
   *  otherwise server-baked) without mutating the shared list. Undefined →
   *  use the list's intrinsic inclusion (uploaded file's inclusionType or the
   *  standard list's kind). */
  domainListInclusion?: 'Include' | 'Exclude';
  appBundleListInclusion?: 'Include' | 'Exclude';
  /** Per-deal IAB categories (canonical IAB_OPTIONS names or SSP-catalog
   *  labels from lib/sspIabCatalogs.ts). Three states: undefined → governed
   *  by autoInferIab (toggle ON → inferred per deal from theme/segments/
   *  brand; toggle OFF → NOTHING ships); [] → explicitly none; non-empty →
   *  the trader's own picks. Inference is deterministic, so the deal card
   *  and the generated prompt always agree. */
  iabCategories?: string[];
  /** OPT-IN switch for keyword inference on THIS deal. Absent/undefined = OFF
   *  (the default): a deal without explicit iabCategories ships NO categories
   *  — no iab lines in any prompt, nothing on the deal-sheet email. true =
   *  inferIabCategories runs and its output ships (previewed on the card as
   *  "inferred — review before submit"). Explicit iabCategories always win
   *  over the toggle. NEVER set by templates — inference is
   *  a per-deal trader choice. Mirrors AutoInferIab in rules.go. */
  autoInferIab?: boolean;
  /** Per-deal IAB category / content-genre EXCLUSIONS. EXPLICIT ONLY:
   *  undefined/[] = none — there is NO inference (inference only ever ADDS
   *  include categories) and NO campaign-level counterpart. Values are human
   *  names: the 26 canonical IAB_OPTIONS names OR SSP-native genre names
   *  entered free-text (e.g. IX "Content > Genres" names like "Hard News").
   *  Per-SSP API support: Index Exchange (`excluded_iab_categories` →
   *  contentgenre NONE_OF) and PubMatic (`exclude_iab_categories`) apply at
   *  create time; OpenX and Media.net only via post-create update tools;
   *  Magnite/Xandr/TripleLift have no IAB/genre exclude API at all. For those
   *  five the prompt surfaces the exclusions as explicit trader-UI follow-ups
   *  (per-deal comment + Required-final-summary line) — never silently
   *  dropped. See effectiveIabExcludes (lib/inferIab.ts). */
  iabCategoriesExclude?: string[];
  /** Optional free-text hint surfaced in the batch prompt to guide the
   *  agent's IAB category lookup (e.g. "Trader wants: local news"). The
   *  agent resolves to `iab_categories` via ox_list_iab_categories. */
  iabHint?: string;
  /** Optional free-text notes that propagate into the batch prompt and the
   *  Required final summary. Use for wire-shape assertions or anything
   *  per-deal that doesn't fit a structured field. */
  notes?: string[];
  /** Optional post-create UI fixes the trader still needs to apply. Each
   *  entry renders as a reminder line in the batch prompt's final summary
   *  contract. Auto-suppressed when the underlying MCP arg is now populated
   *  (inventory categories, excluded publishers). The OpenX Expected
   *  Sensitive Category reminder is the reverse: the prompt builder INJECTS
   *  it on every OpenX deal when form.expectedAdCategory is set, because the
   *  partner API cannot set that field. */
  postCreateUiFix?: string[];
}

/** Campaign-level reporting labels — KV pairs that some SSPs (notably IX and
 *  OpenX) attach to each deal. The Weather Company expects every deal to
 *  carry advertiser/agency/salesperson/externalReferenceID/custom. */
export interface ReportingLabels {
  salesperson: string;
  /** Free-form custom label, e.g. "submitter:<email>". */
  custom: string;
}

export interface FormData {
  // Submitter + dates
  submitterName: string;
  submitterEmail: string;
  requestedDueDate: string;
  flightStartDate: string;
  flightEndDate: string;

  // Client / campaign
  agency: string;
  brand: string;
  campaignName: string;
  campaignId: string;
  dataPartner: string;
  funnel: string;
  attributionCode: string;

  // DSPs (shared across all deals)
  dsps: DspEntry[];
  multipleDsps: boolean;

  // Shared defaults used when a deal doesn't override
  defaultInventoryType: InventoryType | '';
  defaultGeoInclude: GeoEntry[];
  defaultGeoExclude: GeoEntry[];
  defaultLanguage: string;
  defaultDisplayCpm: string;
  defaultVideoCpm: string;
  defaultVcr: string;
  // NOTE: there is deliberately NO campaign-level viewability default.
  // Viewability is per-deal only (deal.viewabilityTarget) and applied only
  // when explicitly specified — a hidden defaultViewabilityTarget once leaked
  // a template's 70% into every deal of a batch.

  // SSP-specific configuration — each config is shared across every deal that uses that SSP.
  ixConfig: IXConfig;
  openxConfig: OpenXConfig;
  pubmaticConfig: PubMaticConfig;
  medianetConfig: MediaNetConfig;
  xandrConfig: XandrConfig;
  tripleliftConfig: TripleLiftConfig;
  magniteConfig: MagniteConfig;

  // Shared campaign metadata
  // RETIRED as a shipping input: no editor and no prompt/audit consumer reads
  // it — a persisted legacy value folds onto the per-deal iabCategories at
  // every form entry point (migrateCampaignIabCategories) and the Go audit
  // fails closed on a non-empty value (iab_campaign_retired).
  iabCategories: string[];
  dailyPacingGoal: string;
  kpiGoal: string;
  /** OpenX "Expected Sensitive Category" (e.g. "Politics"). Required by
   *  OpenX policy for political and other sensitive deals — but a MANUAL
   *  post-create UI step: the OpenX partner API does not expose the field
   *  (verified 2026-08-17 — dealCreate rejects `expected_ad_category` as
   *  undefined and dealById never returns it; cutlass PR #489's arg never
   *  worked live). A set value renders a post_create_ui_fix reminder on
   *  every OpenX deal, a summary-email reminder, and a QA-checklist item.
   *  Blank = no reminders. */
  expectedAdCategory: string;

  // Shared pricing
  curatedDealFee: string;
  feeType: string;

  // Files — shared. Auto-routed to deals based on channel (see fileRouting.ts).
  domainLists: UploadedFile[];
  appBundleLists: UploadedFile[];
  // Standard-list ids toggled on for this deal. Audit/prompt resolves them
  // server-side via /api/lists; UI never holds the raw file contents.
  appliedDomainListIds: string[];
  appliedAppBundleListIds: string[];

  // THE deals list
  deals: DealEntry[];

  // Email the deal-sheet XLSX will be sent to at the end of the runner batch.
  // ALWAYS defaults to the logged-in trader's session email, NEVER to
  // submitterEmail — submitterEmail can be a client address when the form
  // was populated from a client brief, and emailing a deal sheet
  // straight to the client is a serious mistake (see incident 2026-05-21).
  // Trader can override this field to forward to a teammate.
  dealSheetRecipient: string;

  // Deal-sheet theme override. "" = the runner's default theme; a trader pick
  // pins one for the batch. Values come from KNOWN_DEAL_SHEET_THEMES
  // (lib/dealPromptYaml).
  dealSheetTheme: string;

  // Campaign-level reporting labels — ride onto SSPs with a labels wire.
  reportingLabels: ReportingLabels;
}

/** Fold legacy campaign-default geos down onto the deals and clear them.
 *
 *  The Campaign Defaults section (the only editor for defaultGeoInclude/
 *  defaultGeoExclude) was retired in the 2026-07 restructure, but resolve()
 *  and the deal-name geo slot still fall back to these fields — a persisted
 *  draft or template carrying hidden default geos would silently target them
 *  while the deal card claims "blank = Global". Distributing the defaults
 *  onto every geo-less deal makes the targeting visible and editable on the
 *  cards. Run on every form entry point (storage hydration, templates, the
 *  parser merge). */
export function migrateCampaignGeoDefaults(form: FormData): FormData {
  if (form.defaultGeoInclude.length === 0 && form.defaultGeoExclude.length === 0) return form;
  const clone = (gs: GeoEntry[]): GeoEntry[] =>
    gs.map(g => ({ ...g, id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }));
  return {
    ...form,
    deals: form.deals.map(d => {
      const needsInclude = d.geoInclude.length === 0 && form.defaultGeoInclude.length > 0;
      const needsExclude = d.geoExclude.length === 0 && form.defaultGeoExclude.length > 0;
      if (!needsInclude && !needsExclude) return d;
      return {
        ...d,
        geoInclude: needsInclude ? clone(form.defaultGeoInclude) : d.geoInclude,
        geoExclude: needsExclude ? clone(form.defaultGeoExclude) : d.geoExclude,
      };
    }),
    defaultGeoInclude: [],
    defaultGeoExclude: [],
  };
}

/** Fold a legacy campaign-wide IAB selection down onto the deals and clear it.
 *
 *  The campaign-level iabCategories editor was retired in the 2026-07
 *  restructure, but effectiveIabCategories used to fall back to the field —
 *  a persisted draft or template carrying the hidden list silently shipped it
 *  on every deal without explicit picks (a 2026-07 automotive-category
 *  incident). Distributing the list onto every auto deal (iabCategories ===
 *  undefined) makes it visible and editable on the cards; explicit picks AND
 *  explicit [] are untouched. Run on every form entry point (storage
 *  hydration, templates, the parser merge), chained with
 *  migrateCampaignGeoDefaults.
 *
 *  With NO deals there is nothing to fold onto, so the legacy value is kept
 *  in place rather than cleared — clearing would silently drop the list
 *  (deals added afterwards would run keyword inference instead of the
 *  draft's/brief's stated categories) AND blind the fail-closed Go backstop
 *  (iab_campaign_retired), which only fires on a non-empty value. A later
 *  entry-point run folds it once deals exist, and the audit fails closed
 *  until then. */
export function migrateCampaignIabCategories(form: FormData): FormData {
  if (form.iabCategories.length === 0 || form.deals.length === 0) return form;
  return {
    ...form,
    deals: form.deals.map(d =>
      d.iabCategories === undefined ? { ...d, iabCategories: [...form.iabCategories] } : d
    ),
    iabCategories: [],
  };
}

/** Fold a legacy campaign-default language down onto the deals and clear it.
 *
 *  The Campaign Defaults section (the only editor for defaultLanguage) was
 *  retired in the 2026-07 restructure, but resolve() still falls back to the
 *  field — a persisted draft or template carrying a hidden default language
 *  ships it on every deal while each card's Language select shows "— None —"
 *  (the 2026-07-15 "audit says Spanish, cards say none" report: the
 *  SignalForge template seeds defaultLanguage 'Spanish'). Distributing it
 *  onto every language-less deal makes it visible and editable on the cards.
 *  Mirrors migrateCampaignGeoDefaults: run on every form entry point
 *  (storage hydration, templates, the parser merge). With NO deals the value
 *  is kept in place — a later entry-point run folds it once deals exist
 *  (same reasoning as migrateCampaignIabCategories). */
export function migrateCampaignLanguage(form: FormData): FormData {
  if (form.defaultLanguage.trim() === '' || form.deals.length === 0) return form;
  return {
    ...form,
    deals: form.deals.map(d =>
      d.language.trim() === '' ? { ...d, language: form.defaultLanguage } : d
    ),
    defaultLanguage: '',
  };
}

export function newDeal(defaultGeoCountry?: string | null): DealEntry {
  return {
    id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    nameOverride: '',
    theme: '',
    channel: '',
    ssp: '',
    inventoryType: '',
    // Geo policy (lib/geoPolicy.ts): every new deal starts targeted to the
    // house default country (US). Callers that overwrite geo (the parser)
    // re-apply the policy through withDefaultGeo at their overwrite point.
    geoInclude: defaultGeoInclude(defaultGeoCountry),
    geoExclude: [],
    language: '',
    includeSegments: [],
    excludeSegments: [],
    cpm: '',
    vcr: '',
    viewabilityTarget: '',
    externalReferenceId: '',
  };
}

export const DEFAULT_FORM: FormData = {
  submitterName: '',
  submitterEmail: '',
  requestedDueDate: '',
  flightStartDate: '',
  flightEndDate: '',
  agency: '',
  brand: '',
  campaignName: '',
  campaignId: '',
  dataPartner: '',
  funnel: '',
  attributionCode: 'A1',
  dsps: [{ id: '1', dsp: '', seatId: '' }],
  multipleDsps: false,
  defaultInventoryType: 'All',
  defaultGeoInclude: [],
  defaultGeoExclude: [],
  defaultLanguage: '',
  defaultDisplayCpm: '0.10',
  defaultVideoCpm: '0.10',
  defaultVcr: '',
  ixConfig: { accountId: '', auctionType: 'First Price', allPublishers: true },
  openxConfig: {
    allPublishers: true,
    packageName: '',
    autoPackageName: true,
    renderingContext: '',
    domainTargetingOption: '',
    currency: 'USD',
    dealPrice: '',
    buyers: [{ id: '1', buyerId: '' }],
    feePartner: '',
    revenueMethod: 'PoM',
    grossShare: '',
    pmpDealType: 'PREFERRED_DEAL',
    excludedPublisherIds: [],
    inventoryCategories: [],
  },
  // PubMatic formats/platforms and the Media.net ad format default to EMPTY =
  // auto: the prompt builders derive them from each deal's channel/inventory.
  // A pre-checked value here would silently suppress that derivation (an
  // untouched CTV batch used to emit Banner/Desktop).
  pubmaticConfig: {
    // Max Reach defaults ON: traders never scope PubMatic deals to named
    // publishers — unchecking it re-enables the publisher-names inputs.
    maxReach: true,
    publisherNames: [''],
    maxAllowedPublishers: '',
    publisherBlockList: [],
    adFormats: [],
    platforms: [],
  },
  medianetConfig: { adFormat: '', environments: [], marginType: 'Percentage (1)', marginValue: '30' },
  xandrConfig: {
    dealCode: '',
    dealType: 'Curated',
    paymentType: 'CPM',
    insertionOrder: '',
    revenueType: 'vcpm',
    dealListNames: '',
  },
  tripleliftConfig: { dealPriceType: 'FLOOR', channel: '', commercializedFormats: [], allowPoliticalAds: false },
  magniteConfig: { marketplace: '', priceType: 'Market Rate', floorCpm: '0.10', allPublishers: true },
  iabCategories: [],
  dailyPacingGoal: '',
  kpiGoal: '',
  expectedAdCategory: '',
  curatedDealFee: '',
  feeType: '',
  domainLists: [],
  appBundleLists: [],
  appliedDomainListIds: [],
  appliedAppBundleListIds: [],
  deals: [],
  dealSheetRecipient: '',
  dealSheetTheme: '',
  reportingLabels: { salesperson: '', custom: '' },
};

export interface AuditCheck {
  rule: string;
  passed: boolean;
  message: string;
  dealIndex?: number;
  fieldPath?: string;
}

/** Deal QA Specialist item statuses — mirrors internal/validation/qa.go. */
export type QAItemStatus = 'pass' | 'flag' | 'warn' | 'manual' | 'na';

export interface QAItem {
  id: string;
  label: string;
  status: QAItemStatus;
  /** What was checked and what was found. */
  detail?: string;
  /** Exactly what to do about it, in QA-best-practice terms. */
  fix?: string;
  fieldPath?: string;
  dealIndex?: number;
  /** Originating audit rule for flag items derived from a failed check. */
  rule?: string;
}

export interface QASection {
  id: string;
  title: string;
  items: QAItem[];
}

export interface QAReport {
  outcome: 'approved' | 'approved_minor' | 'rework';
  summary: string;
  counts: { pass: number; flag: number; warn: number; manual: number; na: number };
  sections: QASection[];
}

export interface AuditResult {
  status: 'passed' | 'warnings' | 'failed';
  total_deals: number;
  deal_names: string[];
  checks: AuditCheck[];
  inferred: {
    iab_categories: string[];
    note: string;
    /** Per-deal inference — one entry per deal that had no explicit
     *  iabCategories, mirroring the client-side inferIabCategories table. */
    per_deal?: { deal_index: number; iab_categories: string[] }[];
  };
  /** The Deal QA Specialist report — the pre-launch QA checklist
   *  evaluated against this form. Absent on synthetic (network-error)
   *  results, in which case the flat check list renders instead. */
  qa?: QAReport;
}

export interface AuditAIInsight {
  severity: 'info' | 'warn' | 'critical';
  message: string;
  fieldHint?: string;
  dealIndex?: number;
  /** QA checklist section this insight belongs to (internal/validation/qa.go
   *  section ids). Insights with a known section render inside it; others
   *  fall back to the general AI review block. */
  qaSection?: string;
}

export interface AuditAIResult {
  insights: AuditAIInsight[];
  notes?: string;
}

/** Distinct SSPs currently in use across deals — drives which config panels to render. */
export function sspsInUse(deals: DealEntry[]): Ssp[] {
  const seen = new Set<Ssp>();
  for (const d of deals) {
    if (d.ssp) seen.add(d.ssp as Ssp);
  }
  return Array.from(seen);
}

/** Distinct channels currently in use across deals. */
export function channelsInUse(deals: DealEntry[]): Channel[] {
  const seen = new Set<Channel>();
  for (const d of deals) {
    if (d.channel) seen.add(d.channel as Channel);
  }
  return Array.from(seen);
}

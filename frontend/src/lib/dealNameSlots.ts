// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

/** Canonical deal-name slot vocabulary + generation — THE frontend source of
 *  truth for the 12-slot deal name. The spec is docs/DEAL_NAMING.md;
 *  internal/validation/rules.go mirrors these semantics byte-for-byte for the
 *  server-side audit, and the two are pinned together by the shared golden
 *  fixture internal/validation/testdata/deal_naming_golden.json.
 *
 *    {Curator}_{SSP}_{DSP}_{Agency}_{Brand}_{DataPartner}_{Segment}_{Channel}_{Inventory}_{Geo}_{CampaignID}_{Attribution}
 *
 *  Label slots (SSP, DSP, Channel, Inventory, DataPartner) come from the
 *  vocabulary tables verbatim; value slots (Curator-when-freeform, Agency,
 *  Brand, Segment, Attribution) are sanitized so a stray underscore or
 *  whitespace character can never shift slot positions. */

import { DealEntry, DspEntry, FormData, GeoEntry } from '../types/deal'
import { getOperatorConfig, campaignIdPlaceholder } from './operatorConfig'

// ---------------------------------------------------------------------------
// LOCKED sheet vocabulary (product decision — do not re-abbreviate).
// Keys are vocabKey()-normalized (lowercased, whitespace-collapsed) so lookups
// are case- and whitespace-insensitive on input.
// ---------------------------------------------------------------------------

const SSP_SLOT_CODE: Record<string, string> = {
  'index exchange': 'Index',
  'openx': 'OpenX',
  'pubmatic': 'Pubmatic',
  'magnite': 'Magnite',
  'xandr': 'Xandr',
  'media.net': 'Media.net',
  'triplelift': 'TripleLift',
}

const DSP_SLOT_CODE: Record<string, string> = {
  'the trade desk': 'TTD',
  'the trade desk - rtb': 'TTD',
  'dv360': 'DV360',
  'amazon dsp': 'Amazon',
  'adsp': 'Amazon', // common short form of Amazon DSP
  'yahoo dsp': 'Yahoo',
}

// The shared whitespace class for slot-input trimming — the UNION of Go's
// unicode.IsSpace and JS \s: JS \s lacks U+0085 (NEL, which Go strips) and
// Go lacks U+FEFF (BOM, which JS \s strips). Both languages trim the union so
// a pasted NEL/BOM can never make the two generators disagree. Mirrors
// isNameSpace/trimInput in internal/validation/rules.go.
const NAME_SPACE = /[\s\u0085\uFEFF]+/g

/** Trim leading/trailing shared-class whitespace from a slot input. */
export function trimInput(s: string): string {
  return (s || '').replace(/^[\s\u0085\uFEFF]+/, '').replace(/[\s\u0085\uFEFF]+$/, '')
}

/** Normalize a vocabulary-lookup input: trim, collapse internal whitespace
 *  (shared class, incl. NEL/BOM), lowercase — so "\uFEFFThe Trade  Desk "
 *  still resolves to TTD. */
function vocabKey(s: string): string {
  return (s || '').split(NAME_SPACE).filter(Boolean).join(' ').toLowerCase()
}

/** ASCII-only uppercase: maps [a-z] to [A-Z] and leaves every other rune for
 *  the sanitizer. Locale/Unicode-aware uppercasing diverges between languages
 *  (JS "ß".toUpperCase() → "SS"; Go keeps ß) — byte parity wins. Mirrors
 *  upperASCII in rules.go. */
function upperAscii(s: string): string {
  return (s || '').replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 32))
}

/** Sanitize a VALUE slot: keep [A-Za-z0-9 .-] — spaces are PRESERVED inside
 *  slots (owner call 2026-08-11, matching the naming workbook and historical
 *  booked names: "SNAP proxy users" stays spaced). All Unicode
 *  whitespace (NBSP, tabs, NEL, BOM, …) normalizes to a single ASCII space;
 *  underscores (which would corrupt slot positions) and punctuation are
 *  dropped; runs of spaces collapse and the ends are trimmed. Mirrors
 *  sanitizeSlotValue in internal/validation/rules.go byte-for-byte. */
export function sanitizeSlotValue(s: string): string {
  return (s || '')
    .replace(/[\s\u0085\uFEFF]/g, ' ')
    .replace(/[^A-Za-z0-9 .-]+/g, '')
    .replace(/ +/g, ' ')
    .replace(/^ | $/g, '')
}

/** Slot 2 — SSP label from the locked vocabulary; unknown SSPs pass through
 *  sanitized so the slot can never carry whitespace/underscores. */
export function sspSlot(ssp: string): string {
  return SSP_SLOT_CODE[vocabKey(ssp)] || sanitizeSlotValue(ssp) || 'SSP'
}

/** Slot 3 — DSP code from the locked vocabulary ("The Trade Desk"/"- RTB" →
 *  TTD, DV360, Amazon, Yahoo); unknown DSP names pass through sanitized. */
export function dspSlot(dspName: string): string {
  return DSP_SLOT_CODE[vocabKey(dspName)] || sanitizeSlotValue(dspName) || 'DSP'
}

/** The DSPs that participate in deal expansion: all of them when the
 *  "multiple DSPs" toggle is on, else only the first row — entries without a
 *  DSP name never count. Mirrors activeDSPs in rules.go. */
export function activeDsps(form: FormData): DspEntry[] {
  const list = form.multipleDsps ? form.dsps : form.dsps.slice(0, 1)
  return list.filter(d => trimInput(d.dsp) !== '')
}

/** One expanded (deal × DSP) pair — the unit every emission path iterates. */
export interface DealDspPair {
  deal: DealEntry
  /** The DSP this expanded deal targets — carries the name-slot code (slot 3)
   *  and the seat id for prompt_inputs. undefined when no DSP is configured. */
  dsp?: DspEntry
}

/** Expand deals × active DSPs (LOCKED product decision — total deals =
 *  Audiences × Channels × SSPs × DSPs): each selected DSP yields its own deal
 *  carrying that DSP's name-slot code and that DSP's seat id. A deal with a
 *  nameOverride is a single, already-named deal — it does NOT expand
 *  (expanding would emit the same override name N times). Mirrors
 *  generateNamedDeals in internal/validation/rules.go. */
export function expandDealDsps(deals: DealEntry[], form: FormData): DealDspPair[] {
  const dsps = activeDsps(form)
  const out: DealDspPair[] = []
  for (const deal of deals) {
    const override = trimInput(deal.nameOverride || '')
    // No expansion for (a) override deals — expanding would emit the same
    // override name N times — and (b) SHEET-ONLY rows: those deals already
    // exist from a previous (possibly pre-expansion) batch, so fabricating
    // extra per-DSP "already created" names would put deals that never
    // existed on the client deal-sheet email. A sheet-only row is exactly
    // ONE pair on the first active DSP; follow-up batches should carry the
    // recorded name as nameOverride (docs/DEAL_NAMING.md §6).
    if (override || deal.sheetOnly || dsps.length <= 1) {
      out.push({ deal, dsp: dsps[0] })
      continue
    }
    for (const dsp of dsps) out.push({ deal, dsp })
  }
  return out
}

/** Data partner → Curator-slot code: the partner's name, sanitized to the
 *  slot charset. Mirrors dataPartnerCodeFor in rules.go. */
function dataPartnerCode(dp: string): string {
  return sanitizeSlotValue(dp)
}

/** Slot 1 — Curator. Data partner code if set, else the operator's ORG_NAME
 *  (lib/operatorConfig.ts). Mirrors curatorSlot in rules.go. */
export function curator(form: FormData): string {
  const dp = trimInput(form.dataPartner)
  if (dp) {
    const code = dataPartnerCode(dp)
    if (code) return code
  }
  return sanitizeSlotValue(getOperatorConfig().orgName) || 'Curator'
}

/** Back-compat aliases for denormalized slot columns —
 *  same vocabulary as the generator by construction. */
export function sspAbbr(ssp: string): string {
  return sspSlot(ssp)
}

export function dspAbbr(form: FormData, dsp?: DspEntry): string {
  const entry = dsp ?? activeDsps(form)[0]
  return entry ? dspSlot(entry.dsp) : 'DSP'
}

/** Slot 6 — DataPartner. Literal "NA" whenever the data partner IS the
 *  curator (always true today — the partner rides in slot 1) or is unset.
 *  Reserved for a future secondary data overlay; the partner must NEVER
 *  appear in both slots (e.g. curator Partner ⇒ DataPartner NA). */
export function dataPartnerSlot(_form?: FormData): string {
  return 'NA'
}

/** Slot 9 — Inventory. Workbook vocabulary: "All" | "In-app" | "Web".
 *  Known form values normalize; unknown values pass through sanitized (the
 *  audit flags them via the inventory_code check). */
export function inventoryCode(inv: string): string {
  switch (vocabKey(inv)) {
    case '':
    case 'all':
      return 'All'
    case 'web only':
    case 'web':
      return 'Web'
    case 'in-app':
    case 'in app':
    case 'inapp':
      return 'In-app'
    default:
      return sanitizeSlotValue(inv) || 'All'
  }
}

export function inventorySlot(deal: DealEntry, form: FormData): string {
  return inventoryCode(deal.inventoryType || form.defaultInventoryType || 'All')
}

/** SSPs whose create path CANNOT carry US-state / CA-province include
 *  targeting (#233.7/.8): the IX create wire is include-only
 *  geo_countries + dma_codes (no state/region key), and Media.net consumes
 *  countries only. A state include on these SSPs is NOT applied — the
 *  builder emits a loud NOT-SUPPORTED marker — so the deal NAME's Geo slot
 *  must not claim the state either (a "..._CA_..." name over a whole-country
 *  deal is a lying name). Mirrors sspStateIncludeUnsupported in
 *  internal/validation/rules.go; keys are vocabKey()-normalized. */
const SSP_STATE_INCLUDE_UNSUPPORTED: ReadonlySet<string> = new Set(['index exchange', 'media.net'])

/** True when this SSP's create path carries include-state targeting. An
 *  unset/unknown SSP keeps the legacy state-first behavior. */
export function sspCarriesIncludeStates(ssp: string): boolean {
  return !SSP_STATE_INCLUDE_UNSUPPORTED.has(vocabKey(ssp || ''))
}

/** Slot 10 — Geo. FIRST STATE if any state entry is set, else the first
 *  country, else "Global". zip/dma entries NEVER reach the name (the
 *  typed-geo refactor briefly took the first entry of any type, which
 *  dropped the state preference — this restores the workbook rule).
 *  `includeStates: false` (SSPs with no state wire — #233.8) skips
 *  state entries entirely so the name never claims an untargeted state.
 *  Mirrors primaryGeo/primaryGeoForSSP in internal/validation/rules.go. */
export function geoCode(geos: GeoEntry[], opts: { includeStates?: boolean } = {}): string {
  const includeStates = opts.includeStates !== false
  let firstCountry = ''
  for (const g of geos) {
    const v = trimInput(g.value || '')
    if (!v) continue
    if (g.type === 'state') {
      if (includeStates) return sanitizeSlotValue(v) || 'Global'
      continue // no state wire on this SSP — the name must not claim it
    }
    // upperAscii, not toUpperCase(): Unicode-aware uppercasing diverges
    // between JS and Go (ß → SS in JS only) and would 422 the submit gate.
    if (g.type === 'country' && !firstCountry) firstCountry = sanitizeSlotValue(upperAscii(v))
  }
  return firstCountry || 'Global'
}

export function geoSlot(deal: DealEntry, form: FormData): string {
  const inc = deal.geoInclude.length ? deal.geoInclude : form.defaultGeoInclude
  return geoCode(inc, { includeStates: sspCarriesIncludeStates(deal.ssp) })
}

const CHANNEL_SLOT_CODE: Record<string, string> = {
  'display': 'Display',
  'olv (online video)': 'OLV',
  'olv': 'OLV',
  'ctv': 'CTV',
  'ott': 'OTT',
  'native': 'Native',
  'audio': 'Audio',
}

/** Slot 8 — Channel code ("OLV (Online Video)" → "OLV"). Recognized channels
 *  normalize via the vocabulary; unknown values pass through sanitized (the
 *  audit flags them via the channel_code check). Empty → '' (the name path
 *  falls back to the `Channel` placeholder). */
export function channelCode(ch: string): string {
  const key = vocabKey(ch)
  if (!key) return ''
  return CHANNEL_SLOT_CODE[key] || sanitizeSlotValue(ch)
}

export function channelSlot(deal: DealEntry): string {
  return channelCode(deal.channel) || 'Channel'
}

export interface DealNameOptions {
  /** The DSP this expanded deal is for (slot 3 + seat routing). Defaults to
   *  the first active DSP. */
  dsp?: DspEntry
}

/** Generate the canonical 12-slot deal name (or return a non-empty
 *  nameOverride verbatim — nothing is derived from an override). Mirrors
 *  generateNamedDeals in rules.go. */
export function generateDealName(form: FormData, deal: DealEntry, opts: DealNameOptions = {}): string {
  // Null-safe: an un-hydrated deal (e.g. straight off an LLM chat edit) may omit
  // nameOverride entirely. Guard so name generation never throws on undefined.
  const override = trimInput(deal.nameOverride || '')
  if (override) return override

  const cur = curator(form)
  const ssp = deal.ssp ? sspSlot(deal.ssp) : 'SSP'
  const dsp = opts.dsp ?? activeDsps(form)[0]
  const dspCode = dsp ? dspSlot(dsp.dsp) : 'DSP'
  const agency = sanitizeSlotValue(form.agency) || 'Agency'
  const brand = sanitizeSlotValue(form.brand) || 'Brand'
  const theme = sanitizeSlotValue(deal.theme) || 'Audience'
  const ch = channelSlot(deal)
  const inv = inventorySlot(deal, form)
  const geo = geoSlot(deal, form)
  const campaign = trimInput(form.campaignId) || campaignIdPlaceholder()
  const attr = sanitizeSlotValue(form.attributionCode) || getOperatorConfig().defaultAttributionCode

  return [cur, ssp, dspCode, agency, brand, dataPartnerSlot(form), theme, ch, inv, geo, campaign, attr].join('_')
}

// ---------------------------------------------------------------------------
// Media.net deal_id — the ≤30-char slug Media.net carries as ITS deal id.
// Built here (next to the name slots it derives from) so the prompt builder
// (dealPromptYaml.ts) and any record writer
// compute the IDENTICAL id — records must be able to resolve the deal at
// Media.net without waiting for a writeback that may never land.
// ---------------------------------------------------------------------------

const MN_DEAL_ID_MAX = 30

/** Sanitize a string into the Media.net deal_id charset: ≤30 chars,
 *  [A-Za-z0-9_-] only. Forbidden: # % $ @ * & ? ! ` ~ " ' , / \ | ( ) { } [ ] + = ^ : */
export function mnSlug(s: string, max = MN_DEAL_ID_MAX): string {
  const cleaned = (s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return cleaned.slice(0, max)
}

/** FNV-1a 32-bit hash over UTF-16 code units, as 8 lowercase hex chars.
 *  Deterministic, dependency-free — used to keep truncated Media.net deal_ids
 *  unique. (TS-only: the Go audit guards MN uniqueness on the source tuple,
 *  not the slug, so no cross-language parity is required.) */
export function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** The Media.net deal_id for one expanded (deal × DSP) pair.
 *
 *  Seed = DSP (multi-DSP batches) + curator/data-partner + theme + channel +
 *  inventory + geo + campaign id — every slot that distinguishes deals within
 *  a batch. (The pre-2026-07 seed stopped at channel, so two MN Display deals
 *  differing only by inventory or geo collided on the same deal_id.)
 *
 *  When the sanitized seed exceeds 30 chars, blind head-truncation would cut
 *  off exactly the differentiating tail — instead keep the head (which leads
 *  with the DSP token under multi-DSP expansion) and append an 8-hex FNV-1a
 *  digest of the FULL canonical deal name, which is unique per deal by
 *  construction (qa_duplicate_deals). */
export function medianetDealId(form: FormData, deal: DealEntry, opts: DealNameOptions = {}): string {
  const dsps = activeDsps(form)
  const dsp = opts.dsp ?? dsps[0]
  const seed = [
    // Multi-DSP expansion: the DSP token joins FIRST so head-truncation can
    // never collapse the per-DSP ids into one.
    ...(dsps.length > 1 ? [dsp ? dspSlot(dsp.dsp) : 'DSP'] : []),
    curator(form),
    sanitizeSlotValue(deal.theme) || 'Audience',
    channelSlot(deal),
    inventorySlot(deal, form),
    geoSlot(deal, form),
    trimInput(form.campaignId) || getOperatorConfig().campaignIdPrefix,
  ].join('-')
  const cleaned = mnSlug(seed, Number.MAX_SAFE_INTEGER)
  if (cleaned.length <= MN_DEAL_ID_MAX) return cleaned
  const digest = fnv1a32Hex(generateDealName(form, deal, opts))
  const head = cleaned.slice(0, MN_DEAL_ID_MAX - digest.length - 1).replace(/_+$/, '')
  return `${head}_${digest}`
}


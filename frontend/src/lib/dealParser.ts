// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { DealEntry, FormData, GeoEntry, GeoType, migrateCampaignGeoDefaults, migrateCampaignIabCategories, migrateCampaignLanguage, newDeal } from '../types/deal'
import { computeAutoEndDate } from './flightDates'
import { withDefaultGeo } from './geoPolicy'

export async function spreadsheetToText(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    if (csv.trim()) {
      parts.push(`=== Sheet: ${sheetName} ===\n${csv}`)
    }
  }
  return parts.join('\n\n')
}

function nextId(prefix = ''): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function ensureId<T extends object>(item: T, prefix = ''): T & { id: string } {
  const existing = (item as { id?: unknown }).id
  return { ...item, id: typeof existing === 'string' && existing ? existing : nextId(prefix) }
}

type Parsed = Record<string, unknown>

const SCALAR_KEYS: (keyof FormData)[] = [
  'submitterName', 'submitterEmail', 'requestedDueDate', 'flightStartDate', 'flightEndDate',
  'agency', 'brand', 'campaignName', 'campaignId', 'dataPartner', 'funnel', 'attributionCode',
  'defaultInventoryType', 'defaultLanguage',
  'defaultDisplayCpm', 'defaultVideoCpm', 'defaultVcr',
  'dailyPacingGoal', 'kpiGoal',
  'curatedDealFee', 'feeType',
]

const STRING_ARRAY_KEYS: (keyof FormData)[] = ['iabCategories']

const NESTED_CONFIG_KEYS: (keyof FormData)[] = [
  'ixConfig', 'openxConfig', 'pubmaticConfig', 'medianetConfig', 'xandrConfig', 'tripleliftConfig',
  'magniteConfig',
]

export interface MergeResult {
  form: FormData
  appliedFields: string[]
}

function parseGeos(input: unknown): GeoEntry[] {
  if (!Array.isArray(input)) return []
  const out: GeoEntry[] = []
  for (const g of input) {
    if (typeof g !== 'object' || g === null) continue
    const rec = g as Record<string, unknown>
    // Preferred shape: { type, value }.
    if (nonEmptyString(rec.type) && nonEmptyString(rec.value)) {
      const t = rec.type.trim().toLowerCase()
      const type: GeoType = (t === 'state' || t === 'zip' || t === 'dma') ? (t as GeoType) : 'country'
      const value = type === 'country' ? rec.value.trim().toUpperCase() : rec.value.trim()
      out.push(ensureId({ type, value }, 'g-'))
      continue
    }
    // Legacy brief shape: { country, state } — a single entry could carry both,
    // so emit one entry per populated field (state implies its own row).
    if (nonEmptyString(rec.country)) out.push(ensureId({ type: 'country' as GeoType, value: rec.country.trim().toUpperCase() }, 'g-'))
    if (nonEmptyString(rec.state)) out.push(ensureId({ type: 'state' as GeoType, value: rec.state.trim() }, 'g-'))
  }
  return out
}

function parseDeal(raw: unknown): DealEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Partial<DealEntry> & Record<string, unknown>
  const include = Array.isArray(r.includeSegments)
    ? r.includeSegments.filter(nonEmptyString).map(s => s.trim())
    : []
  const exclude = Array.isArray(r.excludeSegments)
    ? r.excludeSegments.filter(nonEmptyString).map(s => s.trim())
    : []
  const geoIn = parseGeos(r.geoInclude)
  const geoEx = parseGeos(r.geoExclude)

  const base = newDeal()
  let nameOverride = nonEmptyString(r.nameOverride)
    ? r.nameOverride.trim()
    : nonEmptyString((r as Record<string, unknown>).name)
      ? String((r as Record<string, unknown>).name).trim()
      : ''
  let externalReferenceIdField = nonEmptyString((r as Record<string, unknown>).externalReferenceId)
    ? String((r as Record<string, unknown>).externalReferenceId).trim()
    : ''
  // externalReferenceId carries only a client-supplied reference id — there is
  // no name-derived fallback; it is left blank when absent.
  const externalReferenceId = externalReferenceIdField
  // The model sometimes returns JSON numbers for these despite the [string]
  // schema hint — coerce finite numbers to strings so a brief's stated
  // duration requirement is never silently dropped (and a mixed ["15", 30]
  // array is never silently narrowed). Malformed strings still ride through
  // to the loud Go QA check (qa_ad_duration).
  const asDurationString = (v: unknown): unknown =>
    typeof v === 'number' && Number.isFinite(v) ? String(v) : v
  const adDurations = Array.isArray(r.adDurations)
    ? r.adDurations.map(asDurationString).filter(nonEmptyString).map(s => s.trim())
    : []
  const maxAdDurationRaw = asDurationString(r.maxAdDurationSecs)
  const deal: DealEntry = {
    ...base,
    nameOverride,
    theme: nonEmptyString(r.theme) ? r.theme.trim() : '',
    channel: nonEmptyString(r.channel) ? (r.channel.trim() as DealEntry['channel']) : '',
    ssp: nonEmptyString(r.ssp) ? (r.ssp.trim() as DealEntry['ssp']) : '',
    inventoryType: nonEmptyString(r.inventoryType) ? (r.inventoryType.trim() as DealEntry['inventoryType']) : '',
    // Deliberately UNSEEDED here — the US geo default applies at the END of
    // mergeParsedIntoForm, AFTER migrateCampaignGeoDefaults, so a brief's
    // campaign-level geo ("Geo: CA" header → defaultGeoInclude) can fold onto
    // geo-less deals first. A premature per-deal seed would block that fold
    // and silently replace the brief's stated targeting with US. geoExclude
    // is preserved verbatim: it is unemittable on every SSP today, so the
    // geo_exclude_unsupported audit rule fails the batch closed until the
    // trader removes the exclusion (#219).
    geoInclude: geoIn,
    geoExclude: geoEx,
    language: nonEmptyString(r.language) ? r.language.trim() : '',
    includeSegments: include,
    excludeSegments: exclude,
    cpm: nonEmptyString(r.cpm) ? r.cpm.trim() : '',
    vcr: nonEmptyString(r.vcr) ? r.vcr.trim() : '',
    viewabilityTarget: nonEmptyString(r.viewabilityTarget) ? r.viewabilityTarget.trim() : '',
    externalReferenceId,
    // Per-deal IAB categories: only set when the model explicitly returned an
    // array (the brief listed categories for THIS deal) — undefined leaves the
    // deal with NO categories (inference is opt-in via the card's autoInferIab
    // toggle, default OFF — the parser never sets it; see
    // effectiveIabCategories).
    ...(Array.isArray(r.iabCategories)
      ? { iabCategories: r.iabCategories.filter(nonEmptyString).map(s => s.trim()) }
      : {}),
    // Per-deal IAB/content-genre EXCLUSIONS: explicit only, verbatim names
    // (canonical or SSP-native — same validation as iabCategories). Unlike
    // includes there is no auto state to preserve, so an empty array is
    // dropped — undefined and [] both mean "none" (effectiveIabExcludes).
    ...(Array.isArray(r.iabCategoriesExclude) && r.iabCategoriesExclude.filter(nonEmptyString).length > 0
      ? { iabCategoriesExclude: r.iabCategoriesExclude.filter(nonEmptyString).map(s => s.trim()) }
      : {}),
    // Magnite DV+ ad-format ids the model extracted for this deal.
    ...(Array.isArray(r.magniteSizes) && r.magniteSizes.filter(nonEmptyString).length > 0
      ? { magniteSizes: r.magniteSizes.filter(nonEmptyString).map(s => s.trim()) }
      : {}),
    // CTV/video ad-duration targeting the model extracted for this deal
    // (integer seconds; allowed-list and max are alternatives — see DealEntry).
    ...(adDurations.length > 0 ? { adDurations } : {}),
    ...(nonEmptyString(maxAdDurationRaw) ? { maxAdDurationSecs: maxAdDurationRaw.trim() } : {}),
    ...(Array.isArray(r.notes) ? { notes: r.notes.filter(nonEmptyString).map(s => s.trim()) } : {}),
    ...(Array.isArray(r.postCreateUiFix) ? { postCreateUiFix: r.postCreateUiFix.filter(nonEmptyString).map(s => s.trim()) } : {}),
  }
  if (!deal.theme && !deal.channel && !deal.ssp && deal.includeSegments.length === 0 && !deal.nameOverride) {
    return null
  }
  return deal
}

export function mergeParsedIntoForm(current: FormData, parsed: Parsed, defaultGeoCountry?: string | null): MergeResult {
  const next: FormData = { ...current }
  const applied: string[] = []

  for (const key of SCALAR_KEYS) {
    const v = parsed[key as string]
    if (nonEmptyString(v)) {
      // @ts-expect-error dynamic scalar assignment
      next[key] = v.trim()
      applied.push(key as string)
    }
  }

  // End-date policy override: brief-supplied end dates are intentionally
  // discarded. Recompute from whatever start date landed in the merged
  // form. See lib/flightDates.ts for rationale.
  const policyEnd = computeAutoEndDate(next.flightStartDate)
  if (policyEnd && policyEnd !== next.flightEndDate) {
    next.flightEndDate = policyEnd
    if (!applied.includes('flightEndDate')) applied.push('flightEndDate')
  }

  for (const key of STRING_ARRAY_KEYS) {
    const v = parsed[key as string]
    if (Array.isArray(v) && v.length > 0) {
      const filtered = v.filter(nonEmptyString)
      if (filtered.length > 0) {
        // @ts-expect-error dynamic array assignment
        next[key] = filtered
        applied.push(key as string)
      }
    }
  }

  if (typeof parsed.multipleDsps === 'boolean') next.multipleDsps = parsed.multipleDsps

  if (Array.isArray(parsed.dsps) && parsed.dsps.length > 0) {
    const dsps = parsed.dsps
      .filter((d): d is { dsp?: unknown; seatId?: unknown } => typeof d === 'object' && d !== null)
      .map(d => ensureId({
        dsp: nonEmptyString(d.dsp) ? d.dsp.trim() : '',
        seatId: nonEmptyString(d.seatId) ? d.seatId.trim() : '',
      }, 'dsp-'))
      .filter(d => d.dsp || d.seatId)
    if (dsps.length > 0) {
      next.dsps = dsps
      if (dsps.length > 1) next.multipleDsps = true
      applied.push('dsps')
    }
  }

  const defaultGeoInclude = parseGeos(parsed.defaultGeoInclude)
  if (defaultGeoInclude.length > 0) {
    next.defaultGeoInclude = defaultGeoInclude
    applied.push('defaultGeoInclude')
  }
  const defaultGeoExclude = parseGeos(parsed.defaultGeoExclude)
  if (defaultGeoExclude.length > 0) {
    next.defaultGeoExclude = defaultGeoExclude
    applied.push('defaultGeoExclude')
  }

  for (const cfgKey of NESTED_CONFIG_KEYS) {
    const incoming = parsed[cfgKey as string]
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      const merged = mergeConfig(next[cfgKey], incoming as Parsed, cfgKey as string)
      if (merged.changed) {
        // @ts-expect-error dynamic nested config
        next[cfgKey] = merged.value
        applied.push(cfgKey as string)
      }
    }
  }

  if (Array.isArray(parsed.deals) && parsed.deals.length > 0) {
    const deals = parsed.deals.map(parseDeal).filter((d): d is DealEntry => d !== null)
    if (deals.length > 0) {
      next.deals = deals
      applied.push('deals')
    }
  }

  // TOP-LEVEL iabCategoriesExclude safety net: the prompt tells the model to
  // fan campaign-wide content exclusions out per deal, but a model that emits
  // the list top-level (mirroring the top-level iabCategories key) must not
  // have it silently dropped — a lost exclusion books deals against content
  // the brief forbade. Union it onto EVERY deal's exclude list: each deal's
  // own excludes keep their order, campaign-wide names it doesn't already
  // carry (case-insensitively) append after.
  if (Array.isArray(parsed.iabCategoriesExclude)) {
    const topExcludes = parsed.iabCategoriesExclude.filter(nonEmptyString).map(s => s.trim())
    if (topExcludes.length > 0 && next.deals.length > 0) {
      next.deals = next.deals.map(d => {
        const merged = [...(d.iabCategoriesExclude ?? [])]
        const seen = new Set(merged.map(s => s.toLowerCase()))
        for (const name of topExcludes) {
          const key = name.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(name)
        }
        return merged.length > 0 ? { ...d, iabCategoriesExclude: merged } : d
      })
      if (!applied.includes('deals')) applied.push('deals')
    }
  }

  // Reporting labels — campaign-level KV like salesperson, custom.
  if (parsed.reportingLabels && typeof parsed.reportingLabels === 'object') {
    const incoming = parsed.reportingLabels as Record<string, unknown>
    const merged = { ...next.reportingLabels }
    let changed = false
    if (nonEmptyString(incoming.salesperson)) {
      merged.salesperson = String(incoming.salesperson).trim()
      changed = true
    }
    if (nonEmptyString(incoming.custom)) {
      merged.custom = String(incoming.custom).trim()
      changed = true
    }
    if (changed) {
      next.reportingLabels = merged
      applied.push('reportingLabels')
    }
  }

  // Fold any parsed campaign-default geos and campaign-level IAB categories
  // onto the deals — the Campaign Defaults section is retired, so hidden
  // defaults would be invisible.
  const folded = migrateCampaignLanguage(migrateCampaignIabCategories(migrateCampaignGeoDefaults(next)))
  // Geo policy (lib/geoPolicy.ts), applied ONLY after the fold and
  // ONLY to deals THIS parse produced: a deal with no geo INCLUDES once the
  // brief's campaign-level geo has distributed gets the house default
  // country (US) — an
  // exclude-only deal too (#219: excludes are unemittable on every
  // SSP, so without the seed "exclude US" would serve globally INCLUDING the
  // US; the seed bounds the blast radius and the geo_exclude_unsupported
  // audit rule blocks the batch until the exclusion is removed). The parsed
  // geoExclude is preserved on the deal so the intent stays visible. Deals
  // the parse did NOT replace keep whatever geo state the trader left them in.
  if (applied.includes('deals')) {
    folded.deals = folded.deals.map(d => {
      const seeded = withDefaultGeo(d.geoInclude, d.geoExclude, defaultGeoCountry)
      return seeded === d.geoInclude ? d : { ...d, geoInclude: seeded }
    })
  }
  return { form: folded, appliedFields: applied }
}

function mergeConfig(current: unknown, incoming: Parsed, key: string): { value: unknown; changed: boolean } {
  const base = (current && typeof current === 'object' && !Array.isArray(current))
    ? { ...(current as Record<string, unknown>) }
    : {}
  let changed = false

  for (const [k, v] of Object.entries(incoming)) {
    if (k === 'buyers' && key === 'openxConfig' && Array.isArray(v) && v.length > 0) {
      const buyers = v
        .filter((b): b is { buyerId?: unknown } => typeof b === 'object' && b !== null)
        .map(b => ensureId({
          buyerId: nonEmptyString(b.buyerId) ? b.buyerId.trim() : '',
        }, 'b-'))
        .filter(b => b.buyerId)
      if (buyers.length > 0) {
        base.buyers = buyers
        changed = true
      }
      continue
    }
    if (k === 'publisherNames' && key === 'pubmaticConfig' && Array.isArray(v)) {
      const names = v.filter(nonEmptyString)
      if (names.length > 0) {
        base.publisherNames = names
        changed = true
      }
      continue
    }
    if (nonEmptyString(v)) {
      base[k] = v.trim()
      changed = true
    } else if (typeof v === 'boolean') {
      base[k] = v
      changed = true
    }
  }

  return { value: base, changed }
}

import { useEffect, useState } from 'react'
import type { PublisherAllowlistEntry } from '../types/deal'

/** Known publisher list — the repo-shipped snapshot of each SSP's available
 *  publishers (catalogs/publisher-catalog.json, refreshed by code push).
 *  Powers ENTRY-TIME advisory validation in the allowlist chips: ID
 *  auto-fill, unknown-entry flags, typo suggestions, and wrong-SSP-card
 *  detection. Advisory only — booking-time verification against the live SSP
 *  catalog remains the enforcement. Mirrors internal/pubcatalog (Go). */

export type CatalogSlice = 'index' | 'openx' | 'pubmatic' | 'magnite_ctv' | 'magnite_dvplus'

export interface CatalogEntry { id?: string; name?: string }

export interface PublisherCatalog {
  as_of: string
  source?: string
  slices: Partial<Record<CatalogSlice, CatalogEntry[]>>
}

export const CATALOG_SLICE_LABELS: Record<CatalogSlice, string> = {
  index: 'Index',
  openx: 'OpenX',
  pubmatic: 'PubMatic',
  magnite_ctv: 'Magnite CTV',
  magnite_dvplus: 'Magnite DV+',
}

// Module-level cache: the snapshot is immutable per deploy, so one fetch per
// session serves every SSP card.
let cached: PublisherCatalog | null | undefined
let inflight: Promise<PublisherCatalog | null> | undefined

async function fetchCatalog(): Promise<PublisherCatalog | null> {
  if (cached !== undefined) return cached
  inflight = inflight || fetch('/api/publisher-catalog', { cache: 'no-store' })
    .then(async r => {
      if (!r.ok) throw new Error(`status ${r.status}`)
      const body = await r.json()
      cached = (body?.catalog as PublisherCatalog) ?? null
      return cached
    })
    .catch(() => {
      // Advisory feature: any failure degrades to "no catalog" silently.
      cached = null
      return null
    })
  return inflight
}

/** usePublisherCatalog — session-cached fetch; null = none shipped/reachable. */
export function usePublisherCatalog(): PublisherCatalog | null {
  const [catalog, setCatalog] = useState<PublisherCatalog | null>(cached ?? null)
  useEffect(() => {
    let cancelled = false
    void fetchCatalog().then(c => { if (!cancelled) setCatalog(c) })
    return () => { cancelled = true }
  }, [])
  return catalog
}

/** Test hook: seed/clear the module cache. */
export function __setCatalogForTests(c: PublisherCatalog | null | undefined): void {
  cached = c
  inflight = undefined
}

export interface CatalogLookup {
  ids: Set<string>
  /** lowercased name → id ('' when the catalog row has no id) */
  nameToId: Map<string, string>
  /** canonical display names, for typo suggestions */
  names: string[]
  asOf: string
}

export function buildCatalogLookup(catalog: PublisherCatalog, slices: CatalogSlice[]): CatalogLookup {
  const ids = new Set<string>()
  const nameToId = new Map<string, string>()
  const names: string[] = []
  for (const s of slices) {
    for (const e of catalog.slices[s] || []) {
      const id = (e.id || '').trim()
      const name = (e.name || '').trim()
      if (id) ids.add(id)
      if (name) {
        const key = name.toLowerCase()
        if (!nameToId.has(key)) {
          nameToId.set(key, id)
          names.push(name)
        }
      }
    }
  }
  return { ids, nameToId, names, asOf: catalog.as_of }
}

/** resolveAgainstCatalog — auto-fill from the known list where it can:
 *  a known name gains its exact id, a known id keeps whatever name the trader
 *  supplied. Returns the (possibly enriched) entry plus whether it's known. */
export function resolveAgainstCatalog(
  entry: PublisherAllowlistEntry,
  lookup: CatalogLookup,
): { entry: PublisherAllowlistEntry; known: boolean } {
  const id = (entry.id || '').trim()
  const name = (entry.name || '').trim()
  if (id) {
    return { entry, known: lookup.ids.has(id) }
  }
  const foundId = lookup.nameToId.get(name.toLowerCase())
  if (foundId !== undefined) {
    return { entry: foundId ? { id: foundId, name } : { name }, known: true }
  }
  return { entry, known: false }
}

/** Bounded Levenshtein (≤ max) with early exit; -1 when over the bound. */
function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return -1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return -1
    prev = cur
  }
  return prev[b.length] <= max ? prev[b.length] : -1
}

/** suggestName — nearest known publisher name for a flagged NAME entry, or
 *  undefined. Two modes, both case-insensitive: whole-name edit distance ≤ 2
 *  ("Roku - oRTB!" → "Roku - oRTB"), and PREFIX edit distance ≤ 1 for probes
 *  of 5+ chars ("Paramont" → "Paramount - Springserve") — catalog names are
 *  long-form, so traders typing short names would never come within whole-
 *  name distance. Whole-name matches win ties. */
export function suggestName(name: string, lookup: CatalogLookup): string | undefined {
  const probe = name.trim().toLowerCase()
  if (probe.length < 3) return undefined
  let best: string | undefined
  let bestScore = 100
  for (const candidate of lookup.names) {
    const lower = candidate.toLowerCase()
    const full = boundedDistance(probe, lower, 2)
    let score = full >= 0 ? full : 100
    if (probe.length >= 5 && lower.length > probe.length) {
      for (const cut of [probe.length, probe.length + 1]) {
        const d = boundedDistance(probe, lower.slice(0, cut), 1)
        // Prefix matches rank just below a same-distance whole-name match.
        if (d >= 0) score = Math.min(score, d + 0.5)
      }
    }
    if (score < bestScore) {
      best = candidate
      bestScore = score
      if (score === 0) break
    }
  }
  return bestScore <= 2 ? best : undefined
}

/** wrongCardHint — do this card's unknown IDs belong to ANOTHER SSP's list
 *  (the pasted-the-wrong-column failure)? Same thresholds as the Go side:
 *  every unknown ID in one other slice, or ≥2 covering at least half. */
export function wrongCardHint(
  unknownIds: string[],
  catalog: PublisherCatalog,
  ownSlices: CatalogSlice[],
): string | undefined {
  if (unknownIds.length === 0) return undefined
  let bestSlice: CatalogSlice | undefined
  let best = 0
  for (const slice of Object.keys(catalog.slices) as CatalogSlice[]) {
    if (ownSlices.includes(slice)) continue
    const ids = new Set((catalog.slices[slice] || []).map(e => (e.id || '').trim()).filter(Boolean))
    const n = unknownIds.filter(id => ids.has(id)).length
    if (n > best) { best = n; bestSlice = slice }
  }
  if (bestSlice && (best === unknownIds.length || (best >= 2 && best * 2 >= unknownIds.length))) {
    return `${best} of the ${unknownIds.length} unknown ID${unknownIds.length !== 1 ? 's' : ''} match the ${CATALOG_SLICE_LABELS[bestSlice]} list — wrong SSP card?`
  }
  return undefined
}

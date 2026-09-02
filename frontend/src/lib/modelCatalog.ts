// Model catalog client for the composer picker — ported from fleet
// (chat-experience.tsx's ranked/catalog loaders + filteredRankedModels).
//
// Two same-origin endpoints feed the picker (the server proxies OpenRouter
// behind session auth):
//   - /api/models/rankings — the browse rows: newest model per major lab,
//     tier slugs excluded (they're pinned client-side).
//   - /api/models/catalog  — the search source: every text-capable
//     OpenRouter model, expensive-first.

import { TIER_MODELS } from './modelAliases'

export type RankedModel = {
  slug: string
  name: string
  /** Total context window from the OpenRouter catalog (catalog only). */
  contextLength?: number
  /** Unix seconds first listed on OpenRouter — drives the "✨ new" pill. */
  created?: number
}

export const NEW_MODEL_WINDOW_DAYS = 14

/** True when the model was listed on OpenRouter within the last two weeks. */
export function isNewlyReleased(createdSeconds: number | undefined): boolean {
  if (!createdSeconds || createdSeconds <= 0) return false
  const ageDays = (Date.now() / 1000 - createdSeconds) / 86400
  return ageDays >= 0 && ageDays < NEW_MODEL_WINDOW_DAYS
}

type WireModel = { slug?: unknown; name?: unknown; context_length?: unknown; created?: unknown }

function normalize(models: WireModel[] | undefined): RankedModel[] {
  const out: RankedModel[] = []
  for (const m of models ?? []) {
    if (typeof m.slug !== 'string' || m.slug === '') continue
    out.push({
      slug: m.slug,
      name: typeof m.name === 'string' && m.name !== '' ? m.name : m.slug,
      contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
      created: typeof m.created === 'number' ? m.created : undefined,
    })
  }
  return out
}

// Module-level caches: once-per-session ATTEMPTS regardless of outcome.
// Fleet's catalogAttemptedRef exists because guarding only on "list is
// empty / loading" let a failing catalog re-fire the fetch in a tight loop
// (the client self-DDoSed /api/model-catalog thousands of times). Keep the
// attempted flags — the lists are an autocomplete enhancement, not a
// dependency, so one failed try per page load is the correct behavior.
let rankedCache: RankedModel[] = []
let rankedAttempted = false
let rankedInflight: Promise<RankedModel[]> | null = null

let catalogCache: RankedModel[] = []
let catalogAttempted = false
let catalogInflight: Promise<RankedModel[]> | null = null

async function fetchModels(url: string): Promise<RankedModel[]> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) return []
  const data = (await res.json().catch(() => ({}))) as { models?: WireModel[] }
  return normalize(data.models)
}

export async function loadRankedModels(): Promise<RankedModel[]> {
  if (rankedAttempted) return rankedCache
  if (rankedInflight) return rankedInflight
  rankedInflight = (async () => {
    try {
      rankedCache = await fetchModels('/api/models/rankings')
    } catch {
      /* enhancement only — the pinned tier rows still render */
    } finally {
      rankedAttempted = true
      rankedInflight = null
    }
    return rankedCache
  })()
  return rankedInflight
}

export async function loadCatalogModels(): Promise<RankedModel[]> {
  if (catalogAttempted) return catalogCache
  if (catalogInflight) return catalogInflight
  catalogInflight = (async () => {
    try {
      catalogCache = await fetchModels('/api/models/catalog')
    } catch {
      /* enhancement only — search falls back to the ranked list */
    } finally {
      catalogAttempted = true
      catalogInflight = null
    }
    return catalogCache
  })()
  return catalogInflight
}

export const MAX_SEARCH_RESULTS = 15

/** The picker's pinned rows: optional extras (e.g. the parser's
 *  "Server default"), then the tier models. */
export function pinnedModels(extraPinned: RankedModel[] = []): RankedModel[] {
  return [...extraPinned, ...TIER_MODELS.map(t => ({ slug: t.slug, name: t.label }))]
}

/** Compose the visible picker rows — fleet's filteredRankedModels logic.
 *  Browse (no query): pinned rows, then the ranked latest-per-lab list.
 *  Search: pinned matches first, then the full catalog (or the ranked list
 *  while the catalog hasn't loaded), capped at MAX_SEARCH_RESULTS. */
export function composePickerModels(
  query: string,
  ranked: RankedModel[],
  catalog: RankedModel[],
  extraPinned: RankedModel[] = [],
): RankedModel[] {
  const q = query.trim().toLowerCase()
  const defaults = pinnedModels(extraPinned)

  if (!q) {
    const seen = new Set<string>()
    const out: RankedModel[] = []
    for (const m of [...defaults, ...ranked]) {
      if (seen.has(m.slug)) continue
      seen.add(m.slug)
      out.push(m)
    }
    return out
  }

  const source = catalog.length > 0 ? catalog : ranked
  const matchesQuery = (m: RankedModel) =>
    m.slug.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
  const seen = new Set<string>()
  const matches: RankedModel[] = []
  for (const d of defaults) {
    if (seen.has(d.slug)) continue
    if (matchesQuery(d)) {
      seen.add(d.slug)
      matches.push(d)
    }
  }
  for (const model of source) {
    if (seen.has(model.slug)) continue
    if (!matchesQuery(model)) continue
    seen.add(model.slug)
    matches.push(model)
    if (matches.length >= MAX_SEARCH_RESULTS) break
  }
  return matches
}

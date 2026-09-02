// Geo-default policy. Single source of truth for "where does a deal serve
// when the deal info doesn't say?"
//
// Policy: a deal with NO geo INCLUDES defaults to
// UNITED STATES country targeting on every SSP — unless the client's preset
// names a different home country (clients/<id>.json `default_geo_country`,
// e.g. Outcomes CA, whose IX seat is registered in Canada). The house default
// stays US; the per-client value only moves WHERE the seed points, never
// WHETHER one is applied.
//
// Excludes do NOT count as "specified" (#219): an exclude-only deal
// without the seed would serve GLOBALLY — including the excluded geography,
// the worst possible corruption. The seed bounds the blast radius. Per-SSP exclude EMISSION
// shipped with #244 (OpenX geographic.excludes, PubMatic excludeGeos,
// Xandr country/region_action="exclude", Magnite geo_countries_exclude); any
// exclusion shape outside that matrix still fails the audit closed
// (geo_exclude_unsupported — the exclusion is preserved on the deal and
// visible in the deal card so the trader can remove or reshape it). When
// includes ARE given they pass through untouched, and the update flow never
// defaults (all seven SSP update paths leave geo alone when a change request
// doesn't mention it).
//
// This module is the policy boundary, mirroring flightDates.ts. The default
// is applied WRITE-TIME at every path that creates a deal entry — newDeal()
// (the manual "Add deal" button), the LLM parser, and the
// chat-apply boundary — so the seeded chip is VISIBLE in
// the deal card's geo editor, flows into the deal name's Geo slot, the QA/AI
// audits, the per-SSP prompt sections, and the brief. Each of
// those call sites passes the active client's default_geo_country; a path
// with no client in scope gets the house US default.
//
// Escape hatch: because seeding happens at creation (never at hydrate/load),
// a trader can DELETE the seeded chip to run a deliberately-global deal — the
// qa_geo audit item then asks them to confirm global is intended.

// Type-only import: at runtime this module depends on nothing, so
// types/deal.ts can import the policy functions without a cycle.
import type { GeoEntry } from '../types/deal'

/** The country a geo-less deal targets when the client says nothing. ISO-2. */
export const DEFAULT_GEO_COUNTRY = 'US'

/** Per-client override of the house default (clients/<id>.json
 *  `default_geo_country`). The default roster is US-first, but a client whose
 *  seat is registered in another country — Outcomes CA transacts on an
 *  IX Marketplace account registered in Canada and denominated in CAD —
 *  would otherwise have every deal seeded to a geography it does not sell,
 *  and the trader has to remember to swap the chip on each one.
 *
 *  Normalizes to an ISO-2 uppercase code and falls back to the house default
 *  on anything else, so a typo in a hand-edited preset degrades to today's
 *  behavior instead of shipping a junk country token to an SSP. */
export function resolveGeoDefault(country?: string | null): string {
  const iso = (country || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(iso) ? iso : DEFAULT_GEO_COUNTRY
}

let seq = 0

/** A fresh policy-default include list: one country entry. New id per call
 *  so cross-producted/cloned deals never share entry ids. */
export function defaultGeoInclude(country?: string | null): GeoEntry[] {
  seq += 1
  return [{ id: `g-geodefault-${Date.now()}-${seq}`, type: 'country', value: resolveGeoDefault(country) }]
}

/** The write-time policy: the deal's own includes when it has any; otherwise
 *  the client's default country (the US house default when unset). An exclude
 *  does NOT suppress the seed (#219): an unseeded exclude-only deal
 *  would serve globally including the excluded geo — the seed bounds the blast
 *  radius, per-SSP exclude emission (#244) carries the exclusion where
 *  the wire supports it, and the geo_exclude_unsupported audit rule blocks any
 *  unshippable shape. The geoExclude parameter is retained (call-shape
 *  stability). */
export function withDefaultGeo(geoInclude: GeoEntry[], _geoExclude: GeoEntry[], country?: string | null): GeoEntry[] {
  if (geoInclude.length > 0) return geoInclude
  return defaultGeoInclude(country)
}

/** Chat-apply boundary: the LLM edit paths (deal chat, bulk chat)
 *  return a whole replacement form in which the model may have invented NEW
 *  deals with no geo. Seed the default on genuinely-new geo-less deals only —
 *  a deal that already existed keeps whatever geo state the trader left it in
 *  (deleting the seeded chip stays deleted; the escape hatch holds). */
export function seedNewDealsGeo<D extends { id: string; geoInclude: GeoEntry[]; geoExclude: GeoEntry[] }, F extends { deals: D[] }>(
  prevDeals: ReadonlyArray<{ id: string }>,
  form: F,
  country?: string | null,
): F {
  const known = new Set(prevDeals.map(d => d.id))
  let changed = false
  const deals = form.deals.map(d => {
    if (known.has(d.id)) return d
    const seeded = withDefaultGeo(d.geoInclude, d.geoExclude, country)
    if (seeded === d.geoInclude) return d
    changed = true
    return { ...d, geoInclude: seeded }
  })
  return changed ? { ...form, deals } : form
}

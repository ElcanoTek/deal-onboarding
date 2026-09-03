// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Fixture-integrity + full-replay suite for the per-SSP IAB catalog data
// layer (2026-07-14 live audit). Two guarantees:
//   1. Every canonical-map target in dealPromptYaml.ts exists (normalized) in
//      its checked-in live-pulled catalog — an emitted name is never invented.
//   2. Every IAB_OPTIONS picker name is classified for every supporting SSP
//      as exactly one of {canonical-mapped, verbatim-hit, not-supported} —
//      no silent gaps: an unclassified name would ship a doomed token
//      (fail-closed MCPs) or silently drop/mis-promote (Xandr's fail-open
//      resolver).
import { describe, expect, it } from 'vitest'

import {
  IX_IAB_NOT_SUPPORTED,
  IX_IAB_TO_CONTENT_GENRE,
  IX_IAB_TO_IAB_CONTENT_CATEGORY,
  MEDIANET_IAB_NAME_CANONICAL,
  MEDIANET_IAB_NOT_SUPPORTED,
  MEDIANET_IAB_VERIFIED,
  OPENX_IAB_NAME_CANONICAL,
  OPENX_IAB_NOT_SUPPORTED,
  OPENX_IAB_VERIFIED,
  PUBMATIC_IAB_NAME_CANONICAL,
  PUBMATIC_IAB_NOT_SUPPORTED,
  PUBMATIC_IAB_VERIFIED,
  XANDR_IAB_NAME_CANONICAL,
  XANDR_IAB_NOT_SUPPORTED,
  XANDR_IAB_VERIFIED,
} from './dealPromptYaml'
import { IAB_OPTIONS } from './inferIab'
import {
  catalogHasLabel,
  catalogLabel,
  IX_CONTENT_GENRE_CATALOG,
  IX_IAB_CONTENT_CATEGORY_CATALOG,
  MEDIANET_CONTENT_CATEGORY_CATALOG,
  normalizeIabLabel,
  OPENX_IAB_V2_CATALOG,
  OPENX_V1_CATALOG,
  PUBMATIC_IAB_CATALOG,
  SSP_IAB_CAPABILITIES,
  sspCatalogHasLabel,
  SspIabCatalog,
  sspIabPickerOptions,
  XANDR_APP_STORE_PREFIXES,
  XANDR_CONTENT_CATEGORY_CATALOG,
} from './sspIabCatalogs'

// -----------------------------------------------------------------------------
// Fixture integrity — the checked-in catalogs are the 2026-07-14 live pulls
// (scripts/refresh-iab-catalogs.md). Value counts pin against accidental
// truncation on refresh; a deliberate refresh updates these together with
// pulledAt.
// -----------------------------------------------------------------------------
describe('sspIabCatalogs: fixture integrity', () => {
  const FIXTURES: [SspIabCatalog, string, string, number][] = [
    [IX_CONTENT_GENRE_CATALOG, 'indexexchange', 'contentGenre', 94],
    [IX_IAB_CONTENT_CATEGORY_CATALOG, 'indexexchange', 'iabContentCategory', 385],
    [OPENX_IAB_V2_CATALOG, 'openx', 'categories_iab_v2', 698],
    [OPENX_V1_CATALOG, 'openx', 'categories_v1', 494],
    [PUBMATIC_IAB_CATALOG, 'pubmatic', 'iabCategories', 392],
    [XANDR_CONTENT_CATEGORY_CATALOG, 'xandr', 'content-category-universal', 802],
    [MEDIANET_CONTENT_CATEGORY_CATALOG, 'medianet', 'content-categories', 392],
  ]

  it('every catalog carries its identity, the 2026-07-14 pull date, and the full value count', () => {
    for (const [cat, ssp, key, count] of FIXTURES) {
      expect(cat.ssp, key).toBe(ssp)
      expect(cat.key).toBe(key)
      expect(cat.pulledAt, key).toBe('2026-07-14')
      expect(cat.values.length, key).toBe(count)
      for (const v of cat.values) expect(v.label, `${key} label`).toBeTruthy()
    }
  })

  // Every canonical-map TARGET must exist (normalized) in its live catalog —
  // the maps translate picker names INTO the catalog, never past it. This is
  // the test that catches catalog drift on refresh (e.g. the 2026-07-14 pull
  // renamed three IX genres vs the 2026-07-10 probe).
  const MAP_TO_CATALOG: [string, Record<string, string>, SspIabCatalog][] = [
    ['IX_IAB_TO_CONTENT_GENRE', IX_IAB_TO_CONTENT_GENRE, IX_CONTENT_GENRE_CATALOG],
    ['IX_IAB_TO_IAB_CONTENT_CATEGORY', IX_IAB_TO_IAB_CONTENT_CATEGORY, IX_IAB_CONTENT_CATEGORY_CATALOG],
    ['OPENX_IAB_NAME_CANONICAL', OPENX_IAB_NAME_CANONICAL, OPENX_IAB_V2_CATALOG],
    ['PUBMATIC_IAB_NAME_CANONICAL', PUBMATIC_IAB_NAME_CANONICAL, PUBMATIC_IAB_CATALOG],
    ['XANDR_IAB_NAME_CANONICAL', XANDR_IAB_NAME_CANONICAL, XANDR_CONTENT_CATEGORY_CATALOG],
    ['MEDIANET_IAB_NAME_CANONICAL', MEDIANET_IAB_NAME_CANONICAL, MEDIANET_CONTENT_CATEGORY_CATALOG],
  ]

  it('every canonical-map target exists (normalized) in its checked-in catalog', () => {
    for (const [mapName, map, cat] of MAP_TO_CATALOG) {
      for (const [from, to] of Object.entries(map)) {
        expect(catalogHasLabel(cat, to), `${mapName}: '${from}' → '${to}' must exist in ${cat.ssp}/${cat.key}`).toBe(true)
      }
    }
  })

  // The known punctuation divergences the normalized lookup exists for —
  // pinned so a refresh that changes them is loud, not silently absorbed.
  it('pins the live-catalog spellings behind the normalized lookups', () => {
    // PubMatic's live tier-1 drops the comma; the canonical target keeps it
    // (the MCP's exact-normalized matcher absorbs it — live-verified clean
    // 2026-07-14).
    expect(catalogLabel(PUBMATIC_IAB_CATALOG, "Law, Gov't & Politics")).toBe("Law Gov't & Politics")
    // Media.net's live label literally embeds double quotes.
    expect(catalogLabel(MEDIANET_CONTENT_CATEGORY_CATALOG, "Law, Gov't & Politics")).toBe('"Law, Gov\'t & Politics"')
    // Xandr canonical targets are byte-exact standard entities.
    for (const to of Object.values(XANDR_IAB_NAME_CANONICAL)) {
      expect(catalogLabel(XANDR_CONTENT_CATEGORY_CATALOG, to)).toBe(to)
    }
    // OpenX + IX targets are byte-exact too.
    for (const to of Object.values(OPENX_IAB_NAME_CANONICAL)) {
      expect(catalogLabel(OPENX_IAB_V2_CATALOG, to)).toBe(to)
    }
    for (const to of Object.values(IX_IAB_TO_CONTENT_GENRE)) {
      expect(catalogLabel(IX_CONTENT_GENRE_CATALOG, to)).toBe(to)
    }
    for (const to of Object.values(IX_IAB_TO_IAB_CONTENT_CATEGORY)) {
      expect(catalogLabel(IX_IAB_CONTENT_CATEGORY_CATALOG, to)).toBe(to)
    }
  })

  it('normalizeIabLabel is lenient on case/whitespace/commas/quotes but KEEPS apostrophes significant', () => {
    expect(normalizeIabLabel('  Law,  Gov\'t & Politics ')).toBe("law gov't & politics")
    expect(normalizeIabLabel('"Law, Gov\'t & Politics"')).toBe("law gov't & politics")
    // Gov vs Gov't never unifies — that exact mismatch blocked the live
    // Media.net replay.
    expect(normalizeIabLabel('Law, Gov & Politics')).not.toBe(normalizeIabLabel("Law, Gov't & Politics"))
  })
})

// -----------------------------------------------------------------------------
// Full IAB_OPTIONS replay — for every supporting SSP, every one of the 26
// picker names must be exactly one of {canonical-mapped, verbatim-hit,
// not-supported}. The VERIFIED sets in dealPromptYaml.ts are additionally
// pinned to equal the fixture's verbatim hits, so a catalog refresh that
// gains/loses a name fails HERE instead of silently changing emission.
// -----------------------------------------------------------------------------
describe('sspIabCatalogs: full IAB_OPTIONS classification replay', () => {
  const SINGLE_CATALOG_SSPS: [string, Record<string, string>, ReadonlySet<string>, ReadonlySet<string>, SspIabCatalog][] = [
    ['PubMatic', PUBMATIC_IAB_NAME_CANONICAL, PUBMATIC_IAB_NOT_SUPPORTED, PUBMATIC_IAB_VERIFIED, PUBMATIC_IAB_CATALOG],
    ['OpenX', OPENX_IAB_NAME_CANONICAL, OPENX_IAB_NOT_SUPPORTED, OPENX_IAB_VERIFIED, OPENX_IAB_V2_CATALOG],
    ['Xandr', XANDR_IAB_NAME_CANONICAL, XANDR_IAB_NOT_SUPPORTED, XANDR_IAB_VERIFIED, XANDR_CONTENT_CATEGORY_CATALOG],
    ['Media.net', MEDIANET_IAB_NAME_CANONICAL, MEDIANET_IAB_NOT_SUPPORTED, MEDIANET_IAB_VERIFIED, MEDIANET_CONTENT_CATEGORY_CATALOG],
  ]

  for (const [ssp, canonical, notSupported, verified, catalog] of SINGLE_CATALOG_SSPS) {
    it(`${ssp}: all 26 names classify as exactly one of canonical-mapped / verbatim-hit / not-supported`, () => {
      for (const name of IAB_OPTIONS) {
        const mapped = name in canonical
        const refused = notSupported.has(name)
        const hit = catalogHasLabel(catalog, name)
        const states = [mapped, refused, !mapped && !refused && hit].filter(Boolean).length
        expect(states, `${ssp} '${name}' must classify exactly one way (mapped=${mapped} refused=${refused} verbatim=${hit})`).toBe(1)
        // A mapped name must NOT already be a verbatim hit (a redundant map
        // entry would mask catalog drift), and a refused name must NOT exist
        // in the catalog (that would refuse a resolvable category).
        expect(mapped && hit, `${ssp} '${name}' is both canonical-mapped and a verbatim hit`).toBe(false)
        expect(refused && hit, `${ssp} '${name}' is NOT-SUPPORTED but exists in the live catalog`).toBe(false)
      }
    })

    it(`${ssp}: the VERIFIED pin equals the fixture's verbatim hits exactly`, () => {
      const hits = IAB_OPTIONS.filter(n => !(n in canonical) && !notSupported.has(n) && catalogHasLabel(catalog, n))
      expect([...verified].sort()).toEqual(hits.sort())
    })
  }

  it('Index Exchange: every name covers on a key (genre map / 1066 bridge / 1066 verbatim) or is NOT-SUPPORTED on BOTH keys', () => {
    for (const name of IAB_OPTIONS) {
      const genreMapped = name in IX_IAB_TO_CONTENT_GENRE
      const catBridged = name in IX_IAB_TO_IAB_CONTENT_CATEGORY
      const catVerbatim = catalogHasLabel(IX_IAB_CONTENT_CATEGORY_CATALOG, name)
      const refused = IX_IAB_NOT_SUPPORTED.has(name)
      // Coverage on the two keys may overlap (that's what single-key
      // selection arbitrates) — but refused means NEITHER key resolves it.
      expect(genreMapped || catBridged || catVerbatim || refused, `IX '${name}' must be curated one way or the other`).toBe(true)
      expect(refused && (genreMapped || catBridged || catVerbatim), `IX '${name}' is NOT-SUPPORTED but covers on a key`).toBe(false)
      expect(catBridged && catVerbatim, `IX '${name}' must not be both 1066-bridged and a verbatim 1066 hit`).toBe(false)
      // Genre-map targets never leak IAB names: pinned in fixture-integrity
      // above. NOT-SUPPORTED names must also miss the GENRE catalog itself
      // (they are IAB names, not TV genres — a hit would mean the curation
      // wrongly refuses a live genre).
      if (refused) expect(catalogHasLabel(IX_CONTENT_GENRE_CATALOG, name), `IX '${name}' refused but exists as a live TV genre`).toBe(false)
    }
  })
})

// -----------------------------------------------------------------------------
// Capability metadata — the data layer the PR B per-SSP picker consumes. All
// 7 SSPs are first-class: unsupported SSPs are present with a reason, never
// absent.
// -----------------------------------------------------------------------------
describe('sspIabCatalogs: SSP_IAB_CAPABILITIES', () => {
  it('covers all 7 SSPs with the audited include/exclude surfaces', () => {
    expect(Object.keys(SSP_IAB_CAPABILITIES).sort()).toEqual(
      ['Index Exchange', 'Magnite', 'Media.net', 'OpenX', 'PubMatic', 'TripleLift', 'Xandr'],
    )
    const cap = SSP_IAB_CAPABILITIES
    expect(cap['Index Exchange']).toMatchObject({ includes: true, excludes: 'create' })
    expect(cap['Index Exchange'].catalogs).toEqual([IX_CONTENT_GENRE_CATALOG, IX_IAB_CONTENT_CATEGORY_CATALOG])
    expect(cap['PubMatic']).toMatchObject({ includes: true, excludes: 'create' })
    expect(cap['OpenX']).toMatchObject({ includes: true, excludes: 'post-create', excludesVia: 'ox_block_deal_content' })
    expect(cap['Media.net']).toMatchObject({ includes: true, excludes: 'post-create', excludesVia: 'mn_block_deal_content' })
    expect(cap['Xandr']).toMatchObject({ includes: true, excludes: 'none' })
    expect(cap['Magnite']).toMatchObject({ includes: false, excludes: 'none', notSupportedReason: 'ClearLine API has no content-category surface' })
    expect(cap['TripleLift']).toMatchObject({ includes: false, excludes: 'none', notSupportedReason: 'vendor-gated, no ID discovery (cutlass#757)' })
  })

  it('every include-supporting SSP carries at least one catalog; unsupported SSPs carry none + a reason', () => {
    for (const [ssp, cap] of Object.entries(SSP_IAB_CAPABILITIES)) {
      if (cap.includes) {
        expect(cap.catalogs.length, ssp).toBeGreaterThan(0)
      } else {
        expect(cap.catalogs, ssp).toEqual([])
        expect(cap.notSupportedReason, ssp).toBeTruthy()
      }
    }
  })
})

// -----------------------------------------------------------------------------
// Picker options (PR B) — the deal card's per-SSP category picker must be 1:1
// with what the SSP's API accepts: every option IS a catalog label (so a pick
// the MCP can't resolve is impossible via the picker), Xandr's app-store
// storefront rows are filtered out, and IX options carry their targeting-key
// tag (one key per deal, cutlass#831).
// -----------------------------------------------------------------------------
describe('sspIabCatalogs: sspIabPickerOptions', () => {
  it('every option label resolves in the SSP\'s own catalog(s) — 1:1 with the API', () => {
    for (const ssp of ['Index Exchange', 'OpenX', 'PubMatic', 'Media.net', 'Xandr'] as const) {
      const options = sspIabPickerOptions(ssp)
      expect(options.length, ssp).toBeGreaterThan(0)
      for (const o of options) {
        expect(sspCatalogHasLabel(ssp, o.label), `${ssp}: ${o.label}`).toBe(true)
      }
    }
  })

  it('Xandr: app-store storefront rows are filtered out; content rows remain', () => {
    const labels = sspIabPickerOptions('Xandr').map(o => o.label)
    expect(labels.length).toBeGreaterThan(0)
    for (const prefix of XANDR_APP_STORE_PREFIXES) {
      expect(labels.some(l => l.startsWith(prefix)), prefix).toBe(false)
      // The prefixes are REAL catalog families — the filter must be removing
      // something, not matching nothing (guards against prefix drift on a
      // catalog refresh).
      expect(
        XANDR_CONTENT_CATEGORY_CATALOG.values.some(v => v.label.startsWith(prefix)),
        `${prefix} must exist in the raw catalog`,
      ).toBe(true)
    }
    const appStoreRows = XANDR_CONTENT_CATEGORY_CATALOG.values
      .filter(v => XANDR_APP_STORE_PREFIXES.some(p => v.label.startsWith(p))).length
    expect(labels.length).toBe(XANDR_CONTENT_CATEGORY_CATALOG.values.length - appStoreRows)
  })

  it('Index Exchange: the union of both catalogs, each option tagged with its key', () => {
    const options = sspIabPickerOptions('Index Exchange')
    const genres = options.filter(o => o.keyTag === 'genre')
    const iab = options.filter(o => o.keyTag === 'IAB')
    expect(genres.length).toBe(IX_CONTENT_GENRE_CATALOG.values.length)
    expect(iab.length).toBe(IX_IAB_CONTENT_CATEGORY_CATALOG.values.length)
    expect(genres.length + iab.length).toBe(options.length) // every option tagged
  })

  it('single-catalog SSPs carry no key tag; TL/Magnite/no-SSP offer nothing', () => {
    for (const ssp of ['OpenX', 'PubMatic', 'Media.net', 'Xandr'] as const) {
      expect(sspIabPickerOptions(ssp).every(o => o.keyTag === undefined), ssp).toBe(true)
    }
    expect(sspIabPickerOptions('TripleLift')).toEqual([])
    expect(sspIabPickerOptions('Magnite')).toEqual([])
    expect(sspIabPickerOptions('')).toEqual([])
  })
})

describe('sspIabCatalogs: sspCatalogHasLabel (free-text validation gate)', () => {
  it('accepts catalog names (normalized) and rejects non-catalog names per SSP', () => {
    expect(sspCatalogHasLabel('Index Exchange', 'business and financial')).toBe(true) // genre catalog, case-lenient
    expect(sspCatalogHasLabel('Index Exchange', 'Insurance')).toBe(true) // 1066 catalog
    expect(sspCatalogHasLabel('OpenX', 'Travel')).toBe(true)
    expect(sspCatalogHasLabel('OpenX', 'Totally Made Up Category')).toBe(false)
    expect(sspCatalogHasLabel('PubMatic', 'Careers')).toBe(true)
    // Canonical-map DISPLAY aliases are not catalog labels — the picker's
    // common group offers them; free text must resolve against the catalog.
    expect(sspCatalogHasLabel('PubMatic', 'Careers & Employment')).toBe(false)
    expect(sspCatalogHasLabel('TripleLift', 'Travel')).toBe(false) // no catalogs at all
    expect(sspCatalogHasLabel('', 'Travel')).toBe(false)
  })
})

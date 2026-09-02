// Per-SSP IAB / content-category catalog data layer (PR A of the per-SSP IAB
// picker work). The JSON fixtures under sspIabCatalogs/ are LIVE-PULLED
// catalogs (read-only, 2026-07-14 — refresh runbook: scripts/refresh-iab-catalogs.md)
// and are the source of truth every category name Deal Onboarding emits is verified
// against: the canonical maps in dealPromptYaml.ts must only ever target
// labels that exist here (sspIabCatalogs.test.ts pins this), and the later
// per-SSP picker UI (PR B) consumes SSP_IAB_CAPABILITIES to decide what to
// offer per SSP.

import type { Ssp } from '../types/deal'
import ixContentGenre from './sspIabCatalogs/indexexchange-contentGenre.json'
import ixIabContentCategory from './sspIabCatalogs/indexexchange-iabContentCategory.json'
import medianetContentCategories from './sspIabCatalogs/medianet-content-categories.json'
import openxCategoriesIabV2 from './sspIabCatalogs/openx-categories_iab_v2.json'
import openxCategoriesV1 from './sspIabCatalogs/openx-categories_v1.json'
import pubmaticIabCategories from './sspIabCatalogs/pubmatic-iabCategories.json'
import xandrContentCategoryUniversal from './sspIabCatalogs/xandr-content-category-universal.json'

export interface SspIabCatalogValue {
  label: string
  id?: string | number
}

export interface SspIabCatalog {
  ssp: string
  key: string
  taxonomy: string
  pulledAt: string
  values: SspIabCatalogValue[]
}

export const IX_CONTENT_GENRE_CATALOG: SspIabCatalog = ixContentGenre
export const IX_IAB_CONTENT_CATEGORY_CATALOG: SspIabCatalog = ixIabContentCategory
export const OPENX_IAB_V2_CATALOG: SspIabCatalog = openxCategoriesIabV2
// Reference only — the OpenX MCP resolves against the IAB v2 option set;
// checked in so a v1-vs-v2 name question can be answered without a live pull.
export const OPENX_V1_CATALOG: SspIabCatalog = openxCategoriesV1
export const PUBMATIC_IAB_CATALOG: SspIabCatalog = pubmaticIabCategories
export const XANDR_CONTENT_CATEGORY_CATALOG: SspIabCatalog = xandrContentCategoryUniversal
export const MEDIANET_CONTENT_CATEGORY_CATALOG: SspIabCatalog = medianetContentCategories

/** Catalog-label normalization for lookups: case- and whitespace-insensitive,
 *  and punctuation-lenient on the separators the live catalogs disagree on —
 *  commas (PubMatic's live tier-1 is "Law Gov't & Politics", no comma),
 *  periods, and embedded double quotes (the live Media.net catalog label is
 *  literally "\"Law, Gov't & Politics\""). Apostrophes are SIGNIFICANT and
 *  kept: no live matcher unifies Gov/Gov't — that exact mismatch is what
 *  blocked the 2026-07-14 Media.net replay. */
export function normalizeIabLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/["“”]/g, '')
    .replace(/[,.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const labelIndexes = new WeakMap<SspIabCatalog, Map<string, string>>()

function labelIndex(catalog: SspIabCatalog): Map<string, string> {
  let idx = labelIndexes.get(catalog)
  if (!idx) {
    idx = new Map()
    // First occurrence wins — catalogs are de-duplicated on pull.
    for (const v of catalog.values) {
      const norm = normalizeIabLabel(v.label)
      if (!idx.has(norm)) idx.set(norm, v.label)
    }
    labelIndexes.set(catalog, idx)
  }
  return idx
}

/** The catalog's own spelling of `name` (normalized lookup), or undefined when
 *  the catalog has no such label. Emit the RETURNED label, never the input —
 *  the MCP matchers are at best normalization-lenient, never fuzzy. */
export function catalogLabel(catalog: SspIabCatalog, name: string): string | undefined {
  return labelIndex(catalog).get(normalizeIabLabel(name))
}

export function catalogHasLabel(catalog: SspIabCatalog, name: string): boolean {
  return catalogLabel(catalog, name) !== undefined
}

/** How a deal's IAB/content-category EXCLUSIONS reach the SSP: 'create' =
 *  create-time wire arg; 'post-create' = a separate update tool applied after
 *  the create; 'none' = no exclusion surface at all (trader UI follow-up). */
export type IabExcludeSupport = 'create' | 'post-create' | 'none'

export interface SspIabCapability {
  /** Whether the SSP's create wire carries IAB/content-category INCLUDES. */
  includes: boolean
  excludes: IabExcludeSupport
  /** The tool that applies post-create exclusions, when excludes === 'post-create'. */
  excludesVia?: string
  /** The live catalog(s) emitted names must resolve against. Index Exchange
   *  carries two because the MCP resolves per deal on ONE of two targeting
   *  keys (contentGenre first, then iabContentCategory — never mixed). */
  catalogs: SspIabCatalog[]
  /** Why the SSP carries no category surface, when includes === false. */
  notSupportedReason?: string
}

/** Per-SSP IAB/content-category capability — the data layer the PR B picker
 *  UI consumes. All 7 SSPs are first-class: an SSP with no category surface
 *  says so explicitly instead of being absent. */
export const SSP_IAB_CAPABILITIES: Record<Ssp, SspIabCapability> = {
  'Index Exchange': {
    includes: true,
    excludes: 'create', // excluded_iab_categories → NONE_OF on the deal's selected key
    catalogs: [IX_CONTENT_GENRE_CATALOG, IX_IAB_CONTENT_CATEGORY_CATALOG],
  },
  'OpenX': {
    includes: true,
    excludes: 'post-create',
    excludesVia: 'ox_block_deal_content',
    catalogs: [OPENX_IAB_V2_CATALOG],
  },
  'PubMatic': {
    includes: true,
    excludes: 'create', // exclude_iab_categories → excludeIabCategories
    catalogs: [PUBMATIC_IAB_CATALOG],
  },
  'Media.net': {
    includes: true,
    excludes: 'post-create',
    excludesVia: 'mn_block_deal_content',
    catalogs: [MEDIANET_CONTENT_CATEGORY_CATALOG],
  },
  'Xandr': {
    includes: true,
    excludes: 'none',
    catalogs: [XANDR_CONTENT_CATEGORY_CATALOG],
  },
  'TripleLift': {
    includes: false,
    excludes: 'none',
    catalogs: [],
    notSupportedReason: 'vendor-gated, no ID discovery (cutlass#757)',
  },
  'Magnite': {
    includes: false,
    excludes: 'none',
    catalogs: [],
    notSupportedReason: 'ClearLine API has no content-category surface',
  },
}

/** App-store rows in the Xandr universal catalog (e.g. "Apple AppStore:
 *  Games") — storefront categories, NOT content categories; the deal-card
 *  picker filters them out so a trader can't target a storefront by mistake.
 *  Exact prefixes verified against the checked-in fixture (the catalog's only
 *  "<prefix>: " families). */
export const XANDR_APP_STORE_PREFIXES = [
  'Apple AppStore:',
  'Google PlayStore:',
  'Windows Store:',
] as const

export interface SspIabPickerOption {
  label: string
  /** Index Exchange only: which of the two IX targeting keys carries this
   *  label — 'genre' = contentGenre (key 11), 'IAB' = iabContentCategory
   *  (key 1066). Rendered as a suffix tag in the picker because ALL of a
   *  deal's names must land on ONE key (cutlass#831). */
  keyTag?: 'genre' | 'IAB'
}

/** The full, searchable option list for the deal card's per-SSP category
 *  picker — 1:1 with what the SSP's API accepts: every option is a live
 *  catalog label, so a picked label the SSP cannot resolve is impossible via
 *  the picker. Empty for SSPs with no category surface (and for a deal with
 *  no SSP chosen yet). */
export function sspIabPickerOptions(ssp: Ssp | ''): SspIabPickerOption[] {
  switch (ssp) {
    case 'OpenX':
      return OPENX_IAB_V2_CATALOG.values.map(v => ({ label: v.label }))
    case 'PubMatic':
      return PUBMATIC_IAB_CATALOG.values.map(v => ({ label: v.label }))
    case 'Media.net':
      return MEDIANET_CONTENT_CATEGORY_CATALOG.values.map(v => ({ label: v.label }))
    case 'Xandr':
      return XANDR_CONTENT_CATEGORY_CATALOG.values
        .filter(v => !XANDR_APP_STORE_PREFIXES.some(p => v.label.startsWith(p)))
        .map(v => ({ label: v.label }))
    case 'Index Exchange':
      return [
        ...IX_CONTENT_GENRE_CATALOG.values.map(v => ({ label: v.label, keyTag: 'genre' as const })),
        ...IX_IAB_CONTENT_CATEGORY_CATALOG.values.map(v => ({ label: v.label, keyTag: 'IAB' as const })),
      ]
    default:
      return []
  }
}

/** True when `name` resolves (normalized lookup) in ANY of the SSP's live
 *  catalogs — the free-text validation gate for the deal card's chip inputs:
 *  a typed name that resolves nowhere gets an inline error instead of being
 *  silently accepted and failing the create mid-batch. */
export function sspCatalogHasLabel(ssp: Ssp | '', name: string): boolean {
  if (!ssp) return false
  return SSP_IAB_CAPABILITIES[ssp].catalogs.some(c => catalogHasLabel(c, name))
}

import { DealEntry, dealSupportsAdDuration, DspEntry, effectivePubMaticPublisherEntries, FormData, GeoEntry, isVideoChannel, magniteFormatKind, StandardList, UploadedFile } from '../types/deal'
import { generateDealName } from '../hooks/useDealMatrix'
import { activeDsps, curator, DealDspPair, expandDealDsps, medianetDealId, sspCarriesIncludeStates } from './dealNameSlots'
import { effectiveIabCategories, effectiveIabExcludes } from './inferIab'
import { catalogHasLabel, catalogLabel, IX_CONTENT_GENRE_CATALOG, IX_IAB_CONTENT_CATEGORY_CATALOG } from './sspIabCatalogs'
import { splitEmails } from './recipients'
import { splitSeatIds } from './seatPolicy'
import { resolveXandrInsertionOrder } from './xandrInsertionOrders'

// =============================================================================
// the runner DEAL PROMPT GENERATION
//
// Each builder produces a prompt block that the runner pastes verbatim into Cutlass.
// Every prompt:
//   1. Names the exact MCP tool the runner must call
//      (e.g. mcp_xandr_mcp_xandr_execute_deal_from_prompt_inputs)
//   2. Lists the EXACT MCP argument names with resolved values
//   3. Adds inline comments explaining MCP defaults / enum constraints
//
// Source of truth for arg names:
//   cutlass/protocols/deal-creation-{ssp}.yaml
//   cutlass/mcp/{ssp}_mcp.py (each tool's signature)
// =============================================================================

// =============================================================================
// LOOKUPS — pre-resolve every name → value translation the runner agent would
// otherwise burn tool calls confirming.
// =============================================================================

// IX's DSP catalog uses canonical names. TRADR ships through BidSwitch seat 393
// (IPONWEB Demand); Amazon DSP shows up as plain "Amazon"; Trade Desk RTB folds
// into "The Trade Desk".
const IX_DSP_CANONICAL: Record<string, string> = {
  'TRADR': 'BidSwitch',
  'The Trade Desk - RTB': 'The Trade Desk',
  'Amazon DSP': 'Amazon',
  'Yahoo DSP': 'Yahoo DSP',
  'Xandr Invest': 'Xandr',
}

// IX iab_categories → contentGenre translation (cutlass#714). IX targeting
// key 11 "contentGenre" is a TV-GENRE taxonomy (94 live values), NOT IAB, and
// the Cutlass IX MCP resolves this key EXACT-match only (no fuzzy contains —
// the old bidirectional contains-match silently mis-mapped 'Consumer Banking'
// to the generic 'Consumer' TV genre). Every value below is byte-exact from
// the live catalog (read-only pull 2026-07-14, checked in as
// sspIabCatalogs/indexexchange-contentGenre.json — that pull renamed three
// genres vs the 2026-07-10 probe: 'Business/Financial' → 'Business and
// financial', 'Health and Wellness' → 'Health and wellness', 'Home and
// Garden' → 'Home and garden'); an unverified string would fail the deal
// mid-create. Keys are IAB_OPTIONS display names (inferIab.ts). Exported for
// the contract suite, which pins full IAB_OPTIONS coverage across this map +
// IX_IAB_TO_IAB_CONTENT_CATEGORY + IX_IAB_NOT_SUPPORTED.
export const IX_IAB_TO_CONTENT_GENRE: Record<string, string> = {
  'Arts & Entertainment': 'Entertainment',
  'Automotive': 'Automotive',
  'Business': 'Business and financial',
  'Consumer Banking': 'Business and financial', // finance intent — NEVER the generic 'Consumer' TV genre
  'Education': 'Education',
  'Food & Drink': 'Food',
  'Health & Fitness': 'Health and wellness',
  'Home & Garden': 'Home and garden',
  'News': 'News',
  'Personal Finance': 'Business and financial',
  'Pets': 'Animals',
  'Science': 'Science',
  'Sports': 'Sports',
  'Style & Fashion': 'Fashion',
  'Technology & Computing': 'Technology',
  'Travel': 'Travel',
}

// IX ALSO resolves iab_categories against targeting key 1066
// "iabContentCategory" (385 IAB-flavored names, cutlass#831) when a deal's
// names don't all cover as contentGenres — see ixSelectIabKey for the
// single-key rule. Most IAB_OPTIONS names exist verbatim in the checked-in
// 1066 catalog fixture; this map bridges only the spelling/alias gaps,
// mirroring PUBMATIC_IAB_NAME_CANONICAL. Exported for the contract suite.
export const IX_IAB_TO_IAB_CONTENT_CATEGORY: Record<string, string> = {
  // Apostrophe variant: the live 1066 entry is "Law, Gov't & Politics" — the
  // picker's "Law, Gov & Politics" misses the exact-match lookup.
  'Law, Gov & Politics': "Law, Gov't & Politics",
  // The 1066 catalog carries the IAB 1.x tier-1 name 'Careers' — "Careers &
  // Employment" is a display alias with identical semantics (same bridge as
  // PubMatic/OpenX/Media.net).
  'Careers & Employment': 'Careers',
}

// IAB_OPTIONS names supported on NEITHER IX key (verified against both
// checked-in fixtures 2026-07-14): no TV genre exists, and key 1066 carries
// only the generic 'Insurance' — emitting the parent would silently WIDEN
// the category. These emit a loud NOT-SUPPORTED comment and are NEVER
// emitted as tokens — an unmapped name would raise mid-create and kill the
// deal (cutlass#714). Exported for the contract suite.
export const IX_IAB_NOT_SUPPORTED: ReadonlySet<string> = new Set([
  'Auto Insurance',
  'Home Insurance',
  'Life Insurance',
])

export type IxIabKey = 'contentGenre' | 'iabContentCategory'

// A name covers on contentGenre when the curated map translates it, or when
// it is FIXTURE-VERIFIED against the live key-11 catalog (normalized lookup,
// same contract as the 1066 side). The old rule blind-trusted any string
// that wasn't a campaign-picker name as a native genre pass-through — but
// the per-deal IX picker offers BOTH catalogs' labels, so key-1066 picks
// ("Men's Health", "Senor Health", …) counted as genre-coverable, rule (a)
// of ixSelectIabKey chose key 11 for a set that mostly lived on key 1066,
// and the 1066 names shipped verbatim on the wrong key — where exact-match
// resolution killed the whole deal (a live batch DEAL00188 deal 12, 2026-08-13).
function ixCoversOnContentGenre(name: string): boolean {
  return name in IX_IAB_TO_CONTENT_GENRE || catalogHasLabel(IX_CONTENT_GENRE_CATALOG, name)
}

// A name covers on iabContentCategory only when fixture-verified: bridged
// through the canonical map or present in the checked-in 1066 catalog
// (normalized lookup — the catalog's own spelling is what gets emitted).
function ixCoversOnIabContentCategory(name: string): boolean {
  return name in IX_IAB_TO_IAB_CONTENT_CATEGORY || catalogHasLabel(IX_IAB_CONTENT_CATEGORY_CATALOG, name)
}

/** Pick the ONE IX targeting key this deal's iab_categories resolve on.
 *  SINGLE-KEY constraint (cutlass#831): the MCP resolves ALL of a deal's
 *  include+exclude names on one key — contentGenre (key 11) first, then
 *  iabContentCategory (key 1066) — all-or-nothing per key, exact-match only,
 *  NEVER mixed on one deal. Selection: (a) every name genre-coverable →
 *  contentGenre (unchanged wire for existing deals); (b) else every name
 *  1066-coverable → iabContentCategory; (c) else the key covering more of
 *  the requested names wins, but INCLUDE coverage outranks total coverage —
 *  an exclude-heavy vote must never flip the deal onto a key that EMPTIES
 *  the include list while the excludes still ship (that would invert the
 *  deal to all-inventory-except, the FIX 3 disaster). Deterministic final
 *  tie-break: contentGenre. Uncovered names emit loud NOT-SUPPORTED
 *  comments, never doomed tokens. Exported for the contract suite. */
export function ixSelectIabKey(includeNames: string[], excludeNames: string[]): IxIabKey {
  const all = [...includeNames, ...excludeNames]
  if (all.every(ixCoversOnContentGenre)) return 'contentGenre'
  if (all.every(ixCoversOnIabContentCategory)) return 'iabContentCategory'
  const count = (names: string[], covers: (n: string) => boolean) => names.filter(covers).length
  const genreIncludes = count(includeNames, ixCoversOnContentGenre)
  const catIncludes = count(includeNames, ixCoversOnIabContentCategory)
  if (genreIncludes !== catIncludes) return catIncludes > genreIncludes ? 'iabContentCategory' : 'contentGenre'
  const genreTotal = genreIncludes + count(excludeNames, ixCoversOnContentGenre)
  const catTotal = catIncludes + count(excludeNames, ixCoversOnIabContentCategory)
  return catTotal > genreTotal ? 'iabContentCategory' : 'contentGenre'
}

/** Partition a deal's resolved IAB names for the IX builder on the deal's
 *  selected key: curated/bridged names → their verified catalog strings
 *  (deduped — several IAB names can fold into one genre); names the key
 *  cannot carry → notSupported (loud comment, no token). BOTH keys are
 *  fixture-verified: every emitted name ships in the live catalog's own
 *  spelling, and an unverifiable name is never emitted as a token (it would
 *  exact-match nothing at the MCP and kill the whole deal). */
function ixIabNamesForKey(names: string[], key: IxIabKey): { names: string[]; notSupported: string[]; sources: Map<string, string[]> } {
  const out: string[] = []
  const notSupported: string[] = []
  // emitted name (lowercased) → the IAB source name(s) that produced it, for
  // loud collision reporting (a genre can come from several distinct IAB names).
  const sources = new Map<string, string[]>()
  const note = (emitted: string, src: string) => {
    if (!out.includes(emitted)) out.push(emitted)
    const k = emitted.toLowerCase()
    const prior = sources.get(k) || []
    if (!prior.includes(src)) prior.push(src)
    sources.set(k, prior)
  }
  for (const name of names) {
    if (key === 'contentGenre') {
      // Curated translation first, else fixture lookup (emits the catalog's
      // own spelling). Anything else is NOT-SUPPORTED — never a verbatim
      // pass-through: an unverified token exact-matches nothing at the MCP
      // and kills the whole deal (the doomed-token failure this partition
      // exists to prevent).
      const genre = IX_IAB_TO_CONTENT_GENRE[name] || catalogLabel(IX_CONTENT_GENRE_CATALOG, name)
      if (genre) {
        note(genre, name)
      } else if (!notSupported.includes(name)) {
        notSupported.push(name)
      }
    } else {
      const label = IX_IAB_TO_IAB_CONTENT_CATEGORY[name] || catalogLabel(IX_IAB_CONTENT_CATEGORY_CATALOG, name)
      if (label) {
        note(label, name)
      } else if (!notSupported.includes(name)) {
        notSupported.push(name)
      }
    }
  }
  return { names: out, notSupported, sources }
}

/** The fail-loud NOT-SUPPORTED comment for IAB names the deal's SELECTED IX
 *  key cannot carry — mirrors adDurationNotSupportedLines: a loud comment
 *  instead of a doomed token, tied to the batch prompt's Required-final-
 *  summary rules. A minority name can be resolvable on the OTHER key, but
 *  all of a deal's categories ride one key (never mixed, cutlass#831), so it
 *  is omitted rather than mis-targeted. */
function ixIabNotSupportedLines(names: string[], side: 'include' | 'exclude', key: IxIabKey): string[] {
  if (names.length === 0) return []
  const what = side === 'exclude' ? 'IAB category exclusion(s)' : 'IAB category(ies)'
  const keyReason = key === 'contentGenre'
    ? `IX contentGenre (targeting key 11) is a TV-genre taxonomy`
    : `the IX iabContentCategory catalog (targeting key 1066) has no entry at this specificity`
  return [
    `# NOT SUPPORTED: ${what} ${inlineList(names)} — ${keyReason}`,
    `# with no equivalent on this deal's selected key (ONE key per deal, never mixed — cutlass#714/#831); omitted rather than mis-targeted. Do NOT pass unmapped names to the tool` +
      (side === 'exclude' ? ' —' : ';'),
    side === 'exclude'
      ? `# the trader must apply the exclusion in the IX UI; report as a trader UI follow-up in the final summary.`
      : `# they fail the whole create mid-batch; report as NOT APPLIED in the final summary.`,
  ]
}

/** Loud marker for a genre-level include↔exclude collision (cutlass#714,
 *  FIX 3): distinct IAB names can fold onto the SAME IX catalog name (e.g.
 *  include 'Business' + exclude 'Personal Finance' → both 'Business and
 *  financial' on contentGenre).
 *  The include KEEPS the genre (the deal stays genre-targeted — Deal Onboarding never
 *  silently drops the include and widens the deal to all-genres-except); the
 *  colliding genre is removed from the EXCLUDE (so the MCP's include/exclude
 *  conflict gate can't fire) and the contradiction is surfaced here, mirroring
 *  the NOT-SUPPORTED pattern. `bySource` maps each colliding genre to the
 *  include + exclude IAB names that produced it. */
function ixGenreConflictLines(
  collisions: { genre: string; includeNames: string[]; excludeNames: string[] }[],
  key: IxIabKey,
): string[] {
  if (collisions.length === 0) return []
  const out: string[] = []
  for (const { genre, includeNames, excludeNames } of collisions) {
    out.push(
      `# GENRE CONFLICT: include ${inlineList(includeNames)} and exclude ${inlineList(excludeNames)} BOTH map to the IX ${key} "${genre}" (cutlass#714).`,
      `# Kept "${genre}" as an INCLUDE (the deal stays genre-targeted — never silently widened to all-genres-except); the exclusion of "${genre}" was NOT applied.`,
      `# Resolve the contradiction with the trader if the exclusion was intended; report this as a trader UI follow-up in the final summary.`,
    )
  }
  return out
}

// =============================================================================
// PubMatic IAB curation (#233.4 — mirrors the IX #714 approach).
// The live /v1/common/iabCategories taxonomy (392 entries, IAB QAG tier-1 +
// subcategories; read-only probe 2026-07-09 audit) resolves 20/26 IAB_OPTIONS
// picker names by exact-normalized match. The other 6 either canonicalize to
// a live taxonomy name (map) or have NO PubMatic equivalent at the same
// specificity (NOT-SUPPORTED set) and emit a loud marker instead of a doomed
// token — the MCP's _resolve_iab_categories is exact-match fail-closed, so an
// unmapped name kills the WHOLE create mid-batch. Names outside IAB_OPTIONS
// pass through verbatim as deliberate taxonomy names (the MCP exact-matches
// or fails THAT deal loudly). Exported for the contract suite, which pins
// full IAB_OPTIONS coverage across VERIFIED + CANONICAL + NOT_SUPPORTED.
// =============================================================================

export const PUBMATIC_IAB_NAME_CANONICAL: Record<string, string> = {
  // Apostrophe variant: the live QAG tier-1 entry is "Law, Gov't & Politics"
  // (IAB11) — the picker's "Law, Gov & Politics" missed the exact-normalized
  // lookup (the 2026-07-09 audit's live probe pinned this exact mismatch).
  'Law, Gov & Politics': "Law, Gov't & Politics",
  // QAG tier-1 IAB4 is named "Careers" — "Careers & Employment" is a display
  // alias with no live entry. Identical semantics; the MCP stays exact-match
  // fail-closed, so a taxonomy drift blocks the deal rather than mis-mapping.
  'Careers & Employment': 'Careers',
}

// IAB_OPTIONS names with NO PubMatic taxonomy entry at the same specificity
// (QAG carries only the generic IAB13-6 "Insurance"; "Consumer Banking" has
// no entry — nearest is the tier-1 "Personal Finance"). Emitting the generic
// parent would silently WIDEN the category, so these fail loud instead: the
// marker names the nearest live categories for a deliberate re-pick.
export const PUBMATIC_IAB_NOT_SUPPORTED: ReadonlySet<string> = new Set([
  'Auto Insurance',
  'Home Insurance',
  'Life Insurance',
  'Consumer Banking',
])

// The 20 IAB_OPTIONS names live-verified to resolve exact-match against the
// PubMatic taxonomy (2026-07-09 audit probe: HIT 20/26). Purely a contract-
// suite pin — the builder passes them through verbatim.
export const PUBMATIC_IAB_VERIFIED: ReadonlySet<string> = new Set([
  'Arts & Entertainment', 'Automotive', 'Business', 'Education',
  'Family & Parenting', 'Food & Drink', 'Health & Fitness',
  'Hobbies & Interests', 'Home & Garden', 'Insurance', 'News',
  'Personal Finance', 'Pets', 'Real Estate', 'Science', 'Society', 'Sports',
  'Style & Fashion', 'Technology & Computing', 'Travel',
])

/** Shared partition for the single-catalog SSP builders (PubMatic / OpenX /
 *  Xandr / Media.net): canonical-mapped names → their live catalog spelling;
 *  curated-known-unsupported names → notSupported (loud marker, no token);
 *  everything else (live-verified IAB_OPTIONS names + trader-typed native
 *  taxonomy names) passes through verbatim — the MCP resolves it or fails
 *  THAT deal loudly. Deduped, order-preserving. */
function partitionIabNames(
  names: string[],
  canonicalMap: Record<string, string>,
  notSupportedSet: ReadonlySet<string>,
): { names: string[]; notSupported: string[] } {
  const out: string[] = []
  const notSupported: string[] = []
  for (const name of names) {
    const canonical = canonicalMap[name]
    if (canonical) {
      if (!out.includes(canonical)) out.push(canonical)
    } else if (notSupportedSet.has(name)) {
      if (!notSupported.includes(name)) notSupported.push(name)
    } else if (!out.includes(name)) {
      out.push(name)
    }
  }
  return { names: out, notSupported }
}

/** Partition a deal's resolved IAB names for the PubMatic builder — see
 *  partitionIabNames. */
const pmIabNames = (names: string[]) => partitionIabNames(names, PUBMATIC_IAB_NAME_CANONICAL, PUBMATIC_IAB_NOT_SUPPORTED)

/** The fail-loud NOT-SUPPORTED comment for IAB names with no live PubMatic
 *  taxonomy equivalent — mirrors ixGenreNotSupportedLines: a loud comment
 *  instead of a doomed token (the MCP exact-match would kill the create). */
function pmIabNotSupportedLines(names: string[], side: 'include' | 'exclude'): string[] {
  if (names.length === 0) return []
  const what = side === 'exclude' ? 'IAB category exclusion(s)' : 'IAB category(ies)'
  return [
    `# NOT SUPPORTED: ${what} ${inlineList(names)} — no PubMatic taxonomy entry at this specificity (#233.4;`,
    `# the live taxonomy carries only the generic "Insurance" / "Personal Finance" parents — emitting a parent would silently WIDEN the category).`,
    side === 'exclude'
      ? `# Do NOT pass unmapped names to the tool; the trader must apply the exclusion in the PubMatic UI — report as a trader UI follow-up in the final summary.`
      : `# Do NOT pass unmapped names to the tool (they fail the whole create mid-batch); re-pick a live category deliberately or report as NOT APPLIED in the final summary.`,
  ]
}

// =============================================================================
// OpenX IAB curation (2026-07-14 live audit — mirrors the PubMatic
// #233.4 approach). The OpenX MCP resolves iab_categories against the
// live IAB Content Taxonomy 2.x option set with CONTAINS-matching: a no-match
// raises LookupError and an ambiguous (multi-hit) name blocks — either way
// the WHOLE create dies mid-batch — and a single partial hit silently NARROWS
// the category (the 'Family & Parenting' → 'Parenting' defect). The checked-in
// fixture (sspIabCatalogs/openx-categories_iab_v2.json, 698 values) resolves
// 19/26 IAB_OPTIONS picker names exact; the other 7 either canonicalize to a
// live v2 name (map) or have NO defensible 1:1 v2 equivalent (NOT-SUPPORTED
// set) and emit a loud marker instead of a doomed/narrowing token. Names
// outside IAB_OPTIONS pass through verbatim as deliberate taxonomy names.
// Exported for the contract suite, which pins full IAB_OPTIONS coverage
// across VERIFIED + CANONICAL + NOT_SUPPORTED.
// =============================================================================

export const OPENX_IAB_NAME_CANONICAL: Record<string, string> = {
  // v2's tier-1 is 'Careers' — "Careers & Employment" is a display alias
  // with identical semantics (same bridge as PubMatic).
  'Careers & Employment': 'Careers',
  // v2's tier-1 umbrella (id 186); 'Parenting' is its CHILD — the old
  // contains-match narrowed to the child and silently dropped 'Family'.
  'Family & Parenting': 'Family and Relationships',
  // v2 folded News AND Law/Gov/Politics into the single tier-1 'News and
  // Politics' (id 379, children incl. Law + Politics) — the IAB's own 1.0→2.x
  // successor node for both picker names. Bare 'News'/'Law, Gov & Politics'
  // are ambiguous multi-hits under contains-matching and block the create.
  'News': 'News and Politics',
  'Law, Gov & Politics': 'News and Politics',
}

// IAB_OPTIONS names with NO defensible 1:1 in the v2 taxonomy: v2 has no
// 'Arts & Entertainment' or 'Society' node at all, and splits 'Health &
// Fitness' across the DISJOINT tier-1s 'Healthy Living' / 'Medical Health' —
// picking either would silently drop half the intent (the picker's keywords
// span both: fitness/wellness AND pharma/medical). Loud marker for a
// deliberate re-pick, never a guessed token.
export const OPENX_IAB_NOT_SUPPORTED: ReadonlySet<string> = new Set([
  'Arts & Entertainment',
  'Health & Fitness',
  'Society',
])

// The 19 IAB_OPTIONS names verified to exist verbatim in the live v2 catalog
// (2026-07-14 pull). Purely a contract-suite pin against catalog drift — the
// builder passes them through verbatim.
export const OPENX_IAB_VERIFIED: ReadonlySet<string> = new Set([
  'Automotive', 'Auto Insurance', 'Business', 'Consumer Banking', 'Education',
  'Food & Drink', 'Hobbies & Interests', 'Home & Garden', 'Home Insurance',
  'Insurance', 'Life Insurance', 'Personal Finance', 'Pets', 'Real Estate',
  'Science', 'Sports', 'Style & Fashion', 'Technology & Computing', 'Travel',
])

/** Partition a deal's resolved IAB names for the OpenX builder — see
 *  partitionIabNames. */
const oxIabNames = (names: string[]) => partitionIabNames(names, OPENX_IAB_NAME_CANONICAL, OPENX_IAB_NOT_SUPPORTED)

/** The fail-loud NOT-SUPPORTED comment for IAB names with no defensible v2
 *  equivalent — mirrors pmIabNotSupportedLines: a loud comment instead of a
 *  doomed token (a no-match/ambiguous name kills the whole create; a partial
 *  contains-hit silently narrows the category). */
function oxIabNotSupportedLines(names: string[]): string[] {
  if (names.length === 0) return []
  return [
    `# NOT SUPPORTED: IAB category(ies) ${inlineList(names)} — no 1:1 entry in the OpenX IAB v2 taxonomy (2026-07-14 audit;`,
    `# v2 has no 'Arts & Entertainment'/'Society' node and splits 'Health & Fitness' across 'Healthy Living' / 'Medical Health' — a partial match would silently NARROW the category).`,
    `# Do NOT pass unmapped names to the tool (no-match/ambiguous names fail the whole create mid-batch); re-pick a live v2 category deliberately or report as NOT APPLIED in the final summary.`,
  ]
}

// =============================================================================
// Xandr content-category curation (2026-07-14 live audit — mirrors the
// PubMatic #233.4 approach). Xandr's universal content-category
// catalog (checked-in fixture sspIabCatalogs/xandr-content-category-
// universal.json, 802 values) is a PLATFORM taxonomy, NOT IAB, and the MCP
// resolver is FAIL-OPEN: an unresolved name silently DROPS with only a
// quality flag (the deal ships un-targeted on that category), and a
// single-substring hit fuzzy-PROMOTES — 'Style & Fashion' landed on the
// app-store row 'Windows Store: Style & fashion'. Only 11/26 IAB_OPTIONS
// names exist verbatim; the rest either canonicalize to a live standard-type
// entry (map) or have no defensible 1:1 (NOT-SUPPORTED set) and emit a loud
// marker instead of a silently-dropped/mis-promoted token. Names outside
// IAB_OPTIONS pass through verbatim as deliberate catalog names. Exported
// for the contract suite, which pins full IAB_OPTIONS coverage across
// VERIFIED + CANONICAL + NOT_SUPPORTED.
// =============================================================================

export const XANDR_IAB_NAME_CANONICAL: Record<string, string> = {
  'Automotive': 'Autos & Vehicles',
  'Business': 'Business & Industry',
  'Family & Parenting': 'Family & Relationships',
  'Health & Fitness': 'Health',
  'Personal Finance': 'Finance',
  // The catalog's standard entity is word-swapped — the picker name's only
  // substring hit is the WRONG app-store row 'Windows Store: Style & fashion'.
  'Style & Fashion': 'Fashion & Style',
  'Technology & Computing': 'Computers & Electronics',
}

// IAB_OPTIONS names with NO Xandr universal-catalog entry at the same
// specificity (the catalog carries only the generic 'Insurance'/'Banking'
// parents for the finance sub-lines — emitting a parent would silently WIDEN
// the category — and no Careers/Hobbies/Society entity; 'Law, Gov & Politics'
// splits across the separate 'Law & Government' / 'Politics' entities).
// A loud marker instead of a silent fail-open drop.
export const XANDR_IAB_NOT_SUPPORTED: ReadonlySet<string> = new Set([
  'Auto Insurance',
  'Careers & Employment',
  'Consumer Banking',
  'Hobbies & Interests',
  'Home Insurance',
  'Law, Gov & Politics',
  'Life Insurance',
  'Society',
])

// The 11 IAB_OPTIONS names verified to exist verbatim (standard type) in the
// live universal catalog (2026-07-14 pull). Purely a contract-suite pin —
// the builder passes them through verbatim.
export const XANDR_IAB_VERIFIED: ReadonlySet<string> = new Set([
  'Arts & Entertainment', 'Education', 'Food & Drink', 'Home & Garden',
  'Insurance', 'News', 'Pets', 'Real Estate', 'Science', 'Sports', 'Travel',
])

/** Partition a deal's resolved IAB names for the Xandr builder — see
 *  partitionIabNames. */
const xnIabNames = (names: string[]) => partitionIabNames(names, XANDR_IAB_NAME_CANONICAL, XANDR_IAB_NOT_SUPPORTED)

/** The fail-loud NOT-SUPPORTED comment for IAB names with no Xandr universal-
 *  catalog equivalent. Doubly important here because the MCP resolver is
 *  FAIL-OPEN: an unmapped name would not even fail the create — it would
 *  silently drop (quality flag only) or fuzzy-promote to a wrong entity. */
function xnIabNotSupportedLines(names: string[]): string[] {
  if (names.length === 0) return []
  return [
    `# NOT SUPPORTED: IAB category(ies) ${inlineList(names)} — no Xandr universal content-category entry at this specificity (2026-07-14 audit;`,
    `# the catalog carries only generic parents for these — emitting a parent would silently WIDEN the category, and the fail-open resolver would silently DROP or fuzzy-promote an unmapped name).`,
    `# Do NOT pass unmapped names to the tool; re-pick a live catalog category deliberately or report as NOT APPLIED in the final summary.`,
  ]
}

// =============================================================================
// Media.net content-category curation (2026-07-14 live audit — mirrors the
// PubMatic #233.4 approach; the two taxonomies are both IAB 1.x and
// the curation lands identically). The Media.net MCP is exact-match
// fail-closed: an unresolvable name BLOCKS the whole create. The checked-in
// fixture (sspIabCatalogs/medianet-content-categories.json, 392 values)
// resolves 20/26 IAB_OPTIONS names verbatim; 2 canonicalize (map) and the
// same 4 finance sub-lines PubMatic refuses have no same-specificity entry
// (NOT-SUPPORTED set). Names outside IAB_OPTIONS pass through verbatim.
// Exported for the contract suite, which pins full IAB_OPTIONS coverage
// across VERIFIED + CANONICAL + NOT_SUPPORTED.
// =============================================================================

export const MEDIANET_IAB_NAME_CANONICAL: Record<string, string> = {
  // Apostrophe variant: the live catalog entry is "Law, Gov't & Politics"
  // (IAB11; the 2026-07-14 pull carries the label with literal embedded
  // double quotes — the normalized-form emission below is what the audit's
  // live matcher replay resolved).
  'Law, Gov & Politics': "Law, Gov't & Politics",
  // IAB4 is named 'Careers' — "Careers & Employment" is a display alias with
  // identical semantics (same bridge as PubMatic).
  'Careers & Employment': 'Careers',
}

// IAB_OPTIONS names with NO Media.net catalog entry at the same specificity
// (the catalog carries only the generic IAB13-6 'Insurance'; 'Consumer
// Banking' has no entry — nearest is the tier-1 'Personal Finance').
// Emitting the generic parent would silently WIDEN the category, so these
// fail loud instead — the exact set PubMatic refuses, kept consistent.
export const MEDIANET_IAB_NOT_SUPPORTED: ReadonlySet<string> = new Set([
  'Auto Insurance',
  'Home Insurance',
  'Life Insurance',
  'Consumer Banking',
])

// The 20 IAB_OPTIONS names verified to exist verbatim in the live catalog
// (2026-07-14 pull). Purely a contract-suite pin — the builder passes them
// through verbatim.
export const MEDIANET_IAB_VERIFIED: ReadonlySet<string> = new Set([
  'Arts & Entertainment', 'Automotive', 'Business', 'Education',
  'Family & Parenting', 'Food & Drink', 'Health & Fitness',
  'Hobbies & Interests', 'Home & Garden', 'Insurance', 'News',
  'Personal Finance', 'Pets', 'Real Estate', 'Science', 'Society', 'Sports',
  'Style & Fashion', 'Technology & Computing', 'Travel',
])

/** Partition a deal's resolved IAB names for the Media.net builder — see
 *  partitionIabNames. */
const mnIabNames = (names: string[]) => partitionIabNames(names, MEDIANET_IAB_NAME_CANONICAL, MEDIANET_IAB_NOT_SUPPORTED)

/** The fail-loud NOT-SUPPORTED comment for IAB names with no live Media.net
 *  catalog equivalent — mirrors pmIabNotSupportedLines: a loud comment
 *  instead of a doomed token (the MCP exact-match would kill the create). */
function mnIabNotSupportedLines(names: string[]): string[] {
  if (names.length === 0) return []
  return [
    `# NOT SUPPORTED: IAB category(ies) ${inlineList(names)} — no Media.net catalog entry at this specificity (2026-07-14 audit;`,
    `# the live catalog carries only the generic "Insurance" / "Personal Finance" parents — emitting a parent would silently WIDEN the category).`,
    `# Do NOT pass unmapped names to the tool (they fail the whole create mid-batch); re-pick a live category deliberately or report as NOT APPLIED in the final summary.`,
  ]
}

/** UI-facing per-SSP partition of a deal's category names — the SAME
 *  partition/selection logic the prompt builders above run, exported so the
 *  deal card classifies chips without duplicating it. Input names are the
 *  RAW stored names (chips render them verbatim); the result reports which
 *  of them the deal's SSP cannot carry:
 *    unsupportedInclude / unsupportedExclude — raw names the SSP (or, on IX,
 *      the deal's SELECTED key) cannot carry: render struck-through, never
 *      silently dropped.
 *    ixKey — IX only: the ONE targeting key every name rides (cutlass#831).
 *    ixSplitNames — IX only: the subset of unsupported names that WOULD
 *      resolve on the OTHER key — i.e. the picks split across keys and the
 *      card should warn (one key per deal, never mixed). */
export function sspIabPartitionForUi(
  ssp: string,
  includeNames: string[],
  excludeNames: string[],
): { unsupportedInclude: string[]; unsupportedExclude: string[]; ixKey?: IxIabKey; ixSplitNames: string[] } {
  const v2 = (n: string) => IAB_V2_NAMES[n] || n
  if (ssp === 'Index Exchange') {
    const key = ixSelectIabKey(includeNames.map(v2), excludeNames.map(v2))
    const other: IxIabKey = key === 'contentGenre' ? 'iabContentCategory' : 'contentGenre'
    const unsupported = (names: string[]) =>
      names.filter(n => ixIabNamesForKey([v2(n)], key).notSupported.length > 0)
    const unsupportedInclude = unsupported(includeNames)
    const unsupportedExclude = unsupported(excludeNames)
    const ixSplitNames = [...unsupportedInclude, ...unsupportedExclude]
      .filter(n => ixIabNamesForKey([v2(n)], other).notSupported.length === 0)
    return { unsupportedInclude, unsupportedExclude, ixKey: key, ixSplitNames }
  }
  const perName: Record<string, (names: string[]) => { notSupported: string[] }> = {
    'OpenX': oxIabNames,
    'PubMatic': pmIabNames,
    'Xandr': xnIabNames,
    'Media.net': mnIabNames,
  }
  const partition = perName[ssp]
  const unsupported = partition
    ? (names: string[]) => names.filter(n => partition([v2(n)]).notSupported.length > 0)
    : ssp === 'TripleLift' || ssp === 'Magnite'
      ? (names: string[]) => [...names] // no category surface at all — nothing carries
      : () => []
  return {
    unsupportedInclude: unsupported(includeNames),
    unsupportedExclude: unsupported(excludeNames),
    ixSplitNames: [],
  }
}

// OpenX demand_partner expects the EXACT catalog name from
// ox_list_demand_partners — the OpenX MCP resolver is exact id/name match
// (no fuzzy/contains), so a bare brand like "DV360" fails
// demand_partner_unresolved (live: DEAL07273 batch, 2026-08-03, where every
// OpenX create needed an in-run correction to "DV360 - RTB"). Values below
// are verbatim from the live catalog.
const OPENX_DEMAND_PARTNER: Record<string, string> = {
  'The Trade Desk': 'The Trade Desk - RTB',
  'The Trade Desk - RTB': 'The Trade Desk - RTB',
  'TTD': 'The Trade Desk - RTB',
  'DV360': 'DV360 - RTB',
  'Amazon DSP': 'Amazon DSP - RTB',
  'Yahoo DSP': 'Yahoo DSP - RTB',
  'Xandr Invest': 'Xandr - RTB',
  'TRADR': 'Bidswitch - RTB',
}

// OpenX buyer_ids fall back to the deal's DSP seat id for EVERY DSP when the
// trader didn't pick explicit OpenX buyers. The seat id resolves through the
// OpenX buyer directory (live: DV360 seat 849138 → deal 567463867, DEAL07273
// 2026-08-03; TTD seat 5904 present in the directory 2026-08-13), and the
// MCP fail-closes with invalid_buyer_ids when a seat isn't registered under
// the demand partner — so a bad seat fails loudly instead of misrouting.
// History: this fallback used to fire ONLY for DV360 (whose creates OpenX
// hard-rejects without a buyer). Every other DSP accepted buyer-less creates,
// so the trader's seat was silently dropped and the deal was open to ANY seat
// on the demand partner (a live batch DEAL00188, 2026-08-13: four TTD deals
// shipped with buyer_ids=[] while the same seat WAS applied on IX/PubMatic).

// Xandr buyer routing (#231, cutlass#734): the Cutlass MCP resolves a
// buyer NAME via the GET /platform-member directory (~16k rows, fails loud on
// ambiguity), but a NUMERIC id skips resolution entirely (the documented
// escape hatch) — so Deal Onboarding routes each DSP deterministically. House buyer
// member ids live-verified via /platform-member (primary_type=buyer,
// 2026-07-09 audit probe): The Trade Desk → 1088, Yahoo DSP → 2975. Mirrors
// OPENX_DEMAND_PARTNER; ids are Xandr-specific — NEVER copied to another SSP.
// Exported for the contract suite (pinned against cutlass-contract.json).
export const XANDR_BUYER_CANONICAL: Record<string, string> = {
  'The Trade Desk': '1088',
  'The Trade Desk - RTB': '1088',
  'TTD': '1088',
  'Yahoo DSP': '2975',
}

// DSPs with NO house buyer member on Xandr (live-probed 2026-07-09: zero
// /platform-member buyer rows): these deals buy through the agency/advertiser
// member, so route by the trader's NUMERIC seat id — never fuzzy name
// matching. A non-numeric seat falls back to the name (the MCP fails loud);
// an id is never guessed. Exported for the contract suite.
export const XANDR_SEAT_ROUTED_DSPS: ReadonlySet<string> = new Set(['DV360', 'Amazon DSP', 'Amazon'])

const COUNTRY_ISO3: Record<string, string> = {
  US: 'USA', CA: 'CAN', GB: 'GBR', AU: 'AUS', DE: 'DEU', FR: 'FRA',
  ES: 'ESP', IT: 'ITA', JP: 'JPN', MX: 'MEX', BR: 'BRA', IN: 'IND',
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', AU: 'Australia',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', JP: 'Japan',
  MX: 'Mexico', BR: 'Brazil', IN: 'India',
}

const STATE_CODE: Record<string, string> = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
  'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
  'District of Columbia': 'DC', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI',
  'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME',
  'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
  'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE',
  'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
  'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA',
  'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
}

// Canadian provinces/territories — full name → 2-letter code, kept beside
// STATE_CODE so resolve() can classify every subnational geo entry as a US
// state, a CA province, or unknown (cutlass#724 / #223: a bare "SK"
// fed to OpenX used to validate as the COUNTRY Slovakia). No abbreviation
// overlaps STATE_CODE's, so classification is deterministic.
const CA_PROVINCE_CODE: Record<string, string> = {
  'Alberta': 'AB', 'British Columbia': 'BC', 'Manitoba': 'MB', 'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL', 'Nova Scotia': 'NS', 'Northwest Territories': 'NT',
  'Nunavut': 'NU', 'Ontario': 'ON', 'Prince Edward Island': 'PE', 'Quebec': 'QC',
  'Saskatchewan': 'SK', 'Yukon': 'YT',
}

// Case-insensitive lookups derived from the tables above.
const US_STATE_NAME_LOWER: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_CODE).map(([name, code]) => [name.toLowerCase(), code]))
const CA_PROVINCE_NAME_LOWER: Record<string, string> = Object.fromEntries(
  Object.entries(CA_PROVINCE_CODE).map(([name, code]) => [name.toLowerCase(), code]))
const US_STATE_ABBREVS = new Set(Object.values(STATE_CODE))
const CA_PROVINCE_ABBREVS = new Set(Object.values(CA_PROVINCE_CODE))

/** Classify a typed subnational geo entry. Returns the canonical 2-letter code
 *  plus its country ('US' | 'CA'), or country null for unclassifiable input
 *  (the geo_classification audit rule fails those before submit). */
export function classifyGeoState(raw: string): { code: string; country: 'US' | 'CA' | null } {
  // Collapse inner whitespace runs to a single space — IDENTICAL normalization
  // to the Go audit's normalizeGeoToken (strings.Fields + Join). Without this
  // (#244 F1 MUST-FIX 2) a token like "New  York" (double space)
  // classified US in Go — so geo_exclude_unsupported PASSED and the batch
  // submitted — but bucketed UNKNOWN here, so the builder emitted NO exclude
  // arg (only a NOT-SUPPORTED marker) and the deal was created WITHOUT the
  // exclusion: a silent geo-exclude drop. Both sides MUST classify the same.
  const t = raw.trim().replace(/\s+/g, ' ')
  const lower = t.toLowerCase()
  const upper = t.toUpperCase()
  if (US_STATE_NAME_LOWER[lower]) return { code: US_STATE_NAME_LOWER[lower], country: 'US' }
  if (US_STATE_ABBREVS.has(upper)) return { code: upper, country: 'US' }
  if (CA_PROVINCE_NAME_LOWER[lower]) return { code: CA_PROVINCE_NAME_LOWER[lower], country: 'CA' }
  if (CA_PROVINCE_ABBREVS.has(upper)) return { code: upper, country: 'CA' }
  return { code: t, country: null }
}

export const exclusionOverridePhrase = (ssp: string): string =>
  `CREATE ON ${ssp.trim()} WITHOUT THESE EXCLUSIONS`

export interface ExclusionOverrideDetails {
  deal_id: string
  ssp: string
  audience: string[]
  geo: string[]
  source: 'trader'
}

/** Canonical client-side mirror of validation.ActiveExclusionOverride. It
 * computes the exact values stripped from prompt_inputs; the server recomputes
 * and verifies the same marker before dispatch and supplies actor/time itself. */
export function activeExclusionOverride(form: FormData, deal: DealEntry): ExclusionOverrideDetails | null {
  const detail: ExclusionOverrideDetails = {
    deal_id: deal.id.trim(), ssp: (deal.ssp || '').trim(), audience: [], geo: [], source: 'trader',
  }
  if (!deal.exclusionOverride || deal.exclusionOverride.ssp.trim() !== detail.ssp ||
      deal.exclusionOverride.acknowledgement.trim() !== exclusionOverridePhrase(detail.ssp)) return null

  const audienceSupported = detail.ssp === 'Index Exchange' || detail.ssp === 'PubMatic' || detail.ssp === 'Xandr' ||
    (detail.ssp === 'Magnite' && (deal.channel === 'CTV' || deal.channel === 'OTT'))
  if (!audienceSupported) {
    detail.audience = Array.from(new Set(deal.excludeSegments.map(s => s.trim()).filter(Boolean)))
  }

  const excludes = deal.geoExclude.length ? deal.geoExclude : form.defaultGeoExclude
  const includes = deal.geoInclude.length ? deal.geoInclude : form.defaultGeoInclude
  const has = (rows: GeoEntry[], type: GeoEntry['type']) => rows.some(g => g.type === type && g.value.trim())
  let geoBlocked = excludes.length > 0 && !['OpenX', 'PubMatic', 'Xandr', 'Magnite'].includes(detail.ssp)
  if (has(excludes, 'zip') || has(excludes, 'dma')) geoBlocked = true
  const exStates = excludes.filter(g => g.type === 'state' && g.value.trim())
  const exCountries = has(excludes, 'country')
  if (detail.ssp === 'Magnite' && (exStates.length > 0 || (exCountries && has(includes, 'country')))) geoBlocked = true
  if (detail.ssp === 'Xandr' && ((exStates.length > 0 && has(includes, 'state')) || (exCountries && has(includes, 'country')))) geoBlocked = true
  if (detail.ssp === 'OpenX' && exStates.length > 0 && exCountries) geoBlocked = true
  if ((detail.ssp === 'OpenX' || detail.ssp === 'PubMatic') && exStates.length > 0) {
    const countries = new Set(exStates.map(g => classifyGeoState(g.value).country))
    if (countries.has(null) || countries.size > 1) geoBlocked = true
  }
  if (geoBlocked) {
    detail.geo = Array.from(new Set(excludes
      .filter(g => g.value.trim())
      .map(g => `${g.type.trim()}:${g.value.trim()}`)))
  }
  return detail.audience.length > 0 || detail.geo.length > 0 ? detail : null
}

// IAB v2 codes → human names. SSPs that accept names: IX, OpenX, Xandr,
// Media.net, TripleLift. PubMatic accepts both code and name.
const IAB_V2_NAMES: Record<string, string> = {
  'IAB1-1': 'Books & Literature',
  'IAB1-2': 'Celebrity Fan/Gossip',
  'IAB1-3': 'Fine Art',
  'IAB1-4': 'Humor',
  'IAB1-5': 'Movies',
  'IAB1-6': 'Music',
  'IAB1-7': 'Television',
  'IAB2-1': 'Automotive',
  'IAB2-2': 'Auto Body Styles',
  'IAB2-3': 'Auto Parts',
  'IAB2-4': 'Auto Repair',
  'IAB2-5': 'Buying/Selling Cars',
  'IAB2-6': 'Car Culture',
  'IAB2-7': 'Certified Pre-Owned',
}

// PubMatic uses numbered codes for ad formats and platforms.
// Ad-format enum (cutlass#727, live-verified 2026-07-09): Banner=3, Video=13
// — five production read-backs across UI + pipeline eras ALL carry Video id
// 13; id 12 is a legacy value PubMatic silently normalizes to 13 server-side
// (no live deal carries 12 as video). 'Native (13)' is GONE: 13 is Video —
// the old label booked live VIDEO deals as "Native". Native's REAL id is 12,
// per PubMatic's own catalog (authenticated GET /v1/common/adType,
// 2026-08-03: 3=Banner/Rich Media, 12=Native, 13=Video, 14=Audio uiEnabled=0)
// — this supersedes cutlass#754's "vendor-blocked" finding, and Cutlass no
// longer rewrites 12→13 (the rewrite would book a Native deal as Video).
// The old 'Video (12)' persisted-form alias still resolves to real Video 13
// (those forms MEANT video); only the explicit 'Native (12)' label maps to 12.
const PUBMATIC_AD_FORMAT_ID: Record<string, number> = {
  'Banner (3)': 3,
  'Video (13)': 13,
  'Video (12)': 13,  // legacy persisted-form alias — resolves to real Video
  'Native (12)': 12,
}
// Curated Deals platform enum (audited 2026-06-12): 1 Web, 2 Mobile Web,
// 4 Mobile App iOS, 5 Mobile App Android, 7 CTV. The legacy 'CTV (5)' label
// was a mislabel — 5 is Android in-app — and is kept ONLY as an alias so
// forms persisted in localStorage before the fix still resolve to real CTV.
const PUBMATIC_PLATFORM_ID: Record<string, number> = {
  'Desktop (1)': 1,
  'Mobile Web (2)': 2,
  'Mobile App (4)': 4,
  'Mobile App Android (5)': 5,
  'CTV (7)': 7,
  'CTV (5)': 7,  // legacy persisted-form alias — resolves to real CTV
}
// Channel → ad-format fallback. Native maps to 12 per PubMatic's adType
// catalog (2026-08-03) — requires the Cutlass build that dropped the 12→13
// rewrite (cutlass PR #862). Deliberately NO 'Audio' entry: Audio (14) is
// uiEnabled=0 in the catalog, so an Audio channel with no explicit selection
// emits a fail-closed <FILL> that the server unresolved-token gate blocks —
// never a silently mislabeled deal.
const PUBMATIC_AD_FORMAT_FOR_CHANNEL: Record<string, number> = {
  'Display': 3, 'OLV (Online Video)': 13, 'CTV': 13, 'OTT': 13, 'Native': 12,
}
const PUBMATIC_PLATFORMS_FOR_INV: Record<string, number[]> = {
  'Web Only': [1, 2],
  // 4 = Mobile App iOS, 5 = Mobile App Android — In-App means BOTH. The old
  // [4] shipped In-App PubMatic deals iOS-only, silently dropping every
  // Android app impression (found in the 2026-08-11 environment audit).
  'In-App': [4, 5],
  'All': [1, 2, 4, 5],
}

// Channel hint per SSP — drives MCP server-side device-default expansion.
// OTT is intentionally distinct from CTV: CTV → CTV-device defaults
// (Connected TV / Set-top box). OTT → Video format on phone + tablet + PC,
// app-only. Per cutlass/protocols/deal-brief.schema.yaml. The per-SSP MCPs
// branch on this hint to set the right device + creative defaults.
const SSP_CHANNEL_HINT: Record<string, Record<string, string>> = {
  ix: {
    'Display': 'display', 'OLV (Online Video)': 'olv', 'CTV': 'ctv', 'OTT': 'ott',
    // Native is a first-class IX deal_type (creative=Native_ANY on the Display
    // device/inventory footprint) — folding it into 'display' booked every IX
    // Native deal with Banner_ANY creative targeting (fixed 2026-08-21;
    // Native_ANY confirmed in the live creativeTypeSize catalog).
    'Native': 'native', 'Audio': 'olv',
  },
  pubmatic: {
    'Display': 'display', 'OLV (Online Video)': 'olv', 'CTV': 'ctv', 'OTT': 'ott',
    'Native': 'native', 'Audio': 'olv',
  },
  xandr: {
    'Display': 'display', 'OLV (Online Video)': 'olv', 'CTV': 'ctv', 'OTT': 'ott',
    'Native': 'display', 'Audio': 'olv',
  },
  medianet: {
    'Display': 'display', 'OLV (Online Video)': 'olv', 'CTV': 'ctv', 'OTT': 'ott',
    'Native': 'display', 'Audio': 'olv',
  },
  // Magnite's channel doubles as PLATFORM ROUTING: ctv/ott → SpringServe
  // (Streaming), display/olv → DV+ (the MCP normalizes via
  // MAGNITE_SOURCE_ALIASES).
  //
  // OTT maps to 'ott', NOT 'olv'. Streaming carries the streaming-video
  // products — CTV and OTT alike — and all 14 live Magnite OTT deals sit
  // there (DV+ holds zero, verified 2026-08-31). Routing OTT to DV+ also
  // silently dropped its audience segments, because DV+ has no audience API
  // until Magnite v3.0. Audio still routes to DV+ (audio deals need
  // feedTypes, passed via the raw targeting/extra escape hatch).
  magnite: {
    'Display': 'display', 'OLV (Online Video)': 'olv', 'CTV': 'ctv', 'OTT': 'ott',
    'Native': 'display', 'Audio': 'olv',
  },
}

// Xandr ad_types per channel (passed as list[str]).
// Xandr ad_types per channel. The Curate deal builder offers exactly three Ad
// Types — Banner, Video, Native — so there is deliberately NO 'Audio' entry:
// it used to emit ad_types:['audio'], a value Curate does not offer and the
// Xandr MCP has no handling for. Audio now fails closed instead.
const XANDR_AD_TYPES: Record<string, string[]> = {
  'Display': ['banner'], 'OLV (Online Video)': ['video'], 'CTV': ['video'], 'OTT': ['video'],
  'Native': ['native'],
}

// Media.net ad_format ints — VENDOR enum Banner=0, Native=1, Video=2 (Select
// API Guide v9.4 p.12-13/p.23; the official Select MCP schema; live account
// read-backs — NEVER re-derive from cutlass code constants, which once shipped
// inverted and booked OLV/CTV/OTT deals as Native, #222/cutlass#719).
// OLV/CTV/OTT/Audio are Video(2); Display is Banner(0); Native is 1.
const MEDIANET_AD_FORMAT_ID: Record<string, number> = {
  'Display': 0, 'OLV (Online Video)': 2, 'CTV': 2, 'OTT': 2, 'Native': 1, 'Audio': 2,
}

// TripleLift commercializedFormats per channel (uppercase enum values).
const TRIPLELIFT_FORMATS_FOR_CHANNEL: Record<string, string[]> = {
  'Display': ['DISPLAY', 'IMAGE'],
  'OLV (Online Video)': ['OUTSTREAM', 'INSTREAM'],
  'CTV': ['INSTREAM'],
  'OTT': ['INSTREAM'],
  'Native': ['DISPLAY'],
  'Audio': ['INSTREAM'],
}

// =============================================================================
// YAML / value helpers
// =============================================================================

export function quote(s: string | number | undefined | null): string {
  if (s === undefined || s === null) return '""'
  const v = String(s)
  if (v === '') return '""'
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(v)) return v
  // Escape backslash + quote, then newlines and every other control char so a
  // value containing "\n" (e.g. a pasted nameOverride) can never break out of
  // the double-quoted YAML scalar and corrupt the emitted document.
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  return `"${escaped}"`
}

export function inlineList(items: (string | number)[]): string {
  if (items.length === 0) return '[]'
  return '[' + items.map(i => typeof i === 'number' ? String(i) : quote(i)).join(', ') + ']'
}

export function blockList(items: string[], indent: string): string[] {
  return items.map(i => `${indent}- ${quote(i)}`)
}

/** Convert ISO date YYYY-MM-DD to MCP-required datetime "YYYY-MM-DD HH:MM:SS". */
function isoDateTime(date: string, timeOfDay: 'start' | 'end'): string {
  if (!date) return ''
  const time = timeOfDay === 'start' ? '00:00:00' : '23:59:59'
  return `${date} ${time}`
}

// businessTodayISO / BUSINESS_TIMEZONE live in the flight-date policy module
// (flightDates.ts) so record builders can share them without pulling
// this whole prompt builder in; re-exported here for existing importers.
import { BUSINESS_TIMEZONE, businessTodayISO } from './flightDates'
export { BUSINESS_TIMEZONE, businessTodayISO }

/** UTC offset (minutes east of UTC) of BUSINESS_TIMEZONE at a UTC instant. */
function businessTzOffsetMinutes(utc: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(utc)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return Math.round((asUtc - utc.getTime()) / 60000)
}

/** The instant "midnight of `date` in the business timezone" expressed as a
 *  UTC "YYYY-MM-DD HH:MM:SS" string — e.g. "2026-07-15" → "2026-07-15
 *  04:00:00" (EDT) and "2026-12-15" → "2026-12-15 05:00:00" (EST). Xandr's
 *  Deal Service stores naive datetimes as UTC (cutlass#744.8 — live-verified;
 *  the protocol's old "local time" claim was wrong), so the legacy bare
 *  "YYYY-MM-DD 00:00:00" emission went live at 19:00/20:00 ET the PRIOR
 *  calendar day. Handles the DST-transition edge by re-deriving the offset at
 *  the candidate instant. Exported for tests. */
export function businessMidnightUtc(date: string): string {
  if (!date) return ''
  const guess = new Date(`${date}T00:00:00Z`)
  const offset = businessTzOffsetMinutes(guess)
  let result = new Date(guess.getTime() - offset * 60000)
  const offsetAtResult = businessTzOffsetMinutes(result)
  if (offsetAtResult !== offset) result = new Date(guess.getTime() - offsetAtResult * 60000)
  const iso = result.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

// =============================================================================
// Shared resolvers
// =============================================================================

interface Resolved {
  channel: string
  isVideo: boolean
  inv: string
  cpm: string
  vcr: string
  viewabilityFraction: string
  viewabilityPct: string                // 0-100 integer/float for SSPs that want %
  /** Ad-duration targeting, integer SECONDS — resolved ONLY when the channel
   *  supports it (dealSupportsAdDuration: CTV/OLV/OTT; never Display/Native/
   *  Audio — stray values on those channels resolve to unset here and the Go
   *  QA item qa_ad_duration flags them, so nothing is dropped silently).
   *  adDurations = the allowed creative lengths (sorted unique); empty when
   *  the deal expressed a max cap instead. */
  adDurations: number[]
  /** The "cap at N seconds" alternative. undefined when adDurations is set —
   *  the two are brief-schema alternatives and the allowed list wins. */
  maxAdDurationSecs: number | undefined
  /** Derived contiguous bounds for range-only SSPs: lo = min(adDurations);
   *  max-only requirements have NO lo (a cap has no lower bound — see the
   *  per-SSP builders). hi = max(adDurations) or the max cap. */
  adDurationLo: number | undefined
  adDurationHi: number | undefined
  countriesIso2: string[]
  countriesIso3: string[]
  countriesNames: string[]
  /** All subnational codes in classification order (US, then CA, then unknown
   *  verbatim) — the legacy union the flat geo_states emitters consume. */
  states: string[]                      // 2-letter codes
  /** Classified subnational geo (cutlass#724): US state codes, Canadian
   *  province codes, and entries that classify as neither. The OpenX builder
   *  emits the structured {includes:{state,country}} dict from these; the
   *  geo_classification audit rule fails unknown/mixed entries pre-submit. */
  statesUS: string[]
  provincesCA: string[]
  statesUnknown: string[]
  zips: string[]                        // postal codes (geoInclude type 'zip')
  dmas: string[]                        // Nielsen DMA numbers (geoInclude type 'dma')
  /** Geo EXCLUSIONS (#244) — the deal's geoExclude chips (falling
   *  back to the form default, mirroring geoInclude). Classified exactly
   *  like the includes so each SSP builder can emit the exclusion on its
   *  documented exclude wire (PubMatic excludeGeos, Xandr *_action,
   *  Magnite geo_countries_exclude, OpenX geographic.excludes) or fail
   *  LOUD — never silently drop it (the deal would SERVE the excluded
   *  geo). The geo_exclude_unsupported audit rule blocks any exclusion no
   *  builder can carry. */
  excludeCountriesIso2: string[]
  excludeCountriesNames: string[]
  excludeStates: string[]               // union, classification order (US, CA, unknown)
  excludeStatesUS: string[]
  excludeProvincesCA: string[]
  excludeStatesUnknown: string[]
  excludeZips: string[]
  excludeDmas: string[]
  segmentsInclude: string[]
  segmentsExclude: string[]
  iabResolved: string[]                 // human names
  iabExcludeResolved: string[]          // human names — explicit exclusions only, never inferred
  // The file selected for THIS deal. Despite the legacy "domain" name, this
  // can be either a domain list or an app-bundle list — fileKind disambiguates.
  // The pick comes from resolve()'s channel-aware routing: web channels read
  // domainLists, CTV/In-App read appBundleLists. Used by the single-file SSP
  // builders (IX, PubMatic, Media.net, Magnite).
  domainFile: UploadedFile | undefined
  fileKind: 'domain' | 'app_bundle' | undefined
  domainOp: 'ANY_OF' | 'NONE_OF'
  domainOpInclude: 'Include' | 'Exclude'
  // Channel-independent file picks, one per pool. OpenX targets web domains
  // (url_targeting) and app bundles (app_inventory.app_bundle_id) as DISTINCT
  // dimensions, so a single OpenX deal may carry BOTH. These are populated
  // regardless of channel; the OpenX builder emits a block for each that exists.
  webDomainFile: UploadedFile | undefined
  appBundleFile: UploadedFile | undefined
  language: string
  curator: string
  firstDspName: string
  firstSeatId: string
  /** The seat field split into individual buyer-seat tokens. Length > 1 only
   *  when the trader pinned the deal to several seats (comma-separated), which
   *  the seat_multi audit rule confines to Magnite-only batches — Magnite is
   *  the one SSP whose create takes a buyer LIST. Every other builder keeps
   *  using the single firstSeatId. */
  firstSeatIds: string[]
  /** Effective start date the writer should emit. Equals form.flightStartDate
   *  except when that date is in the past, in which case it's bumped forward
   *  to today (IX rejects past start dates at create time). */
  startDate: string
  /** True when startDate was auto-bumped from form.flightStartDate to today.
   *  The writer emits a `# Auto-bumped from <original>` comment so the
   *  trader sees what happened. */
  startDateBumped: boolean
  /** The original form value, only set when bumped — purely for the comment. */
  startDateOriginal: string
  endDate: string
}

/** Mirror of Go's filepath.Ext for a display name: the suffix beginning at the
 *  final dot in the final slash-separated element, or '' when there is no dot.
 *  Kept semantics-identical to the server (lists.List.UploadName uses
 *  filepath.Ext) so the two sides can never disagree about whether a list name
 *  "already has an extension". */
function goPathExt(name: string): string {
  for (let i = name.length - 1; i >= 0 && name[i] !== '/'; i--) {
    if (name[i] === '.') return name.slice(i)
  }
  return ''
}

// The DATA extensions a list file may carry — the same allowlist the Go server
// uses (lists.dataFileExts / the upload handler). UploadName appends the data
// extension unless the NAME already ends in one of these, so a version-
// suffixed name ("Sites v2.1") whose bare filepath.Ext is ".1" still gains a
// real ".csv" (#198 FIX 8) instead of being mistaken for an already-extensioned
// file and re-triggering the IX-reject / OpenX-misroute class.
const DATA_FILE_EXTS = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xls'])

// Character class of Go's unicode.White_Space (what strings.TrimSpace strips),
// deliberately EXCLUDING U+FEFF (BOM): Go's TrimSpace does NOT strip a leading
// BOM, and it DOES strip U+0085 (NEL) — JS's native String.trim() does the
// opposite on both. goTrimSpace matches Go exactly so standardListUploadName
// and lists.List.UploadName agree byte-for-byte on a pasted-BOM / NEL name
// (#198 FIX 7) instead of the frontend name diverging and tripping a
// fail-closed #221 422 false-block.
const GO_WS = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000'
const GO_WS_LEADING = new RegExp(`^[${GO_WS}]+`)
const GO_WS_TRAILING = new RegExp(`[${GO_WS}]+$`)
function goTrimSpace(s: string): string {
  return s.replace(GO_WS_LEADING, '').replace(GO_WS_TRAILING, '')
}

/** The exact attachment name a standard list travels under (#198): the human
 *  list name with the data file's extension (Summary.file_ext) appended unless
 *  the name already ends in a recognized DATA extension. BYTE-IDENTICAL to the
 *  server's lists.List.UploadName — the runner upload display name — so the
 *  prompt's file reference matches the uploaded file exactly (IX rejects an
 *  extensionless list outright; OpenX routes .csv vs .xlsx to different
 *  parsers; a server-only rename would degrade the agent's name match to
 *  fuzzy). Normalization mirrors Go strings.TrimSpace (goTrimSpace) and the
 *  blank-name → data-file-basename fallback (Summary.file_base), so a
 *  pasted-BOM, NEL, or nameless list can't derive a name that diverges from
 *  the server's and false-block on #221. A name already ending in a data
 *  extension is never double-suffixed; a version-suffixed name is not mistaken
 *  for one. Exported for the submit call sites (validateBrief listNames) and
 *  tests. */
export function standardListUploadName(l: StandardList): string {
  let name = goTrimSpace(l.name)
  if (name === '') name = l.file_base || ''
  if (!DATA_FILE_EXTS.has(goPathExt(name).toLowerCase())) return name + (l.file_ext || '')
  return name
}

// Resolve a StandardList to a synthetic UploadedFile so downstream code
// treats ad-hoc uploads and curated lists uniformly. Kind translates to
// inclusionType (allow → Include, block → Exclude). The name is the list's
// UploadName (name + data-file extension, #198) — the exact display name the
// server uploads the list to the runner under — so dealFilePath's emission matches
// the upload byte-for-byte. The path is /input/<name> matching the convention
// dealFilePath uses for files served from disk.
// detectedColumn is pinned to the scope's canonical header: every curated
// lists/*.csv now carries a literal `Sites` / `Bundles` first row (contract
// enforced by internal/lists' header test), so the emitted column states the
// truth rather than riding fileArgsBlock's silent fallback. Exported for tests.
export function standardListAsFile(l: StandardList): UploadedFile {
  return {
    id: 'list:' + l.id,
    name: standardListUploadName(l),
    size: 0,
    path: `/input/${l.id}`,
    inclusionType: l.kind === 'block' ? 'Exclude' : 'Include',
    detectedColumn: l.scope === 'app_bundle' ? 'Bundles' : 'Sites',
  }
}

// pickPrimaryFile materializes the single file that the current YAML wire
// format can carry. Until the runner + each SSP MCP confirms multi-file support,
// we collapse the candidate set with these rules (user-chosen 2026-05-20):
//   1. Block-kind file wins over Allow-kind file
//   2. Ad-hoc uploads sort before standard lists within a kind, so a trader
//      who explicitly uploads a one-off file overrides a global default
//   3. First in declared order otherwise
// Returns undefined when no files apply.
function pickPrimaryFile(uploads: UploadedFile[], standard: StandardList[]): UploadedFile | undefined {
  const adHoc: UploadedFile[] = uploads.filter(f => f.inclusionType === 'Include' || f.inclusionType === 'Exclude')
  const fromStandard: UploadedFile[] = standard.map(standardListAsFile)
  const all = [...adHoc, ...fromStandard]
  const blocks = all.filter(f => f.inclusionType === 'Exclude')
  if (blocks.length > 0) return blocks[0]
  const allows = all.filter(f => f.inclusionType === 'Include')
  if (allows.length > 0) return allows[0]
  return undefined
}

// findListFile resolves a per-deal list id to a concrete file. The id may point
// at an ad-hoc upload (form.domainLists/appBundleLists) or a standard list.
// Returns undefined for an unknown id (treated as "no list" — better than
// silently falling back to the campaign default the trader was overriding).
function findListFile(id: string, uploads: UploadedFile[], standardLists: StandardList[], scope: 'domain' | 'app_bundle'): UploadedFile | undefined {
  const upload = uploads.find(f => f.id === id)
  if (upload) return upload
  const std = standardLists.find(l => l.id === id && l.scope === scope)
  return std ? standardListAsFile(std) : undefined
}

// pickPerDealOrDefault applies the three-state per-deal override:
//   undefined → campaign default (the supplied default pick)
//   ''        → explicitly no list
//   '<id>'    → that specific list
function pickPerDealOrDefault(listId: string | undefined, uploads: UploadedFile[], standardLists: StandardList[], scope: 'domain' | 'app_bundle', fallback: UploadedFile | undefined): UploadedFile | undefined {
  if (listId === undefined) return fallback
  if (listId === '') return undefined
  return findListFile(listId, uploads, standardLists, scope)
}

/** collectSubmitListIds computes the FULL standard-list attachment set for a
 *  batch submit (#221): the batch-level applied ids PLUS every per-deal
 *  domainListId/appBundleListId (on a deal this batch will CREATE) that
 *  resolves to a standard list of the matching scope. Both submit call sites
 *  (DealBuilder handleConfirmCreate + DealPromptOutput SendToMocButton)
 *  MUST use this instead of the applied ids alone — the prompt pipeline
 *  honors per-deal picks (resolve() → pickPerDealOrDefault → findListFile),
 *  so a per-deal standard list absent from POST /api/runner/create listIds is
 *  referenced by name in the prompt but never uploaded to the runner: IX/OpenX/
 *  PubMatic then fail missing_domain_file, and Media.net creates the deal
 *  LIVE and cannot apply the list. Excluded by construction: '' ("no list"
 *  override), unknown ids, ad-hoc upload ids (those ride filePaths), and
 *  wrong-scope ids (they resolve to no file in the prompt). Co-located with
 *  findListFile so the union can never drift from what the prompts reference. */
export function collectSubmitListIds(form: FormData, standardLists: StandardList[]): string[] {
  const ids = new Set<string>()
  // Applied ids resolve against the registry the same way the prompt builders
  // do (buildBatchPrompt only references applied lists found in standardLists),
  // so an id the registry doesn't know is invisible to the prompt — shipping
  // it anyway only trips the server's fail-closed standard-list gate on every
  // retry. Seen live when an LLM-authored draft leaked an
  // ATTACHMENT id into appliedAppBundleListIds (DEAL07300, 2026-08-24); the
  // attachment itself still rides filePaths, so dropping the id loses nothing.
  for (const id of [...form.appliedDomainListIds, ...form.appliedAppBundleListIds]) {
    if (id.trim() !== '' && standardLists.some(l => l.id === id)) ids.add(id)
  }
  for (const d of splitBatchDeals(form.deals).createDeals) {
    for (const [id, scope] of [[d.domainListId, 'domain'], [d.appBundleListId, 'app_bundle']] as const) {
      if (id && standardLists.some(l => l.id === id && l.scope === scope)) ids.add(id)
    }
  }
  return [...ids]
}

/** A deal's resolved ad-duration requirement (brief-schema `ad_duration`,
 *  cutlass deal-brief.schema.yaml v1.1). Integer SECONDS throughout. */
export interface AdDurationRequirement {
  /** Allowed creative lengths — sorted, deduped, positive integers. Empty
   *  when the deal expressed a max cap instead of a list. */
  allowed: number[]
  /** The "cap at N seconds" alternative (ad_duration.max_seconds). undefined
   *  when `allowed` is non-empty — the schema forbids carrying both and the
   *  allowed list is the stricter constraint (Go QA warns when a form carries
   *  both and they disagree). */
  maxSecs: number | undefined
  /** Range-mapping lower bound: min(allowed). A max-only requirement has NO
   *  lo — a cap says nothing about a minimum length. */
  lo: number | undefined
  /** Range-mapping upper bound: max(allowed), or the max cap. */
  hi: number
}

/** Resolve a deal's ad-duration fields into the canonical requirement, or
 *  null when none applies: unsupported channel (only CTV/OLV/OTT can carry
 *  ad_duration — dealSupportsAdDuration) or no parseable values. Parsing is
 *  STRICT — digits only (/^\d+$/, the same pattern as dealUpdateOps'
 *  parseDurationSecondsList) — to match the Go QA layer's strconv.Atoi: an
 *  entry like '1e3' or '15.5' is DROPPED, never mangled by lenient parseInt
 *  into 1/15, so the qa_ad_duration warning is the single truthful signal
 *  and a value the trader never typed can never ride into an SSP payload.
 *  Strict parsing guarantees drop-not-mangle; the drop itself is surfaced by
 *  the Go QA item, which flags every non-integer entry loudly.
 *  Shared by resolve(), the batch prompt's Required-final-summary gate, and
 *  the structured brief (dealBrief.ts) so they can never disagree. */
export function resolveAdDuration(deal: DealEntry): AdDurationRequirement | null {
  const channel = deal.channel || 'Display'
  if (!dealSupportsAdDuration(channel)) return null
  const allowed = Array.from(new Set(
    (deal.adDurations || [])
      .map(s => String(s).trim())
      .filter(s => /^\d+$/.test(s))
      .map(s => parseInt(s, 10))
      .filter(n => n > 0),
  )).sort((a, b) => a - b)
  const maxRaw = (deal.maxAdDurationSecs || '').trim()
  const maxParsed = /^\d+$/.test(maxRaw) ? parseInt(maxRaw, 10) : NaN
  const maxSecs = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : undefined
  if (allowed.length > 0) {
    return { allowed, maxSecs: undefined, lo: allowed[0], hi: allowed[allowed.length - 1] }
  }
  if (maxSecs !== undefined) {
    return { allowed: [], maxSecs, lo: undefined, hi: maxSecs }
  }
  return null
}

/** Human-readable form of the requirement for comments — feeds the
 *  NOT-SUPPORTED pattern, e.g. "allowed durations [15, 30]s" / "max 30s". */
function describeAdDurationRequest(r: Resolved): string {
  return r.adDurations.length > 0
    ? `allowed durations ${inlineList(r.adDurations)}s`
    : `max ${r.maxAdDurationSecs}s`
}

/** True when the deal carries an ad-duration requirement the prompt must
 *  express — or loudly refuse (never silently drop). */
function hasAdDurationRequest(r: Resolved): boolean {
  return r.adDurations.length > 0 || r.maxAdDurationSecs !== undefined
}

/** The fail-loud NOT-SUPPORTED comment for SSPs with NO deal-level
 *  ad-duration API (PubMatic + TripleLift — vendor-verified 2026-07-08).
 *  Mirrors the Magnite DV+-audience / Media.net post-create comment style:
 *  a loud comment instead of a guessed arg, tied to the batch prompt's
 *  Required-final-summary NOT APPLIED line. */
function adDurationNotSupportedLines(r: Resolved, ssp: string): string[] {
  if (!hasAdDurationRequest(r)) return []
  return [
    `# NOT SUPPORTED: ad-duration targeting (${describeAdDurationRequest(r)}) — ${ssp} has no deal-level ad-duration API;`,
    `# cannot be applied on this SSP; report as NOT APPLIED in the final summary.`,
  ]
}

/** The fail-loud comment for SSPs whose create API cannot express IAB /
 *  content-genre EXCLUSIONS (OpenX + Media.net: post-create update tools
 *  only; Magnite/Xandr/TripleLift: no IAB/genre exclude surface at all —
 *  only IX and PubMatic take create-time excludes). Mirrors
 *  adDurationNotSupportedLines: a loud comment instead of a guessed arg,
 *  tied to the batch prompt's Required-final-summary trader-follow-up line —
 *  an exclusion is never silently dropped. */
function iabExcludeNotSupportedLines(r: Resolved, ssp: string): string[] {
  if (r.iabExcludeResolved.length === 0) return []
  return [
    `# IAB/content EXCLUSIONS requested but NOT supported by the ${ssp} create API — trader must apply in the SSP UI: ${r.iabExcludeResolved.join(', ')}`,
    `# Do NOT guess an exclude arg; report these as trader UI follow-ups in the final summary.`,
  ]
}

// =============================================================================
// Silent-drop guards (#226/#244) — one loud NOT-SUPPORTED marker per
// (dimension, SSP) pair the wire cannot carry, mirroring the ad-duration
// pattern above: emit the dimension where the SSP/MCP supports it, else an
// explicit marker in the prompt AND the Required-final-summary, and never a
// green QA item for an unapplied dimension.
// =============================================================================

/** Loud marker for a trader-set IAB INCLUDE set on an SSP with no IAB wire
 *  (TripleLift: vendor-gated — no IAB item-ID discovery endpoint, escalation
 *  cutlass#757; Magnite: the ClearLine Curation API has no content-category
 *  surface). Contrast the ad-duration marker style — a loud comment instead
 *  of a guessed arg. */
function iabIncludeNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (r.iabResolved.length === 0) return []
  return [
    `# NOT SUPPORTED on ${ssp}: IAB categories ${inlineList(r.iabResolved)} — ${reason};`,
    `# do NOT guess an arg or a targeting node; report as NOT APPLIED in the final summary (#226).`,
  ]
}

/** Loud marker for a per-deal viewability target on an SSP (or SSP platform)
 *  with no deal-level viewability wire — Xandr, TripleLift, and Magnite
 *  SpringServe (CTV). The QA item qa_viewability warns on the same set so it
 *  can never report an uncarried target as configured/PASS. */
function viewabilityNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (!r.viewabilityPct) return []
  return [
    `# NOT SUPPORTED on ${ssp}: viewability target ${r.viewabilityPct}% — ${reason};`,
    `# cannot be applied on this SSP; manage it on the DSP line and report as NOT APPLIED in the final summary (#226).`,
  ]
}

/** Loud marker for a trader-entered language on an SSP with no create-time
 *  language wire (only OpenX targeting.languages and Media.net
 *  device_languages carry language — verified against the MCP signatures). */
/** Loud marker for the Environment (Web/In-App) selection on an SSP whose
 *  create wire cannot carry it — silently discarding it runs the deal in
 *  environments the trader excluded (the IX In-app→Web+In-App leak,
 *  2026-08-11). Emitted only when the trader narrowed the environment
 *  (All needs no wire). */
function environmentNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (r.inv !== 'In-App' && r.inv !== 'Web Only') return []
  return [
    `# NOT SUPPORTED on ${ssp}: Environment '${r.inv}' — ${reason};`,
    `# the deal serves ALL environments. Apply the restriction in the SSP UI / on the DSP line and report as NOT APPLIED in the final summary.`,
  ]
}

/** Audio has no verified create path on ANY SSP. Three block it outright
 *  (PubMatic has no audio ad format, Magnite needs feedTypes we never collect,
 *  OpenX rejects the channel); the rest would silently book it as something
 *  else — Index/Media.net/TripleLift ride the OLV hint and produce a VIDEO
 *  deal, and Xandr used to emit ad_types:['audio'], a value the Curate deal
 *  builder does not offer. A wrong-format deal that looks successful is worse
 *  than a blocked one, so every SSP now fails closed the same way. */
function audioNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (r.channel !== 'Audio') return []
  return [
    `# BLOCKED — UNSUPPORTED CHANNEL: Audio on ${ssp} — ${reason}.`,
    `# Do NOT substitute a video or display format: that books a deal the trader did not ask for.`,
    `# Report this deal as NOT CREATED in the final summary.`,
  ]
}

function languageNotSupportedLines(r: Resolved, ssp: string): string[] {
  if (!r.language) return []
  return [
    `# NOT SUPPORTED on ${ssp}: language targeting (${quote(r.language)}) — no create-time language wire exists on this SSP;`,
    `# apply it in the SSP UI or on the DSP line and report as NOT APPLIED in the final summary (#226).`,
  ]
}

/** Loud marker for audience segment EXCLUSIONS on an SSP whose create wire
 *  cannot carry them (Media.net: four include-only segment groups;
 *  TripleLift: excluded:true audience-leaf writes vendor-unconfirmed,
 *  cutlass#757). A dropped exclusion serves the excluded audience — the
 *  opposite-direction twin of the viewability leak. */
function segmentExcludeNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (r.segmentsExclude.length === 0) return []
  return [
    `# NOT SUPPORTED on ${ssp}: audience segment EXCLUSION(s) ${inlineList(r.segmentsExclude)} — ${reason};`,
    `# do NOT guess an exclude arg; the exclusion must be applied via the SSP UI/DSP — report as a trader follow-up in the final summary (#226).`,
  ]
}

/** True when the deal resolves ANY geo exclusion (country/state/zip/dma). */
function hasGeoExcludes(r: Resolved): boolean {
  return r.excludeCountriesIso2.length > 0 || r.excludeStates.length > 0 || r.excludeZips.length > 0 || r.excludeDmas.length > 0
}

/** Human-readable description of a deal's geo exclusions for markers. */
function describeGeoExcludes(r: Resolved): string {
  const parts: string[] = []
  if (r.excludeCountriesIso2.length > 0) parts.push(`countries ${inlineList(r.excludeCountriesIso2)}`)
  if (r.excludeStates.length > 0) parts.push(`states ${inlineList(r.excludeStates)}`)
  if (r.excludeZips.length > 0) parts.push(`ZIPs ${inlineList(r.excludeZips.slice(0, 5))}${r.excludeZips.length > 5 ? '…' : ''}`)
  if (r.excludeDmas.length > 0) parts.push(`DMAs ${inlineList(r.excludeDmas)}`)
  return parts.join(', ')
}

/** Loud marker for geo EXCLUSIONS on an SSP with no exclude wire (IX: no
 *  exclusion surface at all; Media.net: is_excluded vendor-UNVERIFIED;
 *  TripleLift: excluded:true on supply-geo nodes vendor-unconfirmed). These
 *  SSPs stay fail-closed — the geo_exclude_unsupported audit rule blocks the
 *  batch — and this marker is the preview-side defense in depth. */
function geoExcludeNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (!hasGeoExcludes(r)) return []
  return [
    `# NOT SUPPORTED on ${ssp}: geo EXCLUSION(s) ${describeGeoExcludes(r)} — ${reason};`,
    `# the audit fails closed on this (geo_exclude_unsupported, #219/#244) — do NOT guess an exclude arg.`,
  ]
}

/** Loud marker for the SUBSET of a deal's geo exclusions an otherwise
 *  exclude-emitting SSP cannot carry (e.g. ZIP/DMA excludes anywhere, state
 *  excludes on Magnite, include+exclude XOR conflicts on Xandr/Magnite). */
function geoExcludePartialNotSupportedLines(ssp: string, what: string, reason: string): string[] {
  return [
    `# NOT SUPPORTED on ${ssp}: geo EXCLUSION ${what} — ${reason};`,
    `# the audit fails closed on this (geo_exclude_unsupported, #244) — do NOT guess an exclude arg.`,
  ]
}

/** True when the campaign's Fee Type books the curated fee as a PERCENT of
 *  media. '' (legacy/unset forms) counts as percent for emission purposes —
 *  the completeness rule blocks an empty feeType at audit anyway. Exported
 *  for tests; mirrored by the Go fee_type_wire rule (rules.go). */
export function feeTypeIsPercent(feeType: string): boolean {
  const t = (feeType || '').trim()
  return t === '' || t.toLowerCase() === 'percentage of media'
}

/** Fail-closed marker for a NON-PERCENT fee type (#234.1/#234.2 —
 *  money path). Every SSP wire Deal Onboarding emits books curatedDealFee as a
 *  PERCENT margin (IX/Xandr margin_percent, PubMatic feeValue, OpenX PoM
 *  gross_share, TripleLift curationFee FEE_MODEL_TYPE_PERCENT, Media.net
 *  margin, Magnite rev_share fraction) — a 'Flat Fee' 5000 or 'Fixed CPM'
 *  1.00 would silently become a 5000% / 1% margin on a live money deal. No
 *  verified non-percent wire exists yet on any SSP, so the builders emit
 *  this marker INSTEAD of a margin arg. The '# BLOCKED' prefix is the server
 *  submit gate's hard don't-run marker (runner.go), and the Go audit blocks the
 *  batch upstream (fee_type_wire) — this is the prompt-side defense in
 *  depth. */
function nonPercentFeeBlockLines(form: FormData, ssp: string, wire: string): string[] {
  const feeType = (form.feeType || '').trim()
  const fee = (form.curatedDealFee || '').trim() || '<unset>'
  return [
    `# BLOCKED: fee type "${feeType}" has no verified ${ssp} wire — the curated deal fee (${fee}) would be mis-booked`,
    `# as a PERCENT margin (${wire}) on a live money deal (#234.1). NO margin/fee arg is emitted; do NOT invent one`,
    `# and do NOT submit this deal until the fee type is 'Percentage of Media' or a verified non-percent ${ssp} wire ships.`,
  ]
}

/** Loud marker for include-STATE targeting on an SSP with no state wire
 *  (#233.7/#233.8): the IX create wire is include-only geo_countries
 *  + dma_codes (no state/region key) and Media.net consumes countries only.
 *  These states used to be silently voided (`void r.states`) — a parser-fed
 *  "California" on an IX deal yielded a whole-country deal, QA green, with a
 *  lying ..._CA_... name. The states are NOT applied; the deal name's Geo
 *  slot no longer claims them (dealNameSlots.ts geoSlot skips states on these
 *  SSPs) and qa_geo WARNs — this marker is the prompt-side disclosure. */
function stateIncludeNotSupportedLines(r: Resolved, ssp: string, reason: string): string[] {
  if (r.states.length === 0) return []
  return [
    `# NOT SUPPORTED on ${ssp}: state/province include targeting ${inlineList(r.states)} — ${reason};`,
    `# the state scoping is NOT applied (the deal serves its country-wide/global geo) and the deal name's Geo slot does not claim it.`,
    `# Do NOT pass a state/region arg to the tool; apply state scoping in the SSP UI if required and report it as NOT APPLIED in the final summary (#233.7/#233.8).`,
  ]
}

/** Deal Onboarding channel label → the OpenX MCP's targeting.channel enum
 *  (DEFAULT_RENDERING_CONTEXTS keys in cutlass mcp/openx_mcp.py; the video
 *  subset _OX_AD_DURATION_CHANNELS is CI-pinned via cutlass-contract.json
 *  requiresTargetingChannel). The MCP uppercases and compares EXACTLY, so the
 *  'OLV (Online Video)' form label MUST be shortened to 'OLV'. Emitted on ALL
 *  OpenX deals (cutlass#726 / #229): the MCP builds the package
 *  rendering_context (Format / distribution / devices) from targeting.channel
 *  and defaulted every channel-less brief to DISPLAY (BANNER). Unmapped labels
 *  (Audio) fall through verbatim and the MCP fails closed
 *  (ox_unknown_channel for a channel outside DISPLAY/OLV/CTV/OTT/NATIVE;
 *  ox_duration_requires_video_channel on the duration gate) echoing the
 *  rejected value — loud, never a silent BANNER deal. */
const OX_TARGETING_CHANNEL: Record<string, string> = {
  'Display': 'DISPLAY',
  'CTV': 'CTV',
  'OTT': 'OTT',
  'OLV (Online Video)': 'OLV',
  // NATIVE is a first-class OpenX channel (Format=NATIVE, WEB+APP,
  // desktop/mobile/tablet) — ad_placement NATIVE is a live enum value
  // (optionsByPath probe 2026-08-21). The old fold to 'DISPLAY' relied on the
  // rendering_context string hint to carry the format, but channel wins in
  // the MCP, so every OpenX Native deal booked as BANNER (fixed 2026-08-21;
  // MCPs older than that fix upgrade the DISPLAY+native-hint combo themselves).
  'Native': 'NATIVE',
}

/** True when a discrete allowed-durations list has gaps once widened to the
 *  contiguous [lo, hi] range some SSPs require (e.g. [15, 30] admits 20s). */
function adDurationListHasGaps(allowed: number[]): boolean {
  if (allowed.length < 2) return false
  return allowed[allowed.length - 1] - allowed[0] + 1 > allowed.length
}

/** First in-between length a widened range admits — the concrete example for
 *  the widening warning. Only call when adDurationListHasGaps is true. */
function adDurationFirstGap(allowed: number[]): number {
  const set = new Set(allowed)
  for (let n = allowed[0] + 1; n < allowed[allowed.length - 1]; n++) {
    if (!set.has(n)) return n
  }
  return allowed[0] + 1 // unreachable when a gap exists
}

function resolve(form: FormData, deal: DealEntry, standardLists: StandardList[] = [], dsp?: DspEntry): Resolved {
  const channel = deal.channel || 'Display'
  const inv = deal.inventoryType || form.defaultInventoryType || 'All'
  const isVideo = isVideoChannel(channel)
  const cpm = deal.cpm || (isVideo ? form.defaultVideoCpm : form.defaultDisplayCpm) || ''
  const vcr = deal.vcr || form.defaultVcr || ''
  // Viewability is strictly per-deal and only applied when explicitly set —
  // there is no campaign-level fallback (a hidden default once leaked 70%
  // into every deal of a batch). '' keeps every SSP builder silent.
  const view = deal.viewabilityTarget || ''
  const viewNum = view ? parseFloat(view) : NaN
  const viewabilityFraction = isFinite(viewNum) ? (viewNum > 1 ? (viewNum / 100).toFixed(2) : viewNum.toFixed(2)) : ''
  const viewabilityPct = isFinite(viewNum) ? (viewNum > 1 ? viewNum.toFixed(0) : (viewNum * 100).toFixed(0)) : ''

  const geoInclude = deal.geoInclude.length ? deal.geoInclude : form.defaultGeoInclude
  // Bucket the typed geo entries. zip/dma values may be entered as a
  // comma/space/newline-separated list in one row, so split them out.
  const splitGeoValues = (raw: string): string[] => raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  const geoOf = (t: GeoEntry['type']): string[] => geoInclude.filter(g => g.type === t).map(g => (g.value || '').trim())
  const countriesIso2 = Array.from(new Set(geoOf('country').filter(Boolean)))
  const countriesIso3 = countriesIso2.map(c => COUNTRY_ISO3[c] || c)
  const countriesNames = countriesIso2.map(c => COUNTRY_NAMES[c] || c)
  // Classify subnational entries US-state vs CA-province vs unknown instead of
  // the old `STATE_CODE[s] || s` passthrough, which let a Canadian province
  // ("SK", "Saskatchewan") ride into SSP prompts as an untyped token — OpenX
  // read bare "SK" as the country Slovakia (cutlass#724 / #223).
  const statesUS: string[] = []
  const provincesCA: string[] = []
  const statesUnknown: string[] = []
  for (const raw of geoOf('state').filter(Boolean)) {
    const { code, country } = classifyGeoState(raw)
    const bucket = country === 'US' ? statesUS : country === 'CA' ? provincesCA : statesUnknown
    if (!bucket.includes(code)) bucket.push(code)
  }
  const states = [...statesUS, ...provincesCA, ...statesUnknown]
  const zips = Array.from(new Set(geoOf('zip').flatMap(splitGeoValues)))
  const dmas = Array.from(new Set(geoOf('dma').flatMap(splitGeoValues)))

  // Geo EXCLUSIONS (#244) — same per-deal-overrides-default rule and
  // the same classification pipeline as the includes above, so the per-SSP
  // builders can emit them on the documented exclude wires (or fail LOUD).
  const exclusionOverride = activeExclusionOverride(form, deal)
  // An acknowledged unsupported geo shape is stripped as one operation: the
  // audit event records every effective value omitted. Supported shapes never
  // enter this branch and continue to emit normally.
  const geoExclude = exclusionOverride?.geo.length ? [] : (deal.geoExclude.length ? deal.geoExclude : form.defaultGeoExclude)
  const geoExOf = (t: GeoEntry['type']): string[] => geoExclude.filter(g => g.type === t).map(g => (g.value || '').trim())
  const excludeCountriesIso2 = Array.from(new Set(geoExOf('country').filter(Boolean)))
  const excludeCountriesNames = excludeCountriesIso2.map(c => COUNTRY_NAMES[c] || c)
  const excludeStatesUS: string[] = []
  const excludeProvincesCA: string[] = []
  const excludeStatesUnknown: string[] = []
  for (const raw of geoExOf('state').filter(Boolean)) {
    const { code, country } = classifyGeoState(raw)
    const bucket = country === 'US' ? excludeStatesUS : country === 'CA' ? excludeProvincesCA : excludeStatesUnknown
    if (!bucket.includes(code)) bucket.push(code)
  }
  const excludeStates = [...excludeStatesUS, ...excludeProvincesCA, ...excludeStatesUnknown]
  const excludeZips = Array.from(new Set(geoExOf('zip').flatMap(splitGeoValues)))
  const excludeDmas = Array.from(new Set(geoExOf('dma').flatMap(splitGeoValues)))

  // IAB/content-genre EXCLUSIONS are explicit-only (never inferred — see
  // effectiveIabExcludes). Same name mapping as includes; SSP-native genre
  // names (e.g. IX "Hard News") pass through verbatim.
  const iabExcludeResolved = effectiveIabExcludes(deal)
    .map(s => s.trim()).filter(Boolean)
    .map(c => IAB_V2_NAMES[c] || c)
  const iabExcludeSet = new Set(iabExcludeResolved.map(c => c.toLowerCase()))
  // IAB categories are PER-DEAL: explicit per-deal picks win; else the
  // deterministic inference (theme/segments/brand) runs ONLY when the deal's
  // autoInferIab toggle is on (opt-in, default OFF → no iab lines emit at
  // all) — the retired campaign-level field never ships. See lib/inferIab.ts.
  // An explicit exclude always beats an include — includes can be INFERRED
  // (e.g. theme "Evening News" infers News), and emitting the same category
  // on both sides would fail the deal at the SSP MCP's include/exclude
  // conflict gate mid-batch.
  const iabResolved = effectiveIabCategories(deal, form)
    .map(c => IAB_V2_NAMES[c] || c)
    .filter(c => !iabExcludeSet.has(c.toLowerCase()))

  const { web: isWebChannel, app: isAppChannel } = listChannelRouting(form, deal)

  const domainListsApplied = standardLists.filter(l => l.scope === 'domain' && form.appliedDomainListIds.includes(l.id))
  const appBundleListsApplied = standardLists.filter(l => l.scope === 'app_bundle' && form.appliedAppBundleListIds.includes(l.id))
  // Channel-independent picks (one per pool) — OpenX may emit both. A per-deal
  // override (deal.domainListId / appBundleListId) wins over the campaign-wide
  // pick so one batch can scope a list to only some deals; undefined keeps the
  // campaign default (back-compat).
  // A per-deal allow/block override (deal.domainListInclusion / appBundleListInclusion)
  // wins over the list's intrinsic inclusion — lets the deal card's toggle flip a
  // curated list per deal without mutating the shared list. Applied here so it
  // flows to every SSP builder via the file's inclusionType.
  const withInclusion = (f: UploadedFile | undefined, override?: 'Include' | 'Exclude'): UploadedFile | undefined =>
    f && override ? { ...f, inclusionType: override } : f
  // An uploaded file scoped to specific deals (appliesTo — the File Uploads
  // "Applies to" chips) only participates in THIS deal's campaign-default pick
  // when the deal is in its set. Empty/undefined = applies everywhere. An
  // explicit per-deal domainListId/appBundleListId selection bypasses the
  // filter entirely (pickPerDealOrDefault resolves it against ALL uploads).
  // Stale ids (deals removed after the assignment) are ignored: a file whose
  // every scoped deal is gone falls back to "applies everywhere" — matching
  // the all-unchecked chips the UI shows for it.
  const liveDealIds = new Set(form.deals.map(d => d.id))
  const uploadsForDeal = (files: UploadedFile[]): UploadedFile[] =>
    files.filter(f => {
      const scoped = (f.appliesTo || []).filter(id => liveDealIds.has(id))
      return scoped.length === 0 || scoped.includes(deal.id)
    })
  const webDomainFile = withInclusion(pickPerDealOrDefault(deal.domainListId, form.domainLists, standardLists, 'domain', pickPrimaryFile(uploadsForDeal(form.domainLists), domainListsApplied)), deal.domainListInclusion)
  const appBundleFile = withInclusion(pickPerDealOrDefault(deal.appBundleListId, form.appBundleLists, standardLists, 'app_bundle', pickPrimaryFile(uploadsForDeal(form.appBundleLists), appBundleListsApplied)), deal.appBundleListInclusion)
  // Channel-routed single pick — the legacy behavior the other SSP builders rely on.
  const file = isWebChannel
    ? webDomainFile
    : isAppChannel
      ? appBundleFile
      : undefined
  const fileKind: 'domain' | 'app_bundle' | undefined = file
    ? (isAppChannel ? 'app_bundle' : 'domain')
    : undefined
  const domainOpInclude: 'Include' | 'Exclude' = file?.inclusionType === 'Exclude' ? 'Exclude' : 'Include'
  const domainOp: 'ANY_OF' | 'NONE_OF' = domainOpInclude === 'Exclude' ? 'NONE_OF' : 'ANY_OF'

  // The DSP this expanded deal targets. Under multi-DSP expansion each
  // (deal x DSP) pair resolves with its OWN dsp entry, so the emitted
  // dsp_name/seat args carry that DSP's seat id (rule 16: a seat per DSP).
  // The fallback is the first ACTIVE dsp (activeDsps respects the
  // multipleDsps toggle and skips name-less rows) — never raw form.dsps[0].
  const firstDsp = dsp ?? activeDsps(form)[0]

  const excludes = exclusionOverride?.audience.length ? [] : deal.excludeSegments.map(s => s.trim()).filter(Boolean)

  // Ad-duration targeting — per-deal optional extras (adDurations = allowed
  // creative lengths, maxAdDurationSecs = upper cap), integer SECONDS.
  // resolveAdDuration gates on the channel (CTV/OLV/OTT only, per the brief
  // schema) so Display/Native/Audio deals never leak a duration arg.
  const adDur = resolveAdDuration(deal)

  return {
    channel, isVideo, inv, cpm, vcr, viewabilityFraction, viewabilityPct,
    adDurations: adDur?.allowed ?? [],
    maxAdDurationSecs: adDur?.maxSecs,
    adDurationLo: adDur?.lo,
    adDurationHi: adDur?.hi,
    countriesIso2, countriesIso3, countriesNames, states, statesUS, provincesCA, statesUnknown, zips, dmas,
    excludeCountriesIso2, excludeCountriesNames, excludeStates, excludeStatesUS, excludeProvincesCA,
    excludeStatesUnknown, excludeZips, excludeDmas,
    segmentsInclude: deal.includeSegments.map(s => s.trim()).filter(Boolean),
    segmentsExclude: excludes,
    iabResolved,
    iabExcludeResolved,
    domainFile: file, fileKind, domainOp, domainOpInclude,
    webDomainFile, appBundleFile,
    language: deal.language || form.defaultLanguage || '',
    curator: curator(form),
    firstDspName: firstDsp?.dsp || '',
    firstSeatId: firstDsp?.seatId.replace(/^.*\//, '') || '',
    firstSeatIds: splitSeatIds(firstDsp?.seatId || ''),
    ...resolveStartDate(form.flightStartDate),
    endDate: form.flightEndDate || '',
  }
}

export interface DealListLabel {
  name: string
  op: 'allowlist' | 'blocklist'
  kind: 'domain' | 'app_bundle'
  /** Per-SSP delivery disclosure (#220) — what the resolved list actually
   *  becomes on this deal's SSP, so the deal card never claims a resolution
   *  the prompt cannot deliver:
   *    'applied'                    the SSP builder emits a real list arg
   *                                 (IX/OpenX/PubMatic/Magnite file args;
   *                                 Media.net web-domain post-create merge)
   *    'post_create_supply_domain'  TripleLift domain lists: post-create
   *                                 tl_merge_deal_supply_domains merges the
   *                                 SUPPLY-domain (site/inventory) leaf —
   *                                 EB_SUPPLY_DOMAIN_ID (cutlass#731); not a
   *                                 create-time arg, so delivery rides the
   *                                 post-create merge verification
   *    'not_applied'                no emission path at all: Xandr (no
   *                                 list-file ingestion — Curate deal
   *                                 lists only), TripleLift app-bundle
   *                                 lists, Media.net app-bundle lists */
  disclosure: 'applied' | 'post_create_supply_domain' | 'not_applied'
}

/** listDisclosureFor is the single source of truth for which SSPs can carry a
 *  resolved list of the given kind — keyed the same way the per-SSP builders
 *  emit (buildXandrPrompt/buildTripleLiftPrompt NOT-APPLIED comments, the
 *  Media.net app-bundle BLOCKED comment). Shared by dealListLabel (deal card)
 *  and buildBatchPrompt's Required-final-summary contract line. */
export function listDisclosureFor(ssp: string, kind: 'domain' | 'app_bundle'): DealListLabel['disclosure'] {
  if (ssp === 'Xandr') return 'not_applied'
  if (ssp === 'TripleLift') return kind === 'app_bundle' ? 'not_applied' : 'post_create_supply_domain'
  if (ssp === 'Media.net' && kind === 'app_bundle') return 'not_applied'
  return 'applied'
}

/** listChannelRouting decides which list pool(s) a deal's channel routes to —
 *  the single source of truth shared by resolve() and the deal card's
 *  assignment UI. CTV and OTT are both app-only per cutlass/protocols/
 *  deal-brief.schema.yaml; they differ only in device set, which the SSP MCP
 *  picks up from the channel hint. Audio (non-In-App) routes to neither. */
export function listChannelRouting(form: FormData, deal: DealEntry): { web: boolean; app: boolean } {
  const channel = deal.channel
  const inv = deal.inventoryType || form.defaultInventoryType
  // OTT reaches desktop and web, so it draws from BOTH pools — a streaming
  // buy carries app bundles AND domains. CTV stays app-only.
  const web = channel === 'Display' || channel === 'Native' || channel === 'OTT'
    || (channel === 'OLV (Online Video)' && inv !== 'In-App')
  const app = channel === 'CTV' || channel === 'OTT' || inv === 'In-App'
  return { web, app }
}

/** One dimension of a deal's list assignment — what the Domains & app bundles
 *  row renders. Wire-exact: derived from the same resolve() pipeline the
 *  prompt builders run, so the card never shows an assignment the YAML
 *  wouldn't ship (the old two-dropdown UI could — an app-bundle pick on an
 *  OLV deal looked live but resolved to nothing). */
export interface DealListAssignment {
  kind: 'domain' | 'app_bundle'
  /** Whether this dimension actually ships for this deal. OpenX ships BOTH
   *  dimensions (separate url_targeting / app_inventory args); every other
   *  SSP ships only the channel-routed one. */
  ships: boolean
  /** The list that ships (null = none). `op` reflects any per-deal
   *  allow/block override, same as the emitted match_operator. */
  file: { id: string; name: string; op: 'allowlist' | 'blocklist'; source: 'upload' | 'curated' } | null
  /** True when the pick came from the deal's explicit listId (vs inherited
   *  from the campaign's uploads/applied standard lists). */
  explicit: boolean
  /** When the deal explicitly opted out ('' override) while a campaign-level
   *  pick exists, the name of the list it opted out of — drives the
   *  "not applied — Restore" affordance. Null otherwise. */
  optedOutOf: string | null
  disclosure: DealListLabel['disclosure']
}

function assignmentSource(f: UploadedFile): 'upload' | 'curated' {
  return f.id.startsWith('list:') ? 'curated' : 'upload'
}

/** dealListAssignments returns both list dimensions for a deal, wire-exact.
 *  Runs resolve() (and, for opted-out dimensions, a second resolve with the
 *  override lifted, to name what the deal opted out of). */
export function dealListAssignments(form: FormData, deal: DealEntry, standardLists: StandardList[] = []): { domain: DealListAssignment; app_bundle: DealListAssignment } {
  const r = resolve(form, deal, standardLists)
  const routing = listChannelRouting(form, deal)
  const isOpenX = deal.ssp === 'OpenX'
  const optedOut = deal.domainListId === '' || deal.appBundleListId === ''
  const rDefault = optedOut
    ? resolve(form, {
        ...deal,
        domainListId: deal.domainListId === '' ? undefined : deal.domainListId,
        appBundleListId: deal.appBundleListId === '' ? undefined : deal.appBundleListId,
      }, standardLists)
    : null
  const dim = (kind: 'domain' | 'app_bundle'): DealListAssignment => {
    const resolved = kind === 'domain' ? r.webDomainFile : r.appBundleFile
    const listId = kind === 'domain' ? deal.domainListId : deal.appBundleListId
    const fallback = kind === 'domain' ? rDefault?.webDomainFile : rDefault?.appBundleFile
    return {
      kind,
      ships: isOpenX ? true : (kind === 'domain' ? routing.web : routing.app),
      file: resolved ? {
        id: resolved.id,
        name: resolved.name,
        op: resolved.inclusionType === 'Exclude' ? 'blocklist' : 'allowlist',
        source: assignmentSource(resolved),
      } : null,
      explicit: listId !== undefined && listId !== '' && !!resolved,
      optedOutOf: listId === '' && fallback ? fallback.name : null,
      disclosure: listDisclosureFor(deal.ssp, kind),
    }
  }
  return { domain: dim('domain'), app_bundle: dim('app_bundle') }
}

/** dealListLabel returns the site/app-bundle list a deal will actually run on —
 *  the SAME pick the prompt emits (it runs the real resolve() pipeline), so the
 *  review preview and the deal-card hint never disagree with the generated YAML.
 *  Returns null when the deal has no list (campaign default empty, or explicit
 *  "none"). Used by the deal card. */
export function dealListLabel(form: FormData, deal: DealEntry, standardLists: StandardList[] = []): DealListLabel | null {
  const r = resolve(form, deal, standardLists)
  if (!r.domainFile) return null
  const kind = r.fileKind === 'app_bundle' ? 'app_bundle' as const : 'domain' as const
  return {
    name: r.domainFile.name,
    op: r.domainOpInclude === 'Exclude' ? 'blocklist' : 'allowlist',
    kind,
    disclosure: listDisclosureFor(deal.ssp, kind),
  }
}

/** Compute the effective start_date for a deal. IX (and others) reject past
 *  start dates at create time, but a brief authored days/weeks earlier can
 *  go stale before the trader runs the runner. Bump to today silently and let the
 *  writer surface a comment so nobody is surprised. "Today" is the BUSINESS
 *  timezone's calendar date (America/New_York), never the UTC date — the old
 *  toISOString() resolution silently bumped an evening-ET submit to
 *  tomorrow (and mismatched the Go date_logic rule), #235.1. */
function resolveStartDate(formStart: string): { startDate: string; startDateBumped: boolean; startDateOriginal: string } {
  const todayISO = businessTodayISO()
  if (!formStart) {
    // Form left blank — still default to today rather than emitting empty
    // so the YAML carries a creatable value.
    return { startDate: todayISO, startDateBumped: false, startDateOriginal: '' }
  }
  if (formStart < todayISO) {
    return { startDate: todayISO, startDateBumped: true, startDateOriginal: formStart }
  }
  return { startDate: formStart, startDateBumped: false, startDateOriginal: '' }
}

/** Render the start_date line(s) for an SSP writer. Returns one line in the
 *  normal case; two lines (a hash-comment + the value) when the resolver
 *  bumped a past start_date forward to today. The optional formatter is for
 *  SSPs that want "YYYY-MM-DD HH:MM:SS" instead of bare ISO date. */
function startDateLines(r: Resolved, opts: { key?: string; formatDate?: (s: string) => string; trailingComment?: string } = {}): string[] {
  const key = opts.key ?? 'start_date'
  const formatDate = opts.formatDate ?? ((s: string) => s)
  const rendered = formatDate(r.startDate) || '<FILL>'
  const main = `${key}: ${quote(rendered)}${opts.trailingComment ? `    # ${opts.trailingComment}` : ''}`
  if (!r.startDateBumped) return [main]
  return [
    `# ${key} auto-bumped from ${r.startDateOriginal} (in the past — IX rejects past start dates) → ${r.startDate} (today).`,
    main,
  ]
}

function dealFilePath(file: UploadedFile): string {
  // Emit the ORIGINAL filename only — never Deal Onboarding's local server path.
  // The trader copies the prompt into the runner and re-attaches the file there;
  // the runner mounts uploads at /input/ with hash-suffixed names, so the MCP
  // resolves the file by fuzzy name match against the originals. The old
  // behavior of emitting `/opt/deal-onboarding/data/uploads/<id>.xlsx` was
  // unreadable from the runner sandbox and forced the agent to hand-fix the
  // path on every run (observed in the SS-Optimum 4-deal IX brief).
  return file.name
}

/** Emit the three-line file-targeting block (path + column + match_operator)
 *  that the OpenX-style MCPs (IX, PubMatic, OpenX) consume. The arg prefix
 *  swaps between domain_* and app_bundle_* based on which pool the file came
 *  from — domainLists for web channels, appBundleLists for CTV/In-App. The
 *  match operator (allowlist | blocklist) is derived from inclusionType so
 *  the MCP doesn't have to guess from the file name. Returns [] when no
 *  file applies. */
function fileTargetingBlock(r: Resolved): string[] {
  if (!r.domainFile) return []
  return fileArgsBlock(r.domainFile, r.fileKind === 'app_bundle' ? 'app_bundle' : 'domain')
}

/** Emit the path/column/match_operator triplet for a single file under the
 *  given arg prefix. `domain_*` → OpenX url_targeting (web domains); `app_bundle_*`
 *  → OpenX targeting.app_inventory.app_bundle_id (a distinct dimension). The
 *  match operator (allowlist | blocklist) is derived from the file's
 *  Include/Exclude marker so the MCP never has to guess. */
function fileArgsBlock(file: UploadedFile, prefix: 'domain' | 'app_bundle'): string[] {
  const op = file.inclusionType === 'Exclude'
    ? 'blocklist'
    : file.inclusionType === 'Include'
      ? 'allowlist'
      : '<FILL-inclusion-type-allowlist-or-blocklist>'
  // detectedColumn was populated from the file's actual header row on upload
  // (see lib/fileColumns.ts) or pinned by standardListAsFile. Empty/undefined
  // = no recognizable header (or a pre-detection upload): OMIT the column arg
  // entirely — cutlass split_rows then decides the header/data split itself
  // and a HEADERLESS list keeps row 0 (issue #227). The old 'Sites'/'Bundles'
  // fallback named a column that may not exist (loud extraction failure on a
  // real header row), and a fabricated headers[0] "column" silently dropped
  // the first list entry (the #675 data-loss class).
  const column = (file.detectedColumn || '').trim()
  const out = [`${prefix}_file_path: ${quote(dealFilePath(file))}`]
  if (column) out.push(`${prefix}_column: ${quote(column)}`)
  out.push(`${prefix}_match_operator: ${quote(op)}    # allowlist | blocklist (derived from file inclusionType)`)
  return out
}

// =============================================================================
// Per-SSP builders — each emits MCP-exact arg lists
// =============================================================================

function buildIndexExchangePrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const dspName = IX_DSP_CANONICAL[r.firstDspName] || r.firstDspName
  const channelHint = SSP_CHANNEL_HINT.ix[r.channel] || 'display'
  const margin = form.curatedDealFee ? parseFloat(form.curatedDealFee) : NaN

  // No silent fallback: the IX runner tool is fail-closed (no default account).
  // Use the form value; otherwise leave EMPTY and omit account_id below so the
  // runner returns ix_account_required rather than resolving against some other
  // account.
  const accountId = form.ixConfig.accountId || ''

  const lines: string[] = []
  lines.push(`Call ${'mcp_indexexchange_mcp_ix_execute_deal_from_prompt_inputs'} with these EXACT arguments:`)
  lines.push(``)
  if (accountId) {
    lines.push(`account_id: ${accountId}`)
  } else {
    lines.push(`# account_id: OMITTED — no IX account configured on the form.`)
    lines.push(`# The IX tool has NO default account (fail-closed): set the Index Exchange account id in SSP Configuration.`)
  }
  lines.push(`name: ${quote(dealName)}`)
  lines.push(...startDateLines(r))
  // Date-only flight boundary (#235.3, VENDOR-OPEN cutlass#752): IX
  // stores date-only flights with no documented boundary timezone or
  // end-date inclusivity — ASSUMED end-of-day-inclusive in the vendor's
  // clock (±1 day unverifiable from code or read-backs).
  if (r.endDate) lines.push(`end_date: ${quote(r.endDate)}`)
  lines.push(`floor: ${r.cpm || '0.10'}    # CPM, IX minimum 0.10`)
  lines.push(`dsp_name: ${quote(dspName)}`)
  if (r.firstSeatId) lines.push(`seat_name: ${quote(r.firstSeatId)}    # Resolved server-side via ix_list_dsp_seats`)
  lines.push(`auction_type: ${quote(form.ixConfig.auctionType?.toLowerCase().includes('fixed') ? 'fixed' : 'first')}`)
  if (channelHint) lines.push(`deal_type: ${quote(channelHint)}    # Drives device + creative defaults`)
  // Environment (Web vs In-App) — IX inventoryChannel key 272 (cutlass#872).
  // Explicit values are preserved verbatim by the MCP: the deal_type default
  // (display/olv → App+Site) never widens them — this is the fix for In-app
  // deals shipping with Web included (2026-08-11). 'All' omits the field so
  // the deal_type default applies (display/olv → App+Site, ctv/ott → App).
  if (r.inv === 'In-App') {
    lines.push(`inventory_channels: [In-App]    # explicit — MCP preserves verbatim; never widened to Web`)
  } else if (r.inv === 'Web Only') {
    lines.push(`inventory_channels: [Web]    # explicit — MCP preserves verbatim`)
  }
  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1/#234.2: a Flat-Fee/Fixed-CPM value must NEVER ship as
    // margin_percent — IX applies it as a percent of the winning bid.
    lines.push(...nonPercentFeeBlockLines(form, 'Index Exchange', 'margin_percent, % of winning bid'))
  } else if (Number.isNaN(margin)) {
    lines.push(`# margin_percent: OMITTED — set the curated deal fee. Cutlass IX REQUIRES margin_percent (ix_margin_required); there is no built-in default.`)
  } else {
    lines.push(`margin_percent: ${margin}    # Curator margin (% of winning bid). REQUIRED by Cutlass — no built-in default.`)
  }

  // Publisher: when the preset lists publisher_ids (legacyAccountIDs), emit
  // them directly — IX's name lookup fails on ambiguity (e.g. a partner name appears
  // as "via Prebid", "via OB", etc., so publisher_names=["The Weather
  // Company"] resolves to nothing). Fall back to publisher_name only when
  // ids aren't supplied.
  // A deal-level "specific publishers only" allowlist (Max publishers toggle
  // OFF) beats the preset pin — it's the narrower, deliberate choice
  // (sensitive-category batches). Toggle ON = entries never ship.
  const ixAllowlist = form.ixConfig.allPublishers === false
    ? (form.ixConfig.publisherEntries || [])
    : []
  const ixAllowIds = ixAllowlist.map(e => (e.id || '').trim()).filter(Boolean)
  const ixAllowNames = ixAllowlist
    .filter(e => !(e.id || '').trim())
    .map(e => (e.name || '').trim())
    .filter(Boolean)
  if (ixAllowIds.length > 0 || ixAllowNames.length > 0) {
    if (ixAllowIds.length > 0) {
      lines.push(`publisher_ids: [${ixAllowIds.join(', ')}]    # exact legacyAccountIDs (trader-supplied) — deal runs ONLY on these publishers`)
    }
    if (ixAllowNames.length > 0) {
      lines.push(`publisher_names: ${inlineList(ixAllowNames)}    # resolved server-side against the marketplace catalog (misses block the create)`)
    }
  }

  // external_deal_id intentionally NOT emitted — IX treats this field as the
  // primary deal id at create time, which buries the auto-generated IX17...
  // identifier most reporting tools expect. The trader's externalReferenceId
  // still flows through the batch envelope (external_reference_id) and IX's
  // reporting labels (labels.externalReferenceID) for cross-referencing.

  if (r.countriesNames.length > 0) lines.push(`geo_countries: ${inlineList(r.countriesNames)}`)
  // IX does not target by state/region (the deal card doesn't offer State for
  // Index). ZIP/postal codes and Nielsen DMA numbers both target IX's single
  // ZipCode key, so they're merged into one dma_codes list (the MCP param that
  // feeds that key — it accepts both forms).
  const ixZipDma = [...r.zips, ...r.dmas]
  if (ixZipDma.length > 0) lines.push(`dma_codes: ${inlineList(ixZipDma)}`)
  // Parser-fed include-states (#233.7/.8) — the deal card doesn't
  // offer State for IX, but a parsed brief can still land states here. They
  // used to be silently voided; now they emit a loud NOT-SUPPORTED marker and
  // the deal name's Geo slot no longer claims them.
  lines.push(...stateIncludeNotSupportedLines(r, 'Index Exchange', 'the IX create wire is include-only geo_countries + dma_codes (no state/region key)'))

  // IAB → IX key selection (cutlass#714/#831). NEVER-MIX CONSTRAINT: the MCP
  // resolves ALL of a deal's include+exclude categories on ONE targeting key —
  // contentGenre (key 11) first, then iabContentCategory (key 1066) —
  // all-or-nothing per key, EXACT-match only, never mixed on one deal. The
  // key is therefore selected over includes+excludes TOGETHER (both sides
  // always land on the same key): (a) all names genre-coverable → genre names
  // (unchanged wire for existing deals); (b) else all names 1066-coverable →
  // 1066 names; (c) else the key covering more names wins with INCLUDE
  // coverage outranking total coverage (tie → contentGenre) and the rest
  // emit loud NOT-SUPPORTED comments — never a doomed token.
  const ixIabKey = ixSelectIabKey(r.iabResolved, r.iabExcludeResolved)
  const ixInclude = ixIabNamesForKey(r.iabResolved, ixIabKey)
  const ixExclude = ixIabNamesForKey(r.iabExcludeResolved, ixIabKey)
  // Include↔exclude collisions (FIX 3): distinct IAB names can fold onto ONE
  // catalog name (e.g. include 'Business' + exclude 'Personal Finance' both
  // map to the 'Business and financial' genre). Emitting the name on both
  // sides would trip the MCP's include/exclude conflict gate; SILENTLY
  // dropping the include (the old behavior) could empty the include list and
  // ship an all-genres-EXCEPT deal — the near-opposite of the intent, with no
  // marker. Resolution: the INCLUDE keeps the name (deal stays targeted,
  // never silently widened), the collision drops it from the EXCLUDE, and a
  // loud GENRE CONFLICT marker surfaces the contradiction. Two DISTINCT
  // includes mapping to one name just dedupe (handled in ixIabNamesForKey —
  // no drama).
  const ixIncludeGenreSet = new Set(ixInclude.names.map(g => g.toLowerCase()))
  const collisions = ixExclude.names
    .filter(g => ixIncludeGenreSet.has(g.toLowerCase()))
    .map(g => ({
      genre: g,
      includeNames: ixInclude.sources.get(g.toLowerCase()) || [g],
      excludeNames: ixExclude.sources.get(g.toLowerCase()) || [g],
    }))
  const collidingGenreSet = new Set(collisions.map(c => c.genre.toLowerCase()))
  const ixIncludeGenres = ixInclude.names // includes are NEVER dropped by folding
  const ixExcludeGenres = ixExclude.names.filter(g => !collidingGenreSet.has(g.toLowerCase()))
  if (ixIncludeGenres.length > 0) {
    lines.push(ixIabKey === 'contentGenre'
      ? `# iab_categories values are IX contentGenre (key 11) catalog names — this deal's selected key; ALL of its categories resolve here, never mixed with key 1066 (curated IAB→genre map, live catalog 2026-07-14).`
      : `# iab_categories values are IX iabContentCategory (key 1066) catalog names — this deal's selected key; ALL of its categories resolve here, never mixed with contentGenre (live catalog 2026-07-14).`)
    lines.push(`iab_categories:`)
    lines.push(...blockList(ixIncludeGenres, '  '))
  }
  lines.push(...ixIabNotSupportedLines(ixInclude.notSupported, 'include', ixIabKey))
  if (ixExcludeGenres.length > 0) {
    lines.push(`excluded_iab_categories:    # applied as ${ixIabKey === 'contentGenre' ? 'contentgenre' : 'iabContentCategory'} NONE_OF at create`)
    lines.push(...blockList(ixExcludeGenres, '  '))
  }
  lines.push(...ixIabNotSupportedLines(ixExclude.notSupported, 'exclude', ixIabKey))
  lines.push(...ixGenreConflictLines(collisions, ixIabKey))
  if (r.segmentsInclude.length > 0) {
    lines.push(`segment_names:`)
    lines.push(...blockList(r.segmentsInclude, '  '))
    lines.push(`# IX REQUIRES segments at create — they cannot be added later.`)
  }
  // Always emit excluded_segment_names — even as an empty list — so the
  // agent sees the field is recognised and doesn't try to invent its own
  // exclusion structure. Trader-entered exclude segments populate this; for
  // deals without exclusions it ships as [].
  if (r.segmentsExclude.length > 0) {
    lines.push(`excluded_segment_names:`)
    lines.push(...blockList(r.segmentsExclude, '  '))
  } else {
    lines.push(`excluded_segment_names: []`)
  }

  if (r.viewabilityPct) lines.push(`viewability_threshold: ${r.viewabilityPct}    # Integer 0-100 (Viewability key 8)`)

  // Language — IX has no create-time language wire (verified against the IX
  // MCP signature 2026-07-10); fail loud, never guess an arg (#226).
  lines.push(...audioNotSupportedLines(r, 'Index Exchange', "IX has no audio deal_type; the channel rides the olv hint and books a VIDEO deal"))
  lines.push(...languageNotSupportedLines(r, 'Index Exchange'))

  // Geo EXCLUSIONS — IX has ZERO geo-exclusion surface (include-only
  // geo_countries + dma_codes); fail loud + the audit blocks (#244).
  lines.push(...geoExcludeNotSupportedLines(r, 'Index Exchange', 'the IX create wire is include-only (geo_countries + dma_codes); no deals-API exclusion path is known'))

  // Ad-duration targeting — IX's "Ad durations" key is an allowed-LIST of
  // MAX-duration buckets (seconds → OpenRTB video.maxduration, ANY_OF). The
  // key + value tokens are ACCOUNT-discovered at runtime by the MCP (never
  // hardcoded); an unmappable duration fails the WHOLE create
  // (ix_ad_duration_value_unresolved / _key_unresolved) — never dropped.
  if (r.adDurations.length > 0) {
    lines.push(`max_ad_durations: ${inlineList(r.adDurations)}    # allowed MAX-duration buckets, integer seconds; MCP resolves account tokens, fails closed if unmappable`)
  } else if (r.maxAdDurationSecs !== undefined) {
    // A bare cap has no allowed-list form — per the MCP's canonical mapping,
    // a range means "every account bucket inside it". The buckets are
    // account-specific, so the agent must discover them first (mirrors the
    // TripleLift resolve-first placeholders).
    lines.push(`# Ad-duration cap (max ${r.maxAdDurationSecs}s): IX targets an allowed-list of MAX-duration buckets, so a bare cap`)
    lines.push(`# means EVERY account bucket <= ${r.maxAdDurationSecs}s. Resolve the account's "Ad durations" buckets via`)
    lines.push(`# ix_list_targeting_keys / ix_list_targeting_values FIRST, then pass each qualifying bucket:`)
    lines.push(`max_ad_durations: [<every account max-duration bucket <= ${r.maxAdDurationSecs} — resolve via ix_list_targeting_values>]`)
  }

  // File targeting — domain list for web channels, app-bundle list for
  // CTV/In-App. Match operator (allowlist|blocklist) follows the file's
  // Include/Exclude marker; the IX MCP needs it explicit, otherwise it
  // defaults to allowlist regardless of the file's intent.
  lines.push(...fileTargetingBlock(r))

  // Labels block — built from the trader-entered reporting fields (advertiser,
  // agency, salesperson, per-deal external reference id, custom), each value
  // sanitized to IX's reporting-label charset. Omitted entirely when every
  // field is blank — never invent a labels dict.
  const labelLines = buildIxLabels(form, deal, dealName)
  if (labelLines.length > 0) {
    lines.push(`labels:`)
    for (const l of labelLines) lines.push(`  ${l}`)
  } else {
    lines.push(`# labels intentionally omitted — no reporting labels entered on the form. Do NOT invent a labels dict.`)
  }

  return lines.join('\n')
}

export interface ReportingLabel {
  key: string
  value: string
}

/** IX reporting-label charset — the IX deal UI's own field validation
 *  (verified against the edit form 2026-08-11): letters, numbers, spaces, and
 *  $%&,-+./:?@\_`{|}. Anything else (`=`, `!`, `#`, parens, en dashes,
 *  newlines, …) makes the field fail validation, which blocks the trader from
 *  EVER re-saving the deal in the IX UI — so disallowed characters must never
 *  ship in the first place. Disallowed chars become spaces (then runs
 *  collapse) so adjacent words don't fuse. */
const IX_LABEL_DISALLOWED_RE = /[^A-Za-z0-9 $%&,+.\/:?@\\_`{|}-]/g

export function sanitizeIxLabelValue(value: string): string {
  return value.replace(IX_LABEL_DISALLOWED_RE, ' ').replace(/\s+/g, ' ').trim()
}

/** resolveReportingLabels renders the trader-entered reporting fields into the
 *  ordered key/value pairs emitted into the IX deal prompt, each value
 *  sanitized to IX's reporting-label charset. Blank fields are omitted; a form
 *  with no reporting fields set gets NO labels block at all. Shared by the deal
 *  card's Reporting Labels panel and buildIxLabels so the preview never
 *  disagrees with the generated YAML. */
export function resolveReportingLabels(form: FormData, deal: DealEntry, dealName: string): ReportingLabel[] {
  const tmpl: Record<string, string> = {
    advertiser: '{{ brand }}',
    agency: '{{ agency }}',
    salesperson: '{{ salesperson }}',
    externalReferenceID: '{{ externalReferenceId }}',
    custom: '{{ custom }}',
  }
  const ctx: Record<string, string> = {
    brand: form.brand,
    agency: form.agency,
    submitterEmail: form.submitterEmail,
    submitterName: form.submitterName,
    salesperson: form.reportingLabels.salesperson,
    custom: form.reportingLabels.custom,
    // The externalReferenceID label carries the client-supplied reference ONLY.
    // Do NOT fall back to the deal name — an empty reference must render empty
    // (renderTemplate drops empty keys) rather than leaking the deal name.
    externalReferenceId: deal.externalReferenceId,
    campaignId: form.campaignId,
    dealName: dealName,
    theme: deal.theme,
  }
  const out: ReportingLabel[] = []
  for (const [key, template] of Object.entries(tmpl)) {
    const rendered = sanitizeIxLabelValue(renderTemplate(template, ctx))
    if (rendered) out.push({ key, value: rendered })
  }
  return out
}

// Reporting labels come from the trader-entered form fields only (see
// resolveReportingLabels) — never from a generic fallback set.
function buildIxLabels(form: FormData, deal: DealEntry, dealName: string): string[] {
  return resolveReportingLabels(form, deal, dealName).map(l => `${l.key}: ${quote(l.value)}`)
}

/** Render `{{ var }}` placeholders against a context. Unknown vars resolve to ''. */
function renderTemplate(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    const v = ctx[name]
    return v == null ? '' : v
  })
}

function buildOpenXPrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const ox = form.openxConfig
  const buyers = ox.buyers.filter(b => b.buyerId.trim())
  const buyerIds = buyers.map(b => b.buyerId)
  const demandPartner = OPENX_DEMAND_PARTNER[r.firstDspName] || r.firstDspName

  const lines: string[] = []
  lines.push(`Call ${'mcp_openx_mcp_ox_execute_deal_from_prompt_inputs'} with these EXACT arguments:`)
  lines.push(``)
  lines.push(`name: ${quote(dealName)}`)
  lines.push(`currency: ${ox.currency || 'USD'}`)
  lines.push(`deal_price: ${ox.dealPrice || r.cpm || '0.10'}    # CPM floor (numeric)`)
  lines.push(...startDateLines(r, { formatDate: s => isoDateTime(s, 'start'), trailingComment: 'ISO-8601 UTC' }))
  if (r.endDate) lines.push(`end_date: ${quote(isoDateTime(r.endDate, 'end'))}`)

  // package_name: emit ONLY when the trader pins an explicit name. With
  // auto-generation on (the default), omit it so the OpenX MCP mints a unique
  // package name server-side — passing package_name = deal name collides with
  // an orphan package left by a prior failed create and blocks the retry.
  if (!ox.autoPackageName && ox.packageName) {
    lines.push(`package_name: ${quote(ox.packageName)}`)
  }
  lines.push(`demand_partner: ${quote(demandPartner || '<FILL demand_partner — REQUIRED>')}    # OpenX demand partner brand name`)
  // cutlass#766: PRIVATE_AUCTION ("2") is NOT creatable via the OpenX API —
  // dealCreate's backend validation requires open_auction_access, a field
  // absent from the GraphQL create schema, so every type-2 attempt dies with
  // an opaque INTERNAL_SERVER_ERROR. The OpenX MCP fails closed
  // (ox_private_auction_unsupported) and the ox_pmp_type audit rule blocks it
  // upstream; this line-anchored "# BLOCKED" marker is the belt-and-braces
  // backstop the runner submit gate 422s on, so a stale persisted/parsed value
  // can never reach a dead create. NEVER silently coerce to PREFERRED_DEAL —
  // Private Auction has different auction semantics.
  const pmpDealType = ox.pmpDealType || 'PREFERRED_DEAL'
  if (pmpDealType === 'PRIVATE_AUCTION' || pmpDealType === '2') {
    lines.push(`# BLOCKED: OpenX Private Auction (pmp_deal_type 2) is not creatable via the API — open_auction_access is required by OpenX's backend but absent from the create schema (cutlass#766).`)
    lines.push(`# Do NOT submit this deal; switch the OpenX PMP Deal Type to PREFERRED_DEAL.`)
  } else {
    lines.push(`pmp_deal_type: ${quote(pmpDealType)}    # PREFERRED_DEAL | PROGRAMMATIC_GUARANTEED (PRIVATE_AUCTION is API-uncreatable — cutlass#766)`)
  }

  if (buyerIds.length > 0) {
    lines.push(`buyer_ids: ${inlineList(buyerIds)}    # First entry is treated as Main Buyer by OpenX MCP`)
  } else if (r.firstSeatId) {
    // Pin the deal to the trader's DSP seat — same intent the IX/PubMatic
    // blocks honor. Without this, OpenX accepts a buyer-less create and the
    // deal is transactable by ANY seat under the demand partner.
    lines.push(`buyer_ids: ${inlineList([r.firstSeatId])}    # Pins the deal to the trader's ${r.firstDspName} seat — resolved via the OpenX buyer directory; the MCP blocks the create (invalid_buyer_ids) if this seat isn't registered under the demand partner`)
  }

  // excluded_publisher_ids (cutlass PR #490) — emitted as
  // targeting.content.account NOT INTERSECTS by the OpenX MCP. Cannot be
  // combined with publisher_ids inclusion on the same deal — OpenX
  // schema constraint. The MCP returns a `conflicting_publisher_lists`
  // blocker when both are supplied.
  const excludedPubs = ox.excludedPublisherIds.map(s => s.trim()).filter(Boolean)
  // publisher_ids (include) — targeting.content.account INTERSECTS, shipped
  // only with the Max publishers toggle OFF. The OX wire takes account IDS
  // only (no name resolution): name-only entries are blocked by the
  // ox_publisher_ids audit rule before any prompt ships.
  const includePubs = ox.allPublishers === false
    ? (ox.publisherEntries || []).map(e => (e.id || '').trim()).filter(Boolean)
    : []
  if (includePubs.length > 0 && excludedPubs.length > 0) {
    // OpenX schema constraint (MCP `conflicting_publisher_lists` blocker).
    // The ox_publisher_conflict audit rule fails first; keep the preview
    // honest with a loud marker and ship neither list.
    lines.push(`# BLOCKED: publisher include list AND excluded_publisher_ids are both set — OpenX cannot combine them; clear one in the form.`)
  } else if (includePubs.length > 0) {
    lines.push(`publisher_ids: ${inlineList(includePubs)}    # INTERSECTS targeting.content.account — deal runs ONLY on these publishers`)
  } else if (excludedPubs.length > 0) {
    lines.push(`excluded_publisher_ids: ${inlineList(excludedPubs)}    # OpenX MCP plumbs to targeting.content.account NOT INTERSECTS`)
  }

  // inventory_categories (cutlass PR #491) — maps to
  // targeting.metacategory.includes. Required for OpenX CTV App Bundles
  // deals; the MCP resolves names like "TV by OpenX - CTV - App Bundles"
  // to OpenX inventory category codes (e.g. "premiumctv"). Auto-default
  // the CTV App-Bundles category when this is a CTV deal and no override
  // was supplied — that's the standard curated-CTV setup.
  const invCatsRaw = ox.inventoryCategories.map(s => s.trim()).filter(Boolean)
  const invCats = invCatsRaw.length > 0
    ? invCatsRaw
    : (r.channel === 'CTV' ? ['TV by OpenX - CTV - App Bundles'] : [])
  if (invCats.length > 0) {
    lines.push(`inventory_categories: ${inlineList(invCats)}    # OpenX MCP plumbs to targeting.metacategory.includes`)
  }

  // Expected Sensitive Category is deliberately NOT emitted as a create arg.
  // Verified 2026-08-17 against the live OpenX partner GraphQL API: the field
  // exists only on the UI's internal API — DealCreateParams rejects
  // expected_ad_category as undefined ("not defined by type"), and the Deal
  // read type never returns it, so shipping it would hard-fail every OpenX
  // create in the batch (cutlass PR #489's arg never worked live). It rides
  // each deal's post_create_ui_fix reminder instead — a MANUAL trader step in
  // the OpenX UI after create (see buildBatchPrompt).

  // Targeting dict — OpenX MCP accepts a targeting dict OR top-level optional args.
  // Use the discrete top-level args because the MCP's prepare-from-prompt-inputs flow
  // re-resolves these through OpenX optionsByPath.
  if (r.viewabilityFraction) lines.push(`viewability_threshold: ${r.viewabilityFraction}    # 0.0-1.0 fraction`)

  // Ad-duration targeting — package.targeting.video.adunit_max_duration_range
  // {start, end}: an INCLUSIVE range (integer seconds) over the AD UNIT's
  // declared max ad duration. CTV/OLV/OTT only. resolve() gates emission
  // client-side, but that is NOT enough for the MCP: its video-channel gate
  // reads targeting.channel ONLY (never rendering_context or device_type)
  // and blocks the ENTIRE create with ox_duration_requires_video_channel
  // when it's missing — so whenever these args are emitted, the targeting
  // block below MUST carry the channel (see hasAdDurationRequest there).
  if (r.adDurations.length > 0) {
    lines.push(`adunit_max_duration_start: ${r.adDurationLo}    # inclusive range over ad-unit declared max ad duration (seconds)`)
    lines.push(`adunit_max_duration_end: ${r.adDurationHi}`)
    if (adDurationListHasGaps(r.adDurations)) {
      lines.push(`# NOTE: OpenX expresses a contiguous range — the allowed list ${inlineList(r.adDurations)}s widens to ${r.adDurationLo}-${r.adDurationHi}s,`)
      lines.push(`# which also admits in-between lengths (e.g. ${adDurationFirstGap(r.adDurations)}s). Surface this widening in the final summary.`)
    }
  } else if (r.maxAdDurationSecs !== undefined) {
    lines.push(`adunit_max_duration_end: ${r.maxAdDurationSecs}    # "max ${r.maxAdDurationSecs}s" — the MCP defaults start to 0 (no lower bound) with a warning`)
  }

  // Targeting block (optional) — countries, states, IAB, segments, devices.
  // OpenX accepts both names and IDs; pass names so MCP resolves via list tools.
  const targetingLines: string[] = []
  // channel — ALWAYS emitted (cutlass#726 / #229): the MCP builds the
  // package rendering_context (Format / distribution / devices) from
  // targeting.channel and used to default every channel-less brief to DISPLAY
  // (Format=BANNER) — OLV/CTV/OTT deals silently created as banner. The MCP
  // now fails closed (ox_video_channel_unresolved) on a video-string brief
  // without a channel, so the channel line is load-bearing for every video
  // deal; DISPLAY is emitted too so intent is explicit rather than inferred.
  // (The earlier duration-only scoping demanded a per-channel live canary
  // before all-deals emission — that canary is part of this rollout.)
  // Duration deals keep the gate comment: the MCP's video-channel gate reads
  // targeting.channel ONLY and blocks the ENTIRE create
  // (ox_duration_requires_video_channel) when it's missing.
  if (hasAdDurationRequest(r)) {
    targetingLines.push(`  channel: ${OX_TARGETING_CHANNEL[r.channel] ?? r.channel}    # REQUIRED with adunit_max_duration_* — ox_duration_requires_video_channel gate`)
  } else {
    targetingLines.push(`  channel: ${OX_TARGETING_CHANNEL[r.channel] ?? r.channel}    # drives the OpenX rendering_context Format — video channels must never create as BANNER (cutlass#726)`)
  }
  // geographic: the OpenX MCP reads targeting.geographic — NOT geo_countries /
  // geo_states (those keys are silently ignored, leaving the deal with no geo).
  // Subnational geo ships as the STRUCTURED dict {includes: {state, country}}
  // (cutlass#724): a flat token like "SK" is ambiguous between Saskatchewan
  // and Slovakia and the MCP fails closed on it (ambiguous_geo_token) — the
  // structured form carries the country hint that scopes state-id resolution
  // ('CA' here maps to canada via the MCP's COUNTRY_NAME_ALIASES). Country-only
  // deals keep the flat country-NAME list (["United States"]) — names resolve
  // against the MCP's live country option set (all 249 countries).
  const hasSubnational = r.statesUS.length > 0 || r.provincesCA.length > 0 || r.statesUnknown.length > 0
  // Geo EXCLUSIONS (#244) — the OpenX create wire models geographic
  // as {includes, excludes} branches resolved symmetrically (the MCP
  // normalizes + country-resolves BOTH). Emittable here: state exclusions
  // scoped to ONE country (the excludes branch carries a single country
  // hint) and country exclusions when no state exclusion occupies the
  // branch. Everything else fails LOUD below and the geo_exclude_unsupported
  // audit rule blocks the batch.
  const oxExStatesMixed = r.excludeStatesUS.length > 0 && r.excludeProvincesCA.length > 0
  const oxExStatesEmittable = r.excludeStates.length > 0 && r.excludeStatesUnknown.length === 0 && !oxExStatesMixed
  const oxExCountriesEmittable = r.excludeCountriesIso2.length > 0 && r.excludeStates.length === 0
  const geoExcludeMarkers: string[] = []
  if (r.excludeStates.length > 0 && !oxExStatesEmittable) {
    geoExcludeMarkers.push(...geoExcludePartialNotSupportedLines('OpenX', `states ${inlineList(r.excludeStates)}`, 'the excludes branch scopes state-id resolution with ONE country hint — mixed US/CA or unclassifiable exclude states cannot be scoped'))
  }
  if (r.excludeCountriesIso2.length > 0 && !oxExCountriesEmittable) {
    geoExcludeMarkers.push(...geoExcludePartialNotSupportedLines('OpenX', `countries ${inlineList(r.excludeCountriesIso2)}`, 'the excludes branch carries ONE country field, already used as the state-exclusion scope hint'))
  }
  if (r.excludeZips.length > 0) {
    geoExcludeMarkers.push(...geoExcludePartialNotSupportedLines('OpenX', `ZIPs ${inlineList(r.excludeZips.slice(0, 5))}${r.excludeZips.length > 5 ? ' …' : ''}`, 'no postal-code exclude emission is wired'))
  }
  if (r.excludeDmas.length > 0) {
    geoExcludeMarkers.push(...geoExcludePartialNotSupportedLines('OpenX', `DMAs ${inlineList(r.excludeDmas)}`, 'no DMA exclude emission is wired'))
  }
  const wantsExcludeBranch = oxExStatesEmittable || oxExCountriesEmittable
  if (hasSubnational || wantsExcludeBranch) {
    // OpenX supports exactly ONE country per includes branch (the MCP's
    // _subnational_country_hint_from_item), so the geo_classification audit
    // fails mixed US/CA or unknown entries before submit. If such a batch is
    // ever forced through, the shape below still fails closed at the MCP
    // (multi-country hint → subnational_geo_requires_country; unknown token →
    // unresolved_state) instead of guessing a geography.
    targetingLines.push(`  geographic:`)
    if (hasSubnational) {
      const stateList = [...r.statesUS, ...r.provincesCA, ...r.statesUnknown]
      const countries = [...(r.statesUS.length > 0 ? ['US'] : []), ...(r.provincesCA.length > 0 ? ['CA'] : [])]
      targetingLines.push(`    includes:`)
      targetingLines.push(`      state: ${quote(stateList.join(','))}    # 2-letter codes — MCP resolves to numeric OpenX state ids`)
      if (countries.length > 0) {
        targetingLines.push(`      country: ${quote(countries.join(','))}    # scopes state-id resolution (US or CA)`)
      }
    } else if (r.countriesNames.length > 0) {
      // Country include rides the includes branch when an excludes branch is
      // present (the flat name-list form carries no excludes).
      targetingLines.push(`    includes:`)
      targetingLines.push(`      country: ${quote(r.countriesNames.join(','))}    # country NAMES — resolved against the live country option set`)
    }
    if (oxExStatesEmittable) {
      const exHint = r.excludeStatesUS.length > 0 ? 'US' : 'CA'
      targetingLines.push(`    excludes:`)
      targetingLines.push(`      state: ${quote(r.excludeStates.join(','))}    # geo EXCLUSION — never serve these states (#244)`)
      // F1: this country is a RESOLUTION SCOPE HINT ONLY — the OpenX MCP uses
      // it to scope exclude-state-id resolution and STRIPS it before dealCreate
      // (_cleanup_structured_geographic_targeting removes any excludes.country
      // that accompanies an exclude state). It is NEVER a whole-country
      // exclusion on the wire; a genuine whole-country exclude is the
      // country-only branch below.
      targetingLines.push(`      country: ${quote(exHint)}    # RESOLUTION SCOPE HINT ONLY (scopes exclude-state ids) — MCP strips it pre-wire; NOT a country exclusion`)
    } else if (oxExCountriesEmittable) {
      targetingLines.push(`    excludes:`)
      targetingLines.push(`      country: ${quote(r.excludeCountriesNames.join(','))}    # geo EXCLUSION — never serve these countries (#244)`)
    }
  } else if (r.countriesNames.length > 0) {
    targetingLines.push(`  geographic: ${inlineList(r.countriesNames)}    # country NAMES — the OpenX MCP resolves them against its live country option set`)
  }
  // IAB categories — canonicalized to exact live v2 catalog names (2026-07-14
  // audit): the MCP's contains-matching blocks the whole create on a no-match
  // or ambiguous name and silently narrows on a partial hit, so only verified
  // names are emitted; unsupported names get the loud marker below.
  const oxIab = oxIabNames(r.iabResolved)
  if (oxIab.names.length > 0) targetingLines.push(`  iab_categories: ${inlineList(oxIab.names)}    # exact OpenX IAB v2 catalog names (canonicalized, live catalog 2026-07-14)`)
  // Language targeting (#226) — OpenX carries language at create time
  // via targeting.languages → targeting.technographic.language (resolved
  // server-side through optionsByPath; unresolved values fail closed with
  // unresolved_language). One of only two SSPs with a language wire.
  if (r.language) {
    targetingLines.push(`  languages: ${inlineList([r.language])}    # → targeting.technographic.language; MCP resolves via optionsByPath, fails closed if unresolvable`)
  }
  if (r.segmentsInclude.length > 0) {
    // OpenX AUDIENCE model: these are names of PRE-BUILT audiences (the
    // OpenAudience catalog), not raw segments — segments get combined into an
    // audience at build time (OpenX UI / data-provider push), and the deal
    // targets the audience(s). The key stays `audience_segments_include` for
    // wire compat with deployed MCPs (an unknown `audiences:` key would be
    // SILENTLY DROPPED by older cutlass builds — untargeted deal); flip the
    // key to `audiences:` only after cutlass#879 is deployed everywhere.
    targetingLines.push(`  audience_segments_include:    # pre-built OpenX AUDIENCES — each must already exist in the target seat's OpenAudience catalog; AND-logic between segments lives inside the audience, not across entries`)
    for (const s of r.segmentsInclude) targetingLines.push(`    - ${quote(s)}`)
  }
  // Audience segment EXCLUSIONS are NOT emitted as wire VALUES on OpenX
  // (#226 F2): the OpenX targeting schema models audience as an
  // include-only {op, val} object with NO excludes branch, so an exclusion
  // CANNOT be enforced. Emitting the values would make the MCP HARD-FAIL
  // (ox_audience_exclude_unsupported is now a blocker, not a soft flag), and
  // Deal Onboarding's audit fail-closes the (deal, SSP) upstream. We emit the field
  // as an empty [] purely for recognition (so the agent never invents its own
  // exclusion structure) and the loud NOT-SUPPORTED marker below carries the
  // requested segments. Never a create-without.
  targetingLines.push(`  audience_segments_exclude: []`)
  // OpenX rendering_context string hint — kept for old-MCP back-compat. The
  // channel line above is what builds the real rendering_context object; new
  // MCPs consume this string (channel wins) and fail closed
  // (ox_video_channel_unresolved) if a non-banner hint ever arrives without a
  // channel, instead of silently creating a BANNER deal (cutlass#726).
  const ctx = ox.renderingContext || (r.isVideo ? 'video' : r.channel === 'Native' ? 'native' : 'banner')
  targetingLines.push(`  rendering_context: ${quote(ctx)}    # banner | video | native`)
  if (targetingLines.length > 0) {
    lines.push(`targeting:`)
    lines.push(...targetingLines)
  }

  // Geo-exclusion markers for the shapes the OpenX excludes branch cannot
  // carry (computed above) — loud, and audit-blocked (#244).
  lines.push(...geoExcludeMarkers)

  // Audience segment EXCLUSIONS — BLOCKED on OpenX (#226 F2). The
  // audit fail-closes this (deal, SSP) (segment_exclude_unsupported) and the
  // MCP hard-fails if it ever reaches the tool — a create-WITHOUT would
  // silently SERVE the excluded audience.
  lines.push(...segmentExcludeNotSupportedLines(r, 'OpenX', 'OpenX audience targeting is an include-only {op, val} object with no excludes branch (live-introspected schema) — the create fails closed (ox_audience_exclude_unsupported)'))
  // Environment: the OpenX MCP derives rendering_context.distribution_channel
  // from targeting.channel alone (DISPLAY/OLV → "WEB,APP", CTV/OTT → "APP") —
  // there is no caller knob for Web-only / In-app-only on DISPLAY/OLV yet.
  // OpenX derives distribution_channel from targeting.channel — which means the
  // In-App restriction IS honored on CTV/OTT, where the MCP hard-forces
  // distribution_channel=APP (openx_mcp.py DEFAULT_RENDERING_CONTEXTS: CTV and
  // OTT are APP-only; only DISPLAY/OLV ship "WEB,APP"). Emitting the blanket
  // NOT-SUPPORTED note there told traders to go apply a restriction in the
  // OpenX UI that the deal already carries — a false chore on every OpenX CTV
  // In-App deal, and a "NOT APPLIED" line on a deal sheet that was applied.
  // 'Web Only' is NOT exempt: on CTV/OTT it is both unsupported AND
  // contradictory (qa_device_inventory already warns on that combination).
  const openxChannelIsAppOnly = r.channel === 'CTV' || r.channel === 'OTT'
  if (!(openxChannelIsAppOnly && r.inv === 'In-App')) {
    // OTT now honours the caller's distribution_channel (cutlass#898), so the
    // client's Inventory Type reaches the wire instead of a loud marker.
    // DISPLAY/OLV/NATIVE still derive it from the channel — that override is
    // a separate follow-up, so they keep the marker.
    if (r.channel === 'OTT') {
      const distribution = r.inv === 'In-App' ? 'APP' : r.inv === 'Web Only' ? 'WEB' : 'WEB,APP'
      lines.push(`rendering_context:`)
      lines.push(`  distribution_channel: ${quote(distribution)}    # from Inventory Type: All → WEB,APP | Web Only → WEB | In-App → APP`)
    } else {
      lines.push(...environmentNotSupportedLines(r, 'OpenX', 'the OpenX MCP derives distribution_channel from targeting.channel for this channel (DISPLAY/OLV/NATIVE always ship "WEB,APP"); only OTT takes a caller override today'))
    }
  }

  // IAB names with no defensible v2 equivalent — loud marker, never a doomed
  // or silently-narrowing token (2026-07-14 audit).
  lines.push(...oxIabNotSupportedLines(oxIab.notSupported))

  // IAB/content EXCLUSIONS — OpenX has no create-time exclude arg (category
  // excludes are post-create-update-only), so fail loud, never guess an arg.
  lines.push(...iabExcludeNotSupportedLines(r, 'OpenX'))

  // File targeting — OpenX treats web domains and app bundles as DISTINCT
  // dimensions (url_targeting vs targeting.app_inventory.app_bundle_id), so emit
  // a block for each pool that has a file. A single deal — e.g. Display In-App —
  // legitimately carries both. domain_targeting_option (SUBDOMAIN|ROOT) is an
  // OpenX-only advanced setting that applies to web domains only.
  if (r.webDomainFile) {
    lines.push(...fileArgsBlock(r.webDomainFile, 'domain'))
    const opt = (ox.domainTargetingOption || '').toUpperCase()
    if (opt === 'SUBDOMAIN' || opt === 'ROOT') {
      lines.push(`domain_targeting_option: ${quote(opt)}    # SUBDOMAIN | ROOT (advanced; web domains only)`)
    }
  }
  if (r.appBundleFile) {
    lines.push(...fileArgsBlock(r.appBundleFile, 'app_bundle'))
    if (r.appBundleFile.inclusionType === 'Exclude') {
      // The OpenX MCP's app_inventory.app_bundle_id is an include (allowlist)
      // set; blocklists return a structured blocker. Surface it so the trader
      // isn't surprised by a failed create.
      lines.push(`# NOTE: OpenX app-bundle blocklists are not yet supported (app_inventory is an include set).`)
      lines.push(`# Apply these bundles as an allowlist or exclude them in the OpenX UI.`)
    }
  }

  // Inventory attachment — OPTIONAL since 2026-07-20 (trader-confirmed): a
  // pure audience/geo OpenX deal is legitimate and runs RUN-OF-EXCHANGE
  // (url_targeting/app_inventory/publishers are all optional on the create
  // API; the MCP's old missing_prompt_input_attachment blocker was removed
  // the same day and replaced with an ox_run_of_exchange quality flag). Emit
  // an explicit marker so the open footprint reads as a decision, not an
  // omission, and the agent knows not to hunt for a file.
  if (!r.webDomainFile && !r.appBundleFile) {
    lines.push(`# RUN-OF-EXCHANGE: no domain/app-bundle list on this deal — it targets ALL eligible OpenX inventory (audience/geo/format targeting still applies). This is intentional; do NOT attach a file.`)
  }

  // Fee — ALWAYS emit (percent fee types). The OpenX MCP fails fast with
  // `ox_fee_required` when the fee dict is omitted (there is NO built-in
  // default fee), so a curator-fee deal with no explicit OpenX Fee Partner
  // must still carry the margin. Accepted keys:
  // partner_name_or_id | partner_id (NOT partner_name); revenue_method enum is
  // exactly "PoM" | "CPM" (GraphQL enum, no normalization server-side).
  //   - PoM (Percent of Media): margin rides on gross_share_percent — the
  //     EXPLICIT-UNIT percent 0-100 key (#234.3 / cutlass#743.7).
  //     The legacy `gross_share` key is unit-ambiguous below 1 (the MCP once
  //     read a trader-meant 0.5% as a 0.5 FRACTION = 50% share) and now
  //     fails closed there; gross_share_percent carries sub-1% shares
  //     correctly (0.5 → wire fraction "0.005").
  //   - CPM (flat fee): margin rides on gross_cpm_cap.
  // The gross share defaults to the curator deal fee when the OpenX-specific
  // Gross Share field is blank, so the global curated fee reaches OpenX.
  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1: no verified non-percent wire is plumbed (the CPM
    // revenue method's gross_cpm_cap emission is unbuilt/unverified) — never
    // ship a Flat-Fee/Fixed-CPM value as a percent-of-media share.
    lines.push(...nonPercentFeeBlockLines(form, 'OpenX', 'fee.gross_share_percent, PoM percent of media'))
  } else {
    const oxRevenueMethod = ox.revenueMethod === 'CPM' ? 'CPM' : 'PoM'
    const oxGrossShare = (ox.grossShare || form.curatedDealFee || '').trim()
    lines.push(`fee:`)
    if (ox.feePartner) {
      lines.push(`  partner_name_or_id: ${quote(ox.feePartner)}    # name or numeric id; MCP resolves to partner_id`)
    } else {
      lines.push(`  # partner_name_or_id OMITTED — the OpenX tool has NO default fee partner: set the OpenX Fee Partner or OpenX returns missing_fee_partner.`)
    }
    lines.push(`  revenue_method: ${quote(oxRevenueMethod)}    # PoM (Percent of Media → gross_share_percent) | CPM (flat fee)`)
    if (oxRevenueMethod === 'PoM') {
      if (oxGrossShare) {
        lines.push(`  gross_share_percent: ${quote(oxGrossShare)}    # EXPLICIT-UNIT percent 0-100 (curator margin); sub-1 = a sub-1% share — the MCP converts to OpenX's 0-1 fraction wire (#234.3/cutlass#743.7)`)
      } else {
        lines.push(`  # gross_share_percent OMITTED — set the OpenX Gross Share or the curated deal fee. PoM REQUIRES the gross share.`)
      }
    }
  }


  return lines.join('\n')
}

function buildPubMaticPrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const pm = form.pubmaticConfig
  // Explicit form picks resolve through PUBMATIC_AD_FORMAT_ID (the legacy
  // 'Video (12)' alias lands on 13, so dedupe); otherwise fall back to the
  // channel map. NO '|| 3' fallback: a channel with no verified PubMatic
  // format (Native/Audio — cutlass#754) yields an empty list and emits a
  // fail-closed <FILL> below instead of silently minting a Banner deal.
  const explicitAdFormats = pm.adFormats?.length
    ? [...new Set(pm.adFormats.map(a => PUBMATIC_AD_FORMAT_ID[a]).filter(Boolean))]
    : []
  const channelAdFormat = PUBMATIC_AD_FORMAT_FOR_CHANNEL[r.channel]
  const adFormatId = explicitAdFormats.length
    ? explicitAdFormats
    : channelAdFormat ? [channelAdFormat] : []
  // CTV/OTT channels override the inventory-derived platform fallback: CTV
  // inventory is platform 7 (not the web/app set), OTT is mobile in-app video.
  // CTV pins to platform 7 — a CTV deal is TV-screen inventory by nature.
  // OTT does NOT pin: the environment is the client's Inventory Type choice,
  // so OTT falls through to PUBMATIC_PLATFORMS_FOR_INV exactly as OLV does
  // (All → [1,2,4,5], Web Only → [1,2], In-App → [4,5]).
  const channelPlatforms = r.channel === 'CTV' ? [7] : null
  const platformIds = pm.platforms?.length
    ? pm.platforms.map(p => PUBMATIC_PLATFORM_ID[p]).filter(Boolean)
    : (channelPlatforms || PUBMATIC_PLATFORMS_FOR_INV[r.inv] || [1])
  const publisherEntries = effectivePubMaticPublisherEntries(pm)
  const channelHint = SSP_CHANNEL_HINT.pubmatic[r.channel]
  const hasMaxReach = pm.maxReach ? 1 : 0
  // Curator margin: form curated deal fee ONLY. NO hardcoded 30 fallback —
  // Cutlass PubMatic has no built-in default fee, and fabricating 30% silently
  // over-bills a blank-fee deal. Leave NaN and emit a <FILL> placeholder so the
  // server unresolved-token gate catches it (mirrors IX/Xandr/Magnite/Media.net
  // fail-closed handling).
  const margin = form.curatedDealFee ? parseFloat(form.curatedDealFee) : NaN
  // PubMatic honors a deal-level floor (flooreCPM) ONLY on Fixed Price
  // (auctionType=3) deals — under First Price the platform rejects/drops it.
  // The old builder shipped the deal CPM as floor_ecpm, which silently flipped
  // every CPM-bearing deal to Fixed Price, TRANSACTING at that exact CPM
  // (PM-ZOOR-0075 booked fixed at $22.77 — client escalation, 2026-08-19).
  // Owner call: PubMatic deals are always First Price (dynamic) and ship NO
  // deal-level floor — publisher minimums govern via the auction. The deal
  // CPM never reaches PubMatic (deal_cpm skips PM, mirroring Magnite).

  const lines: string[] = []
  lines.push(`Call ${'mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs'} with these EXACT arguments:`)
  lines.push(``)
  lines.push(`name: ${quote(dealName)}`)
  lines.push(...startDateLines(r))
  lines.push(`end_date: ${quote(r.endDate || '<FILL>')}`)
  lines.push(`logged_in_owner_type_id: 7    # Buyer (required for write access)`)

  if (r.firstDspName) lines.push(`dsp_name: ${quote(r.firstDspName)}`)
  if (r.firstSeatId) {
    lines.push(`seat_id: ${quote(r.firstSeatId)}    # MCP looks up the buyer mapped to this seat`)
  }

  lines.push(`auction_type: 1    # First Price (dynamic) — NEVER 3, and NEVER send floor_ecpm: a deal-level floor forces Fixed Price and the deal transacts at that exact CPM (PM-ZOOR-0075, 2026-08-19)`)
  lines.push(`deal_source: 8    # DataProvider — required for our token's role`)
  lines.push(`has_max_reach: ${hasMaxReach}`)
  if (channelHint) lines.push(`channel: ${quote(channelHint)}    # Auto-fills device_types`)

  if (hasMaxReach === 0) {
    // Allowlist entries: id-bearing entries ship as exact publisher_ids;
    // name-only entries ride publisher_names (the PM MCP resolves them
    // server-side and warns on misses). The MCP unions both params.
    const pmPublisherIds = publisherEntries.map(e => (e.id || '').trim()).filter(Boolean)
    const pmPublisherNames = publisherEntries
      .filter(e => !(e.id || '').trim())
      .map(e => (e.name || '').trim())
      .filter(Boolean)
    if (pmPublisherIds.length > 0) {
      lines.push(`publisher_ids: [${pmPublisherIds.join(', ')}]    # exact trader-supplied publisher ids`)
    }
    if (pmPublisherNames.length > 0) {
      lines.push(`publisher_names:`)
      lines.push(...blockList(pmPublisherNames, '  '))
    }
  } else if (pm.maxAllowedPublishers) {
    lines.push(`max_allowed_publishers: ${pm.maxAllowedPublishers}`)
  }

  if (pm.publisherBlockList?.length > 0) {
    lines.push(`publisher_block_list: ${inlineList(pm.publisherBlockList.map(p => parseInt(p, 10) || 0).filter(n => n > 0))}    # Numeric publisher IDs`)
  }

  if (adFormatId.length > 0) {
    lines.push(`ad_formats: ${inlineList(adFormatId)}    # 3=Banner, 12=Native, 13=Video (PubMatic /v1/common/adType catalog)`)
  } else {
    // Fail closed: PubMatic has NO usable ad-format id for this channel
    // (Audio is id 14 but uiEnabled=0 in the adType catalog). The unresolved
    // token blocks the runner submit rather than guessing a format — the old
    // 'Native (13)' enum guess booked live VIDEO deals.
    lines.push(`ad_formats: <FILL — PubMatic has no usable ad-format id for the ${r.channel} channel (Audio id 14 is uiEnabled=0 in the adType catalog); pick Banner (3), Video (13), or Native (12) explicitly, or drop PubMatic for this deal>`)
  }
  lines.push(`platforms: ${inlineList(platformIds)}    # 1=Web, 2=MobileWeb, 4=MobileAppIOS, 5=MobileAppAndroid, 7=CTV`)

  if (r.countriesIso2.length > 0) lines.push(`geo_countries: ${inlineList(r.countriesIso2)}`)
  if (r.states.length > 0) lines.push(`geo_states: ${inlineList(r.states)}`)

  // Geo EXCLUSIONS (#244) — create-time geo_countries_exclude /
  // geo_states_exclude → targeting excludeGeos (the pm_merge_deal_geo
  // direction="exclude" wire field, "never serve here"). Fail-closed
  // server-side: pm_geo_exclude_unresolved / pm_geo_conflict. The MCP scopes
  // exclude-state resolution by the INCLUDE country context (F3), so emit
  // exclude states only when they classify to a single US/CA country —
  // unclassifiable ("Jersey") or mixed-country exclude states have no safe
  // scope and are audit-blocked (F3c), mirroring OpenX. ZIP/DMA exclusions
  // have no PubMatic path — loud + audit-blocked.
  if (r.excludeCountriesIso2.length > 0) {
    lines.push(`geo_countries_exclude: ${inlineList(r.excludeCountriesIso2)}    # → excludeGeos (never serve here); fail-closed (pm_geo_exclude_unresolved / pm_geo_conflict)`)
  }
  const pmExStatesMixed = r.excludeStatesUS.length > 0 && r.excludeProvincesCA.length > 0
  const pmExStatesClassifiable = r.excludeStatesUnknown.length === 0 && !pmExStatesMixed
  if (r.excludeStates.length > 0 && pmExStatesClassifiable) {
    lines.push(`geo_states_exclude: ${inlineList(r.excludeStates)}    # → excludeGeos; 2-letter codes resolved server-side scoped by the include country, fail-closed`)
  } else if (r.excludeStates.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('PubMatic', `states ${inlineList(r.excludeStates)}`, 'exclude states must classify to a single US/CA country to be scoped — mixed-country or unclassifiable exclude states have no safe PubMatic resolution scope'))
  }
  if (r.excludeZips.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('PubMatic', `ZIPs ${inlineList(r.excludeZips.slice(0, 5))}${r.excludeZips.length > 5 ? ' …' : ''}`, 'the PubMatic create wire has no postal-code geo path'))
  }
  if (r.excludeDmas.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('PubMatic', `DMAs ${inlineList(r.excludeDmas)}`, 'the PubMatic create wire has no DMA geo path'))
  }

  // IAB categories (#233.4) — names canonicalized to the live
  // PubMatic taxonomy spelling (curated map); names with no live equivalent
  // emit a loud NOT-SUPPORTED marker instead of a doomed token (the MCP's
  // exact-match resolver fails the WHOLE create on an unresolvable name).
  const pmIabInclude = pmIabNames(r.iabResolved)
  const pmIabExclude = pmIabNames(r.iabExcludeResolved)
  if (pmIabInclude.names.length > 0) {
    lines.push(`iab_categories:    # canonicalized to the live PubMatic taxonomy names (#233.4)`)
    lines.push(...blockList(pmIabInclude.names, '  '))
  }
  lines.push(...pmIabNotSupportedLines(pmIabInclude.notSupported, 'include'))

  if (pmIabExclude.names.length > 0) {
    lines.push(`exclude_iab_categories:    # IAB names/codes — resolved server-side → excludeIabCategories`)
    lines.push(...blockList(pmIabExclude.names, '  '))
  }
  lines.push(...pmIabNotSupportedLines(pmIabExclude.notSupported, 'exclude'))

  if (r.segmentsInclude.length > 0) {
    lines.push(`segment_names:`)
    lines.push(...blockList(r.segmentsInclude, '  '))
  }

  // Audience segment EXCLUSIONS (#226) — create-time
  // excluded_segment_names → targeting excludeAudienceSegments (the
  // pm_merge_deal_segments direction="exclude" wire shape, "never serve to
  // these"). Fail-closed server-side: an unresolved exclusion blocks the
  // create (pm_exclude_audience_unresolved) and an include/exclude overlap
  // blocks with pm_segment_conflict — never a silently narrowed exclusion.
  if (r.segmentsExclude.length > 0) {
    lines.push(`excluded_segment_names:    # → excludeAudienceSegments (never serve to these); fail-closed (pm_exclude_audience_unresolved / pm_segment_conflict)`)
    lines.push(...blockList(r.segmentsExclude, '  '))
  }

  if (r.viewabilityPct) lines.push(`viewability_threshold: ${r.viewabilityPct}    # 0-100 integer`)

  // Language — PubMatic has NO create-time language wire (verified against
  // the full pm prepare/execute signatures 2026-07-10); the legacy
  // qa_pm_language "Language targeting is set" PASS was a false green
  // (#226). Fail loud, never guess an arg.
  lines.push(...languageNotSupportedLines(r, 'PubMatic'))

  // Ad-duration targeting — PubMatic has NO deal-level ad-duration API
  // (curated-deal object + immutable targeting object carry no duration
  // field; verified against the archived full MBC video-targeting field
  // list, 2026-07-08). Fail loud, never guess an arg.
  lines.push(...adDurationNotSupportedLines(r, 'PubMatic'))

  // File targeting — domain or app-bundle, with explicit allow/block operator.
  lines.push(...fileTargetingBlock(r))

  // Fee — curator margin ONLY (a percentage). Cutlass normalizes this into the
  // PubMatic dealFees entry, deriving the recipient from the loaded seat's OWN
  // owner account (PUBMATIC_OWNER_ID_<client>) and the numeric feeType. Deal Onboarding
  // MUST NOT pin a string `recipient` or string `feeType` — that malformed shape
  // (recipient: the curator name / feeType: PoM) produced the INV_00_001 "Internal Error"
  // in a failed live batch.
  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1: PubMatic's dealFees entry books feeValue as a PERCENT.
    lines.push(...nonPercentFeeBlockLines(form, 'PubMatic', 'fee.feeValue, curator margin percent'))
  } else {
    lines.push(`fee:`)
    if (Number.isNaN(margin)) {
      lines.push(`  feeValue: <FILL curated deal fee — REQUIRED>    # curator margin %; Cutlass PubMatic has NO built-in default — set the curated deal fee`)
    } else {
      lines.push(`  feeValue: ${margin}    # curator margin % — the MCP resolves the dealFees recipient/feeType`)
    }
  }

  return lines.join('\n')
}

function buildXandrPrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const xn = form.xandrConfig
  const channelHint = SSP_CHANNEL_HINT.xandr[r.channel] || 'display'
  const adTypes = XANDR_AD_TYPES[r.channel] || ['banner']
  // Curator margin: the form's curated deal fee. NO hardcoded fallback — the
  // Xandr tool fails closed (`xandr_margin_required`) when margin is omitted;
  // never fabricate 30. Leave NaN and emit a fail-closed marker.
  const margin = form.curatedDealFee ? parseFloat(form.curatedDealFee) : NaN
  // The IO catalog (reference/xandr_insertion_orders.json) is the operator's
  // own insertion-order list. A known IO resolves to its numeric id +
  // advertiser id here; an unknown name ships as insertion_order_name for the
  // tool's live lookup.
  const ioName = xn.insertionOrder || ''
  const io = resolveXandrInsertionOrder(ioName)
  const dealLists = xn.dealListNames
    ? xn.dealListNames.split(',').map(s => s.trim()).filter(Boolean)
    : []

  // Deal code — unique within the Xandr account. A form-level dealCode with
  // >1 Xandr create in the batch would ship the SAME "unique" code twice and
  // the second create fails at the API. With multiple Xandr deals, treat a set
  // dealCode as a PREFIX: <code>-<n>, n = this deal's 1-based ordinal among
  // the batch's expanded Xandr create pairs (deterministic — same order the
  // batch emits). The per-deal-name fallback stays (names are unique by
  // construction). The audit's qa_xn_deal_codes item names the derived codes.
  const xnCreatePairs = expandDealDsps(splitBatchDeals(form.deals).createDeals.filter(x => x.ssp === 'Xandr'), form)
  const xnOrdinal = xnCreatePairs.findIndex(p => p.deal === deal && p.dsp === dsp)
  const rawCode = (xn.dealCode || '').trim()
  const code = rawCode
    ? (xnCreatePairs.length > 1 && xnOrdinal >= 0 ? `${rawCode}-${xnOrdinal + 1}` : rawCode)
    : dealName

  const lines: string[] = []
  lines.push(`Call ${'mcp_xandr_mcp_xandr_execute_deal_from_prompt_inputs'} with these EXACT arguments:`)
  lines.push(``)
  lines.push(`name: ${quote(dealName)}`)
  lines.push(`code: ${quote(code)}    # Unique within the Xandr account${rawCode && xnCreatePairs.length > 1 ? ' — form deal code applied as a prefix, one suffix per Xandr deal' : ''}`)
  // Deterministic buyer routing (#231): numeric member/seat ids skip
  // the MCP's /platform-member name resolution entirely; names resolve
  // server-side and FAIL LOUD on ambiguity — never fuzzy-guessed.
  const xnBuyerId = XANDR_BUYER_CANONICAL[r.firstDspName]
  const xnSeatId = (r.firstSeatId || '').trim()
  if (xnBuyerId) {
    lines.push(`buyer: ${xnBuyerId}    # ${r.firstDspName} house buyer member id (curated XANDR_BUYER_CANONICAL map; numeric skips name resolution)`)
  } else if (XANDR_SEAT_ROUTED_DSPS.has(r.firstDspName) && /^\d+$/.test(xnSeatId)) {
    lines.push(`buyer: ${xnSeatId}    # ${r.firstDspName} has NO house buyer member on Xandr — routed by the trader's numeric seat id (#231)`)
  } else {
    lines.push(`buyer: ${quote(r.firstDspName || '<FILL>')}    # DSP brand name; MCP resolves via /platform-member (primary_type=buyer) and fails loud on ambiguity`)
  }
  if (io) {
    lines.push(`insertion_order_id: ${io.id}    # ${ioName}`)
    lines.push(`advertiser_id: ${io.advertiserId}    # derived from the IO; the Curate line item bills under it`)
  } else if (!ioName) {
    lines.push(`# insertion_order_name: OMITTED — no Xandr Insertion Order specified on the form.`)
    lines.push(`# Set the Xandr Insertion Order in SSP Configuration; the tool resolves id+advertiser via live lookup.`)
  } else {
    lines.push(`insertion_order_name: ${quote(ioName)}    # REQUIRED — Curate IO; MCP resolves id+advertiser via live lookup`)
  }
  lines.push(`deal_type: ${quote(xn.dealType || 'Curated')}    # Curated (id=5) for Curate UI visibility`)
  lines.push(`channel: ${quote(channelHint)}`)
  lines.push(`ad_types: ${inlineList(adTypes)}    # banner | video | native — Curate offers no audio type`)

  // Supply type carries the client's Inventory Type. Curate has an Inventory
  // Type axis (All / Web / App) and the profile takes supply_type_targets +
  // supply_type_action, but this builder emitted nothing for it, so the
  // client's choice was silently dropped on every Xandr deal. Values are
  // live-verified off the account's own profiles: web, mobile_web, mobile_app
  // (the canonical AppNexus docs say "mobile_browser"; the wire says
  // "mobile_web"). Environment = All targets nothing, which means no
  // restriction — narrowing only happens when the trader asks for it.
  const xandrSupplyTypes =
    r.inv === 'In-App' ? ['mobile_app'] : r.inv === 'Web Only' ? ['web', 'mobile_web'] : []
  if (xandrSupplyTypes.length > 0) {
    lines.push(`supply_types: ${inlineList(xandrSupplyTypes)}    # from Inventory Type '${r.inv}' → profile.supply_type_targets (action=include)`)
  }

  // Xandr start_date — the Deal Service stores naive datetimes as UTC
  // (cutlass#744.8, live-verified; the protocol's old "local time" claim was
  // wrong): the legacy "YYYY-MM-DD 00:00:00" emission went live at
  // 19:00/20:00 US-Eastern the PRIOR calendar day. Emit the intended
  // ET-calendar-day boundary as its UTC instant (midnight America/New_York →
  // 04:00:00 EDT / 05:00:00 EST). A start of TODAY would render a past
  // instant (ET midnight has already passed), so it is omitted — the MCP
  // defaults start_date to "now" (immediate), the correct start-today wire.
  if (r.startDate === businessTodayISO()) {
    lines.push(`# start_date omitted — this deal starts TODAY (${r.startDate} ${BUSINESS_TIMEZONE}); the MCP defaults to "now" (immediate start).`)
    lines.push(`# Xandr stores naive datetimes as UTC (cutlass#744.8) — do NOT pass "${r.startDate} 00:00:00" (that instant is already past / prior-evening ET).`)
    if (r.startDateBumped) {
      lines.push(`# (form start ${r.startDateOriginal} was in the past — auto-bumped to today.)`)
    }
  } else {
    lines.push(...startDateLines(r, { formatDate: businessMidnightUtc, trailingComment: `UTC instant of midnight ${BUSINESS_TIMEZONE} — Xandr stores naive datetimes as UTC (cutlass#744.8)` }))
  }
  // Xandr supports always-on natively (docstring + protocol confirm,
  // audited 2026-05-21). Per the house end-date policy we leave end_date
  // off entirely so the Xandr deal is created with no expiry.
  lines.push(`# end_date intentionally omitted — Xandr always-on per house policy.`)

  lines.push(`revenue_type: ${quote(xn.revenueType || 'vcpm')}    # vcpm (Standard/Dynamic) | cpm (Fixed)`)
  if (r.cpm) lines.push(`ask_price: ${r.cpm}    # CPM floor (valuation.min_revenue_value when revenue_type=vcpm)`)
  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1: margin_cpm exists on the Xandr wire but its mapping
    // from the form's Fixed-CPM/Flat-Fee semantics is unverified — fail
    // closed rather than guess a money wire.
    lines.push(...nonPercentFeeBlockLines(form, 'Xandr', 'margin_percent, % of buyer bid'))
  } else if (Number.isNaN(margin)) {
    lines.push(`# margin_percent: OMITTED — set the curated deal fee. Cutlass Xandr REQUIRES a curator margin (xandr_margin_required); there is no built-in default.`)
  } else {
    lines.push(`margin_percent: ${margin}    # Curator margin (% of buyer bid). Mutually exclusive with margin_cpm. REQUIRED by Cutlass — no built-in default.`)
  }
  lines.push(`payment_type: ${quote(xn.paymentType?.toLowerCase() === 'revshare' ? 'cpvm' : 'default')}    # default | cpvm`)
  lines.push(`currency: USD`)
  lines.push(`active: true`)
  lines.push(`use_deal_floor: true`)

  if (form.brand) lines.push(`description: ${quote(`${form.brand} — ${deal.theme || dealName}`)}`)

  if (r.countriesIso2.length > 0) lines.push(`geo_countries: ${inlineList(r.countriesIso2)}    # ISO-2 codes`)
  if (r.states.length > 0) lines.push(`geo_states: ${inlineList(r.states)}    # 2-letter`)

  // Geo EXCLUSIONS (#244) — the Xandr profile carries ONE
  // country_action / region_action for the whole dimension (the same
  // sibling fields the merge tool drives), so an exclusion emits ONLY when
  // its dimension has no includes (the MCP XOR-gates this:
  // xandr_geo_country_conflict / xandr_geo_region_conflict). The canonical
  // compose — include country + exclude region — works: country_action stays
  // include while region_action goes exclude. Unresolved exclusions fail the
  // create closed (xandr_geo_exclude_unresolved), never partial-drop.
  if (r.excludeCountriesIso2.length > 0) {
    if (r.countriesIso2.length > 0) {
      lines.push(...geoExcludePartialNotSupportedLines('Xandr', `countries ${inlineList(r.excludeCountriesIso2)}`, 'the profile carries ONE country_action — a country exclude cannot ride alongside country includes'))
    } else {
      lines.push(`geo_countries_exclude: ${inlineList(r.excludeCountriesIso2)}    # country_action="exclude" (never serve here); fail-closed (xandr_geo_exclude_unresolved)`)
    }
  }
  if (r.excludeStates.length > 0) {
    if (r.states.length > 0) {
      lines.push(...geoExcludePartialNotSupportedLines('Xandr', `states ${inlineList(r.excludeStates)}`, 'the profile carries ONE region_action — a region exclude cannot ride alongside region includes'))
    } else {
      lines.push(`geo_states_exclude: ${inlineList(r.excludeStates)}    # region_action="exclude"; composes with geo_countries includes (include US, exclude state); fail-closed`)
    }
  }
  if (r.excludeZips.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('Xandr', `ZIPs ${inlineList(r.excludeZips.slice(0, 5))}${r.excludeZips.length > 5 ? ' …' : ''}`, 'no Xandr postal-code exclude emission is wired'))
  }
  if (r.excludeDmas.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('Xandr', `DMAs ${inlineList(r.excludeDmas)}`, 'no Xandr DMA exclude emission is wired'))
  }

  // IAB categories — canonicalized to exact live universal-catalog names
  // (2026-07-14 audit): the MCP resolver is FAIL-OPEN (unresolved names
  // silently drop with a quality flag; single-substring hits fuzzy-promote to
  // wrong entities), so only verified catalog names are emitted; unsupported
  // names get the loud marker instead of silently vanishing.
  const xnIab = xnIabNames(r.iabResolved)
  if (xnIab.names.length > 0) {
    lines.push(`iab_categories:    # exact Xandr universal content-category names (canonicalized, live catalog 2026-07-14)`)
    lines.push(...blockList(xnIab.names, '  '))
    lines.push(`# Auto-uses platform_content_category_targets on the profile (Curate-required)`)
  }
  lines.push(...xnIabNotSupportedLines(xnIab.notSupported))
  // IAB/content EXCLUSIONS — Xandr's API has no IAB/genre exclude, fail loud.
  lines.push(...iabExcludeNotSupportedLines(r, 'Xandr'))
  if (r.segmentsInclude.length > 0) {
    lines.push(`segment_names:`)
    lines.push(...blockList(r.segmentsInclude, '  '))
  }
  // Audience segment EXCLUSIONS (#226) — create-time
  // excluded_segment_names → segment_targets elements with action="exclude"
  // (the merge tool's element shape). Fail-closed server-side: an unresolved
  // exclusion blocks the create (xandr_segment_exclude_unresolved) and an
  // include/exclude overlap blocks with xandr_segment_conflict.
  if (r.segmentsExclude.length > 0) {
    lines.push(`excluded_segment_names:    # → segment_targets action="exclude" (never serve to these); fail-closed (xandr_segment_exclude_unresolved / xandr_segment_conflict)`)
    lines.push(...blockList(r.segmentsExclude, '  '))
  }
  if (dealLists.length > 0) {
    lines.push(`deal_list_names:`)
    lines.push(...blockList(dealLists, '  '))
  }

  // #220: a resolved site/app-bundle list has NO Xandr emission path — the
  // MCP cannot ingest a list FILE (deal_list_targets take PRE-EXISTING Curate
  // deal lists only, and raw publisher_targets are platform-prohibited on
  // Curate profiles). Fail LOUD instead of silently dropping the list: the
  // deal used to be created with zero domain/app scoping while the deal card
  // and QA claimed the list was applied.
  if (r.domainFile) {
    const op = r.domainOpInclude === 'Exclude' ? 'blocklist' : 'allowlist'
    const kindLabel = r.fileKind === 'app_bundle' ? 'app-bundle' : 'site'
    lines.push(`# LIST NOT APPLIED: "${dealFilePath(r.domainFile)}" (${op}, ${kindLabel} list) — Xandr cannot ingest a list FILE;`)
    lines.push(`# deal-list targeting (xandr_merge_deal_lists) takes PRE-EXISTING Curate deal lists only, and raw`)
    lines.push(`# publisher_targets are platform-prohibited on Curate profiles. Do NOT pass this file to any Xandr tool.`)
    lines.push(`# Configure a Curate deal list in the Xandr UI (or pass deal_list_names above) to cover these entries,`)
    lines.push(`# and report this list as NOT APPLIED in the final summary.`)
  }

  // Viewability — Xandr's create wire (deal + profile + curated line item)
  // has NO deal-level viewability field (verified against the full
  // xandr_execute_deal_from_prompt_inputs surface 2026-07-10). Fail loud —
  // qa_viewability warns on Xandr so a set target can never report PASS
  // "configured" while nothing ships (#226).
  lines.push(...viewabilityNotSupportedLines(r, 'Xandr', 'the Xandr create wire (deal/profile/line item) carries no viewability field'))

  // Language — Xandr's create wire has no language targeting arg; fail loud.
  lines.push(...audioNotSupportedLines(r, 'Xandr', "the Curate deal builder offers only Banner, Video and Native ad types"))
  // Environment now HAS a wire on Xandr (supply_types above), so no marker.
  lines.push(...languageNotSupportedLines(r, 'Xandr'))

  // Ad-duration targeting — profile.video_targets.deal_creative_duration is
  // a ONE-SIDED MINIMUM-ALLOWED filter ("slots allowing >= N seconds"), so
  // the canonical mapping is the LOWER bound. Xandr cannot cap ad length
  // upward — a max-only requirement is NOT expressible and must fail loud
  // (never approximated silently). Rides the deal LINE-ITEM's profile.
  if (r.adDurations.length > 0) {
    lines.push(`deal_creative_duration: ${r.adDurationLo}    # LOWER bound, integer seconds: targets slots allowing >= ${r.adDurationLo}s`)
    lines.push(`# NOTE: Xandr cannot cap ad length upward — ${describeAdDurationRequest(r)} maps to the lower bound only (>= ${r.adDurationLo}s);`)
    lines.push(`# lengths above ${r.adDurationHi}s are NOT excluded by Xandr. Per-ad length enforcement stays DSP-side. Surface this in the final summary.`)
  } else if (r.maxAdDurationSecs !== undefined) {
    lines.push(`# NOT SUPPORTED on Xandr: ad-duration cap (max ${r.maxAdDurationSecs}s) — deal_creative_duration is a one-sided MINIMUM-allowed`)
    lines.push(`# filter and cannot express an upper cap; cannot be applied on this SSP; report as NOT APPLIED in the final summary.`)
  }

  return lines.join('\n')
}

function buildTripleLiftPrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const tl = form.tripleliftConfig
  // TripleLift's channel is DERIVED FROM THE DEAL, not the batch. It used to
  // read only the batch-level form dropdown, so a CTV deal in a mixed batch
  // shipped `channel: WEB` unless a trader remembered to flip it by hand —
  // silently booking TV inventory against the web supply pool. CTV is the
  // only channel that routes to the CTV pool; every other channel is
  // "Web & Mobile" (the vendor's own label for WEB). An explicit form value
  // still wins, so an operator can override for a case we have not modelled.
  const channel = (tl.channel || (r.channel === 'CTV' ? 'CTV' : 'WEB')).toUpperCase()
  const dealPriceType = (tl.dealPriceType || 'FLOOR').toUpperCase()
  const formats = tl.commercializedFormats?.length
    ? tl.commercializedFormats.map(f => f.toUpperCase().replace(/\s+/g, '_'))
    : (TRIPLELIFT_FORMATS_FOR_CHANNEL[r.channel] || ['DISPLAY'])
  // dealPriceValue is REQUIRED — no silent 0.10 default. NaN → fail-closed marker.
  const price = r.cpm ? parseFloat(r.cpm) : NaN
  // Curator margin: the form's curated deal fee. tl_create_deal fails fast
  // with `tl_fee_required` when curationFee is absent — no default.
  const feePct = form.curatedDealFee ? parseFloat(form.curatedDealFee) : NaN

  // TripleLift's dsp.seat.id is the BUYER id (== dsp.id), NOT the seat token.
  // The trader's seat string (e.g. "393") goes in seat.seatString only. Live
  // shape: dsp:{id:2409, seat:{id:2409, name, seatString:"393"}} — emitting the
  // seat token in seat.id (the old parseInt(firstSeatId)) creates the wrong deal.
  const seatString = r.firstSeatId || '<FILL seatString>'
  const dspName = r.firstDspName || '<DSP>'
  const tlCreateTool = 'mcp_triplelift_mcp_tl_create_deal'
  const tlListBuyers = 'mcp_triplelift_mcp_tl_list_buyers'
  const tlListCountries = 'mcp_triplelift_mcp_tl_list_countries'
  const tlListRegions = 'mcp_triplelift_mcp_tl_list_regions'
  const tlListSegments = 'mcp_triplelift_mcp_tl_list_segments'

  // Dynamic Step-1 sub-step letters: only emitted resolution steps consume a
  // letter, so every "<… from Step 1x>" token in the payload points at a real
  // sub-step (states without countries, segments without geo, etc.).
  const stepLetters = ['b', 'c', 'd']
  let stepIdx = 0
  const countryStep = r.countriesIso2.length > 0 ? stepLetters[stepIdx++] : ''
  const regionStep = r.states.length > 0 ? stepLetters[stepIdx++] : ''
  const segmentStep = r.segmentsInclude.length > 0 ? stepLetters[stepIdx++] : ''

  const lines: string[] = []
  // TripleLift has NO prepare/execute tool — tl_create_deal takes a raw payload
  // and int-casts dsp.id / country_ids / region_ids / segment_ids, so passing
  // names or ISO codes crashes the create. Resolve the numeric IDs via the list
  // tools FIRST, then create. This is what makes a TL deal paste-and-go like
  // the other SSPs.
  lines.push(`TripleLift has no prepare/resolve tool — resolve numeric IDs FIRST (Step 1), then create (Step 2).`)
  lines.push(``)
  lines.push(`Step 1 — resolve numeric IDs (run BEFORE tl_create_deal):`)
  lines.push(`  a. ${tlListBuyers} — find the buyer whose name matches ${quote(dspName)}. Use its numeric id for BOTH dsp.id AND dsp.seat.id (TripleLift uses the buyer id as the seat id; tl_list_buyers returns no separate seat object). The trader's seat token goes in dsp.seat.seatString only.`)
  if (countryStep) {
    lines.push(`  ${countryStep}. ${tlListCountries} — map ${inlineList(r.countriesIso2)} to numeric ids for country_ids.`)
  }
  if (regionStep) {
    // State/province targeting (cutlass#732): the EB_SUPPLY_GEO_REGION_ID
    // catalog carries ISO-3166-2-style codes (e.g. US-CA), so emit the
    // country-qualified codes the classifier resolved — never a bare "CA"
    // (California vs Canada is exactly the ambiguity that widened geo).
    const regionCodes = [...r.statesUS.map(s => `US-${s}`), ...r.provincesCA.map(p => `CA-${p}`)]
    lines.push(`  ${regionStep}. ${tlListRegions} — map ${inlineList(regionCodes.length > 0 ? regionCodes : r.states)} to numeric REGION ids for region_ids (match the catalog code, e.g. US-CA, or region name). An unresolvable state/province is a HARD failure — STOP and report that deal BLOCKED; NEVER create with silently widened geo (cutlass#732).`)
    if (r.statesUnknown.length > 0) {
      lines.push(`     # UNCLASSIFIED region tokens ${inlineList(r.statesUnknown)} — could not tell US state from CA province; resolve each against the ${tlListRegions} catalog explicitly and STOP if ambiguous.`)
    }
  }
  if (segmentStep) {
    lines.push(`  ${segmentStep}. ${tlListSegments} — map these segment names to numeric ids for segment_ids:`)
    for (const s of r.segmentsInclude) lines.push(`       - ${quote(s)}`)
  }
  lines.push(``)
  lines.push(`Step 2 — call ${tlCreateTool} with this payload (memberId defaults from the loaded seat's TRIPLELIFT_MEMBER_ID env). Replace every <…from Step 1> token with the resolved INTEGER ids — names/codes will fail:`)
  lines.push(``)
  lines.push(`payload:`)
  lines.push(`  name: ${quote(dealName)}`)
  lines.push(`  active: true`)
  lines.push(`  dealTypeId: 1    # REQUIRED by tl_create_deal (Missing required fields: dealTypeId otherwise)`)
  lines.push(`  primaryGoalId: 1    # MAXIMIZE_REVENUE — TripleLift catalog default for curator deals`)
  // secondaryGoal is REQUIRED for curated deals — TripleLift rejects null with
  // "Secondary goal is required for curated deals". Emit the flattened shape
  // {id, value:<number>} the live API accepts (id 2 = spend goal, value in
  // USD cents). The MCP's nested→flat normalization does not fire on create.
  lines.push(`  secondaryGoal: {id: 2, value: 250}    # REQUIRED for curated deals (id=2 spend goal, value in USD cents)`)
  lines.push(`  budget: 0    # 0 = uncapped`)
  lines.push(`  dealPriceType: ${dealPriceType}    # CEILING | FIXED | FLOOR`)
  if (Number.isNaN(price)) {
    lines.push(`  dealPriceValue: <FILL dealPriceValue — REQUIRED; set the deal CPM>    # Numeric, no currency suffix`)
  } else {
    lines.push(`  dealPriceValue: ${price}    # Numeric, no currency suffix`)
  }
  // curationFee — REQUIRED by tl_create_deal (tl_fee_required, fail-fast before
  // any network call). Shape: {feeModel:{id:3,type:FEE_MODEL_TYPE_PERCENT}, value, cap}.
  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1: the emitted feeModel is FEE_MODEL_TYPE_PERCENT — a
    // Flat-Fee/Fixed-CPM value would book as a percent curation fee.
    for (const ln of nonPercentFeeBlockLines(form, 'TripleLift', 'curationFee FEE_MODEL_TYPE_PERCENT')) {
      lines.push(`  ${ln}`)
    }
  } else if (Number.isNaN(feePct)) {
    lines.push(`  # curationFee: OMITTED — set the curated deal fee. tl_create_deal REQUIRES curationFee (tl_fee_required); there is no built-in default.`)
  } else {
    lines.push(`  curationFee:`)
    lines.push(`    feeModel:`)
    lines.push(`      id: 3`)
    lines.push(`      type: FEE_MODEL_TYPE_PERCENT`)
    lines.push(`    value: ${feePct}    # Curator margin percent`)
    lines.push(`    cap: null    # no CPM cap`)
  }
  // TripleLift uses camelCase + 2-space indent for the payload dict.
  for (const ln of startDateLines(r, { key: 'startDate', trailingComment: 'ISO-8601 (YYYY-MM-DD ok)' })) {
    lines.push(`  ${ln}`)
  }
  // Date-only flight boundary (#235.3, VENDOR-OPEN cutlass#757):
  // TripleLift documents no boundary timezone/inclusivity for date-only
  // flights — ASSUMED end-of-day-inclusive in the vendor's clock.
  lines.push(`  endDate: ${quote(r.endDate || '<FILL end_date>')}`)
  lines.push(`  commercializedFormats: ${inlineList(formats)}    # Uppercase enum`)
  lines.push(`  channel: ${channel}    # WEB | CTV — ${tl.channel ? 'forced for the batch' : `derived from this deal's channel '${r.channel}'`}`)
  lines.push(`  isPublisher: false`)
  lines.push(`  creativeTags: false    # nullable boolean — NOT an array`)
  lines.push(`  dspFormatWorkflow: null    # enum NATIVE | VIDEO, or null (display/standard)`)
  lines.push(`  dsp:`)
  lines.push(`    id: <dsp.id from Step 1a — buyer ${quote(dspName)}>`)
  lines.push(`    seat:`)
  lines.push(`      id: <dsp.id from Step 1a — the SAME buyer id as dsp.id, NOT the seat token>`)
  lines.push(`      name: ${quote(dspName)}`)
  lines.push(`      seatString: ${quote(seatString)}    # the trader's seat token (e.g. 393) — NOT the dsp.seat.id`)
  // Convenience targeting keys (MCP folds into targetingExpression) — integers only.
  if (countryStep) {
    lines.push(`  country_ids: [<numeric ids from Step 1${countryStep}>]    # integers only — resolved from ${inlineList(r.countriesIso2)}`)
  }
  if (regionStep) {
    lines.push(`  region_ids: [<numeric REGION ids from Step 1${regionStep}>]    # integers only — state/province geo (EB_SUPPLY_GEO_REGION_ID); composes with country_ids`)
  }
  if (segmentStep) {
    lines.push(`  segment_ids: [<numeric ids from Step 1${segmentStep}>]    # integers only — one per segment name above`)
  }
  lines.push(`  targeting_operator: AND`)
  if (r.countriesIso2.length === 0 && r.states.length === 0 && r.segmentsInclude.length === 0 && !tl.allowPoliticalAds) {
    lines.push(`  # BLOCKED: TripleLift requires targetingExpression, but this deliberately-global deal has no verified country/region/device/segment/political input from which to build one (#238.6).`)
    lines.push(`  # Add an explicit supported targeting input. Do NOT improvise an empty/raw targetingExpression tree.`)
  }
  // Regulatory Policy → Controlled → "Include Political Ads Allowed". The MCP
  // convenience key folds the UI_EXPR_REGULATORY_POLICY_CONTROLLED node into
  // targetingExpression — do NOT hand-build that node.
  if (tl.allowPoliticalAds) {
    lines.push(`  allow_political_ads: true    # Regulatory Policy → Controlled → Include Political Ads Allowed`)
  }

  // ZIP + DMA geo (cutlass#732) — fail LOUD, never silently drop. ZIPs: the
  // TL API supports EB_SUPPLY_GEO_CANONICAL_POSTAL_CODE (live-read-proven,
  // deal 85579) and cutlass tl_create_deal now accepts a postal_codes
  // convenience key, but WRITE acceptance is vendor-unconfirmed until the
  // live create canary runs — until then the prompt forbids the key and
  // routes ZIPs to a manual UI step. DMAs: no TripleLift binding exists at
  // all. Mirrors the adDurationNotSupportedLines fail-loud style.
  if (r.zips.length > 0) {
    lines.push(``)
    lines.push(`# NOT SUPPORTED on TripleLift (pending cutlass#732 write canary): ZIP/postal targeting (${r.zips.length} ZIP${r.zips.length === 1 ? '' : 's'}, e.g. ${inlineList(r.zips.slice(0, 5))}) —`)
    lines.push(`# the postal_codes write path is vendor-unconfirmed; do NOT pass a postal_codes key. Apply the ZIP list`)
    lines.push(`# manually in the TripleLift UI and report it as NOT APPLIED in the final summary.`)
  }
  if (r.dmas.length > 0) {
    lines.push(``)
    lines.push(`# NOT SUPPORTED on TripleLift: DMA targeting (${inlineList(r.dmas)}) — no DMA binding exists on the TripleLift API;`)
    lines.push(`# apply DMA scoping manually in the UI and report it as NOT APPLIED in the final summary.`)
  }

  // IAB categories (#226) — VENDOR-GATED: tl_create_deal has no IAB
  // path and the brandAndCreativeControls iabCategoryTargeting scaffold ships
  // EMPTY; TripleLift publishes no IAB item-ID discovery endpoint (vendor
  // escalation cutlass#757 ask #4). Never guess targeting-node item ids —
  // fail loud instead, and qa_contextual warns so TL IAB can never report
  // configured.
  lines.push(...iabIncludeNotSupportedLines(r, 'TripleLift', 'tl_create_deal has no IAB path and TripleLift publishes no IAB item-ID discovery endpoint (vendor-gated, cutlass#757)'))

  // Audience segment EXCLUSIONS (#226) — the targetingExpression
  // format carries an excluded flag, but whether the TL engine honors
  // excluded:true on EB_SUPPLY_1P_SEGMENT_ID audience leaves is
  // vendor-unconfirmed (cutlass#757). Ambiguous capability = NOT SUPPORTED.
  lines.push(...segmentExcludeNotSupportedLines(r, 'TripleLift', 'excluded:true on audience-segment leaves is vendor-unconfirmed (cutlass#757) — never write an unverified exclude leaf'))

  // Viewability — TripleLift has no deal-level viewability wire; fail loud.
  lines.push(...viewabilityNotSupportedLines(r, 'TripleLift', 'tl_create_deal and the targetingExpression bindings carry no viewability field'))

  // Language — TripleLift has no create-time language wire; fail loud.
  // Device targeting — EB_SUPPLY_DEVICE_TYPE integer ids, resolved live via
  // tl_list_device_types (cutlass#898 fixed the catalog read):
  //     1 Desktop/Laptop · 2 Phone · 3 Tablet · 4 Connected TV
  // One rule, same as every other SSP: CTV takes the TV device, everything
  // else takes the rest. TripleLift has no environment axis, so Inventory
  // Type never narrows this.
  const tlDeviceTypes = r.channel === 'CTV' ? [4] : [1, 2, 3]
  lines.push(`device_types: ${inlineList(tlDeviceTypes)}    # ${r.channel === 'CTV' ? 'Connected TV' : 'Desktop/Laptop, Phone, Tablet'} (EB_SUPPLY_DEVICE_TYPE ids)`)

  lines.push(...audioNotSupportedLines(r, 'TripleLift', "commercializedFormats has no audio value; the channel would book INSTREAM video"))
  lines.push(...environmentNotSupportedLines(r, 'TripleLift', 'the TripleLift create wire has no web/app environment leaf'))
  lines.push(...languageNotSupportedLines(r, 'TripleLift'))

  // Geo EXCLUSIONS (#244) — excluded:true on supply-geo nodes is
  // vendor-unconfirmed; fail loud + the audit blocks the batch.
  lines.push(...geoExcludeNotSupportedLines(r, 'TripleLift', 'excluded:true on EB_SUPPLY_GEO_* nodes is vendor-unconfirmed (fail-closed indefinitely per #244)'))

  // Ad-duration targeting — TripleLift has NO deal-level ad-duration
  // mechanism (live-probed 2026-07-08: legacyTargeting duration fields are
  // read-only null projections; every duration-shaped targetingExpression
  // binding candidate was rejected). Fail loud, never guess an arg.
  lines.push(...adDurationNotSupportedLines(r, 'TripleLift'))

  // IAB/content EXCLUSIONS — TripleLift's API has no IAB/genre exclude, fail loud.
  lines.push(...iabExcludeNotSupportedLines(r, 'TripleLift'))

  // #220/#731: a resolved list has NO create-time TripleLift arg. Domain
  // lists get a post-create tl_merge_deal_supply_domains instruction
  // (mirroring the Media.net post-create pattern; every arg below is a REAL
  // parameter of the tool, pinned by cutlass-contract.json TripleLift.lists).
  // The tool merges the SUPPLY-domain inventory leaf (targetingExpression
  // binding EB_SUPPLY_DOMAIN_ID — the dimension a site list actually means);
  // tl_merge_deal_domains remains the separate ADVERTISER/adomain
  // brand-safety control and is never a substitute. App-bundle lists have no
  // TripleLift dimension at all — fail LOUD, never merge bundle ids into a
  // domain field.
  if (r.domainFile) {
    if (r.fileKind === 'app_bundle') {
      lines.push(``)
      lines.push(`# LIST NOT APPLIED: the attached app-bundle list "${dealFilePath(r.domainFile)}" CANNOT be applied on TripleLift.`)
      lines.push(`# The supply-domain leaf (EB_SUPPLY_DOMAIN_ID) targets site domains, not app bundles — merging bundle ids`)
      lines.push(`# there (or into advertiser-domain brand-safety) would corrupt the field. You MUST NOT pass this file to any TripleLift tool.`)
      lines.push(`# Report this list as NOT APPLIED in the final summary.`)
    } else {
      const excluded = r.domainOpInclude === 'Exclude'
      const mergeTool = 'mcp_triplelift_mcp_tl_merge_deal_supply_domains'
      lines.push(``)
      lines.push(`# POST-CREATE TARGETING (REQUIRED): the attached list "${dealFilePath(r.domainFile)}"`)
      lines.push(`# cannot ride tl_create_deal. After the deal is created, merge it into SUPPLY-domain (site/inventory) targeting with:`)
      lines.push(`#   ${mergeTool}(`)
      lines.push(`#     deal_id: <the created TripleLift deal id>`)
      lines.push(`#     values_file: ${dealFilePath(r.domainFile)}`)
      lines.push(`#     values_sha256: <sha256sum of the file>`)
      lines.push(`#     expected_count: <non-blank line count of the file>`)
      lines.push(`#     merge_mode: add`)
      lines.push(`#     action: ${excluded ? 'EXCLUDE' : 'INCLUDE'}    # ${excluded ? 'blocklist ⇒ excluded:true supply leaf' : 'allowlist ⇒ excluded:false supply leaf'} (from file inclusionType)`)
      lines.push(`#   )`)
      lines.push(`# DIMENSION (cutlass#731): tl_merge_deal_supply_domains merges the SUPPLY-domain inventory leaf`)
      lines.push(`# (targetingExpression binding EB_SUPPLY_DOMAIN_ID — bare-domain stringTargets; the excluded flag is the block/allow direction).`)
      lines.push(`# ADVERTISER/adomain brand-safety lists are a DIFFERENT dimension (tl_merge_deal_domains) — never conflate the two.`)
      lines.push(`# Report this list as applied POST-CREATE to supply-domain targeting in the final summary, citing the merge`)
      lines.push(`# tool's returned verification (change_present / verification_status) for the deal.`)
    }
  }

  return lines.join('\n')
}

function buildMediaNetPrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const mn = form.medianetConfig
  // VENDOR ad_format ints: Banner=0, Native=1, Video=2 (Select API Guide v9.4
  // p.12-13/p.23). Do NOT invert Video/Native, and never "correct" this to
  // match code constants — the vendor guide is the only source of truth.
  const adFormatId = (() => {
    if (mn.adFormat?.includes('Video')) return 2
    if (mn.adFormat?.includes('Native')) return 1
    if (mn.adFormat?.includes('Banner')) return 0
    return MEDIANET_AD_FORMAT_ID[r.channel] ?? 0
  })()
  const marginType = mn.marginType?.includes('Percentage') ? 1 : 0
  // Curator margin: form Media.net margin → global curated deal fee → client
  // fee_percent. NO hardcoded fallback — Media.net REQUIRES margin; leave NaN
  // and emit a fail-closed marker (mirrors the IX margin_required pattern).
  const margin = parseFloat(
    mn.marginValue || form.curatedDealFee || '',
  )
  const channelHint = SSP_CHANNEL_HINT.medianet[r.channel]
  // Media.net's `environments` axis spans BOTH of ours: it carries the
  // CTV-vs-not distinction we call Channel AND the web-vs-app distinction we
  // call Inventory Type. So the value is a function of both.
  //
  // Vocabulary is Web | MobileApp | CTV, per the official Select MCP's
  // create-deal schema. 'App' is the deprecated spelling of 'MobileApp'.
  // A CTV deal ships the CTV environment — its devices (Connected TV,
  // Connected Device, Set Top Box) exist ONLY in that environment, so a CTV
  // deal on Web/MobileApp targets devices that are not valid there.
  const envs = mn.environments?.length
    ? mn.environments
    : r.channel === 'CTV'
      ? ['CTV']
      : (r.inv === 'In-App' ? ['MobileApp'] : r.inv === 'Web Only' ? ['Web'] : ['Web', 'MobileApp'])

  // Media.net deal_id: ≤30 chars, [A-Za-z0-9_-]+ — computed by the shared
  // medianetDealId helper (dealNameSlots.ts) so records carry the
  // IDENTICAL id at create time. The seed covers DSP + data-partner + theme +
  // channel + inventory + geo + campaign (everything that distinguishes deals
  // in a batch); over-length seeds keep the head and append an 8-hex digest of
  // the full canonical deal name instead of blind tail-truncation.
  const dealId = medianetDealId(form, deal, { dsp })
  // display_name carries the FULL canonical deal name (≤255): cutlass#747
  // lifted the Media.net MCP's old 30-char create guard — Media.net stores
  // 73+ char names fine, and the old truncated-theme display_name broke
  // cross-SSP name consistency in the Media.net UI. The audit's
  // deal_name_length check gates the 255 ceiling.
  const displayName = dealName.replace(/\s+/g, ' ').trim()
  // demand_partners is scoped to THIS expanded deal's DSP (matching the
  // OpenX/IX/TripleLift builders) — under multi-DSP expansion each per-DSP
  // deal must carry exactly its own DSP, and with the multipleDsps toggle
  // off a stale second row must not leak in (r.firstDspName already rides
  // the activeDsps() resolution).
  const demandPartners = r.firstDspName ? [r.firstDspName] : []

  const lines: string[] = []
  lines.push(`Call ${'mcp_medianet_mcp_mn_execute_deal_from_prompt_inputs'} with these EXACT arguments:`)
  lines.push(``)
  lines.push(`deal_id: ${quote(dealId)}    # ≤30 chars, alphanumeric+dash/underscore only`)
  lines.push(`display_name: ${quote(displayName)}    # canonical deal name, ≤255 chars (cutlass#747)`)
  lines.push(...startDateLines(r))
  // Date-only flight boundary (#235.3, VENDOR-OPEN cutlass#755):
  // Media.net documents no boundary timezone (IST?) or end-date inclusivity
  // for date-only flights — ASSUMED end-of-day-inclusive in the vendor's
  // clock (±1 day unverifiable from code or read-backs).
  if (r.endDate) lines.push(`end_date: ${quote(r.endDate)}`)
  lines.push(`ad_format: ${adFormatId}    # 0=Banner, 1=Native, 2=Video`)
  lines.push(`demand_partners: ${inlineList(demandPartners.length ? demandPartners : ['<FILL demand_partner — REQUIRED>'])}    # MCP resolves via per-format demand-partners endpoint`)
  if (r.firstSeatId) {
    lines.push(`# NOT SUPPORTED: Media.net seat-level buyer scoping for ${quote(r.firstDspName)} seat ${quote(r.firstSeatId)} is NOT emitted —`)
    lines.push(`# the verified create path supports DSP-level demand_partners only; whitelisted_seats write acceptance is vendor-unverified (cutlass#755).`)
    lines.push(`# Route at the DSP level and report the requested seat as NOT APPLIED; never invent the retired phantom seat_id shape (#234.4).`)
  }
  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1: Media.net's margin_type=0 (Fixed USD CPM) is the likely
    // future wire for a 'Fixed CPM' fee, but the form's marginType default is
    // Percentage and the mapping is unwired/vendor-unverified — fail closed
    // rather than book a wrong-unit margin.
    lines.push(...nonPercentFeeBlockLines(form, 'Media.net', 'margin with margin_type=1 Percentage'))
  } else {
    lines.push(`margin_type: ${marginType}    # 0=Fixed (USD CPM), 1=Percentage`)
    if (Number.isNaN(margin)) {
      lines.push(`# margin: OMITTED — set the Media.net margin or the curated deal fee. Media.net REQUIRES a curator margin; there is no built-in default.`)
    } else {
      lines.push(`margin: ${margin}    # 0-25 if Fixed, 0-50 if Percentage`)
    }
  }
  lines.push(...audioNotSupportedLines(r, 'Media.net', "ad_format has no audio value (0=Banner, 1=Native, 2=Video); the channel would book VIDEO"))
  lines.push(`environments: ${inlineList(envs)}    # Web | MobileApp | CTV`)
  lines.push(`status: 1    # 1=Active, -1=Inactive, -2=Archived`)
  if (r.cpm) lines.push(`bid_floor: ${r.cpm}    # CPM`)
  if (channelHint) lines.push(`channel: ${quote(channelHint)}    # display | olv | ctv`)

  if (r.countriesIso2.length > 0) {
    // Media.net accepts 2-letter codes or full names directly for country geo.
    lines.push(`geo: ${inlineList(r.countriesIso2)}    # 2-letter codes; MCP resolves`)
  }

  // Include-states (#233.7/.8) — the Media.net create wire consumes
  // countries only; parser-fed states used to vanish silently. Loud marker +
  // the name's Geo slot no longer claims the state.
  lines.push(...stateIncludeNotSupportedLines(r, 'Media.net', 'the Media.net create wire consumes countries only (geo arg — no state/region entity)'))

  // Geo EXCLUSIONS (#244) — the MCP passes structured
  // {geo_type, id, is_excluded} entries through, but live v9 API acceptance
  // of is_excluded:true is VENDOR-UNVERIFIED (Media.net is the standing
  // vendor-unverified SSP). Ambiguous capability = NOT SUPPORTED: fail loud
  // + the audit blocks the batch.
  lines.push(...geoExcludeNotSupportedLines(r, 'Media.net', 'is_excluded:true geo entries are vendor-UNVERIFIED on the Select v9 API (#244) — never rely on an unverified exclusion'))

  // Content categories — canonicalized to exact live catalog names
  // (2026-07-14 audit): the MCP is exact-match fail-closed, so an unmapped
  // name blocks the WHOLE create; unsupported names get the loud marker.
  const mnIab = mnIabNames(r.iabResolved)
  if (mnIab.names.length > 0) {
    lines.push(`content_categories:    # exact Media.net catalog names (canonicalized, live catalog 2026-07-14)`)
    lines.push(...blockList(mnIab.names, '  '))
  }
  lines.push(...mnIabNotSupportedLines(mnIab.notSupported))

  // IAB/content EXCLUSIONS — Media.net's create call has no category exclude
  // (post-create-update-only surface), so fail loud, never guess an arg.
  lines.push(...iabExcludeNotSupportedLines(r, 'Media.net'))

  if (r.segmentsInclude.length > 0) {
    lines.push(`first_party_segments:`)
    lines.push(...blockList(r.segmentsInclude, '  '))
  }

  // Audience segment EXCLUSIONS (#226) — Media.net's four segment
  // groups (first-party / Experian custom / Experian syndicated /
  // contextual) are ALL include-only on create AND merge; there is no
  // segment-exclude wire anywhere in the Select API surface. Fail loud.
  lines.push(...segmentExcludeNotSupportedLines(r, 'Media.net', 'all four Media.net segment groups are include-only — the Select API has no audience-exclusion surface'))

  // Language targeting (#226) — Media.net carries language at create
  // time via device_languages (resolved server-side against the
  // device-languages entity catalog; unresolved values fail closed with
  // device_languages_unresolved). One of only two SSPs with a language wire.
  if (r.language) {
    lines.push(`device_languages: ${inlineList([r.language])}    # resolved via the device-languages entity catalog; fails closed if unresolvable`)
  }

  if (r.viewabilityPct) lines.push(`viewability_min: ${parseFloat(r.viewabilityPct) / 100}`)
  if (r.isVideo && r.vcr) lines.push(`vcr_min: ${parseFloat(r.vcr) > 1 ? parseFloat(r.vcr) / 100 : r.vcr}`)

  // Ad-duration targeting — deal-body video:{min, max}. ⚠ The field EXISTS
  // but its semantics are UNVERIFIED with Media.net (the Select API guide is
  // partner-gated): video_min/video_max are PRESUMED duration bounds in
  // integer seconds. Emit them, but never without the warning below.
  if (hasAdDurationRequest(r)) {
    lines.push(`# ⚠ UNVERIFIED SEMANTICS: video_min/video_max are PRESUMED ad-duration bounds in integer seconds —`)
    lines.push(`# Media.net's partner docs are gated and the units/direction are unconfirmed. Confirm with the partner`)
    lines.push(`# before relying on this for a client duration commitment; verify on the first live deal and note it in the final summary.`)
    if (r.adDurationLo !== undefined) lines.push(`video_min: ${r.adDurationLo}    # presumed min ad duration, seconds (semantics UNVERIFIED)`)
    lines.push(`video_max: ${r.adDurationHi}    # presumed max ad duration, seconds (semantics UNVERIFIED)`)
    if (adDurationListHasGaps(r.adDurations)) {
      lines.push(`# NOTE: Media.net expresses a contiguous range — the allowed list ${inlineList(r.adDurations)}s widens to ${r.adDurationLo}-${r.adDurationHi}s,`)
      lines.push(`# which also admits in-between lengths (e.g. ${adDurationFirstGap(r.adDurations)}s). Surface this widening in the final summary.`)
    }
  }

  if (r.domainFile) {
    if (r.fileKind === 'app_bundle') {
      // Media.net has NO app-bundle targeting field: the Select API's
      // app_categories are IAB-style CATEGORY ids, not bundle ids (Guide
      // v9.4), and no other deal-body field takes bundles. This is a LIST
      // DISCLOSURE, not a don't-run marker (#224/#237.8): the deal
      // IS created and the app-bundle list reported NOT APPLIED — exactly the
      // TripleLift app-bundle semantics/phrasing. It deliberately does NOT use
      // the "# BLOCKED" prefix, which the server submit gate treats as a
      // hard don't-run marker (a mixed-SSP in-app batch with a bundle
      // blocklist must still submit).
      lines.push(`# LIST NOT APPLIED: the attached app-bundle list "${dealFilePath(r.domainFile)}" CANNOT be applied on Media.net.`)
      lines.push(`# Media.net has no app-bundle targeting field (app_categories are category ids, NOT bundle ids — Select API Guide v9.4).`)
      lines.push(`# You MUST NOT pass this file to any Media.net tool and MUST NOT write whitelisted_domains in its place.`)
      lines.push(`# Report this list as NOT APPLIED with quality_flag=unsupported_targeting_op in the final summary.`)
    } else {
      // Web domain lists are publisher/inventory targeting: the deal-body
      // OBJECT publisher_domains {values, is_excluded} (Guide v9.4 p.26),
      // written by the dedicated inventory merge tool. The Media.net MCP
      // CANNOT read an "@<file>" reference as a create-time targeting value,
      // so the list is attached AFTER the deal is created via the merge tool,
      // which reads the file, verifies its hash + row count, applies the
      // values, and read-back-verifies the advertiser whitelist stayed
      // untouched. Every arg below is a REAL parameter of the tool —
      // phantom args (the old target:/is_excluded: on the whitelist tool)
      // were silently dropped and mis-wrote the ADVERTISER whitelist
      // (#224 / cutlass#720).
      const excluded = r.domainOpInclude === 'Exclude'
      const mergeTool = 'mcp_medianet_mcp_medianet_merge_deal_publisher_domains'
      lines.push(`# POST-CREATE TARGETING (REQUIRED): the attached list "${dealFilePath(r.domainFile)}" is publisher-domain INVENTORY targeting.`)
      lines.push(`# Do NOT pass it as a create-time value — the Media.net create call cannot read a file.`)
      lines.push(`# Do NOT use the advertiser-whitelist merge tool for this — it cannot write inventory targeting.`)
      lines.push(`# After the deal is created, apply the list with the dedicated inventory merge tool:`)
      lines.push(`#   ${mergeTool}(`)
      lines.push(`#     deal_id: ${dealId}`)
      lines.push(`#     values_file: ${dealFilePath(r.domainFile)}`)
      lines.push(`#     values_sha256: <sha256sum of the file>`)
      lines.push(`#     expected_count: <non-blank line count of the file>`)
      lines.push(`#     is_excluded: ${excluded}    # ${excluded ? 'blocklist' : 'allowlist'} (from file inclusionType)`)
      lines.push(`#     merge_mode: add`)
      lines.push(`#   )`)
      lines.push(`# NOTE: Media.net requires ONE include-or-exclude direction across publisher_domains/domain_group/publisher_urls/url_group — the tool fails closed on a conflict.`)
    }
  }

  return lines.join('\n')
}

/** ISO 3166-2 region tokens for the Magnite geo args.
 *
 *  Deal Onboarding normalizes subnational geo to bare 2-letter codes bucketed by
 *  country (classifyGeoState), but a bare code is AMBIGUOUS against a region
 *  catalog — "CA" is both California's abbreviation and Canada's ISO-2. The
 *  prefixed form is unambiguous and resolves on BOTH Magnite sources: it
 *  matches SpringServe's `value` ("CA-QC") exactly, and Cutlass's
 *  _REGION_CODE_NAMES expands it to the plain label DV+ returns ("Quebec").
 *  Same convention the TripleLift builder already uses for region_ids.
 *
 *  Unclassified tokens ship UNPREFIXED rather than being guessed into a
 *  country — the MCP then fails the deal loudly, which for an exclusion is the
 *  only safe direction (a silently widened geo would SERVE what was excluded). */
function magniteRegionCodes(statesUS: string[], provincesCA: string[], unknown: string[]): string[] {
  return [...statesUS.map(s => `US-${s}`), ...provincesCA.map(p => `CA-${p}`), ...unknown]
}

function buildMagnitePrompt(form: FormData, deal: DealEntry, dealName: string, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const r = resolve(form, deal, standardLists, dsp)
  const mg = form.magniteConfig
  const channelHint = SSP_CHANNEL_HINT.magnite[r.channel] || 'display'
  // Streaming carries both CTV and OTT; everything else is DV+.
  const isSpringServe = channelHint === 'ctv' || channelHint === 'ott'
  // Marketplace: explicit form config wins; fall back to the
  // first listed ClearLine marketplace. Immutable after creation, so a wrong
  // value means delete-and-recreate — hence the REQUIRED treatment.
  const presetMarketplaces: string[] = []
  const marketplace = mg.marketplace.trim() || presetMarketplaces[0] || ''
  // Magnite's Percent rev-share scale is PERCENT UNITS (30 = 30%) —
  // LIVE-VERIFIED 2026-07-21 (DEAL00176): the old fraction reading of the API
  // guide (0.25 = 25%) booked a 30% margin as 0.30% and the trader had to
  // correct all 20 deals in the ClearLine UI. curatedDealFee is already a
  // human percentage — pass it through unscaled. When the form leaves it
  // blank, fall back to the batch's commercial default;
  // the curator margin is a per-client commercial term, owned by Deal Onboarding
  // config — not Cutlass.
  const feePct = form.curatedDealFee
    ? parseFloat(form.curatedDealFee)
    : NaN

  const lines: string[] = []
  lines.push(`Call ${'mcp_magnite_mcp_magnite_execute_deal_from_prompt_inputs'} with these EXACT arguments:`)
  lines.push(``)
  lines.push(`deal_name: ${quote(dealName)}`)
  lines.push(`channel: ${quote(channelHint)}    # Platform routing: ctv → SpringServe; display/olv → DV+`)
  lines.push(`marketplace: ${quote(marketplace || '<FILL marketplace — REQUIRED; resolve via magnite_list_marketplaces>')}    # Name or numeric id. IMMUTABLE after creation.`)

  // DSPs + buyers — Magnite requires >=1 buyer per DSP. A bare DSP token only
  // works when that DSP has exactly one buyer (the MCP refuses to guess).
  const dspName = r.firstDspName || '<FILL dsp name>'
  if (r.firstSeatIds.length > 0) {
    // ClearLine takes a buyer LIST per DSP and resolves each ref independently
    // against that DSP's buyer catalog, so a deal can be pinned to several
    // seats at once (one live deal carried 14 DV360 buyers). The
    // seat_multi audit rule keeps a multi-seat value out of every other SSP —
    // they carry a single seat token and would ship the comma list verbatim.
    const buyerNote = r.firstSeatIds.length > 1
      ? `# ${r.firstSeatIds.length} buyer seats — each resolves independently via magnite_list_dsp_buyers; ANY unresolved ref blocks the create (buyer_unresolved), so no deal books with a partial buyer list`
      : `# Buyer name or numeric id; MCP resolves via magnite_list_dsp_buyers`
    lines.push(`dsps:`)
    lines.push(`  - dsp: ${quote(dspName)}`)
    lines.push(`    buyers: ${inlineList(r.firstSeatIds)}    ${buyerNote}`)
  } else {
    lines.push(`dsps: ${inlineList([dspName])}    # Bare DSP auto-selects its buyer ONLY when exactly one exists; otherwise pass {dsp, buyers: [...]}`)
  }

  // Publishers: the explicit "ALL" opt-in by default — the MCP expands it
  // server-side to every eligible marketplace publisher (an enumerated
  // snapshot, filtered to this deal's DV+ sizes; on CPM-floor deals,
  // floor-ineligible publishers are excluded and reported via a quality
  // flag). publisher_filter_size_ids is NOT sent — "ALL" discovery already
  // uses the deal's own sizes. With the "All eligible publishers" toggle OFF
  // (owner-approved opt-out, 2026-08-21) the trader's allowlist ships as an
  // explicit list instead: ids as ints, name-only entries as strings —
  // both resolved fail-closed against the live catalog by the MCP, and NEVER
  // mixed with "ALL" (the MCP's all_publishers_ambiguous blocker).
  const mgAllowlist = form.magniteConfig.allPublishers === false
    ? (form.magniteConfig.publisherEntries || []).filter(e => (e.id || '').trim() !== '' || (e.name || '').trim() !== '')
    : []
  if (mgAllowlist.length > 0) {
    const mgRefs = mgAllowlist.map(e => {
      const id = (e.id || '').trim()
      return id !== '' ? id : quote((e.name || '').trim())
    })
    lines.push(`publishers: [${mgRefs.join(', ')}]    # explicit allowlist (${mgAllowlist.length} publishers) — resolved against the live marketplace catalog; an unresolved ref BLOCKS the create`)
  } else {
    lines.push(`publishers: "ALL"    # verbatim — explicit opt-in; the MCP expands to every eligible marketplace publisher`)
  }

  // Formats (sizes) — PER-DEAL. The MCP takes one `sizes` arg of ad-format ids
  // regardless of family (display/video/native), one format type per deal, max
  // 15. CTV → SpringServe (no sizes); Audio → feedTypes (separate mechanism).
  // The picker stores only ids of the family matching this deal's channel.
  const fmtKind = magniteFormatKind(r.channel)
  if (fmtKind) {
    const sizeIds = (deal.magniteSizes || []).map(s => parseInt(s, 10)).filter(n => n > 0)
    if (sizeIds.length > 0) {
      lines.push(`sizes: ${inlineList(sizeIds)}    # DV+ ${fmtKind} ad-format ids (magnite_list_ad_formats); one format type per deal, max 15`)
    } else {
      lines.push(`sizes: [<FILL ${fmtKind} formats — REQUIRED on DV+; the API 422s size-less DV+ deals. Resolve via magnite_list_ad_formats>]`)
    }
  } else if (r.channel === 'Audio') {
    lines.push(`# BLOCKED: Magnite Audio requires feedTypes, but Deal Onboarding has no verified feed-type catalog/wire selection yet (#238.5).`)
    lines.push(`# Do NOT submit this create or hand-craft extra.feedTypes. Configure a verified feed type in ClearLine and add a typed Deal Onboarding field first.`)
  }

  lines.push(...startDateLines(r))
  lines.push(`end_date: ${quote(r.endDate || '<FILL end_date — REQUIRED by Magnite>')}`)

  // Pricing — the ClearLine price type dropdown, exactly the options Magnite's
  // own UI offers: "Market Rate" (no floor), "Market Rate with Minimum"
  // (market-rate pricing with a minimum floor — the default at 0.10),
  // and "CPM" (fixed CPM floor). The Sun Bum deals (client-flagged, 2026-07)
  // were created as CPM with the trader's $15 deal CPM as the floor — they
  // should have been Market Rate. The floor value must NEVER be the deal CPM:
  // Curator economics ride on rev_share below; the floor is the publisher-tab
  // minimum, kept at 0.10 unless the client directs otherwise. An account-level
  // price_type on the Magnite account (e.g. a "Market Rate" account) overrides
  // the form's dropdown.
  const effectivePriceType = mg.priceType || 'Market Rate'
  const rawFloor = (mg.floorCpm ?? '').trim()
  const parsedFloor = parseFloat(rawFloor)
  const floor = parsedFloor > 0 ? rawFloor : '0.10'
  if (effectivePriceType === 'Market Rate') {
    lines.push(`price_type: Market Rate    # full-marketplace: NO floor (avoids publisher-minimum exclusions)`)
  } else if (effectivePriceType === 'CPM') {
    lines.push(`price_type: CPM    # fixed CPM floor (priceType=CPM, priceBehavior=Auction)`)
    lines.push(`floor: ${floor}    # publisher-tab CPM floor — NOT the deal CPM (default 0.10)`)
  } else if (isSpringServe) {
    // 'Market Rate with Minimum' is DV+-only: SpringServe (CTV) rejects it
    // and the Cutlass MCP fails the whole create closed at prepare
    // (price_type_unsupported_on_springserve) — so every default-config
    // Magnite CTV create was guaranteed to block (#228). Emit the
    // vendor-valid Market Rate instead (the mg_ctv_price_type audit check +
    // qa_mg_ctv_price_type QA item surface the downgrade to the trader).
    lines.push(`price_type: Market Rate    # 'Market Rate with Minimum' is DV+-only — SpringServe (CTV) rejects it, so this deal downgrades to Market Rate (NO minimum floor)`)
  } else {
    // DV+ MRwM: the floor ships as the top-level curatorPricing.minimumCpm
    // (cutlass#718) — the MCP blocks MRwM without a floor (mrwm_minimum_missing).
    lines.push(`price_type: "Market Rate with Minimum"    # market-rate pricing with a minimum floor — the house default (DV+ only)`)
    lines.push(`floor: ${floor}    # publisher-tab minimum floor (-> curatorPricing.minimumCpm) — NOT the deal CPM (default 0.10)`)
  }

  if (!feeTypeIsPercent(form.feeType)) {
    // #234.1: Magnite economics ride the Percent rev-share fraction —
    // a Flat-Fee/Fixed-CPM value has no verified ClearLine wire.
    lines.push(...nonPercentFeeBlockLines(form, 'Magnite', 'rev_share_model Percent fraction'))
  } else if (isFinite(feePct)) {
    lines.push(`rev_share_model: Percent`)
    lines.push(`rev_share_value: ${feePct}    # PERCENT units (${feePct} = ${feePct}% — live-verified 2026-07-21; NOT a fraction)`)
  } else {
    // No fee source (neither curatedDealFee nor client fee_percent). The MCP
    // requires rev_share_value, so fail closed with a marker rather than
    // fabricating a 30% margin — applies to BOTH the CPM-floor and Market-Rate
    // branches.
    lines.push(`# rev_share OMITTED — set the curated deal fee. Magnite REQUIRES rev_share_value; there is no built-in default.`)
  }

  if (r.countriesIso2.length > 0) {
    lines.push(`geo_countries_include: ${inlineList(r.countriesIso2)}    # ISO-2 codes; MCP resolves via metadata/countries`)
  }
  if (r.states.length > 0) {
    lines.push(`geo_regions_include: ${inlineList(magniteRegionCodes(r.statesUS, r.provincesCA, r.statesUnknown))}    # ISO 3166-2 codes; MCP resolves via metadata/regions (exact value on SpringServe, name-expanded on DV+)`)
    if (r.statesUnknown.length > 0) {
      lines.push(`# UNCLASSIFIED region tokens ${inlineList(r.statesUnknown)} — could not tell US state from CA province, so they ship UNPREFIXED and may not resolve. An unresolved region is a HARD create failure (never a silent widen) — resolve them against ${'mcp_magnite_mcp_magnite_list_geo_values'}(kind="regions", source=...) and STOP if ambiguous.`)
    }
  }

  // Geo EXCLUSIONS (#244) — geography.country and geography.region are
  // INDEPENDENT components, each carrying its own single Include XOR Exclude
  // type. So an exclusion cannot ride alongside an include on the SAME
  // component (geo_country_conflict / geo_region_conflict), but a country
  // include composes freely with a region exclude — "target Canada, exclude
  // Quebec". Region Exclude is live-verified (2026-08-28, MGNI-MD-449-34286).
  // ZIP/DMA still have no Magnite exclude surface — loud + blocked.
  if (r.excludeCountriesIso2.length > 0) {
    if (r.countriesIso2.length > 0) {
      lines.push(...geoExcludePartialNotSupportedLines('Magnite', `countries ${inlineList(r.excludeCountriesIso2)}`, 'geography.country is a single Include XOR Exclude component (geo_country_conflict) — an exclude cannot ride alongside country includes'))
    } else {
      lines.push(`geo_countries_exclude: ${inlineList(r.excludeCountriesIso2)}    # ISO-2 codes; XOR with geo_countries_include (geo_country_conflict); never serve here`)
    }
  }
  if (r.excludeStates.length > 0) {
    if (r.states.length > 0) {
      lines.push(...geoExcludePartialNotSupportedLines('Magnite', `states ${inlineList(r.excludeStates)}`, 'geography.region is a single Include XOR Exclude component (geo_region_conflict) — an exclude cannot ride alongside state includes'))
    } else {
      lines.push(`geo_regions_exclude: ${inlineList(magniteRegionCodes(r.excludeStatesUS, r.excludeProvincesCA, r.excludeStatesUnknown))}    # ISO 3166-2 codes; XOR with geo_regions_include (geo_region_conflict); COMPOSES with geo_countries_include (include Canada, exclude Quebec); never serve here`)
      if (r.excludeStatesUnknown.length > 0) {
        lines.push(`# UNCLASSIFIED exclude-region tokens ${inlineList(r.excludeStatesUnknown)} ship UNPREFIXED and may not resolve; an unresolved exclusion is a HARD failure, so the deal never books serving the geography it was meant to exclude.`)
      }
    }
  }
  if (r.excludeZips.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('Magnite', `ZIPs ${inlineList(r.excludeZips.slice(0, 5))}${r.excludeZips.length > 5 ? ' …' : ''}`, 'no Magnite postal-code exclude emission is wired'))
  }
  if (r.excludeDmas.length > 0) {
    lines.push(...geoExcludePartialNotSupportedLines('Magnite', `DMAs ${inlineList(r.excludeDmas)}`, 'no Magnite DMA exclude emission is wired'))
  }

  // Audience segments — SpringServe (CTV) only. The Magnite API does not
  // support DV+ audiences until v3.0 (ETA end of June 2026); the MCP blocks
  // them, so don't emit the arg on DV+ deals.
  if (isSpringServe) {
    if (r.segmentsInclude.length > 0) {
      lines.push(`audience_segments:`)
      lines.push(...blockList(r.segmentsInclude, '  '))
    }
    if (r.segmentsExclude.length > 0) {
      lines.push(`audience_segments_block:`)
      lines.push(...blockList(r.segmentsExclude, '  '))
    }
  } else if (r.segmentsInclude.length > 0 || r.segmentsExclude.length > 0) {
    lines.push(`# ⚠ DV+ audience segments are NOT supported by Magnite's API until v3.0 (ETA end of June 2026).`)
    lines.push(`# Do NOT pass audience_segments on this deal — apply these in the ClearLine UI post-create and`)
    lines.push(`# list them in the final summary as a manual step:`)
    for (const s of r.segmentsInclude) lines.push(`#   include: ${s}`)
    for (const s of r.segmentsExclude) lines.push(`#   exclude: ${s}`)
  }

  // IAB categories (#226) — the ClearLine Curation Demand Management
  // API has NO content-category/IAB surface (verified: zero iab/content-
  // category references in the Magnite MCP, 2026-07-10), so a trader-picked
  // or inferred IAB set cannot ride a Magnite create. Same silent-drop class
  // as TripleLift IAB — fail loud, and qa_contextual warns.
  lines.push(...iabIncludeNotSupportedLines(r, 'Magnite', 'the ClearLine Curation API has no content-category/IAB targeting surface'))

  // IAB/content EXCLUSIONS — Magnite's API has no IAB/genre exclude, fail loud.
  lines.push(...iabExcludeNotSupportedLines(r, 'Magnite'))

  if (r.domainFile) {
    const listKind = r.fileKind === 'app_bundle' ? 'app-bundles' : 'domains'
    const targetKey = r.fileKind === 'app_bundle' ? 'appBundleList' : 'domainList'
    const op = r.domainOpInclude === 'Exclude' ? 'Block' : 'Allow'
    lines.push(`# List file ${quote(r.domainFile.name)} (${op.toLowerCase()}list): Magnite's API cannot ingest list FILES directly.`)
    lines.push(`# Find a curator targeting list with a matching name via magnite_list_targeting_lists(kind="${listKind}") and pass:`)
    lines.push(`#   targeting: {"${targetKey}": {"type": "${op}", "values": [{"id": <list id>}]}}`)
    lines.push(`# If no matching list exists, create it in the ClearLine console first and report it as a post-create step.`)
  }

  if (r.viewabilityPct && !isSpringServe) {
    lines.push(`# Viewability target ${r.viewabilityPct}%: pass via raw targeting {"viewability": {"type": "Allow", "min": <decile ≤ ${r.viewabilityPct}>, "max": null}} (DV+ only; min ∈ {0,10,…,90}).`)
  } else if (isSpringServe) {
    // Magnite-CTV viewability gap (#226): the DV+ raw-targeting
    // viewability component above is DV+-only, and SpringServe (CTV) has no
    // verified viewability surface — a CTV deal used to emit NOTHING here
    // while qa_viewability reported PASS "configured". Fail loud instead.
    lines.push(...viewabilityNotSupportedLines(r, 'Magnite (SpringServe CTV)', 'the DV+ raw-targeting viewability component does not exist on SpringServe, and no SpringServe viewability surface is verified'))
  }

  // Language — Magnite's ClearLine create wire has no language targeting
  // surface (no device/content-language component is documented or
  // verified); fail loud, never guess a raw-targeting node.
  // Environment: Magnite encodes web-vs-app INTO the device VALUES on
  // Streaming ("Mobile In-app" vs "Mobile Web"), so the Inventory Type ships
  // as `environment` and the MCP picks the device set from it (cutlass#898).
  // DV+ has no such distinction — "Mobile (ALL)" is unqualified — so those
  // channels keep the loud marker.
  if (isSpringServe) {
    lines.push(`environment: ${quote(r.inv)}    # narrows the Streaming device set: All | Web Only | In-App`)
  } else {
    lines.push(...environmentNotSupportedLines(r, 'Magnite', 'DV+ device values carry no web/app distinction ("Mobile (ALL)" is unqualified), so Inventory Type has no wire on this channel'))
  }
  lines.push(...languageNotSupportedLines(r, 'Magnite'))

  // Ad-duration targeting — targeting.video.adDuration {min, max}: integer
  // seconds, CONTIGUOUS range, works on BOTH sources (SpringServe CTV and
  // DV+). The MCP fails closed on ad_duration_max without ad_duration_min
  // (the API guide documents adDuration.min as required — only max may be
  // null) and documents min=1 as the "up to N seconds" convention.
  if (r.adDurations.length > 0) {
    lines.push(`ad_duration_min: ${r.adDurationLo}    # targeting.video.adDuration.min, integer seconds`)
    lines.push(`ad_duration_max: ${r.adDurationHi}    # targeting.video.adDuration.max, integer seconds`)
    if (adDurationListHasGaps(r.adDurations)) {
      lines.push(`# NOTE: Magnite expresses a contiguous range — the allowed list ${inlineList(r.adDurations)}s widens to ${r.adDurationLo}-${r.adDurationHi}s,`)
      lines.push(`# which also admits in-between lengths (e.g. ${adDurationFirstGap(r.adDurations)}s). Surface this widening in the final summary.`)
    }
  } else if (r.maxAdDurationSecs !== undefined) {
    lines.push(`ad_duration_min: 1    # REQUIRED with max (adDuration.min may not be null); min=1 is the MCP-documented "up to N seconds" convention`)
    lines.push(`ad_duration_max: ${r.maxAdDurationSecs}    # cap ad length at ${r.maxAdDurationSecs}s`)
  }


  lines.push(``)
  lines.push(`# Magnite returns NO per-deal console URL (deal_url is null) — surface the returned deal_id`)
  lines.push(`# (e.g. "MGNI-CD-2002-100") prominently in the final summary and the deal sheet. There is no`)
  lines.push(`# list-deals endpoint until API v3.0, so the deal_id is the only retrieval handle.`)
  return lines.join('\n')
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate one per-deal prompt block.
 *
 * @param dealIndex  Zero-based position of THIS deal within the cohort the
 *                   trader actually pastes into the runner (e.g. batch-supported
 *                   deals only when called from buildBatchPrompt; the full
 *                   form.deals list otherwise).
 * @param dealTotal  Cohort size for the same view. Defaults to
 *                   form.deals.length for backward-compat with the
 *                   per-deal preview UI. Pass createDeals.length when
 *                   generating a batch payload so the "# Deal N of M"
 *                   header reflects what the runner actually creates — never an
 *                   unfiltered count that includes SSP-less or sheet-only
 *                   deals.
 */
export function generateDealPromptYaml(form: FormData, deal: DealEntry, dealIndex: number, dealTotal: number = form.deals.length, standardLists: StandardList[] = [], dsp?: DspEntry): string {
  const dealName = generateDealName(form, deal, { dsp })
  const ssp = deal.ssp
  const dspLabel = (dsp ?? activeDsps(form)[0])?.dsp
  const override = activeExclusionOverride(form, deal)
  const overrideLine = override ? `\n# EXCLUSION_OVERRIDE: ${JSON.stringify(override)}` : ''
  const header = `# Deal ${dealIndex + 1} of ${dealTotal} — paste into the runner.\n# SSP: ${ssp || '<unset>'} | Channel: ${deal.channel || '<unset>'} | Theme: ${deal.theme || '<unset>'}${dspLabel ? ` | DSP: ${dspLabel}` : ''}${overrideLine}`

  let body: string
  switch (ssp) {
    case 'Index Exchange': body = buildIndexExchangePrompt(form, deal, dealName, standardLists, dsp); break
    case 'OpenX':          body = buildOpenXPrompt(form, deal, dealName, standardLists, dsp); break
    case 'PubMatic':       body = buildPubMaticPrompt(form, deal, dealName, standardLists, dsp); break
    case 'Xandr':          body = buildXandrPrompt(form, deal, dealName, standardLists, dsp); break
    case 'TripleLift':     body = buildTripleLiftPrompt(form, deal, dealName, standardLists, dsp); break
    case 'Media.net':      body = buildMediaNetPrompt(form, deal, dealName, standardLists, dsp); break
    case 'Magnite':        body = buildMagnitePrompt(form, deal, dealName, standardLists, dsp); break
    default:
      body = `# Unknown SSP "${ssp}". Cannot generate prompt — pick a supported SSP on the deal card.`
  }
  return `${header}\n${body}`
}

export function generateAllDealPrompts(form: FormData, standardLists: StandardList[] = []): { deal: DealEntry; dsp?: DspEntry; yaml: string; name: string }[] {
  // Multi-DSP expansion: one prompt per (deal x DSP) pair, mirroring the
  // batch emission and the audit's expanded deal set.
  const pairs = expandDealDsps(form.deals, form)
  return pairs.map(({ deal: d, dsp }, i) => ({
    deal: d,
    dsp,
    yaml: generateDealPromptYaml(form, d, i, pairs.length, standardLists, dsp),
    name: generateDealName(form, d, { dsp }),
  }))
}

// =============================================================================
// Batch / multi-deal prompt — matches cutlass/protocols/multi-deal-creation.yaml
// + cutlass/protocols/deal-brief.schema.yaml
// =============================================================================

/**
 * Operating constraints emitted verbatim at the top of every batch prompt.
 *
 * These rules were proven out by live cutlass smoke tests and the Optimum
 * Display compliance batch (May 2026). the runner ships with SendGrid enabled —
 * the deal-sheet email IS expected to fire as the final critical action.
 *
 * Constants #3 and #4 are environment-dependent workarounds and SHOULD be
 * removed from this preamble once their underlying issues ship:
 *   - #3 drops when IX's segments-API transient error is fixed upstream
 *   - #4 drops when the IX MCP `regionCode` alias is broadened
 */
export const BATCH_OPERATING_PREAMBLE = `Operating constraints for THIS run:
1. Use the TYPED critical_actions field on confirm_audit (see "Audit declaration" block below). Do not include the legacy critical_actions_being_unblocked field.
2. MUST call mcp_deal_sheet_validate_brief BEFORE confirm_audit. If validation fails (ok=false), abort with confirm_audit(success=false, user_visible_summary=...).
3. If ix_execute_deal_from_prompt_inputs returns "Failed to load segments" on the first call for a deal, retry it ONCE before treating that deal as failed — observed transient IX segments-API issue.
4. INDEX EXCHANGE ONLY: do NOT pass geo_states to any Index Exchange tool — only geo_countries. (Pre-existing IX MCP resolver bug for accounts using "regionCode" instead of "state"; will be removed once the IX MCP fix ships.) This constraint does NOT apply to other SSPs: PubMatic and Xandr deal blocks legitimately emit geo_states / geo_states_exclude — pass those through exactly as written (#238.7).`

export const SSP_TO_BATCH_KEY: Record<string, string> = {
  'Index Exchange': 'indexexchange',
  'OpenX': 'openx',
  'PubMatic': 'pubmatic',
  'Xandr': 'xandr',
  'TripleLift': 'triplelift',
  'Media.net': 'medianet',
  'Magnite': 'magnite',
}

const SSP_TO_BATCH_TOOL: Record<string, string> = {
  'Index Exchange': 'mcp_indexexchange_mcp_ix_execute_deal_from_prompt_inputs',
  'OpenX': 'mcp_openx_mcp_ox_execute_deal_from_prompt_inputs',
  'PubMatic': 'mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs',
  'Xandr': 'mcp_xandr_mcp_xandr_execute_deal_from_prompt_inputs',
  'Media.net': 'mcp_medianet_mcp_mn_execute_deal_from_prompt_inputs',
  'TripleLift': 'mcp_triplelift_mcp_tl_create_deal',
  'Magnite': 'mcp_magnite_mcp_magnite_execute_deal_from_prompt_inputs',
}

// Deal-sheet themes registered in the runner's deal_sheet tool. A theme
// outside this set falls back to the default (build_deal_sheet would otherwise
// reject an unknown theme). Extend it with the themes your runner registers.
export const DEFAULT_DEAL_SHEET_THEME = 'default'
export const KNOWN_DEAL_SHEET_THEMES = [DEFAULT_DEAL_SHEET_THEME]

// Cutlass MCP server name per SSP. The variant loader spawns
// "<server>_<slug>" and surfaces its tools as mcp_<server>_<slug>_<rest>.
export const SSP_SERVER: Record<string, string> = {
  'Index Exchange': 'indexexchange_mcp',
  'OpenX': 'openx_mcp',
  'PubMatic': 'pubmatic_mcp',
  'Xandr': 'xandr_mcp',
  'Media.net': 'medianet_mcp',
  'TripleLift': 'triplelift_mcp',
  'Magnite': 'magnite_mcp',
}

/** True iff the deal can be created via MCP in a batch — any deal with an SSP
 *  selected. (Magnite joined the API-backed set in June 2026 via the ClearLine
 *  Curation Demand Management API; the legacy manual/BrowserOS path is gone.) */
export function isBatchSupportedDeal(deal: DealEntry): boolean {
  return deal.ssp !== ''
}

/** Split a form's batch-supported deals into CREATE rows and SHEET-ONLY rows
 *  (DealEntry.sheetOnly — already created in a previous batch; they ride the
 *  deal sheet + email but MUST NOT generate a create/tool call). SINGLE SOURCE
 *  OF TRUTH shared by buildBatchPrompt/buildCriticalActionsBlock here and
 *  buildBatchBrief (dealBrief.ts) — the prompt Cutlass executes and the brief
 *  it validates against must never disagree on which rows create. */
export function splitBatchDeals(deals: DealEntry[]): { createDeals: DealEntry[]; sheetOnlyDeals: DealEntry[] } {
  const batch = deals.filter(isBatchSupportedDeal)
  return {
    createDeals: batch.filter(d => !d.sheetOnly),
    sheetOnlyDeals: batch.filter(d => !!d.sheetOnly),
  }
}

/** splitBatchDeals + multi-DSP expansion in one step: the (deal x DSP) pairs
 *  every batch emission path iterates. Create rows AND sheet-only rows both
 *  expand per DSP so the prompt/brief names match the audit's expanded set
 *  (the runner.go gate compares them 1:1). SINGLE SOURCE OF TRUTH shared by
 *  buildBatchPrompt/buildCriticalActionsBlock here and buildBatchBrief
 *  (dealBrief.ts). */
export function splitBatchPairs(form: FormData): { createPairs: DealDspPair[]; sheetOnlyPairs: DealDspPair[] } {
  const { createDeals, sheetOnlyDeals } = splitBatchDeals(form.deals)
  return {
    createPairs: expandDealDsps(createDeals, form),
    sheetOnlyPairs: expandDealDsps(sheetOnlyDeals, form),
  }
}

/** Build a short, agent-friendly identifier for a batch deal — used as the
 *  `identifier` field on the typed `critical_actions` list. Combines the
 *  brand, external reference id (or deal name fallback), theme, and channel
 *  so the audit log surfaces meaningful per-deal labels even before deal_ids
 *  are returned. */
function buildCriticalActionIdentifier(form: FormData, deal: DealEntry, dsp?: DspEntry): string {
  const clientTag = form.brand || 'deal'
  const ref = (deal.externalReferenceId || generateDealName(form, deal, { dsp })).trim()
  const parts = [clientTag, ref]
  if (deal.theme) parts.push(deal.theme)
  if (deal.channel) parts.push(deal.channel)
  // Strip newlines defensively so the identifier always fits a single YAML line.
  return parts.filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim()
}

/** The truthful deal-count phrasing for the deal-sheet email: sheet-only rows
 *  ride the sheet but are never created, so a batch with them says
 *  "N new + M already created" instead of a single (wrong) create count. */
function sheetCountLabel(createCount: number, sheetOnlyCount: number): string {
  if (sheetOnlyCount === 0) return `${createCount} deals`
  return `${createCount} new + ${sheetOnlyCount} already created`
}

/** Build the typed `critical_actions` YAML block that confirm_audit's preferred
 *  form consumes. One {tool, identifier} entry per CREATE deal — sheet-only
 *  rows (already created in a previous batch) get NO create action — plus
 *  a final mcp_sendgrid_send_email entry — the runner ships with SendGrid enabled
 *  and the deal-sheet email is the canonical batch finalizer. Pre-building
 *  this list removes the substring-matching guesswork the agent would
 *  otherwise have to do. */
export function buildCriticalActionsBlock(form: FormData): string {
  const { createPairs, sheetOnlyPairs } = splitBatchPairs(form)
  if (createPairs.length === 0 && sheetOnlyPairs.length === 0) return ''
  const lines: string[] = []
  lines.push(`=================================================================`)
  lines.push(`Audit declaration (typed critical_actions list)`)
  lines.push(`=================================================================`)
  for (const { deal: d, dsp } of createPairs) {
    const bareTool = SSP_TO_BATCH_TOOL[d.ssp] || `mcp_${SSP_TO_BATCH_KEY[d.ssp] || d.ssp.toLowerCase()}_<tool>`
    const tool = bareTool
    const identifier = buildCriticalActionIdentifier(form, d, dsp)
    lines.push(`- tool: ${tool}`)
    lines.push(`  identifier: ${quote(identifier)}`)
  }
  const clientName = form.brand || 'Client'
  // Same recipient policy as buildBatchPrompt — never fall back to
  // submitterEmail; the identifier binds to the To address (first chip) only.
  const recipient = splitEmails(form.dealSheetRecipient)[0] || '<UNSET-trader-email>'
  lines.push(`- tool: mcp_sendgrid_send_email`)
  lines.push(`  identifier: ${quote(`Deal sheet → ${recipient} (${clientName} ${sheetCountLabel(createPairs.length, sheetOnlyPairs.length)})`)}`)
  return lines.join('\n')
}

/** Build a single combined batch prompt covering every deal in the form that
 *  has an SSP selected. Shape matches cutlass/protocols/deal-brief.schema.yaml
 *  so the multi-deal orchestrator runs the audit envelope, the per-SSP creates,
 *  then the deal-sheet + email finalization. */
export function buildBatchPrompt(form: FormData, standardLists: StandardList[] = []): string {
  // Same split as buildBatchBrief (dealBrief.ts): CREATE rows get a full
  // tool/name/prompt_inputs entry; sheet-only rows (already created in a
  // previous batch) are emitted ONLY in the non-executable
  // already_created_for_sheet section below — the prompt is what Cutlass
  // executes, so a sheet-only row leaking into `deals:` would RE-CREATE a
  // live deal at the SSP.
  const { createDeals, sheetOnlyDeals } = splitBatchDeals(form.deals)
  if (createDeals.length === 0 && sheetOnlyDeals.length === 0) {
    return `# No batch-supported deals — pick an SSP on each deal card.`
  }
  // Multi-DSP expansion (LOCKED): each selected DSP yields its own create/
  // sheet row carrying that DSP's name-slot code and seat id — the same
  // (deal x DSP) pairs the audit's generateNamedDeals produces, so the gate's
  // name binding matches 1:1.
  const { createPairs, sheetOnlyPairs } = splitBatchPairs(form)

  const clientName = form.brand || 'Client'
  // dealSheetRecipient is the trader's own email (defaulted from /api/session
  // on form load), now optionally a comma-joined list from the chip input.
  // The FIRST address is the To (`recipient`/`to_email` — the protocol's
  // single-trader contract); additional addresses ride the schema-blessed cc
  // list. We deliberately do NOT fall back to form.submitterEmail — when the
  // form was populated from a client's brief, submitterEmail may be the
  // CLIENT's address, and emailing the deal sheet there is a serious mistake.
  // If the list is empty the YAML carries
  // the literal placeholder so the runner + the trader both notice before paste.
  const allRecipients = splitEmails(form.dealSheetRecipient)
  const recipient = allRecipients[0] || '<UNSET-trader-email>'
  const ccRecipients = allRecipients.slice(1)
  // Deal-sheet theme: an explicit form pick wins, otherwise the default. Only
  // themes registered in the runner's deal_sheet tool render, so an
  // unrecognized value falls back to the default (with a warning) rather than
  // failing build_deal_sheet at run time.
  const requestedTheme = form.dealSheetTheme || DEFAULT_DEAL_SHEET_THEME
  const theme = KNOWN_DEAL_SHEET_THEMES.includes(requestedTheme) ? requestedTheme : DEFAULT_DEAL_SHEET_THEME
  const themeFellBack = theme !== requestedTheme

  const lines: string[] = []
  lines.push(`# Multi-deal batch creation — submitted to the runner.`)
  lines.push(`# Follow protocols/multi-deal-creation.yaml: audit envelope → per-deal creates → deal sheet → email.`)
  lines.push(`#`)
  lines.push(`# ⚠ RUNNER EMAIL — do NOT pick an address in the runner's "email results to" picker for this task.`)
  lines.push(`#   This prompt already sends the branded deal sheet to ${recipient}${ccRecipients.length > 0 ? ` (cc: ${ccRecipients.join(', ')})` : ''} as its final step.`)
  lines.push(`#   Adding a runner recipient appends a second, generic send block → a DUPLICATE email.`)
  lines.push(``)
  // Operating constraints preamble.
  lines.push(BATCH_OPERATING_PREAMBLE)
  lines.push(``)
  // Media.net deal_id batch-uniqueness assertion. The id derives from the
  // deal's slots (medianetDealId); two MN creates resolving to the same id
  // would silently collide at Media.net (cutlass validates format only). The
  // Go audit flags the colliding tuple earlier (mn_deal_id); this guard is the
  // prompt-level backstop — the <UNSET…> token fail-closes at the /api/runner/create
  // unresolved-placeholder gate, so a colliding batch can never reach the runner.
  const mnIdPairs = createPairs
    .filter(p => p.deal.ssp === 'Media.net')
    .map(p => medianetDealId(form, p.deal, { dsp: p.dsp }))
  const mnDupes = Array.from(new Set(mnIdPairs.filter((id, i) => mnIdPairs.indexOf(id) !== i)))
  if (mnDupes.length > 0) {
    lines.push(`# <UNSET-DUPLICATE-MEDIANET-DEAL-ID> — multiple Media.net deals in this batch resolve to the`)
    lines.push(`# same deal_id (${mnDupes.join(', ')}). Media.net deal_ids must be unique; differentiate the`)
    lines.push(`# deals' theme/channel/inventory/geo before sending. This token intentionally blocks submission.`)
    lines.push(``)
  }
  lines.push(`client_name: ${quote(clientName)}`)
  lines.push(`recipient: ${quote(recipient)}`)
  lines.push(`cc_recipients: [${ccRecipients.map(quote).join(', ')}]`)
  if (themeFellBack) {
    lines.push(`# NOTE: deal_sheet_theme "${requestedTheme}" is not a registered deal_sheet theme — using "${DEFAULT_DEAL_SHEET_THEME}". Register it in the runner's deal_sheet tool or pick a known theme.`)
  }
  lines.push(`theme: ${quote(theme)}`)
  if (form.campaignId) lines.push(`campaign_id: ${quote(form.campaignId)}`)
  lines.push(`notes: |`)
  lines.push(`  Created via Deal Onboarding batch mode.`)
  // Confirm in the brief envelope when start dates were auto-bumped.
  // The resolver replaces any past flightStartDate with today before each
  // deal block emits its start_date arg (IX rejects past start dates),
  // so this note is informational — it tells the trader/the runner the value in
  // the prompt is not what was on the form. Per-deal blocks also carry an
  // inline `# start_date auto-bumped from ...` comment.
  if (form.flightStartDate) {
    const todayISO = businessTodayISO()  // business-tz calendar date, mirrors resolveStartDate (#235.1)
    if (form.flightStartDate < todayISO) {
      lines.push(`  ℹ Form start date ${form.flightStartDate} was in the past; every deal's start_date was auto-bumped to ${todayISO}. See per-deal comments.`)
    }
  }
  lines.push(``)
  if (createPairs.length === 0) {
    lines.push(`deals: []  # No new creates in this batch — every row already exists; build the deal sheet + email only.`)
  } else {
    lines.push(`deals:`)
  }
  for (let batchIndex = 0; batchIndex < createPairs.length; batchIndex++) {
    const { deal: d, dsp } = createPairs[batchIndex]
    const dealName = generateDealName(form, d, { dsp })
    const sspKey = SSP_TO_BATCH_KEY[d.ssp] || d.ssp.toLowerCase()
    const tool = SSP_TO_BATCH_TOOL[d.ssp] || `mcp_${sspKey}_<tool>`
    lines.push(`  - ssp: ${sspKey}`)
    lines.push(`    tool: ${tool}`)
    lines.push(`    name: ${quote(dealName)}`)
    if (d.externalReferenceId.trim()) {
      lines.push(`    external_reference_id: ${quote(d.externalReferenceId.trim())}`)
    }
    // Optional iab_hint — free-text guide for the agent's
    // ox_list_iab_categories lookup when the trader hasn't picked
    // canonical IAB v2 names directly.
    if (d.iabHint?.trim()) {
      lines.push(`    iab_hint: ${quote(d.iabHint.trim())}`)
    }
    // Optional per-deal notes — propagated into the final summary so any
    // wire-shape assertion the trader cares about lands in the report.
    const notes = (d.notes || []).map(s => s.trim()).filter(Boolean)
    if (notes.length > 0) {
      lines.push(`    notes:`)
      for (const n of notes) lines.push(`      - ${quote(n)}`)
    }
    // Optional post_create_ui_fix — reminder lines the trader still
    // needs to apply manually. Auto-suppress entries whose underlying
    // MCP arg is now populated by this prompt.
    const suppressFixIfArgEmitted = (raw: string): boolean => {
      const s = raw.toLowerCase()
      if (s.includes('inventory categor') && (form.openxConfig.inventoryCategories.some(x => x.trim()) || d.channel === 'CTV')) return true
      if (s.includes('exclude publisher') && form.openxConfig.excludedPublisherIds.some(x => x.trim())) return true
      return false
    }
    const fixes = (d.postCreateUiFix || []).map(s => s.trim()).filter(s => s && !suppressFixIfArgEmitted(s))
    // Expected Sensitive Category is a MANDATORY MANUAL step on every OpenX
    // deal when set: the OpenX partner API cannot set it (verified 2026-08-17
    // — DealCreateParams/dealUpdate reject the field; only the OpenX UI's
    // internal API carries it), so inject the reminder here rather than an
    // MCP arg. Skip only when the trader's own postCreateUiFix already
    // mentions it (no duplicate lines).
    if (d.ssp === 'OpenX' && form.expectedAdCategory.trim()
      && !fixes.some(f => f.toLowerCase().includes('expected sensitive category'))) {
      fixes.push(`MANUAL (trader, after create): set Expected Sensitive Category = '${form.expectedAdCategory.trim()}' on this deal in the OpenX UI. The OpenX partner API does not expose this field — do NOT pass expected_ad_category to any OpenX create/update tool (the API rejects it and the call fails).`)
    }
    if (fixes.length > 0) {
      lines.push(`    post_create_ui_fix:`)
      for (const f of fixes) lines.push(`      - ${quote(f)}`)
    }
    lines.push(`    prompt_inputs: |`)
    // The "# Deal N of M" header reflects this batch's view of the world —
    // createDeals excludes SSP-less and sheet-only deals, so N/M agree with
    // what the runner actually iterates (same indexing as buildBatchBrief). Passing
    // form.deals.indexOf(d) here historically produced gaps like "Deal 2 of 7"
    // when deals had been filtered out of the batch.
    const body = generateDealPromptYaml(form, d, batchIndex, createPairs.length, standardLists, dsp)
    for (const ln of body.split('\n')) {
      lines.push(`      ${ln}`)
    }
    lines.push(``)
  }

  // Sheet-only rows — same section name + status the structured brief uses
  // (dealBrief.ts already_created_for_sheet), so agent, brief, and prompt
  // speak one language. These rows carry NO tool and NO prompt_inputs: their
  // names are embedded here so the server audit gate (runner.go promptEmbedsName)
  // can bind every audited deal name to the prompt without authorizing a
  // create for them.
  if (sheetOnlyPairs.length > 0) {
    lines.push(`# ALREADY-CREATED (sheet-only) rows: the ${sheetOnlyPairs.length} deal(s) below already exist from a`)
    lines.push(`# previous batch. Do NOT create, update, or call any SSP tool for them —`)
    lines.push(`# no create entry above and no critical_actions entry below authorizes one.`)
    lines.push(`# Their ONLY role in this run: include each on the deal sheet and in the`)
    lines.push(`# deal-sheet email alongside the newly created deals.`)
    lines.push(`already_created_for_sheet:`)
    for (const { deal: d, dsp } of sheetOnlyPairs) {
      const sspKey = SSP_TO_BATCH_KEY[d.ssp] || d.ssp.toLowerCase()
      lines.push(`  - ssp: ${sspKey}`)
      lines.push(`    name: ${quote(generateDealName(form, d, { dsp }))}`)
      if (d.channel) lines.push(`    channel: ${quote(d.channel)}`)
      lines.push(`    status: already_created`)
    }
    lines.push(``)
  }

  lines.push(`final_step:`)
  lines.push(`  tool: mcp_deal_sheet_build_deal_sheet`)
  lines.push(`  args:`)
  // Every arg here MUST be a real build_deal_sheet parameter — this block used
  // to emit phantom partner:/campaign_id: args the tool never accepted
  // (#236.1). The arg set is pinned by cutlass-contract.json
  // createProtocol.finalStep.args (contractGolden.test.ts asserts this
  // emission; check-cutlass-contract.mjs pins each arg against the cutlass
  // signature), so a rename on either side fails CI, not a live batch.
  lines.push(`    client_name: ${quote(clientName)}`)
  lines.push(`    theme: ${quote(theme)}`)
  // Campaign ID is the key identifier for this campaign — build_deal_sheet has
  // no campaign_id param, so the campaign keying rides the filename override
  // (the server's default is {client_slug}_deal_sheet_{date}.xlsx; this keeps
  // that shape with the campaign_id prefixed).
  if (form.campaignId) {
    const clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    lines.push(`    output_filename: ${quote(`${form.campaignId}_${clientSlug}_deal_sheet.xlsx`)}`)
  }
  if (sheetOnlyPairs.length > 0) {
    lines.push(`    deals: <Inferred from successful per-deal creates above PLUS every already_created_for_sheet row.>`)
  } else {
    lines.push(`    deals: <Inferred from successful per-deal creates above.>`)
  }

  // followup_step: send the deal-sheet email via SendGrid. the runner ships
  // with SendGrid enabled — this is the canonical batch finalizer.
  lines.push(`followup_step:`)
  lines.push(`  tool: mcp_sendgrid_send_email`)
  lines.push(`  args:`)
  lines.push(`    to_email: ${quote(recipient)}`)
  // Additional chip-input recipients cc the same send — emitted only when
  // present so single-recipient prompts stay byte-identical.
  if (ccRecipients.length > 0) {
    lines.push(`    cc_emails: [${ccRecipients.map(quote).join(', ')}]`)
  }
  lines.push(`    subject: ${quote(`Deal Sheet — ${form.campaignId ? `${form.campaignId} — ` : ''}${clientName} (${sheetCountLabel(createPairs.length, sheetOnlyPairs.length)})`)}`)
  lines.push(`    attachments: [<XLSX path returned by build_deal_sheet>]`)

  // Pre-built typed critical_actions block — confirm_audit's preferred form.
  // One {tool, identifier} per deal, plus the final send_email entry.
  lines.push(``)
  lines.push(buildCriticalActionsBlock(form))

  // Required final summary — gives the agent an explicit reporting contract
  // so we can verify post-run that all the per-run gates fired. Lines
  // tied to a specific new MCP arg are conditional — they only fire when
  // the arg is actually emitted by buildOpenXPrompt, so the agent doesn't
  // get asked to confirm something the prompt never set.
  lines.push(``)
  lines.push(`=================================================================`)
  lines.push(`Required final summary`)
  lines.push(`=================================================================`)
  lines.push(`For each created deal: success/failure, deal_id, deal_url, any quality_flags surfaced.`)
  lines.push(`build_deal_sheet output XLSX path.`)
  lines.push(`send_email confirmation (message_id from mcp_sendgrid_send_email).`)
  lines.push(`Confirm: you used the typed critical_actions field, and called validate_brief before confirm_audit.`)
  if (sheetOnlyPairs.length > 0) {
    lines.push(`Confirm: NO create/update tool was called for any already_created_for_sheet row, and each of the ${sheetOnlyPairs.length} row(s) appears on the deal sheet.`)
  }
  lines.push(`Per deal with a domain file: confirm domain_match_operator was passed and the wire url_targeting.type matches the operator chosen for the deal.`)
  lines.push(`Per deal with an app-bundle file: confirm app_bundle_match_operator was passed and the wire app/bundle-targeting type matches the operator chosen for the deal.`)
  lines.push(`Per deal: list which IAB category names the MCP resolved and which (if any) the trader needs to set in the UI.`)
  if (form.expectedAdCategory.trim() && createDeals.some(d => d.ssp === 'OpenX')) {
    lines.push(`List every OpenX deal that needs the MANUAL post-create step: set Expected Sensitive Category = "${form.expectedAdCategory.trim()}" in the OpenX UI (the partner API does not expose this field — you MUST NOT attempt it via any OpenX tool; a trader applies it by hand). Include this reminder in the summary email body.`)
  }
  if (createDeals.some(d => d.ssp === 'OpenX' && form.openxConfig.excludedPublisherIds.some(s => s.trim()))) {
    const exc = form.openxConfig.excludedPublisherIds.map(s => s.trim()).filter(Boolean)
    lines.push(`Confirm: excluded_publisher_ids ${JSON.stringify(exc)} applied to every OpenX deal.`)
  }
  if (createDeals.some(d => d.ssp === 'OpenX' && (form.openxConfig.inventoryCategories.some(s => s.trim()) || d.channel === 'CTV'))) {
    lines.push(`Confirm: inventory_categories applied to every OpenX deal that ships this field (resolved → targeting.metacategory.includes).`)
  }
  lines.push(`Report: number of unique entries (domains or app bundles) the SSP MCP extracted from each list-file per deal.`)
  // Xandr/TripleLift list-delivery disclosure (#220) — fires only when a
  // create pair on one of those SSPs actually resolves a list, i.e. exactly
  // when a per-deal block above emitted the LIST NOT APPLIED comment or the
  // tl_merge_deal_supply_domains instruction. Forces the agent to report the
  // list's real status instead of silently claiming full application.
  const xnTlListPairs = createPairs.filter(p => {
    if (p.deal.ssp !== 'Xandr' && p.deal.ssp !== 'TripleLift') return false
    return !!resolve(form, p.deal, standardLists, p.dsp).domainFile
  })
  if (xnTlListPairs.length > 0) {
    lines.push(`Per Xandr/TripleLift deal with a site or app-bundle list: report the list's delivery status explicitly — Xandr: NOT APPLIED (no list-file ingestion; a Curate deal list must be configured in the UI); TripleLift domain lists: applied POST-CREATE to supply-domain (site/inventory) targeting via tl_merge_deal_supply_domains (EB_SUPPLY_DOMAIN_ID leaf, cutlass#731) — cite the merge tool's returned verification per deal; TripleLift app-bundle lists: NOT APPLIED. Never report such a list as fully applied at create time or without the post-create merge verification.`)
  }
  // Ad-duration reporting contract — fires only when a deal actually carries
  // a resolvable duration requirement (CTV/OLV/OTT + parseable values), i.e.
  // exactly when a per-deal block above emitted a duration arg or a loud
  // NOT-SUPPORTED comment. Stray durations on other channels emit nothing
  // here — the Go QA item (qa_ad_duration) flags those pre-submit.
  if (createDeals.some(d => resolveAdDuration(d) !== null)) {
    lines.push(`Per deal with ad-duration targeting: report the requirement as APPLIED (name the duration arg + the values the SSP accepted) or NOT APPLIED (unsupported SSP — PubMatic/TripleLift — or an inexpressible bound, e.g. a max-only cap on Xandr, or a blocked write). Every duration-carrying deal MUST appear one way or the other; never silently drop a duration requirement.`)
  }
  // IAB-exclude reporting contract — fires only when a deal in the batch
  // carries explicit exclusions (effectiveIabExcludes; never inferred). Only
  // IX and PubMatic apply them at create; every other SSP's exclusions ride
  // the per-deal NOT-supported comment and must come back as trader UI
  // follow-ups here — never silently dropped.
  if (createDeals.some(d => effectiveIabExcludes(d).length > 0)) {
    lines.push(`Per deal with IAB/content EXCLUSIONS: report them as APPLIED (Index Exchange excluded_iab_categories / PubMatic exclude_iab_categories — name the category names the MCP accepted) or as a TRADER UI FOLLOW-UP naming the SSP and the excluded category names (OpenX/Media.net/Magnite/Xandr/TripleLift — no create-time exclude API). Every exclusion-carrying deal MUST appear one way or the other; never silently drop an exclusion.`)
  }
  // Silent-drop reporting contracts (#226/#244) — each line fires
  // only when a deal in the batch actually carries the dimension, i.e.
  // exactly when a per-deal block above emitted the arg or its loud
  // NOT-SUPPORTED marker. Every carrying deal MUST come back one way or the
  // other; nothing may be dropped silently.
  if (createDeals.some(d => (d.viewabilityTarget || '').trim() !== '')) {
    lines.push(`Per deal with a viewability target: report it as APPLIED (IX/OpenX/PubMatic viewability_threshold, Media.net viewability_min — name the value the SSP accepted; Magnite DV+ raw-targeting viewability is a MANUAL step — confirm it or report it as a pending trader step) or NOT APPLIED (Xandr / TripleLift / Magnite CTV — no viewability wire; the deal block carries the NOT-SUPPORTED marker). Never report an uncarried viewability target as configured.`)
  }
  if (createDeals.some(d => (d.language || form.defaultLanguage || '').trim() !== '')) {
    lines.push(`Per deal with language targeting: report it as APPLIED (OpenX targeting.languages / Media.net device_languages — name the resolved language) or NOT APPLIED (Index Exchange / PubMatic / Xandr / TripleLift / Magnite — no language wire; trader applies it in the SSP UI or on the DSP line). Never report an uncarried language as configured.`)
  }
  if (createDeals.some(d => resolve(form, d, standardLists).segmentsExclude.length > 0)) {
    lines.push(`Per deal with audience segment EXCLUSIONS: report them as APPLIED (Index Exchange / PubMatic / Xandr excluded_segment_names, Magnite CTV audience_segments_block — name the segments the MCP accepted). Any exclusion on an SSP that cannot enforce it (OpenX — ox_audience_exclude_unsupported hard-fails the create; Media.net / TripleLift — no exclude wire; Magnite DV+ — no audience API until v3.0) is BLOCKED by the Deal Onboarding audit (segment_exclude_unsupported) — the batch does not submit until the trader removes the unsupported exclude or moves the deal to an enforcing SSP, so no such deal reaches this run. A dropped exclusion SERVES the excluded audience.`)
  }
  if (createDeals.some(d => (d.geoExclude.length > 0 ? d.geoExclude : form.defaultGeoExclude).length > 0)) {
    lines.push(`Per deal with geo EXCLUSIONS: report them as APPLIED (PubMatic geo_countries_exclude/geo_states_exclude → excludeGeos; Xandr geo_countries_exclude/geo_states_exclude → country/region_action="exclude"; Magnite geo_countries_exclude; OpenX targeting.geographic.excludes — name the values the MCP accepted) or BLOCKED (any deal block above carrying a geo-exclusion NOT-SUPPORTED marker must NOT be created with the exclusion dropped — the audit fails those closed). A dropped geo exclusion SERVES the excluded geography.`)
  }
  // Include-state drop disclosure (#233.7/.8) — fires exactly when a
  // deal block above emitted the state NOT-SUPPORTED marker (IX/Media.net
  // have no include-state wire). The states are never passed to a tool and
  // the deal name's Geo slot no longer claims them.
  if (createDeals.some(d => {
    const inc = d.geoInclude.length ? d.geoInclude : form.defaultGeoInclude
    return !sspCarriesIncludeStates(d.ssp) && inc.some(g => g.type === 'state' && (g.value || '').trim() !== '')
  })) {
    lines.push(`Per Index Exchange / Media.net deal with state/province include targeting: report the state(s) as NOT APPLIED (no include-state wire on that SSP — the deal serves its country-wide/global geo; the deal block carries the NOT-SUPPORTED marker and the deal name's Geo slot does not claim the state). Never report such a deal as state-targeted, and never pass a state/region arg to an IX or Media.net tool.`)
  }
  if (createDeals.some(d => (d.ssp === 'TripleLift' || d.ssp === 'Magnite') && effectiveIabCategories(d, form).length > 0)) {
    lines.push(`Per TripleLift/Magnite deal with IAB categories: report them as NOT APPLIED (TripleLift — vendor-gated, no IAB item-ID discovery, cutlass#757; Magnite — no ClearLine content-category surface); the trader applies contextual scoping in the SSP UI. Never report TL/Magnite IAB as configured.`)
  }
  if (createDeals.some(d => d.ssp === 'Magnite')) {
    lines.push(`Per Magnite deal: surface the returned deal_id prominently (Magnite has no per-deal console URL and no list-deals endpoint until API v3.0) and report any magnite_* quality flags, especially the default rev-share flag.`)
  }

  return lines.join('\n')
}

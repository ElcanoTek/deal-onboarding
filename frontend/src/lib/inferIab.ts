// Per-deal IAB category inference — OPT-IN PER DEAL, DEFAULT OFF.
//
// Deterministic keyword table matched against each deal's own details (theme,
// segments, IAB hint) plus the campaign brand/KPI text — so two deals in the
// same campaign infer independently (a "Cold & Flu" OLV deal and a "Beach
// Travel" display deal get different categories). Deterministic on purpose:
// the deal card preview, the audit's inferred block, and the generated prompt
// all run the same table and can never disagree.
//
// MIRROR CONTRACT: internal/validation/rules.go (inferIABForDeal) implements
// the SAME table for the backend audit's `inferred.per_deal` block. Change the
// keywords in BOTH places or neither — inferIab.test.ts and rules_test.go pin
// shared fixtures to enforce the mirror. Precedence is per-deal only: explicit
// picks (deal.iabCategories !== undefined) win; else inference runs ONLY when
// the deal's autoInferIab toggle is on; else NOTHING ships. The retired
// campaign-level form.iabCategories never ships (it folds onto the deals at
// load, and the Go audit fails closed on it via iab_campaign_retired).

import type { DealEntry, FormData } from '../types/deal'

/** Canonical IAB category display names offered in the per-deal picker.
 *  (Moved from the retired Campaign Defaults section — same list.) */
export const IAB_OPTIONS = [
  'Arts & Entertainment', 'Automotive', 'Auto Insurance', 'Business', 'Careers & Employment',
  'Consumer Banking', 'Education', 'Family & Parenting', 'Food & Drink', 'Health & Fitness',
  'Hobbies & Interests', 'Home & Garden', 'Home Insurance', 'Insurance', 'Law, Gov & Politics',
  'Life Insurance', 'News', 'Personal Finance', 'Pets', 'Real Estate', 'Science', 'Society',
  'Sports', 'Style & Fashion', 'Technology & Computing', 'Travel',
]

// keyword (lowercase word/phrase) → category. First-declared order wins for
// output ordering; every keyword matches on WORD BOUNDARIES (see matchesWord),
// so 'pet' matches "pet food" but not "carpet" or "competition".
const KEYWORD_TO_CATEGORY: [string, string][] = [
  ['auto insurance', 'Auto Insurance'],
  ['automotive', 'Automotive'],
  ['car', 'Automotive'],
  ['cars', 'Automotive'],
  ['vehicle', 'Automotive'],
  ['vehicles', 'Automotive'],
  ['dealership', 'Automotive'],
  ['home insurance', 'Home Insurance'],
  ['life insurance', 'Life Insurance'],
  ['insurance', 'Insurance'],
  ['bank', 'Consumer Banking'],
  ['banking', 'Consumer Banking'],
  ['credit', 'Personal Finance'],
  ['finance', 'Personal Finance'],
  ['financial', 'Personal Finance'],
  ['invest', 'Personal Finance'],
  ['investing', 'Personal Finance'],
  ['investment', 'Personal Finance'],
  ['b2b', 'Business'],
  ['business', 'Business'],
  ['career', 'Careers & Employment'],
  ['job', 'Careers & Employment'],
  ['hiring', 'Careers & Employment'],
  ['education', 'Education'],
  ['school', 'Education'],
  ['college', 'Education'],
  ['parent', 'Family & Parenting'],
  ['family', 'Family & Parenting'],
  ['baby', 'Family & Parenting'],
  ['food', 'Food & Drink'],
  ['drink', 'Food & Drink'],
  ['beverage', 'Food & Drink'],
  ['restaurant', 'Food & Drink'],
  ['grocery', 'Food & Drink'],
  ['recipe', 'Food & Drink'],
  ['health', 'Health & Fitness'],
  ['fitness', 'Health & Fitness'],
  ['wellness', 'Health & Fitness'],
  ['pharma', 'Health & Fitness'],
  ['medical', 'Health & Fitness'],
  ['medicine', 'Health & Fitness'],
  ['cold and flu', 'Health & Fitness'],
  ['cold & flu', 'Health & Fitness'],
  ['flu', 'Health & Fitness'],
  ['allergy', 'Health & Fitness'],
  ['sunscreen', 'Health & Fitness'],
  ['skincare', 'Style & Fashion'],
  ['skin care', 'Style & Fashion'],
  ['beauty', 'Style & Fashion'],
  ['fashion', 'Style & Fashion'],
  ['apparel', 'Style & Fashion'],
  ['cosmetic', 'Style & Fashion'],
  ['home & garden', 'Home & Garden'],
  ['garden', 'Home & Garden'],
  ['home improvement', 'Home & Garden'],
  ['furniture', 'Home & Garden'],
  ['diy', 'Home & Garden'],
  ['politics', 'Law, Gov & Politics'],
  ['political', 'Law, Gov & Politics'],
  ['government', 'Law, Gov & Politics'],
  ['election', 'Law, Gov & Politics'],
  ['news', 'News'],
  ['weather', 'News'],
  ['pet', 'Pets'],
  ['pets', 'Pets'],
  ['dog', 'Pets'],
  ['dogs', 'Pets'],
  ['cat', 'Pets'],
  ['cats', 'Pets'],
  ['real estate', 'Real Estate'],
  ['mortgage', 'Real Estate'],
  ['home buyer', 'Real Estate'],
  ['science', 'Science'],
  ['sport', 'Sports'],
  ['sports', 'Sports'],
  ['nfl', 'Sports'],
  ['nba', 'Sports'],
  ['mlb', 'Sports'],
  ['golf', 'Sports'],
  ['tech', 'Technology & Computing'],
  ['software', 'Technology & Computing'],
  ['computing', 'Technology & Computing'],
  ['gaming', 'Technology & Computing'],
  ['travel', 'Travel'],
  ['vacation', 'Travel'],
  ['tourism', 'Travel'],
  ['hotel', 'Travel'],
  ['airline', 'Travel'],
  ['beach', 'Travel'],
  ['outdoor', 'Hobbies & Interests'],
  ['hobby', 'Hobbies & Interests'],
  ['crafts', 'Hobbies & Interests'],
  ['entertainment', 'Arts & Entertainment'],
  ['movie', 'Arts & Entertainment'],
  ['music', 'Arts & Entertainment'],
  ['streaming', 'Arts & Entertainment'],
  ['tv show', 'Arts & Entertainment'],
]

/** The text a deal's inference runs over: its own details first, then the
 *  campaign-level brand/KPI context shared by every deal. */
function dealText(deal: DealEntry, form: FormData): string {
  return [
    deal.theme,
    ...deal.includeSegments,
    deal.iabHint || '',
    form.brand,
    form.kpiGoal,
  ].join(' \n ').toLowerCase()
}

/** Word-boundary keyword match: the keyword (word or phrase) must not be
 *  glued to alphanumerics on either side — 'pet' matches "pet food" but not
 *  "carpet", "competition", or "petroleum". Mirrored by matchesIABKeyword in
 *  rules.go. */
function matchesWord(text: string, kw: string): boolean {
  const isAlnum = (c: string) => /[a-z0-9]/.test(c)
  let idx = text.indexOf(kw)
  while (idx !== -1) {
    const beforeOk = idx === 0 || !isAlnum(text[idx - 1])
    const end = idx + kw.length
    const afterOk = end >= text.length || !isAlnum(text[end])
    if (beforeOk && afterOk) return true
    idx = text.indexOf(kw, idx + 1)
  }
  return false
}

/** Infer IAB categories for ONE deal from its own details. Deterministic and
 *  order-stable (keyword declaration order). Returns [] when nothing matches —
 *  callers decide the fallback. */
export function inferIabCategories(deal: DealEntry, form: FormData): string[] {
  const text = dealText(deal, form)
  if (!text.trim()) return []
  const out: string[] = []
  for (const [kw, cat] of KEYWORD_TO_CATEGORY) {
    if (out.includes(cat)) continue
    if (matchesWord(text, kw)) out.push(cat)
  }
  return out
}

/** The categories a deal actually ships. Precedence:
 *    1. explicit per-deal picks (deal.iabCategories !== undefined) — win,
 *       including [] = explicitly none;
 *    2. else, IF the deal OPTED IN to inference (autoInferIab === true), the
 *       deterministic per-deal inference;
 *    3. else [] — NOTHING ships: no iab lines in any prompt, so nothing
 *       appears in deal-sheet emails. Inference is opt-in per deal, default
 *       OFF (the deal card's "Auto-infer IAB categories" toggle).
 *  The campaign-level form.iabCategories is RETIRED as a shipping input — its
 *  editor is gone, so a fallback here shipped an invisible persisted list (the
 *  2026-07 automotive-category incident); legacy values instead fold onto
 *  the deals at load (migrateCampaignIabCategories in types/deal.ts). The form
 *  param stays: inference reads the campaign brand/KPI text. */
export function effectiveIabCategories(deal: DealEntry, form: FormData): string[] {
  if (deal.iabCategories !== undefined) return deal.iabCategories
  if (deal.autoInferIab === true) return inferIabCategories(deal, form)
  return []
}

/** The IAB category / content-genre EXCLUSIONS a deal ships: the trader's
 *  explicit per-deal list, else nothing. Deliberately NO inference and NO
 *  campaign-level fallback — inference only ever ADDS include categories; an
 *  exclusion must always be a deliberate trader/brief choice. Single accessor
 *  shared by the deal card and the prompt builders (dealPromptYaml.ts) so the
 *  two can never disagree — the exclude mirror of effectiveIabCategories. */
export function effectiveIabExcludes(deal: DealEntry): string[] {
  return deal.iabCategoriesExclude ?? []
}

import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, newDeal, type FormData } from '../types/deal'
import { effectiveIabCategories, effectiveIabExcludes, inferIabCategories } from './inferIab'

function formWith(extra: Partial<FormData> = {}): FormData {
  return { ...DEFAULT_FORM, ...extra }
}

// MIRROR CONTRACT: these fixtures are duplicated verbatim in
// internal/validation/rules_test.go (TestInferIAB_MirrorFixtures). If one side
// changes, change both — the TS and Go keyword tables must stay identical.
describe('inferIabCategories — mirror fixtures (shared with rules_test.go)', () => {
  const cases: { name: string; theme: string; segments?: string[]; brand?: string; iabHint?: string; want: string[] }[] = [
    { name: 'cold and flu', theme: 'Cold & Flu', brand: 'TheraFlu', want: ['Health & Fitness'] },
    { name: 'beach travel', theme: 'Beach Getaways', brand: 'Sun Bum', want: ['Travel'] },
    { name: 'banking order-stable', theme: 'DigitalConsumer', segments: ['Consumer Banking > Credit Cards'], want: ['Consumer Banking', 'Personal Finance'] },
    { name: 'sports news order', theme: 'Sports News', want: ['News', 'Sports'] },
    { name: 'iab hint feeds inference', theme: 'Q3 Push', iabHint: 'local news', want: ['News'] },
    { name: 'word boundaries — no substring false positives', theme: 'Carpet Cleaning Competition', brand: 'Conscience Co', want: [] },
    { name: 'no match', theme: 'Zzyzx', brand: 'Qwerty', want: [] },
  ]

  it.each(cases)('$name', ({ theme, segments, brand, iabHint, want }) => {
    const form = formWith({ brand: brand || '' })
    const deal = { ...newDeal(), theme, includeSegments: segments || [], iabHint }
    expect(inferIabCategories(deal, form)).toEqual(want)
  })

  it('infers PER DEAL — two deals in one campaign get different categories', () => {
    const form = formWith()
    const flu = { ...newDeal(), theme: 'Cold & Flu' }
    const beach = { ...newDeal(), theme: 'Beach Getaways' }
    expect(inferIabCategories(flu, form)).toEqual(['Health & Fitness'])
    expect(inferIabCategories(beach, form)).toEqual(['Travel'])
  })
})

describe('effectiveIabCategories — precedence truth table (inference is opt-in per deal, default OFF)', () => {
  // picks × toggle: explicit picks always win, regardless of the toggle.
  it('explicit per-deal picks win — toggle off', () => {
    const form = formWith()
    const deal = { ...newDeal(), theme: 'Cold & Flu', iabCategories: ['News'] }
    expect(effectiveIabCategories(deal, form)).toEqual(['News'])
  })

  it('explicit per-deal picks win — toggle on (picks beat inference)', () => {
    const form = formWith()
    const deal = { ...newDeal(), theme: 'Cold & Flu', iabCategories: ['News'], autoInferIab: true }
    expect(effectiveIabCategories(deal, form)).toEqual(['News'])
  })

  // explicit [] beats everything — toggle on or off.
  it('explicit empty array means explicitly none — even with the toggle ON', () => {
    const form = formWith({ iabCategories: ['Sports'] })
    const deal = { ...newDeal(), theme: 'Cold & Flu', iabCategories: [], autoInferIab: true }
    expect(effectiveIabCategories(deal, form)).toEqual([])
  })

  it('explicit empty array means explicitly none — toggle off', () => {
    const form = formWith()
    const deal = { ...newDeal(), theme: 'Cold & Flu', iabCategories: [] }
    expect(effectiveIabCategories(deal, form)).toEqual([])
  })

  // no picks × toggle
  it('no picks + toggle ON → inference runs', () => {
    const form = formWith()
    const deal = { ...newDeal(), theme: 'Cold & Flu', autoInferIab: true }
    expect(effectiveIabCategories(deal, form)).toEqual(['Health & Fitness'])
  })

  it('no picks + toggle OFF (default: field absent) → NOTHING ships, even when inference would match', () => {
    const form = formWith()
    const deal = { ...newDeal(), theme: 'Cold & Flu' }
    expect(effectiveIabCategories(deal, form)).toEqual([])
  })

  it('no picks + toggle explicitly false → nothing ships', () => {
    const form = formWith()
    const deal = { ...newDeal(), theme: 'Cold & Flu', autoInferIab: false }
    expect(effectiveIabCategories(deal, form)).toEqual([])
  })

  it('a stale campaign-level list is IGNORED in every state (the field is retired; legacy values fold onto deals at load)', () => {
    const form = formWith({ iabCategories: ['Sports'] })
    // Toggle on: inference (not the campaign list) ships.
    expect(effectiveIabCategories({ ...newDeal(), theme: 'Cold & Flu', autoInferIab: true }, form))
      .toEqual(['Health & Fitness'])
    // Toggle off: nothing ships — the campaign list never leaks back in.
    expect(effectiveIabCategories({ ...newDeal(), theme: 'Cold & Flu' }, form)).toEqual([])
  })
})

describe('effectiveIabExcludes — explicit only, never inferred', () => {
  it('returns the explicit per-deal list verbatim (SSP-native genre names included)', () => {
    const deal = { ...newDeal(), iabCategoriesExclude: ['Hard News', 'News'] }
    expect(effectiveIabExcludes(deal)).toEqual(['Hard News', 'News'])
  })

  it('undefined → [] — no inference (inference only ever ADDS include categories)', () => {
    // A theme that infers a category for the INCLUDE side must produce zero excludes.
    const deal = { ...newDeal(), theme: 'Cold & Flu' }
    expect(effectiveIabExcludes(deal)).toEqual([])
  })

  it('[] → [] — undefined and empty both mean none (no auto state to preserve)', () => {
    const deal = { ...newDeal(), iabCategoriesExclude: [] }
    expect(effectiveIabExcludes(deal)).toEqual([])
  })
})

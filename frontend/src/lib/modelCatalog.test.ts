import { describe, expect, it } from 'vitest'
import { ADVANCED_MODEL, DEFAULT_MODEL, tierForModel } from './modelAliases'
import { MAX_SEARCH_RESULTS, RankedModel, composePickerModels, isNewlyReleased } from './modelCatalog'

const ranked: RankedModel[] = [
  { slug: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', created: 1_900 },
  { slug: 'google/gemini-3.2-pro', name: 'Google: Gemini 3.2 Pro', created: 1_850 },
]

const catalog: RankedModel[] = [
  ...ranked,
  { slug: 'anthropic/claude-haiku-4.5', name: 'Anthropic: Claude Haiku 4.5' },
  ...Array.from({ length: 30 }, (_, i) => ({
    slug: `lab/model-${i}`,
    name: `Lab: Model ${i}`,
  })),
]

describe('composePickerModels', () => {
  it('browse mode pins the tier rows first, then the ranked list', () => {
    const out = composePickerModels('', ranked, catalog)
    expect(out.map(m => m.slug)).toEqual([
      DEFAULT_MODEL,
      ADVANCED_MODEL,
      'anthropic/claude-opus-5',
      'google/gemini-3.2-pro',
    ])
  })

  it('prepends extra pinned rows (the parser server-default row)', () => {
    const out = composePickerModels('', ranked, catalog, [{ slug: '', name: 'Server default' }])
    expect(out[0]).toEqual({ slug: '', name: 'Server default' })
    expect(out[1].slug).toBe(DEFAULT_MODEL)
  })

  it('dedupes a ranked row that duplicates a pinned slug', () => {
    const out = composePickerModels('', [{ slug: DEFAULT_MODEL, name: 'dup' }, ...ranked], catalog)
    expect(out.filter(m => m.slug === DEFAULT_MODEL)).toHaveLength(1)
  })

  it('search matches slug and name against the full catalog, capped', () => {
    const out = composePickerModels('anthropic', ranked, catalog)
    expect(out.map(m => m.slug)).toEqual([
      'anthropic/claude-opus-5',
      'anthropic/claude-haiku-4.5',
    ])
    const capped = composePickerModels('model', ranked, catalog)
    expect(capped).toHaveLength(MAX_SEARCH_RESULTS)
  })

  it('search falls back to the ranked list while the catalog is empty', () => {
    const out = composePickerModels('gemini', ranked, [])
    expect(out.map(m => m.slug)).toEqual(['google/gemini-3.2-pro'])
  })
})

describe('isNewlyReleased', () => {
  it('true within the 14-day window, false outside or unknown', () => {
    const now = Date.now() / 1000
    expect(isNewlyReleased(now - 3 * 86400)).toBe(true)
    expect(isNewlyReleased(now - 20 * 86400)).toBe(false)
    expect(isNewlyReleased(undefined)).toBe(false)
    expect(isNewlyReleased(0)).toBe(false)
  })
})

describe('tierForModel', () => {
  it('classifies pinned, tested, and experimental slugs', () => {
    expect(tierForModel(DEFAULT_MODEL)).toBe('default')
    expect(tierForModel(ADVANCED_MODEL)).toBe('advanced')
    expect(tierForModel('anthropic/claude-sonnet-4.6')).toBe('tested')
    expect(tierForModel('someone/some-model')).toBe('experimental')
  })
})

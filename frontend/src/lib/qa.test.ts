import { describe, expect, it } from 'vitest'
import { groupInsightsBySection, qaJumpElementId } from './qa'
import { AuditAIInsight, DealEntry, newDeal } from '../types/deal'

function dealWithId(id: string): DealEntry {
  return { ...newDeal(), id }
}

describe('qaJumpElementId', () => {
  const deals = [dealWithId('d-abc'), dealWithId('d-xyz')]

  it('resolves per-deal paths through the deal id (DealsList keys ids by deal.id)', () => {
    expect(qaJumpElementId({ fieldPath: 'deals[0].theme' }, deals)).toBe('deal-theme-d-abc')
    expect(qaJumpElementId({ fieldPath: 'deals[1].cpm' }, deals)).toBe('deal-cpm-d-xyz')
    expect(qaJumpElementId({ fieldPath: 'deals[1].inventoryType' }, deals)).toBe('deal-inv-d-xyz')
    expect(qaJumpElementId({ fieldPath: 'deals[0].magniteSizes' }, deals)).toBe('deal-magniteSizes-d-abc')
  })

  it('falls back to the deal-name anchor for fields without a dedicated input', () => {
    expect(qaJumpElementId({ fieldPath: 'deals[0].includeSegments' }, deals)).toBe('deal-name-d-abc')
    expect(qaJumpElementId({ fieldPath: 'deals[0].geoInclude' }, deals)).toBe('deal-name-d-abc')
  })

  it('returns undefined for an out-of-range deal index', () => {
    expect(qaJumpElementId({ fieldPath: 'deals[5].theme' }, deals)).toBeUndefined()
  })

  it('resolves top-level paths through the audit ELEMENT_ID table', () => {
    expect(qaJumpElementId({ fieldPath: 'funnel' }, deals)).toBe('funnel')
    expect(qaJumpElementId({ fieldPath: 'attributionCode' }, deals)).toBe('attributionCode')
    expect(qaJumpElementId({ fieldPath: 'magniteConfig.floorCpm' }, deals)).toBe('mg-floor')
    // Retired inputs (account-level IX viewability, campaign-wide IAB picker)
    // no longer resolve — the jump falls back to the section anchor.
    expect(qaJumpElementId({ fieldPath: 'ixConfig.viewabilityThreshold' }, deals)).toBeUndefined()
    expect(qaJumpElementId({ fieldPath: 'iabCategories' }, deals)).toBeUndefined()
    // Per-deal IAB editors resolve to the deal card's section anchor.
    expect(qaJumpElementId({ fieldPath: 'deals[0].iabCategories' }, deals)).toBe('deal-iabCategories-d-abc')
  })

  it('returns undefined without a fieldPath', () => {
    expect(qaJumpElementId({}, deals)).toBeUndefined()
  })
})

describe('groupInsightsBySection', () => {
  it('buckets tagged insights and leaves the rest general', () => {
    const insights: AuditAIInsight[] = [
      { severity: 'warn', message: 'floor low', qaSection: 'ssp_configuration' },
      { severity: 'info', message: 'note', qaSection: 'targeting' },
      { severity: 'critical', message: 'untagged' },
      { severity: 'warn', message: 'bad tag', qaSection: 'not_a_section' },
    ]
    const { bySection, general } = groupInsightsBySection(insights)
    expect(bySection['ssp_configuration']).toHaveLength(1)
    expect(bySection['targeting']).toHaveLength(1)
    expect(general.map(i => i.message)).toEqual(['untagged', 'bad tag'])
  })
})

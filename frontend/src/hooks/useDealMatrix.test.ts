import { describe, expect, it } from 'vitest'
import { generateDealName } from './useDealMatrix'
import { DEFAULT_FORM, newDeal, DealEntry } from '../types/deal'

describe('generateDealName', () => {

  it('does not throw when nameOverride is missing (un-hydrated chat-edit deal) and still generates a name', () => {
    // A deal straight off an LLM chat edit can omit nameOverride entirely; the
    // generator must tolerate undefined rather than crashing the review modal.
    const deal = { ...newDeal(), ssp: 'Index Exchange', channel: 'Display' } as DealEntry
    delete (deal as Partial<DealEntry>).nameOverride
    expect(() => generateDealName(DEFAULT_FORM, deal)).not.toThrow()
    expect(generateDealName(DEFAULT_FORM, deal).length).toBeGreaterThan(0)
  })
})

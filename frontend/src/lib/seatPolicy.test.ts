import { describe, expect, it } from 'vitest'
import { seatOptionalDsp, splitSeatIds } from './seatPolicy'

// splitSeatIds is the TS half of a pinned pair — Go's SplitSeatIDs
// (internal/validation/rules.go) must agree token-for-token, because the Go
// audit decides whether a multi-seat value is allowed and the TS builder
// decides what actually ships on the wire.
describe('splitSeatIds', () => {
  it('returns a single token for an ordinary seat', () => {
    expect(splitSeatIds('393')).toEqual(['393'])
    expect(splitSeatIds('House Seat')).toEqual(['House Seat'])
  })

  it('splits a comma list, trimming each token (DEAL07303)', () => {
    expect(splitSeatIds('1413973141,850299280, 134 ,163531')).toEqual([
      '1413973141', '850299280', '134', '163531',
    ])
  })

  it('applies the prefix/seat strip PER TOKEN, not across the whole string', () => {
    // The pre-existing single-seat strip is greedy from the start of the
    // string, so run over a list it would have collapsed everything before the
    // LAST slash — silently dropping seats.
    expect(splitSeatIds('acct/393,other/394')).toEqual(['393', '394'])
  })

  it('drops empties and dedupes, preserving first-seen order', () => {
    expect(splitSeatIds('393,,394, 393 ,')).toEqual(['393', '394'])
    expect(splitSeatIds('')).toEqual([])
    expect(splitSeatIds('  ,  ')).toEqual([])
  })

  it('leaves the seat-optional DSP policy alone', () => {
    expect(seatOptionalDsp('StackAdapt')).toBe(true)
    expect(seatOptionalDsp('DV360')).toBe(false)
  })
})

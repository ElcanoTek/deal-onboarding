// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

/** Geo direction rows on the deal card.
 *
 *  The deal keeps geoInclude/geoExclude as separate arrays (the prompt builders
 *  and the geo_exclude_unsupported audit rule both read them that way) while the
 *  card shows ONE list with a direction per row. These pin the translation, and
 *  in particular that flipping direction MOVES an entry rather than recreating
 *  it — a trader changing "include Quebec" to "exclude Quebec" must not have to
 *  re-pick the type or re-type the value.
 */
import { describe, it, expect } from 'vitest'
import { newDeal } from '../types/deal'
import type { DealEntry, GeoEntry } from '../types/deal'
import { geoRowsOf, patchGeoRow, removeGeoRow, moveGeoRow } from './DealsList'

const geo = (id: string, type: GeoEntry['type'], value: string): GeoEntry => ({ id, type, value })

function dealWith(include: GeoEntry[], exclude: GeoEntry[]): DealEntry {
  return { ...newDeal(), geoInclude: include, geoExclude: exclude }
}

describe('geoRowsOf', () => {
  it('lists includes first, then exclusions, each tagged with its array', () => {
    const d = dealWith([geo('a', 'country', 'CA')], [geo('b', 'state', 'QC')])
    expect(geoRowsOf(d)).toEqual([
      { entry: geo('a', 'country', 'CA'), dir: 'include' },
      { entry: geo('b', 'state', 'QC'), dir: 'exclude' },
    ])
  })

  it('is empty for a deal with no geo at all', () => {
    expect(geoRowsOf(dealWith([], []))).toEqual([])
  })
})

describe('patchGeoRow', () => {
  it('edits in place in whichever array the row lives', () => {
    const d = dealWith([geo('a', 'country', 'CA')], [geo('b', 'state', 'QC')])
    expect(patchGeoRow(d, 'b', 'exclude', { value: 'ON' })).toEqual({
      geoExclude: [geo('b', 'state', 'ON')],
    })
    // The untouched array is not part of the patch, so it cannot be clobbered.
    expect(patchGeoRow(d, 'b', 'exclude', { value: 'ON' })).not.toHaveProperty('geoInclude')
  })

  it('changing type clears the value (the old value belongs to the old type)', () => {
    const d = dealWith([geo('a', 'country', 'CA')], [])
    expect(patchGeoRow(d, 'a', 'include', { type: 'state', value: '' })).toEqual({
      geoInclude: [geo('a', 'state', '')],
    })
  })
})

describe('removeGeoRow', () => {
  it('removes only from the row’s own array', () => {
    const d = dealWith([geo('a', 'country', 'CA')], [geo('b', 'state', 'QC')])
    expect(removeGeoRow(d, 'a', 'include')).toEqual({ geoInclude: [] })
    expect(removeGeoRow(d, 'b', 'exclude')).toEqual({ geoExclude: [] })
  })
})

describe('moveGeoRow', () => {
  it('flips include -> exclude preserving id, type and value', () => {
    const d = dealWith([geo('a', 'state', 'QC')], [])
    expect(moveGeoRow(d, 'a', 'include', 'exclude')).toEqual({
      geoInclude: [],
      geoExclude: [geo('a', 'state', 'QC')],
    })
  })

  it('flips exclude -> include preserving the entry', () => {
    const d = dealWith([], [geo('a', 'country', 'US')])
    expect(moveGeoRow(d, 'a', 'exclude', 'include')).toEqual({
      geoExclude: [],
      geoInclude: [geo('a', 'country', 'US')],
    })
  })

  it('appends to the destination without disturbing what is already there', () => {
    const d = dealWith([geo('a', 'country', 'CA'), geo('b', 'state', 'QC')], [geo('c', 'state', 'ON')])
    expect(moveGeoRow(d, 'b', 'include', 'exclude')).toEqual({
      geoInclude: [geo('a', 'country', 'CA')],
      geoExclude: [geo('c', 'state', 'ON'), geo('b', 'state', 'QC')],
    })
  })

  it('is a no-op patch when the direction has not changed', () => {
    const d = dealWith([geo('a', 'country', 'CA')], [])
    expect(moveGeoRow(d, 'a', 'include', 'include')).toEqual({})
  })

  it('is a no-op patch for an unknown id rather than emptying an array', () => {
    const d = dealWith([geo('a', 'country', 'CA')], [])
    expect(moveGeoRow(d, 'nope', 'include', 'exclude')).toEqual({})
  })

  it('round-trips: flipping twice returns the original arrays', () => {
    const d = dealWith([geo('a', 'state', 'QC')], [])
    const once = { ...d, ...moveGeoRow(d, 'a', 'include', 'exclude') }
    const twice = { ...once, ...moveGeoRow(once, 'a', 'exclude', 'include') }
    expect(twice.geoInclude).toEqual(d.geoInclude)
    expect(twice.geoExclude).toEqual(d.geoExclude)
  })
})

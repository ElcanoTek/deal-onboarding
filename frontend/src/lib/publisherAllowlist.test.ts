// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { dedupeEntries, entriesFromRows, parsePublisherInput } from './publisherAllowlist'

describe('parsePublisherInput', () => {
  it('parses names, ids, and tab pairs per line', () => {
    const entries = parsePublisherInput([
      'Paramount - Springserve',
      '161578',
      '165045\tRoku - oRTB',
      'Vizio Inc.\t159942', // pair in either order
      '',
    ].join('\n'))
    expect(entries).toEqual([
      { name: 'Paramount - Springserve' },
      { id: '161578' },
      { id: '165045', name: 'Roku - oRTB' },
      { id: '159942', name: 'Vizio Inc.' },
    ])
  })

  it('never splits names on commas', () => {
    expect(parsePublisherInput('TStack, Inc.')).toEqual([{ name: 'TStack, Inc.' }])
  })

  it('splits a digits-only comma list into ids', () => {
    expect(parsePublisherInput('16356, 26144,17280')).toEqual([
      { id: '16356' }, { id: '26144' }, { id: '17280' },
    ])
  })
})

describe('entriesFromRows', () => {
  it('lifts id/name spreadsheet rows like a paste', () => {
    expect(entriesFromRows([
      ['Seller ID', 'Seller Name'], // header row (no numeric cell) is dropped
      [60315, 'Paramount'],
      [null, 'Tubi'],
      [61574, null],
    ])).toEqual([
      { id: '60315', name: 'Paramount' },
      { name: 'Tubi' },
      { id: '61574' },
    ])
  })
})

describe('dedupeEntries', () => {
  it('dedupes by id, then by lowercased name', () => {
    expect(dedupeEntries([
      { id: '60315', name: 'Paramount' },
      { id: '60315' },
      { name: 'Tubi' },
      { name: 'TUBI' },
      { name: '' },
    ])).toEqual([
      { id: '60315', name: 'Paramount' },
      { name: 'Tubi' },
    ])
  })
})

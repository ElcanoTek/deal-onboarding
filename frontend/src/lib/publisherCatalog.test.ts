// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import {
  buildCatalogLookup,
  resolveAgainstCatalog,
  suggestName,
  wrongCardHint,
  type PublisherCatalog,
} from './publisherCatalog'

const catalog: PublisherCatalog = {
  as_of: '2026-08-21',
  slices: {
    openx: [{ id: '557339752', name: 'GAM UNDESTO S.L. - CTA' }],
    pubmatic: [
      { id: '161578', name: 'Paramount - Springserve' },
      { id: '165045', name: 'Roku - oRTB' },
      { id: '159942', name: 'Vizio - SpringServe Prebid' },
    ],
    magnite_ctv: [{ id: '60315', name: 'Paramount' }],
    magnite_dvplus: [{ id: '16356', name: 'Applovin Pub' }, { id: '26144' }],
  },
}

describe('resolveAgainstCatalog', () => {
  const lookup = buildCatalogLookup(catalog, ['pubmatic'])

  it('auto-fills the id for a known name (case-insensitive)', () => {
    expect(resolveAgainstCatalog({ name: 'roku - ortb' }, lookup)).toEqual({
      entry: { id: '165045', name: 'roku - ortb' },
      known: true,
    })
  })

  it('recognizes a known id and keeps trader-supplied fields', () => {
    expect(resolveAgainstCatalog({ id: '161578', name: 'Paramount' }, lookup)).toEqual({
      entry: { id: '161578', name: 'Paramount' },
      known: true,
    })
  })

  it('flags unknown entries without touching them', () => {
    expect(resolveAgainstCatalog({ name: 'Paramont' }, lookup)).toEqual({
      entry: { name: 'Paramont' },
      known: false,
    })
    expect(resolveAgainstCatalog({ id: '99999' }, lookup)).toEqual({
      entry: { id: '99999' },
      known: false,
    })
  })

  it('keeps an id-less known name id-less (catalog row without id)', () => {
    const dv = buildCatalogLookup(catalog, ['magnite_dvplus'])
    expect(resolveAgainstCatalog({ name: 'Applovin Pub' }, dv).entry).toEqual({ id: '16356', name: 'Applovin Pub' })
  })
})

describe('suggestName', () => {
  const lookup = buildCatalogLookup(catalog, ['pubmatic', 'magnite_ctv'])

  it('finds a near-miss within edit distance 2', () => {
    expect(suggestName('Paramont', lookup)).toBe('Paramount')
    expect(suggestName('roku - ortb!', lookup)).toBe('Roku - oRTB')
  })

  it('matches a typo of a long name by prefix', () => {
    const pm = buildCatalogLookup(catalog, ['pubmatic'])
    // No plain "Paramount" in the PubMatic slice — prefix mode reaches the
    // long-form name.
    expect(suggestName('Paramont', pm)).toBe('Paramount - Springserve')
    expect(suggestName('Vizio', pm)).toBe('Vizio - SpringServe Prebid')
  })

  it('returns nothing for a genuinely different name', () => {
    expect(suggestName('Totally Different Publisher', lookup)).toBeUndefined()
  })
})

describe('wrongCardHint', () => {
  it('flags a full wrong-column paste', () => {
    expect(wrongCardHint(['161578', '165045', '159942'], catalog, ['openx']))
      .toBe('3 of the 3 unknown IDs match the PubMatic list — wrong SSP card?')
  })

  it('flags a single unknown id that belongs to the other Magnite catalog', () => {
    expect(wrongCardHint(['16356'], catalog, ['magnite_ctv']))
      .toBe('1 of the 1 unknown ID match the Magnite DV+ list — wrong SSP card?')
  })

  it('stays quiet on a lone coincidence among several unknowns', () => {
    expect(wrongCardHint(['161578', '111', '222', '333'], catalog, ['openx'])).toBeUndefined()
  })

  it('stays quiet with no unknown ids', () => {
    expect(wrongCardHint([], catalog, ['openx'])).toBeUndefined()
  })
})

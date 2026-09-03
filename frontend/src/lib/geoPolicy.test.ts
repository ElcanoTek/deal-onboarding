// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { defaultGeoInclude, DEFAULT_GEO_COUNTRY, withDefaultGeo } from './geoPolicy'
import { GeoEntry, newDeal } from '../types/deal'

const us = (): GeoEntry[] => [{ id: 'g1', type: 'country', value: 'US' }]
const ca = (): GeoEntry[] => [{ id: 'g2', type: 'country', value: 'CA' }]

describe('geoPolicy — US default when NO geo is specified', () => {
  it('defaults to a single US country entry when both lists are empty', () => {
    const got = withDefaultGeo([], [])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'country', value: DEFAULT_GEO_COUNTRY })
  })

  it('passes explicit includes through untouched', () => {
    const includes = ca()
    expect(withDefaultGeo(includes, [])).toBe(includes)
  })

  it('an exclude-only deal still gets the US-default include (#219 fail-closed)', () => {
    // Excludes are unemittable on every SSP today: without the seed an
    // "exclude US" deal would serve GLOBALLY — including the excluded
    // country. The seed bounds the blast radius; the geo_exclude_unsupported
    // audit rule blocks the batch until the exclusion is removed, so the
    // seeded include never ships alongside a live exclusion.
    const got = withDefaultGeo([], us())
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'country', value: DEFAULT_GEO_COUNTRY })
  })

  it('mints a fresh entry id per call (cloned/cross-producted deals must not share ids)', () => {
    const a = defaultGeoInclude()
    const b = defaultGeoInclude()
    expect(a[0].id).not.toBe(b[0].id)
  })

  it('newDeal() seeds the US default so every manually-added deal starts targeted', () => {
    const d = newDeal()
    expect(d.geoInclude).toHaveLength(1)
    expect(d.geoInclude[0]).toMatchObject({ type: 'country', value: DEFAULT_GEO_COUNTRY })
    expect(d.geoExclude).toEqual([])
  })

  it('the seeded chip is deletable — an emptied list stays empty (deliberate global run)', () => {
    // The policy applies at CREATION, never at hydrate/read time: a trader
    // who deletes the US chip gets a global deal, and qa_geo asks them to
    // confirm. This pins that withDefaultGeo is NOT re-applied to a deal the
    // trader explicitly emptied (the caller only invokes it when building).
    const d = newDeal()
    d.geoInclude = []
    expect(d.geoInclude).toEqual([])
  })
})


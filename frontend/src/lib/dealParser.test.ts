// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, it, expect } from 'vitest'
import { mergeParsedIntoForm } from './dealParser'
import { DEFAULT_FORM, newDeal } from '../types/deal'

// Ad-duration extraction: /api/parse-deal offers adDurations/maxAdDurationSecs
// in its per-deal schema; parseDeal must land them on the deal (same
// silent-loss class the brief import path fixed — a pasted brief's duration
// requirement must never vanish between the model and the form).
describe('ad-duration parsing', () => {
  it('lands adDurations and maxAdDurationSecs from the model onto the deal', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [
        { channel: 'CTV', ssp: 'Magnite', adDurations: ['15', ' 30 '], includeSegments: ['Sports Fans'] },
        { channel: 'CTV', ssp: 'OpenX', maxAdDurationSecs: '30', includeSegments: ['Sports Fans'] },
      ],
    })
    expect(form.deals[0].adDurations).toEqual(['15', '30'])
    expect(form.deals[0].maxAdDurationSecs).toBeUndefined()
    expect(form.deals[1].adDurations).toBeUndefined()
    expect(form.deals[1].maxAdDurationSecs).toBe('30')
  })

  it('leaves both fields unset when the model returns none (no empty arrays)', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [{ channel: 'CTV', ssp: 'Magnite', adDurations: [], includeSegments: ['Sports Fans'] }],
    })
    expect(form.deals[0].adDurations).toBeUndefined()
    expect(form.deals[0].maxAdDurationSecs).toBeUndefined()
  })

  // The model sometimes emits JSON numbers despite the [string] schema hint.
  // Dropping them would silently lose the brief's requirement (absence leaves
  // no QA trace), and a mixed ["15", 30] array would silently NARROW the
  // targeting to only 15s — coerce numbers to strings instead.
  it('coerces model-returned JSON numbers to strings (never a silent drop)', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [
        { channel: 'CTV', ssp: 'Magnite', adDurations: [15, 30], includeSegments: ['Sports Fans'] },
        { channel: 'CTV', ssp: 'OpenX', maxAdDurationSecs: 30, includeSegments: ['Sports Fans'] },
      ],
    })
    expect(form.deals[0].adDurations).toEqual(['15', '30'])
    expect(form.deals[1].maxAdDurationSecs).toBe('30')
  })

  it('keeps every entry of a mixed string/number array (never silently narrows)', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [{ channel: 'CTV', ssp: 'Magnite', adDurations: ['15', 30], includeSegments: ['Sports Fans'] }],
    })
    expect(form.deals[0].adDurations).toEqual(['15', '30'])
  })
})

describe('dayparting disclosure', () => {
  it('preserves parser-supplied dayparting notes and manual follow-up', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [{
        theme: 'Commuters', channel: 'Display', ssp: 'OpenX',
        notes: ['Weekdays 6–10am and 4–8pm local time'],
        postCreateUiFix: ['Dayparting NOT APPLIED at create — manually apply: Weekdays 6–10am and 4–8pm local time'],
      }],
    })
    expect(form.deals[0].notes).toEqual(['Weekdays 6–10am and 4–8pm local time'])
    expect(form.deals[0].postCreateUiFix?.[0]).toMatch(/Dayparting NOT APPLIED/)
  })
})

// IAB include/EXCLUDE extraction: /api/parse-deal offers per-deal
// iabCategories + iabCategoriesExclude (a brief's "Content > Genres" /
// "index exclude: …" lists route here, NOT into segments). parseDeal must
// land them on the deal with the same hygiene as includes.
describe('IAB include/exclude parsing', () => {
  it('lands iabCategoriesExclude verbatim (trimmed, empties dropped)', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [{ theme: 'Snacks', channel: 'Display', ssp: 'Index Exchange', iabCategoriesExclude: [' Hard News ', 'Kids content', ''] }],
    })
    expect(form.deals[0].iabCategoriesExclude).toEqual(['Hard News', 'Kids content'])
  })

  it('leaves iabCategoriesExclude unset when the model returns none or an empty array', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [
        { theme: 'A', channel: 'Display', ssp: 'Index Exchange' },
        { theme: 'B', channel: 'Display', ssp: 'Index Exchange', iabCategoriesExclude: [] },
      ],
    })
    expect(form.deals[0].iabCategoriesExclude).toBeUndefined()
    expect(form.deals[1].iabCategoriesExclude).toBeUndefined()
  })

  it('includes and excludes land independently on the same deal', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [{ theme: 'Genres', channel: 'Display', ssp: 'Index Exchange', iabCategories: ['Entertainment', 'Sports'], iabCategoriesExclude: ['Hard News'] }],
    })
    expect(form.deals[0].iabCategories).toEqual(['Entertainment', 'Sports'])
    expect(form.deals[0].iabCategoriesExclude).toEqual(['Hard News'])
  })

  // TOP-LEVEL iabCategoriesExclude safety net: the prompt steers the model to
  // per-deal placement, but a top-level list (mirroring the top-level
  // iabCategories key) must not be silently dropped — mergeParsedIntoForm fans
  // it out to every deal.
  it('a TOP-LEVEL iabCategoriesExclude fans out to every deal (trimmed, empties dropped)', () => {
    const { form, appliedFields } = mergeParsedIntoForm(DEFAULT_FORM, {
      iabCategoriesExclude: [' Hard News ', 'Kids content', ''],
      deals: [
        { theme: 'A', channel: 'Display', ssp: 'Index Exchange' },
        { theme: 'B', channel: 'OLV (Online Video)', ssp: 'PubMatic' },
      ],
    })
    expect(form.deals).toHaveLength(2)
    expect(form.deals[0].iabCategoriesExclude).toEqual(['Hard News', 'Kids content'])
    expect(form.deals[1].iabCategoriesExclude).toEqual(['Hard News', 'Kids content'])
    expect(appliedFields).toContain('deals')
  })

  it('top-level excludes UNION with each deal\'s own list — own order first, campaign-wide appended, no dupes (case-insensitive)', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      iabCategoriesExclude: ['hard news', 'Gambling'],
      deals: [
        { theme: 'A', channel: 'Display', ssp: 'Index Exchange', iabCategoriesExclude: ['Kids content', 'Hard News'] },
        { theme: 'B', channel: 'Display', ssp: 'Index Exchange' },
      ],
    })
    // Deal 0 already carries "Hard News" — the lowercase campaign-wide copy is
    // a dupe (deal's own casing wins); only "Gambling" appends.
    expect(form.deals[0].iabCategoriesExclude).toEqual(['Kids content', 'Hard News', 'Gambling'])
    expect(form.deals[1].iabCategoriesExclude).toEqual(['hard news', 'Gambling'])
  })

  it('a top-level exclude with NO parsed deals lands on the existing deals and marks deals applied', () => {
    const current = { ...DEFAULT_FORM, deals: [{ ...newDeal(), theme: 'Snacks', channel: 'Display' as const, ssp: 'Index Exchange' as const }] }
    const { form, appliedFields } = mergeParsedIntoForm(current, {
      iabCategoriesExclude: ['Hard News'],
    })
    expect(form.deals[0].iabCategoriesExclude).toEqual(['Hard News'])
    expect(appliedFields).toContain('deals')
  })
})

describe('geo policy through the parser (US default)', () => {
  it('brief campaign-level geo folds onto geo-less deals — never replaced by the US seed', () => {
    // parse.go maps a shared "Geo: CA, Alberta" header to defaultGeoInclude
    // with per-deal geo empty; the fold must distribute it, and the US
    // default must NOT fire (regression: a pre-fold seed once blocked this,
    // silently mistargeting the brief's Canada deals to the US).
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      defaultGeoInclude: [{ type: 'country', value: 'CA' }],
      deals: [{ theme: 'Winter', channel: 'Display', ssp: 'Index Exchange' }],
    })
    expect(form.deals).toHaveLength(1)
    expect(form.deals[0].geoInclude.map(g => g.value)).toEqual(['CA'])
    expect(form.defaultGeoInclude).toEqual([])
  })

  it('an exclude-only brief gains the US-default include AND keeps the exclusion (#219 fail-closed)', () => {
    // Excludes are unemittable on every SSP today: without the seed an
    // "exclude US" brief would serve GLOBALLY including the excluded country.
    // The seed bounds the blast radius, the exclusion is preserved so the
    // trader sees the brief's intent, and the geo_exclude_unsupported audit
    // rule blocks the batch until the exclusion is removed.
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      defaultGeoExclude: [{ type: 'country', value: 'US' }],
      deals: [{ theme: 'Global run', channel: 'Display', ssp: 'Index Exchange' }],
    })
    expect(form.deals[0].geoInclude).toHaveLength(1)
    expect(form.deals[0].geoInclude[0]).toMatchObject({ type: 'country', value: 'US' })
    expect(form.deals[0].geoExclude.map(g => g.value)).toEqual(['US'])
  })

  it('a brief with NO geo anywhere seeds the US default per parsed deal', () => {
    const { form } = mergeParsedIntoForm(DEFAULT_FORM, {
      deals: [{ theme: 'A', channel: 'Display', ssp: 'Index Exchange' }, { theme: 'B', channel: 'CTV', ssp: 'Magnite' }],
    })
    for (const d of form.deals) {
      expect(d.geoInclude).toHaveLength(1)
      expect(d.geoInclude[0]).toMatchObject({ type: 'country', value: 'US' })
    }
    // Fresh ids per deal — cross-producted deals must not share geo entries.
    expect(form.deals[0].geoInclude[0].id).not.toBe(form.deals[1].geoInclude[0].id)
  })

})

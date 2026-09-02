// Pins the Magnite DV+ ad-format catalog fixture (live-pulled 2026-08-21 via
// magnite_list_ad_formats) and the derived picker constants. The picker must
// offer the FULL catalog — the pre-fix curated 13-size display subset made
// 465 of the 478 live display sizes unbookable through the form.

import { describe, expect, it } from 'vitest'
import {
  MAGNITE_AD_FORMAT_CATALOG,
  MAGNITE_DISPLAY_FORMAT_OPTIONS,
  MAGNITE_NATIVE_FORMAT_OPTIONS,
  MAGNITE_SIZES_MAX,
  MAGNITE_VIDEO_FORMAT_OPTIONS,
  magniteFormatLabel,
} from './magniteAdFormats'
import {
  MAGNITE_DISPLAY_SIZES,
  MAGNITE_FORMATS_BY_KIND,
  MAGNITE_NATIVE_FORMATS,
  MAGNITE_POPULAR_SIZE_IDS,
  MAGNITE_VIDEO_FORMATS,
} from '../types/deal'

describe('magnite ad-format catalog fixture', () => {
  it('carries the full live catalog per family (2026-08-21 pull)', () => {
    const byFamily = (f: string) => MAGNITE_AD_FORMAT_CATALOG.filter(r => r.format === f).length
    expect(byFamily('Display')).toBe(478)
    expect(byFamily('Video')).toBe(10)
    expect(byFamily('Native')).toBe(25)
    expect(byFamily('Audio')).toBe(5) // reference only — Audio deals use feedTypes, never sizes
    expect(MAGNITE_AD_FORMAT_CATALOG.length).toBe(518)
  })

  it('has no duplicate format ids', () => {
    const ids = MAGNITE_AD_FORMAT_CATALOG.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('picker labels are unique — dimensions disambiguate same-named formats', () => {
    // The raw catalog reuses names (several "Custom Horizontal" rows differing
    // only by size); a label collision would make two picker rows
    // indistinguishable and the Deal QA readback ambiguous.
    for (const options of [MAGNITE_DISPLAY_FORMAT_OPTIONS, MAGNITE_VIDEO_FORMAT_OPTIONS, MAGNITE_NATIVE_FORMAT_OPTIONS]) {
      const labels = options.map(o => o.label)
      const dupes = labels.filter((l, i) => labels.indexOf(l) !== i)
      expect(dupes, `duplicate labels: ${[...new Set(dupes)].join(', ')}`).toEqual([])
    }
  })

  it('labels carry dimensions when the format has them', () => {
    const banner = MAGNITE_AD_FORMAT_CATALOG.find(f => f.id === 1)!
    expect(magniteFormatLabel(banner)).toBe('Banner — 468×60')
  })
})

describe('derived picker constants (types/deal.ts)', () => {
  it('display picker offers the FULL catalog, not the curated subset', () => {
    expect(MAGNITE_DISPLAY_SIZES.length).toBe(478)
    expect(MAGNITE_FORMATS_BY_KIND.display).toBe(MAGNITE_DISPLAY_SIZES)
  })

  it('every "most popular" quick-select id exists in the live display catalog', () => {
    const displayIds = new Set(MAGNITE_DISPLAY_SIZES.map(s => s.id))
    for (const id of MAGNITE_POPULAR_SIZE_IDS) {
      expect(displayIds.has(id), `popular id ${id} missing from live display catalog`).toBe(true)
    }
    // The curated set must stay within one deal's size budget.
    expect(MAGNITE_POPULAR_SIZE_IDS.length).toBeLessThanOrEqual(MAGNITE_SIZES_MAX)
  })

  it('video and native lists match the live catalog exactly (previously hand-maintained)', () => {
    expect(new Set(MAGNITE_VIDEO_FORMATS.map(f => f.id))).toEqual(
      new Set([201, 202, 203, 204, 205, 207, 273, 275, 277, 656]),
    )
    expect(MAGNITE_NATIVE_FORMATS.length).toBe(25)
    const nativeIds = new Set(MAGNITE_NATIVE_FORMATS.map(f => f.id))
    for (const id of [600, 601, 602, 603, 604, 605, 606, 607, 608, 609, 610, 611, 161, 162, 163, 164, 165, 166, 167, 617, 618, 619, 620, 624, 657]) {
      expect(nativeIds.has(id), `native id ${id} missing`).toBe(true)
    }
  })

  it('Magnite create cap is 15 sizes per deal', () => {
    expect(MAGNITE_SIZES_MAX).toBe(15)
  })
})

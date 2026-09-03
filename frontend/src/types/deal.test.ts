// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { CHANNEL_OPTIONS, dealNameLengthError, dealSupportsAdDuration, isVideoChannel } from './deal'

describe('dealSupportsAdDuration', () => {
  // Brief-schema ad_duration (cutlass deal-brief.schema.yaml v1.1) is valid
  // ONLY on CTV / OLV / OTT — Audio is a video channel for KPI purposes but
  // has no ad-duration targeting, and Display/Native never had one.
  it('is true for exactly CTV / OLV / OTT', () => {
    const supported = CHANNEL_OPTIONS.filter(dealSupportsAdDuration)
    expect(supported).toEqual(['OLV (Online Video)', 'CTV', 'OTT'])
  })

  it('excludes Audio even though it is a video channel', () => {
    expect(isVideoChannel('Audio')).toBe(true)
    expect(dealSupportsAdDuration('Audio')).toBe(false)
  })

  // The short 'OLV' label (deal-name slot form AND the cutlass brief-schema
  // canonical channel enum value) must count, mirroring Go isVideoChannel /
  // supportsAdDuration (internal/validation/rules.go). When the mirrors
  // diverged, a parsed short-form 'OLV' deal got a GREEN Go qa_ad_duration
  // PASS while every TS emission gate silently dropped its ad durations.
  it('accepts the short OLV label, in lockstep with the Go gate', () => {
    expect(isVideoChannel('OLV')).toBe(true)
    expect(dealSupportsAdDuration('OLV')).toBe(true)
    expect(dealSupportsAdDuration('OLV (Online Video)')).toBe(true)
  })

  it('is false for blank / unknown channels', () => {
    expect(dealSupportsAdDuration('')).toBe(false)
    expect(dealSupportsAdDuration('Display')).toBe(false)
    expect(dealSupportsAdDuration('ctv')).toBe(false) // exact channel names only
  })
})

// Live deal-name length ceilings — mirrored from the Go deal_name_length rule
// (internal/validation/rules.go). These power the as-you-type finding on the
// Deal name field; the backend audit re-confirms server-side on the same
// deals[N].nameOverride anchor. If the mirrors diverge, a trader either sees
// a phantom error the audit won't confirm or types past a ceiling silently
// until the debounced re-audit lands.
describe('dealNameLengthError', () => {
  it('flags vendor ceilings: IX/Xandr/Media.net past 255, PubMatic past 250', () => {
    const long = 'x'.repeat(256)
    expect(dealNameLengthError('Index Exchange', 'Display', long, false)).toContain('rejects names longer than 255')
    expect(dealNameLengthError('Xandr', 'Display', long, false)).toContain('rejects names longer than 255')
    expect(dealNameLengthError('Media.net', 'Display', long, false)).toContain('rejects names longer than 255')
    expect(dealNameLengthError('PubMatic', 'Display', 'x'.repeat(251), false)).toContain('rejects names longer than 250')
  })

  it('flags the TripleLift 150 UI hard-cap (trader-verified 2026-08-12)', () => {
    expect(dealNameLengthError('TripleLift', 'Display', 'x'.repeat(151), false)).toContain('150')
    expect(dealNameLengthError('TripleLift', 'Display', 'x'.repeat(150), false)).toBeUndefined()
  })

  it('splits Magnite by marketplace: Streaming 250, DV+ 200 (trader-verified 2026-08-12)', () => {
    const n201 = 'x'.repeat(201)
    // DV+ channels cap at 200
    expect(dealNameLengthError('Magnite', 'Display', n201, false)).toContain('Magnite DV+')
    expect(dealNameLengthError('Magnite', 'OLV (Online Video)', n201, false)).toContain('200')
    // unset channel takes the stricter DV+ cap (fail-closed)
    expect(dealNameLengthError('Magnite', '', n201, false)).toContain('200')
    // Streaming channels allow up to 250
    expect(dealNameLengthError('Magnite', 'CTV', n201, false)).toBeUndefined()
    expect(dealNameLengthError('Magnite', 'Audio', n201, false)).toBeUndefined()
    expect(dealNameLengthError('Magnite', 'CTV', 'x'.repeat(251), false)).toContain('Magnite Streaming')
  })

  it('flags the app policy ceiling on OpenX (no published limit)', () => {
    const msg = dealNameLengthError('OpenX', 'Display', 'x'.repeat(256), false)
    expect(msg).toContain('capped at 255')
    expect(msg).toContain('app policy')
  })

  it('is silent at the ceiling and when no SSP is chosen yet', () => {
    expect(dealNameLengthError('Index Exchange', 'Display', 'x'.repeat(255), false)).toBeUndefined()
    expect(dealNameLengthError('PubMatic', 'Display', 'x'.repeat(250), false)).toBeUndefined()
    expect(dealNameLengthError('OpenX', 'Display', 'x'.repeat(255), false)).toBeUndefined()
    expect(dealNameLengthError('Magnite', 'Display', 'x'.repeat(200), false)).toBeUndefined()
    expect(dealNameLengthError('', 'Display', 'x'.repeat(999), false)).toBeUndefined()
  })

  it('points at the lever the trader actually has', () => {
    const long = 'x'.repeat(300)
    expect(dealNameLengthError('Index Exchange', 'Display', long, true)).toContain('name override')
    expect(dealNameLengthError('Index Exchange', 'Display', long, false)).toContain('theme/agency/brand')
  })
})

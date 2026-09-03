// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { DealEntry, DEFAULT_FORM, FormData, newDeal } from '../types/deal'
import { fnv1a32Hex, medianetDealId } from './dealNameSlots'

// The workbook-derived golden cases live in deal_naming_golden.test.ts (shared
// fixture with the Go suite). These are the targeted unit tests for the
// the override passthrough.


function form(extra: Partial<FormData>): FormData {
  return { ...DEFAULT_FORM, ...extra }
}





describe('fnv1a32Hex', () => {
  it('is deterministic and 8 lowercase hex chars', () => {
    const a = fnv1a32Hex('Curator_Media.net_TTD_Ideon_Acme_NA_Theme_Display_All_US_DEAL00001_A1')
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1a32Hex('Curator_Media.net_TTD_Ideon_Acme_NA_Theme_Display_All_US_DEAL00001_A1')).toBe(a)
  })
  it('differs for different inputs', () => {
    expect(fnv1a32Hex('a')).not.toBe(fnv1a32Hex('b'))
  })
})

describe('medianetDealId', () => {
  function mnForm(extra: Partial<FormData> = {}): FormData {
    return form({
      agency: 'Ideon',
      brand: 'Acme',
      campaignId: 'DEAL00500',
      attributionCode: 'B14',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '111' }],
      deals: [],
      ...extra,
    })
  }
  const mnDeal = (extra: Partial<DealEntry> = {}): DealEntry =>
    ({ ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Pets', ...extra })

  it('stays within 30 chars and the Media.net charset', () => {
    const f = mnForm()
    const id = medianetDealId(f, mnDeal())
    expect(id.length).toBeLessThanOrEqual(30)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('REGRESSION: Web vs In-App deals with the same theme get DISTINCT ids', () => {
    // The pre-2026-07 seed stopped at channel: two MN Display deals differing
    // only by inventory collided on the identical deal_id.
    const f = mnForm()
    const web = medianetDealId(f, mnDeal({ inventoryType: 'Web Only' }))
    const app = medianetDealId(f, mnDeal({ inventoryType: 'In-App' }))
    expect(web).not.toBe(app)
  })

  it('deals differing only by COUNTRY geo get distinct ids', () => {
    const f = mnForm()
    const us = medianetDealId(f, mnDeal({ geoInclude: [{ id: 'g1', type: 'country', value: 'US' }] }))
    const gb = medianetDealId(f, mnDeal({ geoInclude: [{ id: 'g1', type: 'country', value: 'GB' }] }))
    expect(us).not.toBe(gb)
  })

  it('deals differing only by STATE geo share one id — Media.net has no state wire (#233.8)', () => {
    // FAILS OLD: states never reach the Media.net deal (countries-only wire),
    // so a state must not differentiate the deal_id/name Geo slot either —
    // the old state-differentiated ids masked two IDENTICAL live deals.
    const f = mnForm()
    const ca = medianetDealId(f, mnDeal({ geoInclude: [{ id: 'g1', type: 'state', value: 'CA' }] }))
    const ny = medianetDealId(f, mnDeal({ geoInclude: [{ id: 'g1', type: 'state', value: 'NY' }] }))
    expect(ca).toBe(ny)
  })

  it('over-30-char seeds keep the head and append an 8-hex digest of the full name', () => {
    const f = mnForm({ dataPartner: 'An Extremely Long Data Partner Name Indeed' })
    const id = medianetDealId(f, mnDeal())
    expect(id).toHaveLength(30)
    expect(id).toMatch(/_[0-9a-f]{8}$/)
  })

  it('over-30-char multi-DSP ids keep the LEADING DSP token distinct per DSP', () => {
    const f = mnForm({
      multipleDsps: true,
      dataPartner: 'An Extremely Long Data Partner Name Indeed',
      dsps: [
        { id: '1', dsp: 'The Trade Desk', seatId: '111' },
        { id: '2', dsp: 'DV360', seatId: '222' },
      ],
    })
    const ttd = medianetDealId(f, mnDeal(), { dsp: f.dsps[0] })
    const dv = medianetDealId(f, mnDeal(), { dsp: f.dsps[1] })
    expect(ttd).not.toBe(dv)
    expect(ttd.startsWith('TTD')).toBe(true)
    expect(dv.startsWith('DV360')).toBe(true)
  })

  it('is deterministic', () => {
    const f = mnForm()
    expect(medianetDealId(f, mnDeal())).toBe(medianetDealId(f, mnDeal()))
  })
})

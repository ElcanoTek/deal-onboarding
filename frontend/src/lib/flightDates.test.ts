// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import {
  END_DATE_HORIZON_YEARS,
  computeAutoEndDate,
} from './flightDates'

describe('computeAutoEndDate', () => {
  it('returns empty for empty input', () => {
    expect(computeAutoEndDate('')).toBe('')
    expect(computeAutoEndDate('   ')).toBe('')
  })

  it('returns empty for malformed input', () => {
    expect(computeAutoEndDate('not-a-date')).toBe('')
    expect(computeAutoEndDate('2026-05')).toBe('')
    expect(computeAutoEndDate('2026/05/22')).toBe('')
  })

  it('adds 2 years to a standard ISO date', () => {
    expect(computeAutoEndDate('2026-05-22')).toBe('2028-05-22')
    expect(computeAutoEndDate('2026-12-31')).toBe('2028-12-31')
    expect(computeAutoEndDate('2026-01-01')).toBe('2028-01-01')
  })

  it('honors a custom horizon', () => {
    expect(computeAutoEndDate('2026-05-22', 5)).toBe('2031-05-22')
    expect(computeAutoEndDate('2026-05-22', 0)).toBe('2026-05-22')
  })

  it('clamps Feb 29 to Feb 28 when the target year is not a leap year', () => {
    // 2024 was a leap year, 2026 is not — Feb 29 + 2y should become Feb 28
    expect(computeAutoEndDate('2024-02-29')).toBe('2026-02-28')
  })

  it('preserves Feb 29 when target year IS a leap year', () => {
    // 2024 + 4y = 2028, also a leap year
    expect(computeAutoEndDate('2024-02-29', 4)).toBe('2028-02-29')
  })

  it('uses the documented horizon constant', () => {
    expect(END_DATE_HORIZON_YEARS).toBe(2)
  })
})



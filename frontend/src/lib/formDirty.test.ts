import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, newDeal } from '../types/deal'
import { formOverwriteLabel, formWorthSaving } from './formDirty'

// Guards the parse-replace overwrite warning and the restored-draft notice:
// a blank form must pass through silently, real work must trip the guard.
describe('formWorthSaving', () => {
  it('is false for the default (blank) form', () => {
    expect(formWorthSaving({ ...DEFAULT_FORM })).toBe(false)
  })

  it('is false when the only deal is still untouched', () => {
    expect(formWorthSaving({ ...DEFAULT_FORM, deals: [newDeal()] })).toBe(false)
  })

  it.each([
    ['brand', { brand: 'Acme' }],
    ['agency', { agency: 'Northwind' }],
    ['campaignName', { campaignName: 'Spring' }],
    ['campaignId', { campaignId: 'DEAL00001' }],
  ] as const)('is true once %s is filled', (_field, patch) => {
    expect(formWorthSaving({ ...DEFAULT_FORM, ...patch })).toBe(true)
  })

  it('is true once a deal has a theme or channel', () => {
    expect(formWorthSaving({ ...DEFAULT_FORM, deals: [{ ...newDeal(), theme: 'Parenting' }] })).toBe(true)
    expect(formWorthSaving({ ...DEFAULT_FORM, deals: [{ ...newDeal(), channel: 'CTV' }] })).toBe(true)
  })

  it('ignores whitespace-only values', () => {
    expect(formWorthSaving({ ...DEFAULT_FORM, brand: '  ', campaignId: ' ' })).toBe(false)
  })
})

describe('formOverwriteLabel', () => {
  it('names the campaign and brand when present', () => {
    expect(formOverwriteLabel({ ...DEFAULT_FORM, campaignId: 'DEAL07290', brand: 'Uncommon Schools' }))
      .toBe('DEAL07290 — Uncommon Schools')
  })

  it('falls back to campaignName, then a generic label', () => {
    expect(formOverwriteLabel({ ...DEFAULT_FORM, campaignName: 'Back to School' })).toBe('Back to School')
    expect(formOverwriteLabel({ ...DEFAULT_FORM })).toBe('an unsaved build')
  })
})

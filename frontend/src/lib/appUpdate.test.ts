import { describe, expect, it } from 'vitest'
import { isNewVersion, parseVersionPayload } from './appUpdate'

describe('isNewVersion', () => {
  it('flags a changed hash', () => {
    expect(isNewVersion('abc123def456', 'fed654cba321')).toBe(true)
  })
  it('ignores unchanged, missing, and dev-sentinel versions', () => {
    expect(isNewVersion('abc123def456', 'abc123def456')).toBe(false)
    expect(isNewVersion(null, 'abc123def456')).toBe(false)
    expect(isNewVersion('abc123def456', null)).toBe(false)
    // 'dev' = no built frontend (local dev / API-only) — never an update.
    expect(isNewVersion('dev', 'abc123def456')).toBe(false)
    expect(isNewVersion('abc123def456', 'dev')).toBe(false)
  })
})

describe('parseVersionPayload', () => {
  it('extracts a non-empty string version', () => {
    expect(parseVersionPayload({ version: 'abc123def456' })).toBe('abc123def456')
  })
  it('rejects malformed payloads', () => {
    expect(parseVersionPayload(null)).toBeNull()
    expect(parseVersionPayload('abc')).toBeNull()
    expect(parseVersionPayload({})).toBeNull()
    expect(parseVersionPayload({ version: '' })).toBeNull()
    expect(parseVersionPayload({ version: 7 })).toBeNull()
  })
})

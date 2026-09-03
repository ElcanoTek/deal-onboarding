// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { fileBasename, RESERVED_ATTACHMENT_NAMES, uniqueLogicalName } from './files'

describe('fileBasename', () => {
  it('strips client-side path prefixes', () => {
    expect(fileBasename('C:\\Users\\t\\domains.csv')).toBe('domains.csv')
    expect(fileBasename('/tmp/lists/domains.csv')).toBe('domains.csv')
    expect(fileBasename('domains.csv')).toBe('domains.csv')
  })
})

describe('uniqueLogicalName (#282.2)', () => {
  it('passes non-colliding names through verbatim', () => {
    expect(uniqueLogicalName('domains.csv', [])).toBe('domains.csv')
    expect(uniqueLogicalName('domains.csv', ['other.csv'])).toBe('domains.csv')
  })

  it('renames a collision deterministically with a -2 suffix before the extension', () => {
    expect(uniqueLogicalName('domains.csv', ['domains.csv'])).toBe('domains-2.csv')
  })

  it('increments the suffix until the name is free', () => {
    expect(uniqueLogicalName('domains.csv', ['domains.csv', 'domains-2.csv'])).toBe('domains-3.csv')
  })

  it('reserves deal_brief.json — the server uploads the structured brief under it', () => {
    expect(RESERVED_ATTACHMENT_NAMES).toContain('deal_brief.json')
    expect(uniqueLogicalName('deal_brief.json', [])).toBe('deal_brief-2.json')
  })

  it('handles extensionless and dotfile names', () => {
    expect(uniqueLogicalName('README', ['README'])).toBe('README-2')
    expect(uniqueLogicalName('.env', ['.env'])).toBe('.env-2')
  })
})

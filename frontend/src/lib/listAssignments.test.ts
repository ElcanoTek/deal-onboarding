// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { DealEntry, DEFAULT_FORM, FormData, newDeal, UploadedFile } from '../types/deal'
import { dealListAssignments, listChannelRouting } from './dealPromptYaml'

// The deal card's Domains & app bundles row renders EXACTLY what these
// return — the assignment must always match what the prompt builders emit
// (both derive from the same resolve() pipeline).

const siteList: UploadedFile = { id: 'f-sites', name: 'GenZ_Sites.csv', size: 10, path: '/x', inclusionType: 'Include' }
const bundleList: UploadedFile = { id: 'f-apps', name: 'CTV_Bundles.csv', size: 10, path: '/z', inclusionType: 'Include' }

const form = (over: Partial<FormData>): FormData => ({ ...DEFAULT_FORM, ...over })
const deal = (over: Partial<DealEntry>): DealEntry => ({ ...newDeal(), ssp: 'Index Exchange', channel: 'Display', ...over })

describe('listChannelRouting', () => {
  it('routes web channels to the domain pool and app channels to the bundle pool', () => {
    expect(listChannelRouting(form({}), deal({ channel: 'Display' }))).toEqual({ web: true, app: false })
    expect(listChannelRouting(form({}), deal({ channel: 'CTV' }))).toEqual({ web: false, app: true })
    expect(listChannelRouting(form({}), deal({ channel: 'OLV (Online Video)', inventoryType: 'In-App' }))).toEqual({ web: false, app: true })
    expect(listChannelRouting(form({}), deal({ channel: '' }))).toEqual({ web: false, app: false })
  })
})

describe('dealListAssignments', () => {
  it('a Display deal inherits the campaign upload on the domain dimension only', () => {
    const f = form({ domainLists: [siteList] })
    const a = dealListAssignments(f, deal({}), [])
    expect(a.domain.ships).toBe(true)
    expect(a.domain.file).toMatchObject({ id: 'f-sites', op: 'allowlist', source: 'upload' })
    expect(a.domain.explicit).toBe(false)
    expect(a.app_bundle.ships).toBe(false)
  })

  it('OpenX ships BOTH dimensions', () => {
    const f = form({ domainLists: [siteList], appBundleLists: [bundleList] })
    const a = dealListAssignments(f, deal({ ssp: 'OpenX', channel: 'OLV (Online Video)' }), [])
    expect(a.domain.ships).toBe(true)
    expect(a.app_bundle.ships).toBe(true)
    expect(a.app_bundle.file?.id).toBe('f-apps')
  })


  it('an explicit wrong-kind pick resolves its file but does not ship (warning state)', () => {
    const f = form({ appBundleLists: [bundleList] })
    const a = dealListAssignments(f, deal({ channel: 'Display', appBundleListId: 'f-apps' }), [])
    expect(a.app_bundle.ships).toBe(false)
    expect(a.app_bundle.file?.id).toBe('f-apps')
  })

  it('opting out ("" override) names the campaign list it opted out of', () => {
    const f = form({ domainLists: [siteList] })
    const a = dealListAssignments(f, deal({ domainListId: '' }), [])
    expect(a.domain.file).toBeNull()
    expect(a.domain.optedOutOf).toBe('GenZ_Sites.csv')
  })

  it('per-deal allow/block override is reflected in op without mutating the shared file', () => {
    const f = form({ domainLists: [siteList] })
    const a = dealListAssignments(f, deal({ domainListInclusion: 'Exclude' }), [])
    expect(a.domain.file?.op).toBe('blocklist')
    expect(siteList.inclusionType).toBe('Include')
  })

  it('Xandr carries the not_applied disclosure', () => {
    const f = form({ domainLists: [siteList] })
    const a = dealListAssignments(f, deal({ ssp: 'Xandr' }), [])
    expect(a.domain.disclosure).toBe('not_applied')
  })
})

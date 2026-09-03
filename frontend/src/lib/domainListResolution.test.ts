// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, FormData, newDeal, UploadedFile } from '../types/deal'
import { buildBatchPrompt } from './dealPromptYaml'

// Pins the per-deal domain-list resolution contract, born from the DEAL07253
// E2E run (2026-07-20): an ad-hoc Exclude domain list uploaded in the Files
// section reached the runner task as an attachment while NEITHER IX deal's
// prompt_inputs referenced it — the agent (correctly) refused to apply an
// unreferenced file and both deals would have created unscoped. The silent
// gap was a stale per-deal pick: the prompt resolver deliberately treats an
// unknown domainListId as "no list" (never a surprise fallback), while the
// submit ships every uploaded file. That resolver behavior is pinned here as
// intended; the guards are elsewhere — FileUploads.removeFile now clears
// deal picks pointing at a removed file, and the Go audit fails closed on
// what remains (list_ref: stale pick; list_applied: pool nothing carries),
// which also gates /api/runner/create via the #152 server-side re-audit.

const blockFile: UploadedFile = {
  id: 'up-longtail',
  name: 'long_tail_block_list (2) (1).csv',
  size: 12345,
  path: '/opt/deal-onboarding/data/uploads/long_tail_block_list_2__1__5b40f67e.csv',
  inclusionType: 'Exclude',
}

function e2eForm(): FormData {
  return {
    ...DEFAULT_FORM,
    submitterName: 'Elyse',
    submitterEmail: 'elyse@example.com',
    agency: 'Northwind',
    brand: 'ExampleE2E',
    campaignId: 'DEAL07253',
    flightStartDate: '2026-08-03',
    flightEndDate: '2026-08-14',
    defaultDisplayCpm: '0.10',
    defaultVideoCpm: '0.10',
    curatedDealFee: '10',
    feeType: 'Percentage of Media',
    dsps: [{ id: '1', dsp: 'BidSwitch', seatId: '393' }],
    domainLists: [blockFile],
    deals: [
      { ...newDeal(), id: 'd1', theme: 'Outdoor Enthusiasts', channel: 'Display', ssp: 'Index Exchange', inventoryType: 'All', domainListId: 'up-longtail' },
      { ...newDeal(), id: 'd2', theme: 'Outdoor Enthusiasts', channel: 'OLV (Online Video)', ssp: 'Index Exchange', inventoryType: 'All', domainListId: 'up-longtail' },
    ],
  }
}

describe('domain-list resolution — ad-hoc Exclude upload on IX web deals', () => {
  it('emits domain_file_path + blocklist operator on both deals for explicit per-deal picks', () => {
    const out = buildBatchPrompt(e2eForm())
    expect(out.match(/domain_file_path:/g)?.length).toBe(2)
    expect(out.match(/domain_match_operator: blocklist/g)?.length).toBe(2)
  })

  it('emits the file via the campaign default when per-deal picks are unset', () => {
    const f = e2eForm()
    f.deals = f.deals.map(d => ({ ...d, domainListId: undefined }))
    const out = buildBatchPrompt(f)
    expect(out.match(/domain_file_path:/g)?.length).toBe(2)
  })

  it('a stale per-deal pick resolves to NO list by design (guarded by the Go audit list_ref/list_applied rules)', () => {
    const f = e2eForm()
    f.deals = f.deals.map(d => ({ ...d, domainListId: 'up-OLD-DELETED' }))
    const out = buildBatchPrompt(f)
    // Never a surprise fallback to a different list — and never a silent
    // submit either: the audit fails list_ref + list_applied on this form.
    expect(out).not.toMatch(/domain_file_path:/)
  })
})

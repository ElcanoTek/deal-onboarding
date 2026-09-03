// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
import { DealEntry, DEFAULT_FORM, FormData, newDeal } from '../types/deal'
import { buildBatchBrief, serializeBrief, validateBrief } from './dealBrief'


// Full PubMatic deal names shaped like a failed live batch — intentionally
// long, with spaces, to prove they survive transport intact.
const PM_USERS = 'Partner_Pubmatic_Yahoo_Soundwave_SNAP_NA_SNAP users_Display_All_US_DEAL07238_B14'
const PM_PROXY = 'Partner_Pubmatic_Yahoo_Soundwave_SNAP_NA_SNAP proxy users_Display_All_US_DEAL07238_B14'
const OX_USERS = 'Partner_OpenX_Yahoo_Soundwave_SNAP_NA_SNAP users_Display_All_US_DEAL07238_B14'
const OX_PROXY = 'Partner_OpenX_Yahoo_Soundwave_SNAP_NA_SNAP proxy users_Display_All_US_DEAL07238_B14'

function failedBatchForm(): FormData {
  const mk = (over: Partial<DealEntry>): DealEntry => ({ ...newDeal(), channel: 'Display', ...over })
  return {
    ...DEFAULT_FORM,
    submitterName: 'T',
    submitterEmail: 't@example.com',
    flightStartDate: '2027-01-01',
    flightEndDate: '2028-12-31',
    agency: 'Soundwave',
    brand: 'SNAP',
    campaignId: 'DEAL07238',
    dealSheetRecipient: 'elyse@example.com',
    curatedDealFee: '30',
    defaultDisplayCpm: '',
    defaultVideoCpm: '',
    dsps: [{ id: '1', dsp: 'Yahoo', seatId: '6615' }],
    magniteConfig: { marketplace: 'Example Marketplace', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' },
    deals: [
      mk({ ssp: 'PubMatic', theme: 'SNAP users', nameOverride: PM_USERS }),
      mk({ ssp: 'PubMatic', theme: 'SNAP proxy users', nameOverride: PM_PROXY }),
      mk({ ssp: 'Magnite', theme: 'SNAP users', nameOverride: 'Partner_MG_users', magniteSizes: ['1', '2', '8', '9', '10', '67', '100', '117'] }),
      mk({ ssp: 'Magnite', theme: 'SNAP proxy users', nameOverride: 'Partner_MG_proxy', magniteSizes: ['1', '2', '8', '9', '10', '67', '100', '117'] }),
      // Two OpenX rows already live — sheet-only, MUST NOT create.
      mk({ ssp: 'OpenX', theme: 'SNAP users', nameOverride: OX_USERS, sheetOnly: true }),
      mk({ ssp: 'OpenX', theme: 'SNAP proxy users', nameOverride: OX_PROXY, sheetOnly: true }),
    ],
  }
}

describe('dealBrief — structured file-backed transport', () => {
  it('separates sheet-only OpenX rows from create rows', () => {
    const brief = buildBatchBrief(failedBatchForm())
    expect(brief.deals.map(d => d.ssp).sort()).toEqual(['Magnite', 'Magnite', 'PubMatic', 'PubMatic'])
    // OpenX rows are sheet-only, never create rows.
    expect(brief.deals.some(d => d.ssp === 'OpenX')).toBe(false)
    expect(brief.already_created_for_sheet.map(r => r.deal_name).sort()).toEqual([OX_PROXY, OX_USERS])
    expect(brief.already_created_for_sheet.every(r => r.status === 'already_created')).toBe(true)
  })

  it('sheet-only rows carry NO tool routing', () => {
    const brief = buildBatchBrief(failedBatchForm())
    for (const row of brief.already_created_for_sheet) {
      expect('tool' in row).toBe(false)
    }
  })

  it('every create row carries exact mcp_ tool routing for its SSP', () => {
    const brief = buildBatchBrief(failedBatchForm())
    for (const d of brief.deals) {
      expect(d.tool.startsWith('mcp_')).toBe(true)
      expect(d.tool).toContain('execute_deal_from_prompt_inputs')
    }
    expect(brief.deals.find(d => d.ssp === 'PubMatic')!.tool).toContain('pubmatic')
    expect(brief.deals.find(d => d.ssp === 'Magnite')!.tool).toContain('magnite')
  })

  it('preserves long deal names verbatim', () => {
    const brief = buildBatchBrief(failedBatchForm())
    const names = brief.deals.map(d => d.deal_name)
    expect(names).toContain(PM_USERS)
    expect(names).toContain(PM_PROXY)
  })

  it('preserves Magnite size ids in the per-deal args', () => {
    const brief = buildBatchBrief(failedBatchForm())
    const mg = brief.deals.find(d => d.ssp === 'Magnite')!
    expect(mg.prompt_inputs).toContain('sizes: [1, 2, 8, 9, 10, 67, 100, 117]')
    // "ALL" publisher discovery uses the deal sizes server-side — no filter arg.
    expect(mg.prompt_inputs).toContain('publishers: "ALL"')
    expect(mg.prompt_inputs).not.toContain('publisher_filter_size_ids')
  })

  it('keeps the PubMatic fee margin-only (no string recipient/feeType)', () => {
    const brief = buildBatchBrief(failedBatchForm())
    const pm = brief.deals.find(d => d.ssp === 'PubMatic')!
    expect(pm.prompt_inputs).toContain('feeValue: 30')
    expect(pm.prompt_inputs).not.toContain('feeType: PoM')
    expect(pm.prompt_inputs).not.toContain('recipient: Curator')
  })

  // PM-ZOOR-0075 (2026-08-19): a deal CPM shipped as floor_ecpm flips the
  // PubMatic deal to Fixed Price and it transacts at that exact CPM. The
  // prompt never sends a floor, and the brief's floor records 0 to match.
  it('PubMatic rows are First Price with an honest zero floor — never floor_ecpm (PM-ZOOR-0075)', () => {
    const form = failedBatchForm()
    form.deals[0].cpm = '22.77'
    const brief = buildBatchBrief(form)
    const pm = brief.deals.find(d => d.ssp === 'PubMatic')!
    expect(pm.prompt_inputs).toContain('auction_type: 1')
    // Field emission only — the auction_type guard comment names floor_ecpm
    // as a prohibition, which is allowed.
    expect(pm.prompt_inputs).not.toMatch(/^floor_ecpm:/m)
    expect(pm.prompt_inputs).not.toContain('22.77')
    expect(pm.floor).toBe(0)
  })

  it('survives JSON round-trip without garbling (the transport fix)', () => {
    const brief = buildBatchBrief(failedBatchForm())
    const round = JSON.parse(serializeBrief(brief))
    expect(round.deals.find((d: { ssp: string }) => d.ssp === 'PubMatic').deal_name).toBe(PM_USERS)
    expect(round.campaign_id).toBe('DEAL07238')
  })



  it('validates a clean brief', () => {
    const v = validateBrief(buildBatchBrief(failedBatchForm()))
    expect(v.ok, v.issues.join('; ')).toBe(true)
  })

  it('fails validation on an unresolved <FILL token', () => {
    const brief = buildBatchBrief(failedBatchForm())
    brief.deals[0].prompt_inputs += '\nmarketplace: <FILL marketplace>'
    const v = validateBrief(brief)
    expect(v.ok).toBe(false)
    expect(v.issues.some(i => i.includes('unresolved'))).toBe(true)
  })

  it('fails validation when a create row is missing tool routing', () => {
    const brief = buildBatchBrief(failedBatchForm())
    brief.deals[0].tool = ''
    const v = validateBrief(brief)
    expect(v.ok).toBe(false)
    expect(v.issues.some(i => i.includes('tool routing'))).toBe(true)
  })

  it('fails validation on a missing recipient', () => {
    const form = failedBatchForm()
    form.dealSheetRecipient = ''
    const v = validateBrief(buildBatchBrief(form))
    expect(v.ok).toBe(false)
    expect(v.issues.some(i => i.includes('recipient'))).toBe(true)
  })

  it('multi-recipient list: first address is recipient, the rest ride cc_recipients', () => {
    const form = failedBatchForm()
    form.dealSheetRecipient = 'elyse@example.com, brad@example.com; ops@example.com'
    const brief = buildBatchBrief(form)
    expect(brief.recipient).toBe('elyse@example.com')
    expect(brief.cc_recipients).toEqual(['brad@example.com', 'ops@example.com'])
    expect(validateBrief(brief).ok).toBe(true)
  })

  it('a single recipient omits cc_recipients entirely (pre-chip brief shape)', () => {
    const form = failedBatchForm()
    const brief = buildBatchBrief(form)
    expect(brief.cc_recipients).toBeUndefined()
    expect('cc_recipients' in brief).toBe(false)
  })
})

// =============================================================================
// ad_duration — the brief schema v1.1 optional per-deal object. Field names
// must match cutlass protocols/deal-brief.schema.yaml exactly (CI-pinned in
// cutlass-contract.json): EITHER allowed_durations OR min_seconds/max_seconds,
// never both, and only on CTV/OLV/OTT deals.
// =============================================================================
describe('dealBrief — ad_duration (brief schema v1.1)', () => {
  function ctvForm(dur: Partial<DealEntry>): FormData {
    const form = failedBatchForm()
    form.deals = [{ ...newDeal(), ssp: 'Index Exchange', channel: 'CTV', theme: 'Sports', cpm: '25', ...dur }]
    return form
  }

  it('an allowed list rides ad_duration.allowed_durations as integers', () => {
    const brief = buildBatchBrief(ctvForm({ adDurations: ['15', '30'] }))
    expect(brief.deals[0].ad_duration).toEqual({ allowed_durations: [15, 30] })
    expect(validateBrief(brief).ok).toBe(true)
  })

  it('a max-only cap rides ad_duration.max_seconds alone (no derivable min)', () => {
    const brief = buildBatchBrief(ctvForm({ maxAdDurationSecs: '30' }))
    expect(brief.deals[0].ad_duration).toEqual({ max_seconds: 30 })
  })

  it('the allowed list wins when a form carries both (schema forbids both; QA warns on conflicts)', () => {
    const brief = buildBatchBrief(ctvForm({ adDurations: ['15', '30'], maxAdDurationSecs: '30' }))
    expect(brief.deals[0].ad_duration).toEqual({ allowed_durations: [15, 30] })
  })

  it('non-video deals never carry ad_duration (Display durations are a brief validation error)', () => {
    const brief = buildBatchBrief(failedBatchForm()) // all Display deals
    for (const d of brief.deals) {
      expect('ad_duration' in d).toBe(false)
    }
    const stray = failedBatchForm()
    stray.deals[0] = { ...stray.deals[0], adDurations: ['15'] } // stray on Display
    expect(buildBatchBrief(stray).deals[0].ad_duration).toBeUndefined()
  })

  it('duration-less deals omit the key entirely (undefined = unset, no null noise in transport)', () => {
    const brief = buildBatchBrief(ctvForm({}))
    expect('ad_duration' in brief.deals[0]).toBe(false)
    const round = JSON.parse(serializeBrief(brief))
    expect('ad_duration' in round.deals[0]).toBe(false)
  })
})

// =============================================================================
// #221 — validateBrief attachment cross-check: a prompt_inputs list/file
// reference absent from the submit's attachment set (listIds resolved to
// registry names + ad-hoc fileNames) must FAIL CLOSED. Pre-fix, validateBrief
// had no attachment awareness at all — the brief validated clean while the
// referenced file never reached the runner (IX/OpenX/PubMatic missing_domain_file;
// Media.net created the deal LIVE without its list).
// =============================================================================
describe('validateBrief — fail closed on referenced-but-unattached lists (#221)', () => {
  const STD_ALLOW = { id: 'std-news', name: 'Preferred News Sites', kind: 'allow' as const, scope: 'domain' as const, line_count: 10 }
  const STD_BLOCK = { id: 'std-longtail', name: 'Longtail Block List', kind: 'block' as const, scope: 'domain' as const, line_count: 100 }
  const STD_BUNDLES = { id: 'std-bundles', name: 'Bad Bundles', kind: 'block' as const, scope: 'app_bundle' as const, line_count: 5 }
  const LISTS = [STD_ALLOW, STD_BLOCK, STD_BUNDLES]

  const mk = (over: Partial<DealEntry>): DealEntry => ({ ...newDeal(), channel: 'Display', theme: 'T', cpm: '5', ...over })
  function listForm(deals: DealEntry[]): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2027-06-30',
      agency: 'A', brand: 'B', campaignId: 'DEAL50003', dealSheetRecipient: 'trader@example.com',
      curatedDealFee: '25',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
      deals,
    }
  }

  it('IX deal with a per-deal standard list: fails with empty attachments, names the deal + list; passes once listNames carries it', () => {
    const brief = buildBatchBrief(listForm([mk({ ssp: 'Index Exchange', domainListId: 'std-news' })]), LISTS)
    // The generated prompt_inputs really do reference the list (guards the fixture).
    expect(brief.deals[0].prompt_inputs).toContain('Preferred News Sites')

    const failed = validateBrief(brief, { listNames: [], fileNames: [] })
    expect(failed.ok).toBe(false)
    const issue = failed.issues.find(i => i.includes('Preferred News Sites'))
    expect(issue).toBeDefined()
    expect(issue).toContain(brief.deals[0].deal_name)

    expect(validateBrief(brief, { listNames: ['Preferred News Sites'], fileNames: [] }).ok).toBe(true)
  })

  it('app_bundle_file_path references are cross-checked too', () => {
    const brief = buildBatchBrief(listForm([mk({ ssp: 'Index Exchange', channel: 'CTV', vcr: '80', appBundleListId: 'std-bundles' })]), LISTS)
    expect(validateBrief(brief, { listNames: [], fileNames: [] }).ok).toBe(false)
    expect(validateBrief(brief, { listNames: ['Bad Bundles'], fileNames: [] }).ok).toBe(true)
  })

  it('a Media.net values_file post-create merge reference is cross-checked (the deal would otherwise go LIVE without its list)', () => {
    const brief = buildBatchBrief(listForm([mk({ ssp: 'Media.net', domainListId: 'std-longtail' })]), LISTS)
    expect(brief.deals[0].prompt_inputs).toContain('values_file: Longtail Block List')
    const failed = validateBrief(brief, { listNames: [], fileNames: [] })
    expect(failed.ok).toBe(false)
    expect(failed.issues.some(i => i.includes('Longtail Block List'))).toBe(true)
    expect(validateBrief(brief, { listNames: ['Longtail Block List'], fileNames: [] }).ok).toBe(true)
  })

  it('an ad-hoc upload reference is satisfied by fileNames (it rides filePaths, not listIds)', () => {
    const upload = { id: 'up-1', name: 'oneoff sites.csv', size: 1, path: '/tmp/up-1.csv', inclusionType: 'Exclude' as const }
    const form = { ...listForm([mk({ ssp: 'Index Exchange', domainListId: 'up-1' })]), domainLists: [upload] }
    const brief = buildBatchBrief(form, LISTS)
    expect(brief.deals[0].prompt_inputs).toContain('oneoff sites.csv')
    expect(validateBrief(brief, { listNames: [], fileNames: [] }).ok).toBe(false)
    expect(validateBrief(brief, { listNames: [], fileNames: ['oneoff sites.csv'] }).ok).toBe(true)
  })

  it('omitting the attachments argument skips only the cross-check (legacy/preview callers)', () => {
    const brief = buildBatchBrief(listForm([mk({ ssp: 'Index Exchange', domainListId: 'std-news' })]), LISTS)
    expect(validateBrief(brief).ok).toBe(true)
  })
})

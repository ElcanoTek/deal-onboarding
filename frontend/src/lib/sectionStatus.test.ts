import { describe, expect, it } from 'vitest'
import { auditChecksToFormIssues, fieldPathToElementId, getSubmitterStatus } from './sectionStatus'
import { AuditCheck, AuditResult } from '../types/deal'

function makeAudit(checks: AuditCheck[]): AuditResult {
  return {
    status: 'failed',
    total_deals: 1,
    deal_names: ['fake'],
    checks,
    inferred: { iab_categories: [], note: '' },
  }
}

describe('auditChecksToFormIssues', () => {
  it('returns {} for null audit', () => {
    expect(auditChecksToFormIssues(null)).toEqual({})
  })

  it('ignores passed checks', () => {
    const audit = makeAudit([
      { rule: 'ox_fee', passed: true, message: 'ok', fieldPath: 'ixConfig.accountId' },
    ])
    expect(auditChecksToFormIssues(audit)).toEqual({})
  })

  it('ignores per-deal failures (those are handled by auditChecksToDealIssues)', () => {
    const audit = makeAudit([
      { rule: 'deal_theme', passed: false, message: 'theme required', dealIndex: 0, fieldPath: 'theme' },
    ])
    expect(auditChecksToFormIssues(audit)).toEqual({})
  })

  it('returns form-level failures keyed by fieldPath', () => {
    const audit = makeAudit([
      {
        rule: 'ox_fee',
        passed: false,
        message: 'Index Exchange account_id is not set.',
        fieldPath: 'ixConfig.accountId',
      },
    ])
    expect(auditChecksToFormIssues(audit)).toEqual({
      'ixConfig.accountId': 'Index Exchange account_id is not set.',
    })
  })

  it('first failure per fieldPath wins — duplicates do not overwrite', () => {
    const audit = makeAudit([
      { rule: 'r1', passed: false, message: 'first', fieldPath: 'agency' },
      { rule: 'r2', passed: false, message: 'second', fieldPath: 'agency' },
    ])
    expect(auditChecksToFormIssues(audit)).toEqual({ agency: 'first' })
  })

  it('skips form-level failures without a fieldPath', () => {
    const audit = makeAudit([
      { rule: 'completeness', passed: false, message: 'Missing campaign fields: Agency' },
    ])
    expect(auditChecksToFormIssues(audit)).toEqual({})
  })
})

describe('fieldPathToElementId', () => {
  it('maps ixConfig.accountId → ix-account (the IX select id in SspSelection)', () => {
    expect(fieldPathToElementId({ rule: 'ox_fee', passed: false, message: '', fieldPath: 'ixConfig.accountId' })).toBe('ix-account')
  })

  it('returns deal-card field anchor for per-deal failures', () => {
    expect(fieldPathToElementId({ rule: 'deal_theme', passed: false, message: '', dealIndex: 2, fieldPath: 'theme' })).toBe('deal-theme-2')
  })

  it('returns undefined for unmapped fieldPaths', () => {
    expect(fieldPathToElementId({ rule: 'r', passed: false, message: '', fieldPath: 'somethingUnknown' })).toBeUndefined()
  })

  it('returns undefined when no fieldPath at all', () => {
    expect(fieldPathToElementId({ rule: 'r', passed: false, message: '' })).toBeUndefined()
  })
})

import { auditChecksToDealIssues, auditIssuesBySection } from './sectionStatus'
import { DEFAULT_FORM, newDeal, DealEntry } from '../types/deal'

describe('auditChecksToDealIssues — deal index from fieldPath', () => {
  it('maps the FIRST deal (index 0) even when dealIndex is omitted (Go omitempty)', () => {
    const form = { ...DEFAULT_FORM, deals: [newDeal(), newDeal()] }
    // Real backend shape for deal 0: no dealIndex (omitempty dropped it), index in fieldPath.
    const audit = makeAudit([
      { rule: 'deal_ssp', passed: false, message: 'Deal 1: SSP is required', fieldPath: 'deals[0].ssp' },
      { rule: 'deal_cpm', passed: false, message: 'Deal 2: Display CPM required', fieldPath: 'deals[1].cpm' },
    ])
    const issues = auditChecksToDealIssues(form, audit)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ dealId: form.deals[0].id, dealIndex: 0, field: 'ssp' })
    expect(issues[1]).toMatchObject({ dealId: form.deals[1].id, dealIndex: 1, field: 'cpm' })
  })
})

import { checkToSectionId } from './sectionStatus'

// Every rule name emitted by internal/validation/rules.go. If a new rule is
// added there, add it here too — this test fails loudly if any emitted rule
// can't be mapped to a section, which is exactly the "audit fails but no
// section turns red" regression we're fixing. Keep in sync with rules.go.
const ALL_BACKEND_RULES = [
  'completeness', 'date_logic', 'deal_fee', 'deals_required',
  'deal_theme', 'deal_channel', 'deal_ssp', 'deal_inv', 'deal_segments', 'deal_cpm', 'deal_vcr',
  'seat_id', 'seat_multi', 'ox_package', 'ox_deal_price', 'ox_buyers', 'ox_fee', 'ox_pmp_type',
  'pm_publishers', 'xn_deal_code', 'xn_insertion_order', 'tl_price_type', 'tl_channel', 'mn_margin',
  'mg_marketplace', 'mg_publishers', 'mg_floor', 'mg_sizes', 'mg_dvplus_audience',
  'domain_type', 'deal_sheet_recipient', 'openx_app_bundle_blocklist', 'openx_inventory_attachment', 'campaign_id', 'list_selection',
  'qa_duplicate_deals', 'geo_exclude_unsupported', 'iab_campaign_retired',
]

// The deal-sheet recipient may be a comma-joined LIST from the chip input —
// every entry must parse (mirrors the Go email_format rule).
describe('getSubmitterStatus — multi-recipient deal-sheet field', () => {
  const filled = () => ({
    ...DEFAULT_FORM,
    submitterName: 'T', submitterEmail: 't@x.com',
    requestedDueDate: '2099-01-01', flightStartDate: '2099-01-02', flightEndDate: '2099-02-01',
  })

  it('accepts a comma/semicolon-joined list of valid addresses', () => {
    const s = getSubmitterStatus({ ...filled(), dealSheetRecipient: 'a@x.com, b@x.com; c@x.com' })
    expect(s.fieldIssues?.some(i => i.path === 'dealSheetRecipient')).toBe(false)
  })

  it('flags the field when any entry in the list is malformed', () => {
    const s = getSubmitterStatus({ ...filled(), dealSheetRecipient: 'a@x.com, not-an-email' })
    expect(s.fieldIssues?.some(i => i.path === 'dealSheetRecipient')).toBe(true)
  })
})

describe('checkToSectionId — every backend rule maps to a section', () => {
  it.each(ALL_BACKEND_RULES)('rule %s resolves to a section (rule-only, no fieldPath)', (rule) => {
    const section = checkToSectionId({ rule, passed: false, message: '' })
    expect(section, `rule "${rule}" has no section mapping — add it to RULE_TO_SECTION_ID`).toBeDefined()
  })

  it('fieldPath wins over the rule map (SSP-config paths → ssp)', () => {
    expect(checkToSectionId({ rule: 'ox_deal_price', passed: false, message: '', fieldPath: 'openxConfig.dealPrice' })).toBe('ssp')
    expect(checkToSectionId({ rule: 'mn_margin', passed: false, message: '', fieldPath: 'medianetConfig.marginValue' })).toBe('ssp')
    expect(checkToSectionId({ rule: 'deal_sheet_recipient', passed: false, message: '', fieldPath: 'dealSheetRecipient' })).toBe('submitter')
    expect(checkToSectionId({ rule: 'deal_fee', passed: false, message: '', fieldPath: 'curatedDealFee' })).toBe('client')
    expect(checkToSectionId({ rule: 'seat_id', passed: false, message: '', fieldPath: 'dsps[0].seatId' })).toBe('dsp')
  })
})

describe('auditIssuesBySection', () => {
  it('counts failures per section via fieldPath + rule mapping', () => {
    const audit = makeAudit([
      { rule: 'ox_fee', passed: false, message: 'acct', fieldPath: 'ixConfig.accountId' },
      { rule: 'deal_ssp', passed: false, message: 'ssp', fieldPath: 'deals[0].ssp' },
      { rule: 'date_logic', passed: false, message: 'dates' }, // no fieldPath → mapped by rule
      { rule: 'campaign_id', passed: false, message: 'cid' },
      { rule: 'whatever', passed: true, message: 'ok' },
    ])
    const by = auditIssuesBySection(audit)
    expect(by.ssp).toBe(1)
    expect(by.deals).toBe(1)
    expect(by.submitter).toBe(1) // date_logic → submitter
    expect(by.client).toBe(1)    // campaign_id → client
  })
})

import { getLiveFormIssues, getSspConfigStatus, getDealsStatus } from './sectionStatus'

describe('getLiveFormIssues — live field-level red-outline issues', () => {
  it('flags missing Magnite marketplace (shared) for a DV+ deal; publishers are never required', () => {
    const deal = { ...newDeal(), ssp: 'Magnite' as const, channel: 'Display' as const, theme: 'X' }
    const issues = getLiveFormIssues({ ...DEFAULT_FORM, deals: [deal] })
    expect(issues['magniteConfig.marketplace']).toBeDefined()
    // Publishers are not collected — the prompt always applies the "ALL" opt-in.
    expect(issues['magniteConfig.publishers']).toBeUndefined()
    // Ad formats moved to per-deal — NOT a form-level issue.
    expect(issues['magniteConfig.sizes']).toBeUndefined()
  })

  it('flags missing Magnite ad formats PER-DEAL across DV+ channels; CTV/Audio exempt', () => {
    const hasMgSizesIssue = (d: Partial<DealEntry>) =>
      getDealsStatus({ ...DEFAULT_FORM, deals: [{ ...newDeal(), ssp: 'Magnite', theme: 'X', ...d } as DealEntry] })
        .dealIssues.some(i => i.field === 'magniteSizes')

    // DV+ format families (display/video/native) all require a per-deal selection.
    for (const channel of ['Display', 'OLV (Online Video)', 'Native'] as const) {
      expect(hasMgSizesIssue({ channel }), `${channel} empty → should flag`).toBe(true)
      expect(hasMgSizesIssue({ channel, magniteSizes: ['15'] }), `${channel} filled → no flag`).toBe(false)
    }
    // CTV and OTT both route to Streaming (no sizes); Audio uses feedTypes.
    for (const channel of ['CTV', 'OTT', 'Audio'] as const) {
      expect(hasMgSizesIssue({ channel }), `${channel} → exempt`).toBe(false)
    }
  })

  // PM-ZOOR-0075 (2026-08-19): PubMatic deals are always First Price with no
  // deal-level floor — a floor would force Fixed Price and the deal transacts
  // AT that CPM. The deal card collects no CPM, so a blank one is never an issue.
  it('does NOT flag a blank CPM on a PubMatic deal (no floor ships — always First Price)', () => {
    const issues = getDealsStatus({
      ...DEFAULT_FORM,
      deals: [{ ...newDeal(), ssp: 'PubMatic' as const, channel: 'Display' as const, theme: 'X', cpm: '' }],
    }).dealIssues
    expect(issues.some(i => i.field === 'cpm')).toBe(false)
  })

  it('does NOT flag OpenX buyers (optional per MCP) or a BLANK deal price; flags a set-but-invalid one', () => {
    const deal = { ...newDeal(), ssp: 'OpenX' as const, channel: 'Display' as const, theme: 'X' }
    const form = {
      ...DEFAULT_FORM,
      deals: [deal],
      openxConfig: { ...DEFAULT_FORM.openxConfig, dealPrice: '', buyers: [{ id: '1', buyerId: '', isMain: true }] },
    }
    const issues = getLiveFormIssues(form)
    expect(issues['openxConfig.buyers']).toBeUndefined()
    // Deal Price is optional (2026-08-11): blank falls back to each deal's
    // Floor CPM or $0.10 — no live issue.
    expect(issues['openxConfig.dealPrice']).toBeUndefined()
    // A SET value still has to parse > 0 (typo guard).
    const invalid = getLiveFormIssues({ ...form, openxConfig: { ...form.openxConfig, dealPrice: '0' } })
    expect(invalid['openxConfig.dealPrice']).toBeDefined()
  })

  it('auto-generate package name means packageName is not flagged', () => {
    const status = getSspConfigStatus({
      ...DEFAULT_FORM,
      deals: [{ ...newDeal(), ssp: 'OpenX' as const, channel: 'Display' as const }],
      openxConfig: { ...DEFAULT_FORM.openxConfig, autoPackageName: true, dealPrice: '1.0' },
    })
    expect(status.fieldIssues?.some(f => f.path === 'openxConfig.packageName')).toBe(false)
    expect(status.fieldIssues?.some(f => f.path === 'openxConfig.buyers')).toBe(false)
  })

  // PublisherAllowlist chips live in publisherEntries — reading legacy
  // publisherNames alone flagged NEEDS INFO on a fully-populated card
  // (SMT/Optimum DEAL07300, 2026-08-24). Mirrors pm_publishers in rules.go.
  it('PubMatic with Max Reach off: allowlist ENTRIES satisfy the publisher check; legacy names still work; empty fails', () => {
    const pmForm = (cfg: Partial<typeof DEFAULT_FORM.pubmaticConfig>) => ({
      ...DEFAULT_FORM,
      deals: [{ ...newDeal(), ssp: 'PubMatic' as const, channel: 'CTV' as const, theme: 'X' }],
      pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, maxReach: false, ...cfg },
    })
    const entries = getSspConfigStatus(pmForm({ publisherEntries: [{ id: '158583', name: 'Fox News (NTAM)' }] }))
    expect(entries.missing).not.toContain('PubMatic Publisher Names')
    const legacy = getSspConfigStatus(pmForm({ publisherNames: ['Fox News'] }))
    expect(legacy.missing).not.toContain('PubMatic Publisher Names')
    const empty = getSspConfigStatus(pmForm({}))
    expect(empty.missing).toContain('PubMatic Publisher Names')
  })
})

// ---------------------------------------------------------------------------
// getDspStatus — seat-optional DSPs (seatPolicy.ts)
// ---------------------------------------------------------------------------

import { getDspStatus } from './sectionStatus'

function dspForm(dsp: string, seatId: string, ssp: DealEntry['ssp'] = 'Index Exchange', sheetOnly = false) {
  return {
    ...DEFAULT_FORM,
    dsps: [{ id: '1', dsp, seatId }],
    deals: [{ ...newDeal(), ssp, sheetOnly }],
  }
}

describe('getDspStatus seat-optional DSPs', () => {
  it('requires a seat for a normal DSP', () => {
    const status = getDspStatus(dspForm('The Trade Desk', ''))
    expect(status.complete).toBe(false)
    expect(status.fieldIssues?.some(f => f.path === 'dsps[0].seatId')).toBe(true)
  })

  it('allows a seatless StackAdapt batch', () => {
    const status = getDspStatus(dspForm('StackAdapt', ''))
    expect(status.complete).toBe(true)
    expect(status.fieldIssues ?? []).toEqual([])
  })

  it('matches allowlist name variants', () => {
    for (const name of ['stackadapt', 'Stack Adapt', 'STACKADAPT ']) {
      expect(getDspStatus(dspForm(name, '')).complete).toBe(true)
    }
  })

  it('still requires a seat when the batch creates on PubMatic', () => {
    const status = getDspStatus(dspForm('StackAdapt', '', 'PubMatic'))
    expect(status.complete).toBe(false)
    const issue = status.fieldIssues?.find(f => f.path === 'dsps[0].seatId')
    expect(issue?.message).toContain('PubMatic')
  })

  it('still requires a seat when the batch creates on TripleLift', () => {
    expect(getDspStatus(dspForm('StackAdapt', '', 'TripleLift')).complete).toBe(false)
  })

  it('ignores sheet-only PubMatic rows', () => {
    expect(getDspStatus(dspForm('StackAdapt', '', 'PubMatic', true)).complete).toBe(true)
  })

  it('a filled seat always passes', () => {
    expect(getDspStatus(dspForm('StackAdapt', '99', 'PubMatic')).complete).toBe(true)
  })
})

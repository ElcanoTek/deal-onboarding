// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { AuditCheck, AuditResult, DealEntry, FormData, effectivePubMaticPublisherEntries, isVideoChannel, MAGNITE_PRICE_TYPES, magniteDealNeedsFormats, magnitePriceTypeHasFloor, sspReq, sspsInUse } from '../types/deal'
import { campaignIdPattern, campaignIdPlaceholder } from './operatorConfig'
import { splitEmails } from './recipients'
import { seatOptionalDsp, seatRequiredCreateSsps } from './seatPolicy'

export type SectionId = 'submitter' | 'client' | 'ssp' | 'dsp' | 'deals' | 'files'

export interface DealIssue {
  dealId: string
  dealIndex: number
  field: string
  message: string
}

/** A live (pre-backend-audit) validation failure tied to a concrete input.
 *  `path` matches the fieldPath the section panels read via `err(path)`, so
 *  feeding these into `formIssues` red-outlines the exact field with `message`
 *  as inline text — the same machinery the backend audit drives. */
export interface FieldIssue {
  path: string
  message: string
}

export interface SectionStatus {
  id: SectionId
  filled: number
  total: number
  missing: string[]
  /** Field-level issues for the form-level (non-deal) inputs in this section. */
  fieldIssues?: FieldIssue[]
  dealIssues?: DealIssue[]
  complete: boolean
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function nonEmpty(s: string | undefined | null): boolean {
  return typeof s === 'string' && s.trim().length > 0
}

function positive(s: string | undefined | null): boolean {
  if (!s) return false
  const n = parseFloat(s)
  return !isNaN(n) && n > 0
}

function isFutureOrToday(s: string): boolean {
  if (!s) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(s + 'T00:00:00')
  return !isNaN(d.getTime()) && d.getTime() >= today.getTime()
}

export function getSubmitterStatus(form: FormData): SectionStatus {
  const missing: string[] = []
  const fieldIssues: FieldIssue[] = []
  const fail = (label: string, path: string, message: string) => { missing.push(label); fieldIssues.push({ path, message }) }
  if (!nonEmpty(form.submitterName)) fail('Submitter Name', 'submitterName', 'Submitter name is required')
  if (!nonEmpty(form.submitterEmail)) fail('Submitter Email', 'submitterEmail', 'Submitter email is required')
  else if (!EMAIL_RE.test(form.submitterEmail)) fail('Submitter Email must be a valid address', 'submitterEmail', 'Enter a valid email address')
  // The deal-sheet recipient is an actual send-to address (the May 2026
  // mis-send incident) — require it here so the step flags it up front, and
  // format-check it like the submitter email. The field may hold a comma-
  // joined LIST from the chip input (first = To, rest cc'd) — every entry
  // must parse (mirrors the Go email_format rule).
  if (!nonEmpty(form.dealSheetRecipient)) fail('Deal Sheet Recipient', 'dealSheetRecipient', 'Deal sheet recipient is required — the deal sheet emails here after creation')
  else if (!splitEmails(form.dealSheetRecipient).every(a => EMAIL_RE.test(a))) fail('Deal Sheet Recipient must be a valid address', 'dealSheetRecipient', 'Every recipient must be a valid email address')
  if (!nonEmpty(form.requestedDueDate)) fail('Requested Due Date', 'requestedDueDate', 'Requested due date is required')
  if (!nonEmpty(form.flightStartDate)) fail('Flight Start Date', 'flightStartDate', 'Flight start date is required')
  else if (!isFutureOrToday(form.flightStartDate)) fail('Start Date must be today or later', 'flightStartDate', 'Start date must be today or later')
  if (!nonEmpty(form.flightEndDate)) fail('Flight End Date', 'flightEndDate', 'Flight end date is required')
  else if (form.flightStartDate && form.flightEndDate < form.flightStartDate) {
    fail('End Date must be after Start Date', 'flightEndDate', 'End date must be on or after the start date')
  }
  return { id: 'submitter', filled: 6 - missing.length, total: 6, missing, fieldIssues, complete: missing.length === 0 }
}

export function getClientStatus(form: FormData): SectionStatus {
  const missing: string[] = []
  const fieldIssues: FieldIssue[] = []
  if (!nonEmpty(form.agency)) { missing.push('Agency'); fieldIssues.push({ path: 'agency', message: 'Agency is required' }) }
  if (!nonEmpty(form.brand)) { missing.push('Brand'); fieldIssues.push({ path: 'brand', message: 'Brand is required' }) }
  // Commercials moved here from the retired Campaign Defaults section — the
  // fee is a campaign-level term, set once alongside the campaign.
  if (!positive(form.curatedDealFee)) { missing.push('Curated Deal Fee'); fieldIssues.push({ path: 'curatedDealFee', message: 'Curated deal fee must be greater than 0' }) }
  if (!nonEmpty(form.feeType)) { missing.push('Fee Type'); fieldIssues.push({ path: 'feeType', message: 'Fee type is required' }) }
  if (form.campaignId && !campaignIdPattern().test(form.campaignId)) { missing.push(`Campaign ID format (${campaignIdPlaceholder()})`); fieldIssues.push({ path: 'campaignId', message: `Campaign ID must look like ${campaignIdPlaceholder()}` }) }
  return { id: 'client', filled: 4 - missing.filter(m => !m.includes('format')).length, total: 4, missing, fieldIssues, complete: missing.length === 0 }
}

export function getDspStatus(form: FormData): SectionStatus {
  const missing: string[] = []
  const fieldIssues: FieldIssue[] = []
  const active = form.multipleDsps ? form.dsps : form.dsps.slice(0, 1)
  if (active.length === 0 || !nonEmpty(active[0]?.dsp)) {
    missing.push('At least one DSP')
    fieldIssues.push({ path: 'dsps[0].dsp', message: 'Select a DSP' })
  } else {
    let flagged = false
    active.forEach((d, i) => {
      const dspMissing = !nonEmpty(d.dsp)
      if (dspMissing) fieldIssues.push({ path: `dsps[${i}].dsp`, message: 'Select a DSP' })
      // Seat-optional DSPs (seatPolicy.ts) may omit the seat — unless the
      // batch creates on an SSP that needs one to resolve the buyer
      // (PubMatic/TripleLift). Mirrors backend rule 16 (seat_id).
      let seatIssue = ''
      if (!nonEmpty(d.seatId)) {
        if (dspMissing || !seatOptionalDsp(d.dsp)) {
          seatIssue = 'Seat ID is required for this DSP'
        } else {
          const blockers = seatRequiredCreateSsps(form.deals)
          if (blockers.length > 0) seatIssue = `${blockers.join(' and ')} deals need a Seat ID to resolve the ${d.dsp.trim()} buyer`
        }
      }
      if (seatIssue) fieldIssues.push({ path: `dsps[${i}].seatId`, message: seatIssue })
      if ((dspMissing || seatIssue !== '') && !flagged) { missing.push('DSP + Seat ID for every DSP'); flagged = true }
    })
  }
  return { id: 'dsp', filled: missing.length === 0 ? 1 : 0, total: 1, missing, fieldIssues, complete: missing.length === 0 }
}

function validateSingleDeal(deal: DealEntry, index: number, form: FormData): DealIssue[] {
  const issues: DealIssue[] = []
  const push = (field: string, message: string) =>
    issues.push({ dealId: deal.id, dealIndex: index, field, message })

  if (!nonEmpty(deal.theme)) push('theme', 'Theme is required — drives the deal name')
  if (!deal.channel) push('channel', 'Channel is required')
  if (!deal.ssp) push('ssp', 'SSP is required')

  if (!deal.ssp) return issues // can't enforce SSP-specific rules without one selected
  const req = sspReq(deal.ssp)

  const filledIncludes = deal.includeSegments.filter(s => s.trim()).length
  if (req.requiresSegments && filledIncludes === 0) {
    push('includeSegments', `${deal.ssp} requires at least one Include Segment at create time`)
  }

  // Magnite DV+ deals (display/video/native) must pick >=1 ad format — the API
  // rejects size-less DV+ creates. CTV (SpringServe) and Audio are exempt.
  if (deal.ssp === 'Magnite' && magniteDealNeedsFormats(deal.channel)) {
    if ((deal.magniteSizes || []).filter(s => s.trim()).length === 0) {
      push('magniteSizes', 'Pick at least one Magnite ad format for this DV+ deal')
    }
  }

  if (req.needsFloor) {
    const isVideo = deal.channel ? isVideoChannel(deal.channel) : false
    const perDeal = deal.cpm
    const sharedDefault = isVideo ? form.defaultVideoCpm : form.defaultDisplayCpm
    const sspFloor = req.hasSharedFloor && deal.ssp === 'OpenX' ? form.openxConfig.dealPrice : ''
    // Index Exchange ships the 0.10 IX minimum when the floor is blank
    // (dealPromptYaml default; the card hint says "blank = $0.10") — mirror
    // the Go deal_cpm fallback so the step never flags a floor the batch
    // would actually send.
    const ixDefault = deal.ssp === 'Index Exchange' ? '0.10' : ''
    const effective = perDeal || sharedDefault || sspFloor || ixDefault
    if (!positive(effective)) {
      const fallback = req.hasSharedFloor
        ? `Set the Floor CPM on this deal card, or the floor in the ${deal.ssp} config`
        : `Set the Floor CPM on this deal card`
      push('cpm', `Floor CPM required for ${deal.ssp} — ${fallback}`)
    }
  }

  return issues
}

export function getDealsStatus(form: FormData): SectionStatus & { dealIssues: DealIssue[] } {
  const missing: string[] = []
  const allIssues: DealIssue[] = []

  if (form.deals.length === 0) {
    return {
      id: 'deals',
      filled: 0,
      total: 1,
      missing: ['Add at least one deal'],
      dealIssues: [],
      complete: false,
    }
  }

  for (let i = 0; i < form.deals.length; i++) {
    const issues = validateSingleDeal(form.deals[i], i, form)
    allIssues.push(...issues)
  }

  if (allIssues.length > 0) {
    const byDeal = new Map<number, number>()
    for (const iss of allIssues) byDeal.set(iss.dealIndex, (byDeal.get(iss.dealIndex) || 0) + 1)
    for (const [idx, count] of byDeal) {
      missing.push(`Deal ${idx + 1}: ${count} issue${count !== 1 ? 's' : ''}`)
    }
  }

  const total = form.deals.length
  const complete = allIssues.length === 0
  return {
    id: 'deals',
    filled: complete ? total : Math.max(0, total - new Set(allIssues.map(i => i.dealIndex)).size),
    total,
    missing,
    dealIssues: allIssues,
    complete,
  }
}

export function getSspConfigStatus(form: FormData): SectionStatus {
  const missing: string[] = []
  const fieldIssues: FieldIssue[] = []
  const fail = (label: string, path: string, message: string) => { missing.push(label); fieldIssues.push({ path, message }) }
  const used = sspsInUse(form.deals)

  if (used.includes('OpenX')) {
    const ox = form.openxConfig
    if (!ox.autoPackageName && !nonEmpty(ox.packageName)) fail('OpenX Package Name', 'openxConfig.packageName', 'Enter a package name, or turn on “Auto-generate package name”')
    // Deal Price is OPTIONAL (2026-08-11): blank falls back to each deal's
    // Floor CPM or the $0.10 default (mirrors ox_deal_price in rules.go).
    // Only a SET-but-unparseable/zero value is a live issue.
    if (nonEmpty(ox.dealPrice) && !positive(ox.dealPrice)) fail('OpenX Deal Price', 'openxConfig.dealPrice', 'Deal price must be greater than 0 when set (leave blank to use each deal’s Floor CPM)')
    // Buyer IDs are optional — DSP seat ids the MCP resolves server-side; deals
    // create fine without them, so no live failure here.
    if (nonEmpty(ox.feePartner) && !positive(ox.grossShare)) fail('OpenX Gross Share', 'openxConfig.grossShare', 'Gross Share is required when a Fee Partner is set')
  }
  // Xandr deal code is optional — the prompt uses the generated deal name
  // when it's blank, which is unique by construction.
  if (used.includes('TripleLift') && !nonEmpty(form.tripleliftConfig.dealPriceType)) fail('TripleLift Deal Price Type', 'tripleliftConfig.dealPriceType', 'Choose a deal price type')
  if (used.includes('Media.net') && !positive(form.medianetConfig.marginValue)) fail('Media.net Margin Value', 'medianetConfig.marginValue', 'Margin value must be greater than 0')
  if (used.includes('PubMatic') && !form.pubmaticConfig.maxReach) {
    // Effective scope: allowlist entries when set, else the legacy one-per-row
    // names — mirrors pm_publishers in rules.go. Reading publisherNames alone
    // flagged NEEDS INFO on forms whose publishers live in publisherEntries
    // (the PublisherAllowlist chips), telling traders their list vanished.
    const pubs = effectivePubMaticPublisherEntries(form.pubmaticConfig)
    if (pubs.length === 0) fail('PubMatic Publisher Names', 'pubmaticConfig.publisherNames', 'Add at least one publisher, or turn "Max publishers" back on')
  }
  if (used.includes('Magnite')) {
    const mg = form.magniteConfig
    if (!nonEmpty(mg.marketplace)) fail('Magnite Marketplace', 'magniteConfig.marketplace', 'Select a marketplace')
    // Price type: blank = the Market Rate default (owner call, 2026-07-21 —
    // no floor unless a trader deliberately picks MRwM/CPM). The floor
    // applies only to floor-bearing types and must be a positive number when
    // set (blank falls back to 0.10). The floor is NEVER the deal CPM.
    const pt = mg.priceType || 'Market Rate'
    if (!(MAGNITE_PRICE_TYPES as readonly string[]).includes(pt)) {
      fail('Magnite Price Type', 'magniteConfig.priceType', 'Pick Market Rate, Market Rate with Minimum, or CPM')
    } else if (magnitePriceTypeHasFloor(pt)) {
      const rawFloor = (mg.floorCpm ?? '').trim()
      if (rawFloor !== '') {
        const n = parseFloat(rawFloor)
        if (!isFinite(n) || n <= 0) fail('Magnite Floor CPM', 'magniteConfig.floorCpm', 'Floor must be a positive number (blank = 0.10 default)')
      }
    }
    // Publishers are NOT collected — the prompt always sends the explicit
    // publishers: "ALL" opt-in (expanded server-side by the Cutlass MCP).
    // Magnite ad formats (sizes) are validated PER-DEAL in validateSingleDeal —
    // each DV+ deal picks its own format family (display/video/native).
  }

  const total = used.length || 1
  return { id: 'ssp', filled: missing.length === 0 ? total : 0, total, missing, fieldIssues, complete: missing.length === 0 }
}

export function getFilesStatus(form: FormData): SectionStatus {
  const missing: string[] = []
  for (const f of [...form.domainLists, ...form.appBundleLists]) {
    if (!nonEmpty(f.inclusionType)) {
      missing.push('Include/Exclude type for each file')
      break
    }
  }
  return { id: 'files', filled: 0, total: 0, missing, complete: missing.length === 0 }
}

export function getAllStatuses(form: FormData) {
  // Page order: submitter → client → dsp → deals → files → ssp. The SSP
  // panels are driven by the SSPs the deals use, so the section sits after
  // the deal grid. Campaign Defaults is retired — its commercials live in
  // `client`, everything else on the deal cards.
  return [
    getSubmitterStatus(form),
    getClientStatus(form),
    getDspStatus(form),
    getDealsStatus(form),
    getFilesStatus(form),
    getSspConfigStatus(form),
  ]
}

export function readyToAudit(form: FormData): boolean {
  return getAllStatuses(form).every(s => s.complete)
}

/** Field-path → message map for LIVE (pre-backend-audit) validation, so the
 *  exact offending inputs can be red-outlined the moment the trader attempts an
 *  audit — reusing the same formIssues/err() machinery the backend audit drives.
 *  Built in section order (submitter → client → ssp → dsp → deals → files)
 *  so the first entry is the topmost issue on the page. Per-deal field
 *  issues are handled separately via getDealsStatus().dealIssues. */
export function getLiveFormIssues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of getAllStatuses(form)) {
    for (const fi of s.fieldIssues || []) {
      if (out[fi.path] === undefined) out[fi.path] = fi.message
    }
  }
  return out
}

export function totalIssueCount(form: FormData): number {
  return getAllStatuses(form).reduce((sum, s) => sum + s.missing.length, 0)
}

/** Convert backend audit failures into DealIssue records so the existing
 *  per-deal field-highlight UX surfaces them on the cards. The backend uses
 *  both bare field names ("theme", "ssp") for live-rule checks and indexed
 *  paths ("deals[3].excludeSegments") for per-deal rules. Both formats
 *  are normalized to the bare field name here. */
export function auditChecksToDealIssues(form: FormData, audit: AuditResult | null, auditedForm?: FormData | null): DealIssue[] {
  if (!audit) return []
  const issues: DealIssue[] = []
  const seen = new Set<string>()
  for (const check of audit.checks) {
    if (check.passed) continue
    const fieldPath = check.fieldPath
    if (!fieldPath) continue
    // check.dealIndex is dropped by Go's omitempty when it's 0, so the FIRST
    // deal's failures never mapped. Recover the index from the fieldPath
    // ("deals[N].field"), which is always present, and fall back to dealIndex.
    const m = fieldPath.match(/^deals\[(\d+)\]\./)
    const auditedIndex = m ? parseInt(m[1], 10) : (typeof check.dealIndex === 'number' ? check.dealIndex : -1)
    if (auditedIndex < 0) continue
    // The check's index refers to the deal ORDER AT AUDIT TIME. With
    // as-you-go audits the trader may have added/removed/duplicated deals
    // since, so resolve the deal's IDENTITY from the audited snapshot and
    // re-locate it in the current form by id — otherwise a finding lands on
    // whichever card now occupies that index (e.g. a VCR flag on a display
    // deal). Without a snapshot, fall back to the positional deal.
    const auditedDeal = auditedForm?.deals?.[auditedIndex]
    const dealId = auditedDeal ? auditedDeal.id : form.deals[auditedIndex]?.id
    if (!dealId) continue
    const dealIndex = form.deals.findIndex(d => d.id === dealId)
    if (dealIndex < 0) continue // the audited deal no longer exists
    const field = fieldPath.replace(/^deals\[\d+\]\./, '')
    const key = `${dealId}|${field}`
    if (seen.has(key)) continue
    seen.add(key)
    issues.push({
      dealId,
      dealIndex,
      field,
      message: check.message,
    })
  }
  return issues
}

/** Convert backend audit failures that target FORM-level fields (no dealIndex)
 *  into a fieldPath → message map. Consumers use it to apply field-input--error
 *  styling and inline field-error text on the offending input — the same UX the
 *  per-deal rules get via auditChecksToDealIssues(). Re-running audit refreshes
 *  the map; clearing it on form edits is the caller's job (typically by gating
 *  on auditStale so the red outline goes away the moment the trader edits). */
export function auditChecksToFormIssues(audit: AuditResult | null): Record<string, string> {
  if (!audit) return {}
  const issues: Record<string, string> = {}
  for (const check of audit.checks) {
    if (check.passed) continue
    if (typeof check.dealIndex === 'number' && check.dealIndex >= 0) continue
    if (!check.fieldPath) continue
    // First failure wins; a later check on the same field shouldn't overwrite
    // the most actionable message (typically the first one emitted).
    if (issues[check.fieldPath] === undefined) {
      issues[check.fieldPath] = check.message
    }
  }
  return issues
}

// Rule id → section. ONLY for rules that carry no fieldPath (section-level
// failures like deals_required, domain_type). Rule names
// here MUST match the backend (internal/validation/rules.go) exactly — the
// exhaustive test in sectionStatus.test.ts asserts every emitted rule resolves.
// fieldPath always wins over this map when present (see checkToSectionId).
const RULE_TO_SECTION_ID: Record<string, SectionId> = {
  completeness: 'submitter', date_logic: 'submitter', deals_required: 'deals',
  deal_fee: 'client', campaign_id: 'client', seat_id: 'dsp',
  seat_multi: 'dsp',
  deal_sheet_recipient: 'submitter',
  // per-deal rules (also carry a deals[N] fieldPath, mapped here as a backstop)
  deal_theme: 'deals', deal_channel: 'deals', deal_ssp: 'deals', deal_inv: 'deals',
  deal_segments: 'deals', deal_cpm: 'deals', deal_vcr: 'deals',
  qa_duplicate_deals: 'deals', geo_exclude_unsupported: 'deals',
  iab_campaign_retired: 'deals',
  // SSP-config rules
  ox_package: 'ssp', ox_deal_price: 'ssp', ox_buyers: 'ssp', ox_fee: 'ssp',
  ox_pmp_type: 'ssp', pm_publishers: 'ssp', xn_deal_code: 'ssp',
  xn_insertion_order: 'ssp', tl_price_type: 'ssp', tl_channel: 'ssp',
  mn_margin: 'ssp',
  mg_marketplace: 'ssp', mg_publishers: 'ssp', mg_floor: 'ssp',
  mg_ctv_price_type: 'ssp',
  mg_sizes: 'deals', mg_dvplus_audience: 'deals',
  // files
  domain_type: 'files', openx_app_bundle_blocklist: 'files', list_selection: 'files',
  openx_inventory_attachment: 'files',
}

/** The single source of truth for "which section does this audit check belong
 *  to". fieldPath wins (it's stable and enables the red input outline); the
 *  rule-name map is the fallback for section-level rules with no field. Shared
 *  by the section-header indicators AND the AuditResult "Fix →" jump so they
 *  never disagree. Returns undefined only for a genuinely unknown check. */
export function checkToSectionId(check: AuditCheck): SectionId | undefined {
  const fp = check.fieldPath
  if (fp) {
    if (/^deals\[\d+\]/.test(fp) || (typeof check.dealIndex === 'number' && check.dealIndex >= 0)) return 'deals'
    if (fp.startsWith('ixConfig') || fp.startsWith('openxConfig') || fp.startsWith('xandrConfig') ||
        fp.startsWith('tripleliftConfig') || fp.startsWith('medianetConfig') || fp.startsWith('pubmaticConfig') ||
        fp.startsWith('magniteConfig')) return 'ssp'
    if (fp === 'seatId' || fp.startsWith('dsps')) return 'dsp'
    if (['submitterName', 'submitterEmail', 'flightStartDate', 'flightEndDate', 'requestedDueDate', 'dealSheetRecipient'].includes(fp)) return 'submitter'
    // Commercials (fee/pacing/KPI) live in the Campaign section since the 2026-07
    // restructure; the legacy default* fields and campaign-wide iabCategories
    // resolve on the deal cards where their per-deal editors live now.
    if (['agency', 'brand', 'campaignId', 'campaignName', 'dataPartner', 'funnel', 'attributionCode', 'salesperson', 'reportingLabels.salesperson', 'curatedDealFee', 'feeType', 'dailyPacingGoal', 'kpiGoal'].includes(fp)) return 'client'
    if (['defaultVideoCpm', 'defaultDisplayCpm', 'defaultVcr', 'defaultInventoryType', 'defaultLanguage', 'iabCategories'].includes(fp)) return 'deals'
    if (fp === 'expectedAdCategory') return 'ssp'
  }
  return RULE_TO_SECTION_ID[check.rule]
}

/** Count failed audit checks per section so the section header indicator can go
 *  red even when the live field-validation for that section is green — the
 *  "validation says fine but the audit failed here" gap. A failure we can't map
 *  to a section is force-counted into `submitter` (the first section) so it can
 *  NEVER be silently invisible — better an over-eager indicator than a green
 *  section hiding a real blocker. */
export function auditIssuesBySection(audit: AuditResult | null): Record<SectionId, number> {
  const out: Record<SectionId, number> = { submitter: 0, client: 0, ssp: 0, dsp: 0, deals: 0, files: 0 }
  if (!audit) return out
  for (const c of audit.checks) {
    if (c.passed) continue
    const s = checkToSectionId(c) ?? 'submitter'
    out[s]++
  }
  return out
}

/** Map a backend AuditCheck.fieldPath to a top-level form field id we can
 *  scrollIntoView on. Per-deal field paths return the deal-card anchor. */
export function fieldPathToElementId(check: AuditCheck): string | undefined {
  if (typeof check.dealIndex === 'number' && check.dealIndex >= 0 && check.fieldPath) {
    return `deal-${check.fieldPath.replace(/[^a-zA-Z0-9]/g, '-')}-${check.dealIndex}`
  }
  const fp = check.fieldPath
  if (!fp) return undefined
  // DSP entries are keyed by id in the DOM, not index — the section jump is the
  // best we can do here; the red border on the input still points it out.
  if (fp.startsWith('dsps')) return undefined
  // fieldPath → the input's DOM id, so "Fix →" scrolls to and focuses the exact
  // field. Keep in sync with the id="…" on each input.
  const ELEMENT_ID: Record<string, string> = {
    submitterName: 'submitterName', submitterEmail: 'submitterEmail',
    flightStartDate: 'flightStartDate', flightEndDate: 'flightEndDate',
    requestedDueDate: 'requestedDueDate', dealSheetRecipient: 'dealSheetRecipient',
    agency: 'agency', brand: 'brand', campaignId: 'campaignId',
    campaignName: 'campaignName', dataPartner: 'dataPartner',
    funnel: 'funnel', attributionCode: 'attributionCode',
    salesperson: 'salesperson', 'reportingLabels.salesperson': 'salesperson',
    curatedDealFee: 'curatedDealFee', feeType: 'feeType',
    dailyPacingGoal: 'dailyPacingGoal', kpiGoal: 'kpiGoal',
    expectedAdCategory: 'expectedAdCategory',
    'ixConfig.accountId': 'ix-account',
    'magniteConfig.floorCpm': 'mg-floor',
    'magniteConfig.priceType': 'mg-price-type',
    'openxConfig.packageName': 'ox-package', 'openxConfig.dealPrice': 'ox-deal-price',
    'openxConfig.pmpDealType': 'ox-pmp', 'openxConfig.grossShare': 'ox-gross-share',
    'xandrConfig.insertionOrder': 'xn-io',
    'tripleliftConfig.dealPriceType': 'tl-price-type', 'tripleliftConfig.channel': 'tl-channel',
    'medianetConfig.marginValue': 'mn-margin-val',
    'magniteConfig.marketplace': 'mg-marketplace',
    'pubmaticConfig.publisherNames': 'pm-publishers',
  }
  return ELEMENT_ID[fp]
}

import { describe, expect, it } from 'vitest'
import { DealEntry, DEFAULT_FORM, FormData, newDeal, StandardList } from '../types/deal'
import {
  BATCH_OPERATING_PREAMBLE,
  activeExclusionOverride,
  buildBatchPrompt,
  buildCriticalActionsBlock,
  collectSubmitListIds,
  dealListLabel,
  generateDealPromptYaml,
  exclusionOverridePhrase,
  quote,
  resolveAdDuration,
  resolveReportingLabels,
  sanitizeIxLabelValue,
  standardListAsFile,
  standardListUploadName, businessTodayISO } from './dealPromptYaml'

describe('typed exclusion override (#256)', () => {
  it('strips unsupported trader audience + geo values and emits the canonical envelope', () => {
    const deal: DealEntry = {
      ...newDeal(), id: 'd-override', theme: 'Test', channel: 'Display', ssp: 'OpenX', inventoryType: 'All',
      excludeSegments: ['Blocked Audience'], geoExclude: [{ id: 'gx', type: 'zip', value: '90210' }],
      exclusionOverride: { ssp: 'OpenX', acknowledgement: exclusionOverridePhrase('OpenX') },
    }
    const form: FormData = { ...DEFAULT_FORM, deals: [deal], defaultGeoInclude: [{ id: 'us', type: 'country', value: 'US' }] }
    const detail = activeExclusionOverride(form, deal)
    expect(detail).toEqual({ deal_id: 'd-override', ssp: 'OpenX', audience: ['Blocked Audience'], geo: ['zip:90210'], source: 'trader' })
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain(`# EXCLUSION_OVERRIDE: ${JSON.stringify(detail)}`)
    expect(out).toContain('audience_segments_exclude: []')
    expect(out).not.toContain('# NOT SUPPORTED on OpenX: audience segment EXCLUSION')
    expect(out).not.toContain('# BLOCKED — UNSUPPORTED TARGETING: OpenX geo exclusion')
  })

})

// quote() must escape newlines + control chars so a hostile/pasted value (e.g.
// a nameOverride with an embedded \n) can never break out of the emitted
// double-quoted YAML scalar.
describe('quote', () => {
  it('escapes newlines and control characters', () => {
    expect(quote('bad\nname')).toBe('"bad\\nname"')
    expect(quote('tab\there')).toBe('"tab\\there"')
    expect(quote('cr\rname')).toBe('"cr\\rname"')
    expect(quote('bell\u0007x')).toBe('"bell\\x07x"')
  })
  it('still passes bare slot-joined names through verbatim', () => {
    expect(quote('Partner_Index_TTD_A_B_NA_S_Display_All_US_DEAL00001_A1')).toBe('Partner_Index_TTD_A_B_NA_S_Display_All_US_DEAL00001_A1')
  })
})

// =============================================================================
// Fixture — mirrors the two-deal IX batch the cutlass smoke
// test landed live on 2026-05-12 (deal IDs IX177860742221920008 +
// IX177860744311568822). The shape and field choices here lock in the prompt
// format that produced a clean run.
// =============================================================================


function twoDealIxFixture(): FormData {
  const airQualityDeal = {
    ...newDeal(),
    theme: 'Air Quality',
    channel: 'CTV' as const,
    ssp: 'Index Exchange' as const,
    inventoryType: 'All' as const,
    includeSegments: [
      'The Weather Company > Weather Targeting > Absolute > Current > Hazardous Air Quality',
      'The Weather Company > Weather Targeting > Severe Weather > Current > Air Quality Alerts',
    ],
    excludeSegments: ['Weather Block List'],
    cpm: '0.10',
    externalReferenceId: 'PARTNER-REF-1443691',
  }
  const allergyDeal = {
    ...newDeal(),
    theme: 'Allergy',
    channel: 'CTV' as const,
    ssp: 'Index Exchange' as const,
    inventoryType: 'All' as const,
    includeSegments: [
      'The Weather Company > Weather Targeting > Health > Current > Allergy Symptoms',
      'The Weather Company > Weather Targeting > Relative > Current > High Pollen',
    ],
    excludeSegments: ['Weather Block List'],
    cpm: '0.10',
    externalReferenceId: 'PARTNER-REF-1443692',
  }
  return {
    ...DEFAULT_FORM,
    submitterName: 'Ryan Mason',
    submitterEmail: 'planner@example.com',
    flightStartDate: '2026-05-11',
    flightEndDate: '2026-12-31',
    agency: 'OMC',
    brand: 'Northwind Health',
    campaignId: 'DEAL00129',
    attributionCode: 'B14',
    reportingLabels: { ...DEFAULT_FORM.reportingLabels, salesperson: 'Meyako Hughes' },
    deals: [airQualityDeal, allergyDeal],
  }
}

// =============================================================================
// Operating-constraints preamble
// =============================================================================

describe('BATCH_OPERATING_PREAMBLE', () => {
  it('encodes the four post-SendGrid-enable constraints', () => {
    // MOC ships with SendGrid enabled — the legacy "1. SendGrid is NOT
    // configured" rule is gone. The remaining four lines are the universal
    // run-time gates: typed critical_actions, validate_brief, IX retry,
    // and the IX-scoped geo_states ban.
    expect(BATCH_OPERATING_PREAMBLE).toMatch(/^Operating constraints for THIS run:/)
    expect(BATCH_OPERATING_PREAMBLE).toMatch(/1\. Use the TYPED critical_actions field/)
    expect(BATCH_OPERATING_PREAMBLE).toMatch(/2\. MUST call mcp_deal_sheet_validate_brief BEFORE confirm_audit/)
    expect(BATCH_OPERATING_PREAMBLE).toMatch(/3\. If ix_execute_deal_from_prompt_inputs returns "Failed to load segments"/)
    // #238.7 (FAILS OLD): rule 4 was a GLOBAL "Do NOT pass geo_states"
    // while PubMatic/Xandr deal blocks legitimately emit geo_states — an agent
    // obeying it literally widened state-targeted PM/XN deals to whole-country.
    // The ban is now scoped to Index Exchange with an explicit PM/XN carve-out.
    expect(BATCH_OPERATING_PREAMBLE).toMatch(/4\. INDEX EXCHANGE ONLY: do NOT pass geo_states to any Index Exchange tool/)
    expect(BATCH_OPERATING_PREAMBLE).toMatch(/does NOT apply to other SSPs: PubMatic and Xandr/)
    expect(BATCH_OPERATING_PREAMBLE).not.toMatch(/4\. Do NOT pass geo_states/)
    // The legacy SendGrid rule is gone — make sure it stays gone.
    expect(BATCH_OPERATING_PREAMBLE).not.toMatch(/SendGrid is NOT configured/)
  })
})

// =============================================================================
// buildBatchPrompt — two-deal IX fixture
// =============================================================================

describe('buildBatchPrompt — two-deal IX', () => {
  it('emits the operating-constraints preamble verbatim', () => {
    const out = buildBatchPrompt(twoDealIxFixture())
    expect(out).toContain(BATCH_OPERATING_PREAMBLE)
  })


  it('NEVER emits geo_states — sidesteps the IX MCP regionCode resolver bug', () => {
    const out = buildBatchPrompt(twoDealIxFixture())
    expect(out).not.toMatch(/^\s*geo_states\s*:/m)
  })


  it('emits the Required final summary section', () => {
    const out = buildBatchPrompt(twoDealIxFixture())
    expect(out).toContain('Required final summary')
    expect(out).toContain('build_deal_sheet output XLSX path')
    expect(out).toContain('typed critical_actions field')
    expect(out).toContain('validate_brief before confirm_audit')
  })

  it('still emits the existing client_name + theme + deals YAML brief structure', () => {
    // Backward-compat: the new preamble/critical_actions/summary blocks must
    // not displace the existing structured brief that
    // cutlass/protocols/deal-brief.schema.yaml consumes.
    const out = buildBatchPrompt(twoDealIxFixture())
    expect(out).toMatch(/^client_name: "Northwind Health"$/m)
    // theme is a simple identifier so the YAML emitter leaves it unquoted
    expect(out).toMatch(/^theme: default$/m)
    expect(out).toMatch(/^deals:$/m)
    expect(out).toMatch(/^final_step:$/m)
  })
})

// =============================================================================
// Deal-sheet theme — with no client presets every batch renders the default
// sheet theme.
// =============================================================================

describe('buildBatchPrompt — deal-sheet theme', () => {
  function themeForm(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2099-01-01', flightEndDate: '2099-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL50001',
      deals: [{
        ...newDeal(), ssp: 'OpenX' as const, channel: 'Display' as const,
        cpm: '0.10', theme: 'Segment', externalReferenceId: 'X-1',
      }],
    }
  }


  it('emits a form-selected registered theme (default)', () => {
    const out = buildBatchPrompt({ ...themeForm(), dealSheetTheme: 'default' })
    expect(out).toMatch(/^theme: default$/m)
    expect(out).not.toContain('is not a registered deal_sheet theme')
  })

  it('falls back to the default theme (with a note) for an unregistered pick', () => {
    const out = buildBatchPrompt({ ...themeForm(), dealSheetTheme: 'not-a-theme' })
    expect(out).toMatch(/^theme: default$/m)
    expect(out).toContain('is not a registered deal_sheet theme')
  })



  it('falls back to the default theme when the form has no pick', () => {
    const out = buildBatchPrompt(themeForm())
    expect(out).toMatch(/^theme: default$/m)
  })
})

// =============================================================================
// Reporting email alias — follows the campaign_id onto the deal sheet + the
// deal-sheet email. The cutlass counterpart adds the optional build_deal_sheet
// arg + the {reporting_email_alias} slot in the email template; the arg name
// `reporting_email_alias` is that contract.
// =============================================================================


// =============================================================================
// buildCriticalActionsBlock — helper-level coverage
// =============================================================================

describe('buildCriticalActionsBlock', () => {
  it('returns an empty string when no batch-supported deals exist', () => {
    const form = { ...DEFAULT_FORM, deals: [] }
    expect(buildCriticalActionsBlock(form)).toBe('')
  })

  it('includes Magnite deals (API-backed since June 2026)', () => {
    const ixDeal = {
      ...newDeal(),
      ssp: 'Index Exchange' as const,
      channel: 'CTV' as const,
      externalReferenceId: 'IX-deal',
    }
    const magniteDeal = {
      ...newDeal(),
      ssp: 'Magnite' as const,
      channel: 'CTV' as const,
      externalReferenceId: 'Magnite-deal',
    }
    const form = { ...DEFAULT_FORM, deals: [ixDeal, magniteDeal] }
    const block = buildCriticalActionsBlock(form)
    expect(block).toContain('IX-deal')
    expect(block).toContain('Magnite-deal')
    expect(block).toContain('mcp_magnite_mcp_magnite_execute_deal_from_prompt_inputs')
    // 3 tool entries: IX + Magnite deals + the always-emitted send_email finalizer.
    expect(block.match(/- tool:/g)).toHaveLength(3)
    expect(block).toContain('- tool: mcp_sendgrid_send_email')
  })

  it('uses the per-SSP canonical execute tool name', () => {
    const ixDeal = { ...newDeal(), ssp: 'Index Exchange' as const, channel: 'CTV' as const, externalReferenceId: 'x' }
    const openxDeal = { ...newDeal(), ssp: 'OpenX' as const, channel: 'Display' as const, externalReferenceId: 'y' }
    const form = { ...DEFAULT_FORM, deals: [ixDeal, openxDeal] }
    const block = buildCriticalActionsBlock(form)
    expect(block).toContain('mcp_indexexchange_mcp_ix_execute_deal_from_prompt_inputs')
    expect(block).toContain('mcp_openx_mcp_ox_execute_deal_from_prompt_inputs')
  })


})

// =============================================================================
// Per-SSP critical_actions tool-name coverage — every supported SSP must
// resolve to its canonical execute_deal_from_prompt_inputs (or
// SSP-specific equivalent) when the typed audit declaration is built.
// These tests would catch a SSP_TO_BATCH_TOOL map regression that the
// individual smoke tests in the cutlass repo can't cheaply catch.
// =============================================================================

describe('buildCriticalActionsBlock — per-SSP canonical tool names', () => {
  const cases: Array<{ ssp: 'OpenX' | 'PubMatic' | 'Xandr' | 'TripleLift' | 'Media.net'; expectedTool: string }> = [
    { ssp: 'OpenX', expectedTool: 'mcp_openx_mcp_ox_execute_deal_from_prompt_inputs' },
    { ssp: 'PubMatic', expectedTool: 'mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs' },
    { ssp: 'Xandr', expectedTool: 'mcp_xandr_mcp_xandr_execute_deal_from_prompt_inputs' },
    { ssp: 'TripleLift', expectedTool: 'mcp_triplelift_mcp_tl_create_deal' },
    { ssp: 'Media.net', expectedTool: 'mcp_medianet_mcp_mn_execute_deal_from_prompt_inputs' },
  ]

  for (const { ssp, expectedTool } of cases) {
    it(`emits ${expectedTool} for ${ssp} deals`, () => {
      const deal = {
        ...newDeal(),
        ssp: ssp as DealEntry['ssp'],
        channel: 'CTV' as const,
        externalReferenceId: `${ssp}-test-deal`,
      }
      const form = { ...DEFAULT_FORM, deals: [deal] }
      const block = buildCriticalActionsBlock(form)
      expect(block).toContain(`- tool: ${expectedTool}`)
      expect(block).toContain('identifier:')
      expect(block).toContain(`${ssp}-test-deal`)
    })
  }
})

// =============================================================================
// Per-SSP batch prompt smoke — confirm each supported SSP produces a
// non-empty per-deal prompt body inside the YAML brief structure and that
// the body invokes the right MCP tool. Catches accidental break-glass
// changes to SSP_TO_BATCH_TOOL or individual builder helpers.
// =============================================================================

describe('buildBatchPrompt — per-SSP body content', () => {
  function singleSspForm(ssp: DealEntry['ssp'], channel: DealEntry['channel'] = 'CTV'): FormData {
    const deal = {
      ...newDeal(),
      ssp,
      channel,
      externalReferenceId: `${ssp}-sample`,
      includeSegments: ['Sample Segment'],
      cpm: '5.00',
    }
    return {
      ...DEFAULT_FORM,
      submitterName: 'Test Trader',
      submitterEmail: 'trader@example.com',
      flightStartDate: '2026-06-01',
      flightEndDate: '2026-12-31',
      agency: 'TestAgency',
      brand: 'TestBrand',
      campaignId: 'DEAL99999',
      deals: [deal],
    }
  }

  it('OpenX batch prompt invokes ox_execute_deal_from_prompt_inputs', () => {
    const out = buildBatchPrompt(singleSspForm('OpenX', 'Display'))
    expect(out).toContain('mcp_openx_mcp_ox_execute_deal_from_prompt_inputs')
    // OpenX always-emit of audience_segments_exclude — even as [] — landed
    // in this follow-up. Verify it shows up in the per-deal body.
    expect(out).toContain('audience_segments_exclude')
  })

  it('PubMatic batch prompt invokes pm_execute_deal_from_prompt_inputs', () => {
    const out = buildBatchPrompt(singleSspForm('PubMatic'))
    expect(out).toContain('mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs')
  })

  it('Xandr batch prompt invokes xandr_execute_deal_from_prompt_inputs', () => {
    const out = buildBatchPrompt(singleSspForm('Xandr'))
    expect(out).toContain('mcp_xandr_mcp_xandr_execute_deal_from_prompt_inputs')
  })

  it('Xandr prompt emits insertion_order_id + advertiser_id from the catalog (hyphen/en-dash tolerant)', () => {
    const form = singleSspForm('Xandr')
    // Hyphen variant of the en-dash catalog name "Example – Marketplace Pro" —
    // the resolver normalizes it and emits the explicit ids so the MCP uses its
    // verified happy-path instead of an unverified live GET /insertion-order.
    form.xandrConfig = { ...form.xandrConfig, insertionOrder: 'Example - Marketplace Pro' }
    const out = buildBatchPrompt(form)
    expect(out).toContain('insertion_order_id: 1000001')
    expect(out).toContain('advertiser_id: 2000001')
    expect(out).not.toContain('insertion_order_name:')
  })

  it('Xandr prompt falls back to insertion_order_name for an IO not in the catalog', () => {
    const form = singleSspForm('Xandr')
    form.xandrConfig = { ...form.xandrConfig, insertionOrder: 'Brand New IO Not In Catalog' }
    const out = buildBatchPrompt(form)
    expect(out).toContain('insertion_order_name: "Brand New IO Not In Catalog"')
    expect(out).not.toContain('insertion_order_id:')
  })

  it('Xandr prompt omits end_date so the deal is created always-on per house policy', () => {
    // The Xandr MCP + protocol both confirm always-on support (Cutlass audit
    // 2026-05-21). The YAML must NOT carry an end_date: line for Xandr deals,
    // and must surface the omission so MOC operators understand the intent.
    const out = buildBatchPrompt(singleSspForm('Xandr', 'CTV'))
    // The "end_date intentionally omitted" comment must be present.
    expect(out).toContain('end_date intentionally omitted — Xandr always-on per house policy')
    // No "end_date:" key should appear in the Xandr prompt_inputs body
    // (the per-deal-block YAML). The batch envelope still has its own
    // `end_date:` field at the wrapper level, which is informational.
    // Restrict the search to within the prompt_inputs block.
    const promptInputsMatch = /prompt_inputs:\s*\|([\s\S]*?)(?=\n  -|\nfinal_step:)/.exec(out)
    expect(promptInputsMatch, 'expected prompt_inputs block in output').not.toBeNull()
    const promptInputs = promptInputsMatch![1]
    // start_date is either the ET-midnight-as-UTC instant (future start) or —
    // for a today-start like this dateless form — omitted with the loud
    // comment (cutlass#744.8: Xandr stores naive datetimes as UTC, so a
    // midnight value would go live the prior evening ET).
    expect(promptInputs).toMatch(/start_date:|start_date omitted — this deal starts TODAY/)
    expect(promptInputs).not.toMatch(/^\s*end_date:\s/m)
  })

  it('TripleLift batch prompt invokes tl_create_deal', () => {
    const out = buildBatchPrompt(singleSspForm('TripleLift'))
    expect(out).toContain('mcp_triplelift_mcp_tl_create_deal')
  })

  it('Media.net batch prompt invokes mn_execute_deal_from_prompt_inputs', () => {
    const out = buildBatchPrompt(singleSspForm('Media.net'))
    expect(out).toContain('mcp_medianet_mcp_mn_execute_deal_from_prompt_inputs')
  })

  it('every supported SSP body emits the operating preamble + final summary', () => {
    // The cross-SSP universal blocks must not be silently dropped for any SSP.
    for (const ssp of ['OpenX', 'PubMatic', 'Xandr', 'TripleLift', 'Media.net'] as const) {
      const out = buildBatchPrompt(singleSspForm(ssp, ssp === 'OpenX' ? 'Display' : 'CTV'))
      expect(out, `${ssp}: missing preamble`).toContain(BATCH_OPERATING_PREAMBLE)
      expect(out, `${ssp}: missing final summary`).toContain('Required final summary')
      expect(out, `${ssp}: missing critical_actions block`).toContain('Audit declaration (typed critical_actions list)')
    }
  })
})

// =============================================================================
// OpenX always-emit audience_segments_exclude
// =============================================================================

describe('buildOpenXPrompt via buildBatchPrompt — exclude-segments always-emit', () => {
  it('emits audience_segments_exclude: [] when the client has no exclusions', () => {
    const deal = {
      ...newDeal(),
      ssp: 'OpenX' as const,
      channel: 'Display' as const,
      externalReferenceId: 'openx-no-excludes',
      includeSegments: ['Just Includes'],
      excludeSegments: [], // explicitly empty
      cpm: '5.00',
    }
    const form: FormData = {
      ...DEFAULT_FORM,
      submitterName: 'T',
      submitterEmail: 't@example.com',
      flightStartDate: '2026-06-01',
      flightEndDate: '2026-12-31',
      agency: 'A',
      brand: 'B',
      campaignId: 'DEAL99998',
      deals: [deal],
    }
    const out = buildBatchPrompt(form)
    expect(out).toContain('audience_segments_exclude: []')
  })

  it('#226 F2: excludes present → field stays [] (never the VALUES) + a loud NOT-SUPPORTED marker', () => {
    const deal = {
      ...newDeal(),
      ssp: 'OpenX' as const,
      channel: 'Display' as const,
      externalReferenceId: 'openx-with-excludes',
      includeSegments: ['Includes'],
      excludeSegments: ['BadSegment'],
      cpm: '5.00',
    }
    const form: FormData = {
      ...DEFAULT_FORM,
      submitterName: 'T',
      submitterEmail: 't@example.com',
      flightStartDate: '2026-06-01',
      flightEndDate: '2026-12-31',
      agency: 'A',
      brand: 'B',
      campaignId: 'DEAL99997',
      deals: [deal],
    }
    const out = buildBatchPrompt(form)
    // F2: OpenX can't enforce audience excludes — the VALUES are NEVER emitted
    // (they'd hard-fail the MCP), the field ships empty for recognition, and a
    // loud NOT-SUPPORTED marker carries the requested segment.
    expect(out).toContain('audience_segments_exclude: []')
    expect(out).not.toMatch(/audience_segments_exclude:\s*\n\s+-\s+BadSegment\b/)
    // inlineList leaves the bare identifier unquoted → [BadSegment].
    expect(out).toContain('# NOT SUPPORTED on OpenX: audience segment EXCLUSION(s) [BadSegment]')
  })
})

// =============================================================================
// Fabrikam Display political-compliance batch (MOC session-1778692463 shape).
//
// Locks in:
//   - Expected Sensitive Category is a MANUAL post-create UI step (verified
//     2026-08-17: the OpenX partner API rejects expected_ad_category, so the
//     arg must NEVER ship — it renders as a per-deal post_create_ui_fix
//     reminder instead)
//   - one allowlist + three blocklist-by-default deals all carry an
//     explicit domain_match_operator
// =============================================================================


function displayComplianceFixture(): FormData {
  const allowlistFile = {
    id: 'f1', name: 'political_compliant_inventory.csv', size: 1, path: '/input/political_compliant_inventory.csv',
    inclusionType: 'Include' as const,
  }
  const blocklistFile = {
    id: 'f2', name: 'long_tail_block_list.csv', size: 1, path: '/input/long_tail_block_list.csv',
    inclusionType: 'Exclude' as const,
  }
  const baseDeal: Partial<DealEntry> = {
    ssp: 'OpenX' as const,
    channel: 'Display' as const,
    inventoryType: 'Web Only' as const,
    cpm: '0.10',
  }
  const newsDeal: DealEntry = { ...newDeal(), ...baseDeal, theme: 'Local News Consumers', externalReferenceId: 'FabrikamDisplay-1' }
  const voterDeal: DealEntry = { ...newDeal(), ...baseDeal, theme: '2026 Voter Issues', externalReferenceId: 'FabrikamDisplay-2' }
  const medicareDeal: DealEntry = { ...newDeal(), ...baseDeal, theme: 'Medicare', externalReferenceId: 'FabrikamDisplay-3' }
  const healthDeal: DealEntry = { ...newDeal(), ...baseDeal, theme: 'Healthcare Issues', externalReferenceId: 'FabrikamDisplay-4' }
  return {
    ...DEFAULT_FORM,
    submitterName: 'Trader',
    submitterEmail: 'trader@example.com',
    flightStartDate: '2026-05-13',
    flightEndDate: '',
    agency: 'TRADR',
    brand: 'Fabrikam',
    campaignId: 'DEAL00152',
    attributionCode: 'A4',
    expectedAdCategory: 'Politics',
    openxConfig: {
      ...DEFAULT_FORM.openxConfig,
      dealPrice: '0.10',
      feePartner: 'Curator',
      grossShare: '30',
      pmpDealType: '3',
      buyers: [{ id: '1', buyerId: '393', isMain: true }],
    },
    // Deal 2 ships an allowlist; the other three ship the standard blocklist.
    // The file-routing layer normally picks one per deal — for the fixture
    // we put both files in domainLists and rely on resolve() picking [0].
    // To get the per-deal effect we mutate domainLists between renders in
    // the assertions below.
    domainLists: [blocklistFile, allowlistFile],
    deals: [newsDeal, voterDeal, medicareDeal, healthDeal],
  }
}

describe('buildBatchPrompt — Display compliance batch', () => {
  it('never ships expected_ad_category as an MCP arg — the sensitive category is a manual post-create reminder on each OpenX deal', () => {
    const out = buildBatchPrompt(displayComplianceFixture())
    // The OpenX partner API rejects the field (verified 2026-08-17), so the
    // create arg must NOT appear anywhere in the prompt.
    expect(out).not.toMatch(/expected_ad_category:/)
    // Instead every OpenX deal carries the injected manual reminder.
    const reminders = out.match(/MANUAL \(trader, after create\): set Expected Sensitive Category = 'Politics'/g)
    expect(reminders).not.toBeNull()
    expect(reminders!.length).toBe(4)
    // And the summary contract tells the agent to list the deals needing the
    // manual step — never to attempt it via a tool.
    expect(out).toContain('List every OpenX deal that needs the MANUAL post-create step: set Expected Sensitive Category = "Politics"')
  })

  it('emits domain_match_operator on every deal with a domain file', () => {
    const out = buildBatchPrompt(displayComplianceFixture())
    // The first-in-domainLists is the blocklist file, so every deal's
    // prompt body must show "domain_match_operator: blocklist".
    const matches = out.match(/domain_match_operator: blocklist/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(4)
    // Crucially, the legacy "domain_targeting_option: Include/Exclude"
    // emission is gone — that was the OpenX MCP rejection cause.
    expect(out).not.toMatch(/domain_targeting_option:\s*(Include|Exclude)/i)
  })

  it('does not include the legacy SendGrid-not-configured rule', () => {
    const out = buildBatchPrompt(displayComplianceFixture())
    expect(out).not.toContain('SendGrid is NOT configured')
    expect(out).not.toContain('NO send_email entry')
    expect(out).toContain('- tool: mcp_sendgrid_send_email')
  })

  it('emits the followup_step that sends the deal-sheet email', () => {
    const out = buildBatchPrompt(displayComplianceFixture())
    expect(out).toMatch(/^followup_step:$/m)
    expect(out).toContain('  tool: mcp_sendgrid_send_email')
    expect(out).toContain('Deal Sheet — DEAL00152 — Fabrikam (4 deals)')
  })

  // Multi-recipient chip input: FIRST address is the To (the protocol's
  // single-trader `recipient`/`to_email` contract); the rest cc the same
  // send via the schema-blessed cc_recipients / cc_emails lists.
  it('splits a multi-recipient list into recipient (first) + cc lists (rest)', () => {
    const form = displayComplianceFixture()
    form.dealSheetRecipient = 'elyse@example.com, brad@example.com, ops@example.com'
    const out = buildBatchPrompt(form)
    expect(out).toContain('recipient: "elyse@example.com"')
    expect(out).toContain('cc_recipients: ["brad@example.com", "ops@example.com"]')
    expect(out).toContain('    to_email: "elyse@example.com"')
    expect(out).toContain('    cc_emails: ["brad@example.com", "ops@example.com"]')
    // The critical-actions identifier binds to the To address only.
    expect(out).toContain('Deal sheet → elyse@example.com')
  })

  it('a single recipient keeps the pre-chip wire shape (no cc keys)', () => {
    const out = buildBatchPrompt(displayComplianceFixture())
    expect(out).toContain('cc_recipients: []')
    expect(out).not.toContain('cc_emails')
  })
})

// =============================================================================
// DataCo CTV batch (MOC session-1778622687 shape).
//
// Locks in the rest of the OpenX-MCP-arg-parity wins:
//   - excluded_publisher_ids replaces the broken targeting.custom NOT path
//   - inventory_categories defaults to "TV by OpenX - CTV - App Bundles" for
//     CTV deals
//   - blocklist-by-default domain handling is explicit
//   - per-deal post_create_ui_fix entries auto-suppress when the underlying
//     MCP arg is now populated by this prompt
// =============================================================================

function reklaimCtvFixture(): FormData {
  const blocklistFile = {
    id: 'f3', name: 'long_tail_block_list_latest.csv', size: 1,
    path: '/input/long_tail_block_list_latest.csv',
    inclusionType: 'Exclude' as const,
  }
  const baseDeal: Partial<DealEntry> = {
    ssp: 'OpenX' as const,
    channel: 'CTV' as const,
    inventoryType: 'All' as const,
    cpm: '0.10',
  }
  const democratDeal: DealEntry = {
    ...newDeal(), ...baseDeal, theme: 'Democratic Voters',
    externalReferenceId: 'PartnerCTV-Dem',
    includeSegments: ['DataCo > Political Affiliation > Democrat'],
  }
  const republicanDeal: DealEntry = {
    ...newDeal(), ...baseDeal, theme: 'Republican Voters',
    externalReferenceId: 'PartnerCTV-Rep',
    includeSegments: ['DataCo > Political Affiliation > Republican'],
  }
  const independentDeal: DealEntry = {
    ...newDeal(), ...baseDeal, theme: 'Independent Voters',
    externalReferenceId: 'PartnerCTV-Ind',
    includeSegments: ['DataCo > Political Affiliation > Independent'],
  }
  const hispanicDeal: DealEntry = {
    ...newDeal(), ...baseDeal, theme: 'Hispanic Voters',
    externalReferenceId: 'PartnerCTV-Hisp',
    includeSegments: ['DataCo > Political > Hispanic Voters'],
    // Trader-written reminder — renders verbatim (the manual step is real),
    // and its presence stops the builder injecting a duplicate
    // sensitive-category line on this deal.
    postCreateUiFix: ['Set Expected Sensitive Category = Politics in OpenX UI'],
  }
  const multiculturalDeal: DealEntry = {
    ...newDeal(), ...baseDeal, theme: 'Multicultural Voters',
    externalReferenceId: 'PartnerCTV-Multi',
    // No audience — trader will add in UI. iab_hint surfaces this.
    iabHint: 'Trader will add audience segment in OpenX UI during QA.',
    notes: ['Audience to be set in OpenX UI during QA (Multicultural Voters).'],
  }
  return {
    ...DEFAULT_FORM,
    submitterName: 'Trader',
    submitterEmail: 'trader@example.com',
    flightStartDate: '2026-05-12',
    flightEndDate: '',
    agency: 'TRADR',
    brand: 'Fabrikam',
    dataPartner: 'DataCo',
    campaignId: 'DEAL00151',
    attributionCode: 'B6',
    expectedAdCategory: 'Politics',
    openxConfig: {
      ...DEFAULT_FORM.openxConfig,
      dealPrice: '0.10',
      feePartner: 'DataCo',
      grossShare: '30',
      pmpDealType: '3',
      buyers: [{ id: '1', buyerId: '393', isMain: true }],
      excludedPublisherIds: ['193155', '209125'],
    },
    // CTV deals route to appBundleLists (per resolve() in dealPromptYaml.ts),
    // not domainLists. Put the blocklist file there so the per-deal prompt
    // body emits the domain_match_operator arg.
    appBundleLists: [blocklistFile],
    deals: [democratDeal, republicanDeal, independentDeal, hispanicDeal, multiculturalDeal],
  }
}

describe('buildBatchPrompt — DataCo CTV batch', () => {
  it('emits excluded_publisher_ids on every OpenX deal body', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    // quote() emits numeric strings unquoted, so the list serializes as
    // `[193155, 209125]` (no surrounding quotes per id).
    const matches = out.match(/excluded_publisher_ids: \[193155, 209125\]/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(5)
  })

  it('defaults inventory_categories to the CTV App-Bundles category on CTV deals', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    const matches = out.match(/inventory_categories: \["TV by OpenX - CTV - App Bundles"\]/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(5)
  })

  it('emits app_bundle_match_operator=blocklist for the attached app-bundle blocklist on CTV deals', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    // CTV deals route to appBundleLists, so the per-deal YAML must emit the
    // app-bundle arg triplet — NOT the domain_* args.
    const matches = out.match(/app_bundle_match_operator: blocklist/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(5)
    expect(out).not.toMatch(/app_bundle_match_operator: allowlist/)
    // And the wrong-kind keys must NOT appear for these CTV deals.
    expect(out).not.toMatch(/domain_match_operator:/)
    expect(out).not.toMatch(/domain_file_path:/)
    // The app-bundle path must be present; the upload carries no detected
    // column, so the column arg is OMITTED (issue #227 — never a guessed
    // "Bundles" that may not exist in the file).
    expect(out).toMatch(/app_bundle_file_path:/)
    expect(out).not.toMatch(/app_bundle_column:/)
  })

  it('renders the sensitive category as a manual post-create reminder on every OpenX deal, never as an MCP arg', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    expect(out).not.toMatch(/expected_ad_category:/)
    // 4 deals get the injected reminder; the Hispanic deal keeps its own
    // trader-written line (see next test) — 5 deals total carry one each.
    const injected = out.match(/MANUAL \(trader, after create\): set Expected Sensitive Category = 'Politics'/g)
    expect(injected).not.toBeNull()
    expect(injected!.length).toBe(4)
  })

  it('keeps a trader-written "set Expected Sensitive Category" reminder instead of injecting a duplicate', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    // Hispanic deal carried its own postCreateUiFix entry — it renders
    // verbatim (the manual step is real; nothing suppresses it anymore),
    // and the builder must not add a second sensitive-category line to
    // that deal.
    expect(out).toContain('Set Expected Sensitive Category = Politics in OpenX UI')
  })

  it('emits iab_hint and notes for the trader-handled Multicultural deal', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    expect(out).toContain('iab_hint: "Trader will add audience segment in OpenX UI during QA."')
    expect(out).toContain('Audience to be set in OpenX UI during QA (Multicultural Voters).')
  })

  it('includes the send_email finalizer in critical_actions', () => {
    const out = buildBatchPrompt(reklaimCtvFixture())
    expect(out).toContain('- tool: mcp_sendgrid_send_email')
    expect(out).toContain('Deal Sheet — DEAL00151 — Fabrikam (5 deals)')
  })
})

// =============================================================================
// Mixed-channel IX batch — locks in that the resolver picks domain files for
// web channels and app-bundle files for CTV/In-App channels, and that the
// per-deal YAML emits the correctly-prefixed file-targeting block with the
// match_operator derived from each file's Include/Exclude marker.
//
// Regression coverage for the SS-Fabrikam 4-deal IX brief where CTV/OTT
// In-app deals were getting the user's app-bundle upload labeled as
// `domain_file_path` + `domain_column: Sites`.
// =============================================================================

function mixedIxFixture(): FormData {
  const domainAllow = {
    id: 'd1', name: 'preferred_news_sites.csv', size: 1,
    path: '/input/preferred_news_sites.csv',
    inclusionType: 'Include' as const,
  }
  const appExclude = {
    id: 'a1', name: 'app_bundle_block_list.csv', size: 1,
    path: '/input/app_bundle_block_list.csv',
    inclusionType: 'Exclude' as const,
  }
  const displayDeal = {
    ...newDeal(),
    ssp: 'Index Exchange' as const,
    channel: 'Display' as const,
    inventoryType: 'Web Only' as const,
    cpm: '0.10',
    theme: 'News',
    externalReferenceId: 'IX-display',
    includeSegments: ['News Readers'],
  }
  const ctvDeal = {
    ...newDeal(),
    ssp: 'Index Exchange' as const,
    channel: 'CTV' as const,
    inventoryType: 'In-App' as const,
    cpm: '0.10',
    theme: 'News',
    externalReferenceId: 'IX-ctv',
    includeSegments: ['News Viewers'],
  }
  return {
    ...DEFAULT_FORM,
    submitterName: 'Trader',
    submitterEmail: 'trader@example.com',
    flightStartDate: '2026-06-01',
    flightEndDate: '2026-12-31',
    agency: 'SMT',
    brand: 'SS - Fabrikam',
    campaignId: 'DEAL00153',
    attributionCode: 'A4',
    domainLists: [domainAllow],
    appBundleLists: [appExclude],
    deals: [displayDeal, ctvDeal],
  }
}

describe('buildBatchPrompt — mixed-channel IX file routing', () => {
  it('emits domain_* args for the web deal and app_bundle_* args for the CTV deal', () => {
    const out = buildBatchPrompt(mixedIxFixture())
    // Web deal carries the Include-typed domain file → allowlist operator.
    // file_path emits the bare original filename (not /input/) because MOC
    // re-mounts uploads with hash suffixes and resolves by name match.
    expect(out).toMatch(/domain_file_path: "?preferred_news_sites\.csv"?/)
    expect(out).toMatch(/domain_match_operator: allowlist/)
    // CTV deal carries the Exclude-typed app-bundle file → blocklist operator.
    expect(out).toMatch(/app_bundle_file_path: "?app_bundle_block_list\.csv"?/)
    expect(out).toMatch(/app_bundle_match_operator: blocklist/)
    // Neither upload carries a detected column → the column args are OMITTED
    // (issue #227 — the old 'Sites'/'Bundles' guesses could name a column the
    // file doesn't have, or defeat the MCP's headerless handling).
    expect(out).not.toMatch(/domain_column:/)
    expect(out).not.toMatch(/app_bundle_column:/)
  })

  it('never emits domain_* keys for a CTV deal whose only attached file is an app-bundle list', () => {
    // Regression: previously the IX writer keyed every file under
    // domain_file_path regardless of the source pool, so an app-bundle
    // upload on a CTV deal shipped to the MCP as a URL list.
    const out = buildBatchPrompt(mixedIxFixture())
    const ctvBlockMatch = /external_reference_id: IX-ctv[\s\S]*?(?=\n  - ssp:|\nfinal_step:)/.exec(out)
    expect(ctvBlockMatch, 'expected the CTV deal block to be present').not.toBeNull()
    const ctvBlock = ctvBlockMatch![0]
    expect(ctvBlock).not.toMatch(/domain_file_path:/)
    expect(ctvBlock).not.toMatch(/domain_column:/)
    expect(ctvBlock).not.toMatch(/domain_match_operator:/)
  })

  it('a detected column on the file emits that column verbatim', () => {
    // Mirrors the SS-Fabrikam brief where the user's xlsx had columns
    // "Domain" and "Bundle ID" instead of the legacy "Sites"/"Bundles".
    const f = mixedIxFixture()
    f.domainLists[0].detectedColumn = 'Domain'
    f.appBundleLists[0].detectedColumn = 'Bundle ID'
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/domain_column: Domain/)
    expect(out).toMatch(/app_bundle_column: "Bundle ID"/)
    // The fallback hardcoded values must NOT appear now that detection is set.
    expect(out).not.toMatch(/domain_column: Sites/)
    expect(out).not.toMatch(/app_bundle_column: Bundles/)
  })

  it('routes an OTT/In-App deal through the app-bundle pool, not the domain pool', () => {
    const f = mixedIxFixture()
    f.deals[1].channel = 'OTT'
    const out = buildBatchPrompt(f)
    // The OTT deal must reference the app-bundle file, NOT the domain file.
    const ottBlockMatch = /external_reference_id: IX-ctv[\s\S]*?(?=\n  - ssp:|\nfinal_step:)/.exec(out)
    expect(ottBlockMatch, 'expected the OTT deal block to be present').not.toBeNull()
    const ottBlock = ottBlockMatch![0]
    expect(ottBlock).toMatch(/app_bundle_file_path:/)
    expect(ottBlock).not.toMatch(/domain_file_path:/)
    // deal_type carries ott so the IX MCP can branch to phone+tablet+PC.
    expect(ottBlock).toMatch(/deal_type: ott/)
  })

  it('Required final summary calls out both file kinds', () => {
    const out = buildBatchPrompt(mixedIxFixture())
    expect(out).toMatch(/Per deal with a domain file: confirm domain_match_operator was passed/)
    expect(out).toMatch(/Per deal with an app-bundle file: confirm app_bundle_match_operator was passed/)
  })
})

// =============================================================================
// Standard lists — the synthetic UploadedFile now DECLARES its value column
// (matching the literal `Sites`/`Bundles` header row every lists/*.csv carries,
// enforced by internal/lists' header test) instead of riding fileArgsBlock's
// silent fallback. Same emitted string, different honesty: the column is a
// statement about the file, not a guess.
// =============================================================================

describe('standardListAsFile — declared value column', () => {
  const domainList: StandardList = { id: 'longtail-block', name: 'Longtail Block List', kind: 'block', scope: 'domain', line_count: 3 }
  const appList: StandardList = { id: 'example-premium-ctv', name: 'Example Premium CTV Apps', kind: 'allow', scope: 'app_bundle', line_count: 5 }

  it('pins detectedColumn to the scope header — Sites for domain, Bundles for app_bundle', () => {
    expect(standardListAsFile(domainList).detectedColumn).toBe('Sites')
    expect(standardListAsFile(appList).detectedColumn).toBe('Bundles')
    // Kind still translates to the Include/Exclude marker as before.
    expect(standardListAsFile(domainList).inclusionType).toBe('Exclude')
    expect(standardListAsFile(appList).inclusionType).toBe('Include')
  })

  it('an applied standard list emits its declared column through the batch prompt', () => {
    const f = mixedIxFixture()
    f.domainLists = []
    f.appBundleLists = []
    f.appliedDomainListIds = ['longtail-block']
    f.appliedAppBundleListIds = ['example-premium-ctv']
    const out = buildBatchPrompt(f, [domainList, appList])
    // Web deal rides the domain standard list; CTV deal rides the app one.
    expect(out).toMatch(/domain_file_path: "Longtail Block List"/)
    expect(out).toMatch(/domain_column: Sites/)
    expect(out).toMatch(/domain_match_operator: blocklist/)
    expect(out).toMatch(/app_bundle_file_path: "Example Premium CTV Apps"/)
    expect(out).toMatch(/app_bundle_column: Bundles/)
    expect(out).toMatch(/app_bundle_match_operator: allowlist/)
  })
})

// =============================================================================
// #198 — standard-list attachment names carry the data file's extension.
// The MOC upload name is the server's lists.List.UploadName (registry name +
// data-file extension when the name has none); the prompt must reference the
// SAME name or the agent's match degrades to fuzzy (and IX rejects the
// extensionless file outright / OpenX misroutes it). standardListUploadName is
// the frontend half of that byte-identity contract — the Go half is pinned by
// internal/lists TestUploadNameAppendsDataFileExtension with the SAME literals.
// =============================================================================

describe('standardListUploadName — extension-suffixed attachment name (#198)', () => {
  const bare = (over: Partial<StandardList> = {}): StandardList =>
    ({ id: 'longtail-block', name: 'Longtail Block', kind: 'block', scope: 'domain', line_count: 3, file_ext: '.csv', ...over })

  it('appends the data-file extension to an extensionless list name', () => {
    // Byte-identity fixture with Go List{Name:"Longtail Block", Path:"….csv"}.
    expect(standardListUploadName(bare())).toBe('Longtail Block.csv')
    expect(standardListUploadName(bare({ name: 'Premium Allow', file_ext: '.xlsx' }))).toBe('Premium Allow.xlsx')
  })

  it('never double-suffixes a name that already carries a DATA extension', () => {
    expect(standardListUploadName(bare({ name: 'Longtail Block.csv' }))).toBe('Longtail Block.csv')
  })

  // FIX 8 — a version-suffixed name has a non-empty (but non-DATA) extension,
  // so it must STILL gain the real data extension (matches Go
  // TestUploadNameAppendsDataFileExtension's dotted-name cases byte-for-byte).
  it('appends the data extension to a dotted, non-data-extension name (#198 FIX 8)', () => {
    expect(standardListUploadName(bare({ name: 'Sites v2.1' }))).toBe('Sites v2.1.csv')
    expect(standardListUploadName(bare({ name: 'Q3.2026 Blocklist' }))).toBe('Q3.2026 Blocklist.csv')
  })

  it('trims surrounding whitespace like the server does', () => {
    expect(standardListUploadName(bare({ name: '  Longtail Block  ' }))).toBe('Longtail Block.csv')
  })

  // FIX 7 — normalization must match Go strings.TrimSpace, NOT JS .trim():
  // Go keeps a leading BOM and strips NEL; JS .trim() does the opposite. Same
  // inputs → same outputs as the Go BOM/NEL cases in lists_test.go.
  it('keeps a leading BOM (matches Go TrimSpace, not JS trim) (#198 FIX 7)', () => {
    expect(standardListUploadName(bare({ name: '\uFEFFLongtail Block' }))).toBe('\uFEFFLongtail Block.csv')
  })

  it('strips a trailing NEL U+0085 (matches Go TrimSpace) (#198 FIX 7)', () => {
    expect(standardListUploadName(bare({ name: 'Longtail\u0085' }))).toBe('Longtail.csv')
  })

  it('a blank name falls back to the data-file basename (#198 FIX 7)', () => {
    expect(standardListUploadName(bare({ name: '   ', file_base: 'longtail-block.csv' }))).toBe('longtail-block.csv')
  })

  it('emits the bare name when the API reports no extension (legacy responses)', () => {
    expect(standardListUploadName(bare({ file_ext: undefined }))).toBe('Longtail Block')
  })

  it('standardListAsFile carries the suffixed name so dealFilePath emits it', () => {
    expect(standardListAsFile(bare()).name).toBe('Longtail Block.csv')
  })

  it('the prompt references the standard list WITH its extension', () => {
    const f = mixedIxFixture()
    f.domainLists = []
    f.appBundleLists = []
    f.appliedDomainListIds = ['longtail-block']
    const out = buildBatchPrompt(f, [bare()])
    expect(out).toMatch(/domain_file_path: "Longtail Block\.csv"/)
    // The bare extensionless reference must be gone — a prompt name that
    // differs from the MOC upload name is exactly the #198 fuzzy-match bug.
    expect(out).not.toMatch(/domain_file_path: "Longtail Block"/)
  })
})

// =============================================================================
// "Deal N of M" labeling — must reflect what MOC actually iterates, not the
// raw form.deals list (which includes Magnite manuals that get skipped). The
// SS-Fabrikam run shipped "Deal 2 of 7" inside a 4-deal IX batch because the
// header was using form.deals.length unfiltered.
// =============================================================================

describe('buildBatchPrompt — Deal N of M labeling', () => {
  it('counts every deal with an SSP — Magnite included since June 2026 — and skips SSP-less deals', () => {
    const ixDeal = (i: number, channel: DealEntry['channel'] = 'Display') => ({
      ...newDeal(), ssp: 'Index Exchange' as const, channel, cpm: '0.10', theme: `T${i}`,
      externalReferenceId: `IX-${i}`,
    })
    const magnite = { ...newDeal(), ssp: 'Magnite' as const, channel: 'CTV' as const, theme: 'Magnite' }
    const noSsp = { ...newDeal(), channel: 'Display' as const, theme: 'Unrouted' }
    const form: FormData = {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10001',
      deals: [ixDeal(1), magnite, ixDeal(2), noSsp, ixDeal(3, 'OLV (Online Video)')],
    }
    const out = buildBatchPrompt(form)
    // Four batch-supported deals (3 IX + 1 Magnite); the SSP-less deal is filtered out.
    expect(out).toMatch(/# Deal 1 of 4/)
    expect(out).toMatch(/# Deal 4 of 4/)
    // The unfiltered count (5) must NOT appear in any header.
    expect(out).not.toMatch(/# Deal \d of 5/)
  })
})

// =============================================================================
// Auto-bump stale start_date — IX rejects past start dates at create time, so
// the resolver replaces any past flightStartDate with today and per-deal blocks
// surface a comment explaining the bump.
// =============================================================================

describe('buildBatchPrompt — start_date auto-bump', () => {
  function staleFixture(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      // Hardcoded past date so the test is deterministic regardless of when it runs.
      flightStartDate: '2020-01-01',
      flightEndDate: '2030-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10002',
      deals: [{
        ...newDeal(), ssp: 'Index Exchange' as const, channel: 'Display' as const,
        cpm: '0.10', theme: 'News', externalReferenceId: 'IX-stale',
      }],
    }
  }

  it('emits the bump-explanation comment when flightStartDate is in the past', () => {
    const out = buildBatchPrompt(staleFixture())
    expect(out).toMatch(/# start_date auto-bumped from 2020-01-01 \(in the past/)
  })

  it('emits today (not the form value) in start_date for stale briefs', () => {
    const out = buildBatchPrompt(staleFixture())
    // Business-timezone today, same helper the builder uses — UTC "today" is
    // already tomorrow between 8 PM and midnight ET (the PR #302 CI flake).
    const todayISO = businessTodayISO()
    // quote() wraps date strings (they contain dashes), so the emission is
    // `start_date: "<YYYY-MM-DD>"`.
    expect(out).toMatch(new RegExp(`start_date: "${todayISO}"`))
    expect(out).not.toMatch(/start_date: "2020-01-01"/)
  })

  it('surfaces the bump in the brief envelope notes block', () => {
    const out = buildBatchPrompt(staleFixture())
    expect(out).toMatch(/Form start date 2020-01-01 was in the past/)
  })

  it('does NOT bump or comment when the form date is today or future', () => {
    const f = staleFixture()
    f.flightStartDate = '2099-01-01'
    const out = buildBatchPrompt(f)
    expect(out).not.toMatch(/auto-bumped/)
    expect(out).toMatch(/start_date: "2099-01-01"/)
  })
})

// =============================================================================
// OpenX prompt — deal type, geo, package name, and the web-domain + app-bundle
// dual-file emission. Locks in the fixes from a live Display run where
// the generated prompt produced PRIVATE_AUCTION (fails — needs
// open_auction_access), geo_countries (silently ignored by the OpenX MCP), a
// package_name collision against an orphan package, and could carry only ONE of
// the domain / app-bundle lists.
// =============================================================================

describe('buildBatchPrompt — OpenX prompt corrections', () => {
  const domainAllow = {
    id: 'oxd1', name: 'display_domain_allow_list.xlsx', size: 1,
    path: '/input/display_domain_allow_list.xlsx',
    inclusionType: 'Include' as const, detectedColumn: 'domain',
  }
  const bundleAllow = {
    id: 'oxb1', name: 'app_bundles_display_allow_list.xlsx', size: 1,
    path: '/input/app_bundles_display_allow_list.xlsx',
    inclusionType: 'Include' as const, detectedColumn: 'app bundle ids',
  }

  function openxDisplayFixture(): FormData {
    const deal: DealEntry = {
      ...newDeal(),
      ssp: 'OpenX' as const,
      channel: 'Display' as const,
      inventoryType: 'In-App' as const,
      cpm: '0.10',
      theme: 'Buick A18+ Hispanic',
      externalReferenceId: 'GM-Display',
      includeSegments: [],
      geoInclude: [{ id: 'g1', type: 'country', value: 'US' }],
    }
    return {
      ...DEFAULT_FORM,
      submitterName: 'Trader',
      submitterEmail: 'trader@example.com',
      flightStartDate: '2099-06-04',
      flightEndDate: '2099-06-04',
      agency: 'Publicis',
      brand: 'GM',
      dataPartner: 'DataCo',
      campaignId: 'DEAL00162',
      attributionCode: 'B1',
      domainLists: [domainAllow],
      appBundleLists: [bundleAllow],
      deals: [deal],
    }
  }

  it('defaults pmp_deal_type to PREFERRED_DEAL (never PRIVATE_AUCTION)', () => {
    const out = buildBatchPrompt(openxDisplayFixture())
    expect(out).toMatch(/pmp_deal_type: PREFERRED_DEAL/)
    expect(out).not.toMatch(/pmp_deal_type: PRIVATE_AUCTION/)
  })

  it('honors an explicit pmp_deal_type override from the form', () => {
    const f = openxDisplayFixture()
    f.openxConfig = { ...f.openxConfig, pmpDealType: 'PROGRAMMATIC_GUARANTEED' }
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/pmp_deal_type: PROGRAMMATIC_GUARANTEED/)
  })

  // cutlass#766 — PRIVATE_AUCTION is API-uncreatable (dealCreate requires
  // open_auction_access, absent from the create schema; every attempt died
  // with an opaque INTERNAL_SERVER_ERROR). A stale persisted/parsed value
  // must never be emitted as a creatable pmp_deal_type — it becomes a
  // line-anchored "# BLOCKED" marker the MOC submit gate 422s on.
  it('hard-blocks PRIVATE_AUCTION instead of emitting it as a creatable pmp_deal_type (cutlass#766)', () => {
    // FAILS OLD: the pre-guard builder emitted `pmp_deal_type: PRIVATE_AUCTION`.
    const f = openxDisplayFixture()
    f.openxConfig = { ...f.openxConfig, pmpDealType: 'PRIVATE_AUCTION' }
    const out = buildBatchPrompt(f)
    expect(out).not.toMatch(/pmp_deal_type:/)
    expect(out).toMatch(/# BLOCKED: OpenX Private Auction \(pmp_deal_type 2\) is not creatable via the API/)
    expect(out).toMatch(/switch the OpenX PMP Deal Type to PREFERRED_DEAL/)
  })

  it('hard-blocks the numeric "2" form of Private Auction too (cutlass#766)', () => {
    const f = openxDisplayFixture()
    f.openxConfig = { ...f.openxConfig, pmpDealType: '2' }
    const out = buildBatchPrompt(f)
    expect(out).not.toMatch(/pmp_deal_type:/)
    expect(out).toMatch(/# BLOCKED: OpenX Private Auction/)
  })

  it('still emits the numeric "3" (Preferred Deal) form unchanged — the default path keeps working', () => {
    const f = openxDisplayFixture()
    f.openxConfig = { ...f.openxConfig, pmpDealType: '3' }
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/pmp_deal_type: 3 /)
    expect(out).not.toMatch(/# BLOCKED: OpenX Private Auction/)
  })

  // cutlass#726 / #229 — targeting.channel is ALWAYS emitted. The
  // OpenX MCP builds the package rendering_context from targeting.channel and
  // used to default every channel-less brief to DISPLAY (Format=BANNER): a
  // non-duration OLV/CTV/OTT brief silently created as a banner deal.
  it('always emits targeting.channel per channel — video channels must never default to BANNER (cutlass#726)', () => {
    // FAILS OLD: emission was gated on hasAdDurationRequest, so none of these
    // non-duration deals carried a channel line.
    const cases = [
      ['Display', 'DISPLAY'],
      ['OLV (Online Video)', 'OLV'],
      ['CTV', 'CTV'],
      ['OTT', 'OTT'],
    ] as const
    for (const [channel, wire] of cases) {
      const f = openxDisplayFixture()
      f.deals[0] = { ...f.deals[0], channel }
      const out = buildBatchPrompt(f)
      // Batch prompts indent each deal body under deals:, so anchor on the
      // line-relative indent, not an absolute column.
      expect(out, channel).toMatch(new RegExp(`^\\s+channel: ${wire}\\b`, 'm'))
      // Inside the targeting block, where the MCP reads it.
      expect(out.search(/^\s+channel: /m), channel).toBeGreaterThan(out.search(/^\s+targeting:/m))
      // Non-duration deals carry the rendering-context comment, never the
      // duration-gate comment.
      expect(out, channel).not.toContain('ox_duration_requires_video_channel')
      // The string rendering_context stays for old-MCP back-compat.
      expect(out, channel).toMatch(/^\s+rendering_context: /m)
    }
  })

  it('Native maps to the NATIVE channel (Format=NATIVE) — the old DISPLAY fold booked every OpenX Native deal as BANNER (fixed 2026-08-21)', () => {
    const f = openxDisplayFixture()
    f.deals[0] = { ...f.deals[0], channel: 'Native' }
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/^\s+channel: NATIVE\b/m)
    expect(out).not.toMatch(/^\s+channel: DISPLAY\b/m)
    // The string hint stays for old-MCP back-compat (those MCPs upgrade the
    // legacy DISPLAY fold themselves; the hint keeps the intent explicit).
    expect(out).toMatch(/^\s+rendering_context: "?native"?/m)
  })

  it('unmapped channel labels (Audio) fall through verbatim — the MCP fails closed (ox_unknown_channel) rather than minting a BANNER deal', () => {
    const f = openxDisplayFixture()
    f.deals[0] = { ...f.deals[0], channel: 'Audio' }
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/^\s+channel: Audio\b/m)
  })

  it('DV360 deals emit the exact catalog demand partner and the seat id as the required single buyer (DEAL07273, 2026-08-03)', () => {
    const f = openxDisplayFixture()
    f.dsps = [{ id: 'd1', dsp: 'DV360', seatId: '849138' }]
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/demand_partner: "?DV360 - RTB"?/)
    expect(out).toMatch(/buyer_ids: \["?849138"?\]/)
  })

  it('EVERY DSP with a trader seat emits buyer_ids — a buyer-less OpenX create is open to any seat on the demand partner (a live batch DEAL00188, 2026-08-13)', () => {
    const f = openxDisplayFixture()
    f.dsps = [{ id: 'd1', dsp: 'The Trade Desk', seatId: '5904' }]
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/demand_partner: "?The Trade Desk - RTB"?/)
    expect(out).toMatch(/buyer_ids: \["?5904"?\]/)
  })

  it('explicit OpenX Buyers beat the DSP-seat fallback; no seat and no buyers emits nothing', () => {
    const explicit = openxDisplayFixture()
    explicit.dsps = [{ id: 'd1', dsp: 'The Trade Desk', seatId: '5904' }]
    explicit.openxConfig = { ...explicit.openxConfig, buyers: [{ id: 'b1', buyerId: '111' }] }
    const withBuyers = buildBatchPrompt(explicit)
    expect(withBuyers).toMatch(/buyer_ids: \["?111"?\]/)
    expect(withBuyers).not.toMatch(/buyer_ids: \["?5904"?\]/)

    const seatless = openxDisplayFixture()
    seatless.dsps = [{ id: 'd1', dsp: 'The Trade Desk', seatId: '' }]
    const noBuyers = buildBatchPrompt(seatless)
    expect(noBuyers).not.toMatch(/^\s*buyer_ids:/m)
  })

  it('emits targeting.geographic (not the ignored geo_countries / geo_states keys)', () => {
    const out = buildBatchPrompt(openxDisplayFixture())
    // Country case uses full names so the MCP can't mistake a token for a US state.
    expect(out).toMatch(/geographic: \["United States"\]/)
    expect(out).not.toMatch(/geo_countries:/)
    expect(out).not.toMatch(/geo_states:/)
  })

  it('emits the STRUCTURED geographic dict (state + country US) for US states — never the flat list', () => {
    // cutlass#724: the flat `geographic: [CA]` emission was ambiguous — the
    // structured form carries the country hint that scopes state resolution.
    const f = openxDisplayFixture()
    f.deals[0].geoInclude = [{ id: 'g1', type: 'state', value: 'California' }]
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/geographic:\s*\n\s+includes:\s*\n\s+state: CA[^\n]*\n\s+country: US/)
    expect(out).not.toMatch(/geographic: \[CA\]/)
    expect(out).not.toMatch(/geographic: \["United States"\]/)
  })

  it('emits Saskatchewan as structured state SK + country CA — never a flat [SK] Slovakia-collision token', () => {
    const f = openxDisplayFixture()
    f.deals[0].geoInclude = [{ id: 'g1', type: 'state', value: 'Saskatchewan' }]
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/geographic:\s*\n\s+includes:\s*\n\s+state: SK[^\n]*\n\s+country: CA/)
    expect(out).not.toMatch(/geographic: \[SK\]/)
    expect(out).not.toMatch(/geographic: \[Saskatchewan\]/)
  })

  it('groups multiple US states into one comma-joined structured state value', () => {
    const f = openxDisplayFixture()
    f.deals[0].geoInclude = [
      { id: 'g1', type: 'state', value: 'California' },
      { id: 'g2', type: 'state', value: 'TX' },
    ]
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/state: "CA,TX"/)
    expect(out).toMatch(/country: US/)
  })

  it('mixed US + CA subnational geo emits BOTH country hints so the MCP fails closed (audit blocks it first)', () => {
    const f = openxDisplayFixture()
    f.deals[0].geoInclude = [
      { id: 'g1', type: 'state', value: 'California' },
      { id: 'g2', type: 'state', value: 'Saskatchewan' },
    ]
    const out = buildBatchPrompt(f)
    // Never a single guessed country: the multi-country hint trips the MCP's
    // subnational_geo_requires_country blocker if the audit gate is bypassed.
    expect(out).toMatch(/state: "CA,SK"/)
    expect(out).toMatch(/country: "US,CA"/)
  })

  it('unknown state tokens ride the structured state field WITHOUT a country hint (MCP fails closed)', () => {
    const f = openxDisplayFixture()
    f.deals[0].geoInclude = [{ id: 'g1', type: 'state', value: 'Bavaria' }]
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/state: Bavaria/)
    expect(out).not.toMatch(/country: (US|CA)\b/)
    expect(out).not.toMatch(/geographic: \[Bavaria\]/)
  })

  it('emits BOTH the web-domain file and the app-bundle file on one OpenX deal', () => {
    const out = buildBatchPrompt(openxDisplayFixture())
    // Web domains → url_targeting (domain_*).
    expect(out).toMatch(/domain_file_path: "?display_domain_allow_list\.xlsx"?/)
    expect(out).toMatch(/domain_column: domain/)
    expect(out).toMatch(/domain_match_operator: allowlist/)
    // App bundles → app_inventory (app_bundle_*) — the distinct dimension.
    expect(out).toMatch(/app_bundle_file_path: "?app_bundles_display_allow_list\.xlsx"?/)
    expect(out).toMatch(/app_bundle_column: "app bundle ids"/)
    expect(out).toMatch(/app_bundle_match_operator: allowlist/)
  })

  it('omits package_name when auto-generate is on (the default) so the MCP mints a unique one', () => {
    const out = buildBatchPrompt(openxDisplayFixture())
    expect(out).not.toMatch(/package_name:/)
  })

  it('emits an explicit package_name only when auto-generate is off', () => {
    const f = openxDisplayFixture()
    f.openxConfig = { ...f.openxConfig, autoPackageName: false, packageName: 'GM_Custom_Package' }
    const out = buildBatchPrompt(f)
    expect(out).toMatch(/package_name: GM_Custom_Package/)
  })
})

// =============================================================================
// TripleLift resolve-first workflow. TL's create endpoint takes raw numeric IDs
// (dsp.id, country_ids, segment_ids are int-cast), so the prompt must tell the
// agent to resolve names→ids via the list tools BEFORE creating — replacing the
// old bare <FILL_DSP_ID> placeholder that read like a trader hand-fill.
// =============================================================================

describe('generateDealPromptYaml — TripleLift resolve-first', () => {
  function tlForm(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2099-01-01', flightEndDate: '2099-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL70001',
      dealSheetRecipient: 'trader@example.com',
      dsps: [{ id: 'd1', dsp: 'The Trade Desk', seatId: '7726' }],
      defaultGeoInclude: [{ id: 'g1', type: 'country', value: 'US' }],
      deals: [{
        ...newDeal(), ssp: 'TripleLift' as const, channel: 'CTV' as const,
        cpm: '10.00', theme: 'Seg', includeSegments: ['Auto Intenders'],
        externalReferenceId: 'TL-1',
      }],
    }
  }

  it('emits a Step 1 resolve block hitting the list tools, then the create payload', () => {
    const out = generateDealPromptYaml(tlForm(), tlForm().deals[0], 0)
    expect(out).toContain('Step 1 — resolve numeric IDs')
    expect(out).toContain('mcp_triplelift_mcp_tl_list_buyers')
    expect(out).toContain('mcp_triplelift_mcp_tl_list_countries')
    expect(out).toContain('mcp_triplelift_mcp_tl_list_segments')
    expect(out).toContain('mcp_triplelift_mcp_tl_create_deal')
  })

  it('no longer emits the bare <FILL_DSP_ID> placeholder', () => {
    const out = generateDealPromptYaml(tlForm(), tlForm().deals[0], 0)
    expect(out).not.toContain('<FILL_DSP_ID>')
    expect(out).toContain('id: <dsp.id from Step 1a')
  })

  it('routes country_ids / segment_ids through Step 1 (integers only — never raw names/codes)', () => {
    const out = generateDealPromptYaml(tlForm(), tlForm().deals[0], 0)
    // The convenience keys must point at the resolved integers, NOT the raw
    // ISO code / segment name (which the MCP would int-cast and crash on).
    expect(out).toMatch(/country_ids: \[<numeric ids from Step 1b>\]/)
    expect(out).toMatch(/segment_ids: \[<numeric ids from Step 1c>\]/)
    expect(out).not.toMatch(/country_ids: \["?US"?\]/)
    expect(out).not.toMatch(/segment_ids: \["?Auto Intenders"?\]/)
  })

  it('emits schema-valid payload enums (no NONE/STANDARD/[] that TripleLift rejects)', () => {
    const out = generateDealPromptYaml(tlForm(), tlForm().deals[0], 0)
    expect(out).not.toContain('secondaryGoal: NONE')
    expect(out).not.toContain('dspFormatWorkflow: STANDARD')
    expect(out).not.toContain('creativeTags: []')
    // secondaryGoal must be a real (flattened) goal — null is rejected by the live API
    // ("Secondary goal is required for curated deals"). Verified live 2026-06-30 (deal 86277).
    expect(out).not.toContain('secondaryGoal: null')
    expect(out).toContain('secondaryGoal: {id: 2, value: 250}')
    expect(out).toContain('creativeTags: false')
    expect(out).toContain('dspFormatWorkflow: null')
  })

  it('emits the buyer id (not the seat token) in dsp.seat.id; seat token only in seatString', () => {
    const out = generateDealPromptYaml(tlForm(), tlForm().deals[0], 0)
    // seat.id must reference the resolved buyer id, never the raw seat token.
    expect(out).toContain('id: <dsp.id from Step 1a — the SAME buyer id as dsp.id')
    expect(out).toMatch(/seatString: /)
  })

  it('omits allow_political_ads by default', () => {
    const out = generateDealPromptYaml(tlForm(), tlForm().deals[0], 0)
    expect(out).not.toContain('allow_political_ads')
  })

  it('emits allow_political_ads: true when Regulatory Policy political ads is enabled', () => {
    const form = tlForm()
    form.tripleliftConfig = { ...form.tripleliftConfig, allowPoliticalAds: true }
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('allow_political_ads: true')
  })
})

// =============================================================================
// Per-deal site-list assignment — one batch, list on some deals not others.
// =============================================================================
describe('buildBatchPrompt — per-deal domain list assignment', () => {
  const autoSites: import('../types/deal').UploadedFile = {
    id: 'up-auto-sites', name: 'Auto Sites', size: 10, path: '/input/up-auto-sites.csv', inclusionType: 'Include',
  }
  function baseForm(deals: DealEntry[]): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'Trader', submitterEmail: 'trader@example.com',
      flightStartDate: '2026-06-01', flightEndDate: '2026-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL40001',
      domainLists: [autoSites],
      deals,
    }
  }
  const mkDeal = (over: Partial<DealEntry>): DealEntry => ({
    ...newDeal(), ssp: 'Index Exchange', channel: 'Display', externalReferenceId: 'x', includeSegments: ['Seg'], cpm: '5.00', ...over,
  })

  it('scopes a list to only the deal that references it; the explicit-none deal gets nothing', () => {
    const out = buildBatchPrompt(baseForm([
      mkDeal({ theme: 'Contextual', domainListId: 'up-auto-sites' }),
      mkDeal({ theme: 'In-market Auto', domainListId: '' }),
    ]))
    // Exactly one deal body emits the domain file.
    expect(out.match(/domain_file_path:/g) || []).toHaveLength(1)
    expect(out).toMatch(/domain_match_operator: allowlist/)
  })

  it('undefined (unset) keeps the campaign-wide list — back-compat', () => {
    const out = buildBatchPrompt(baseForm([
      mkDeal({ theme: 'Deal A' }), // no domainListId → campaign default
      mkDeal({ theme: 'Deal B' }),
    ]))
    // Both deals inherit the single campaign-wide upload.
    expect(out.match(/domain_file_path:/g) || []).toHaveLength(2)
  })

  it('resolves a standard-list id passed in availableLists', () => {
    const stdList = { id: 'std-news', name: 'News Sites', kind: 'allow' as const, scope: 'domain' as const, line_count: 5 }
    const out = buildBatchPrompt(baseForm([
      mkDeal({ theme: 'Std', domainListId: 'std-news' }),
      mkDeal({ theme: 'None', domainListId: '' }),
    ]), [stdList])
    expect(out.match(/domain_file_path:/g) || []).toHaveLength(1)
  })
})

describe('dealListLabel — per-deal allow/block override on a curated list', () => {
  const stdAppBlock = { id: 'std-apps', name: 'Long Tail Apps', kind: 'block' as const, scope: 'app_bundle' as const, line_count: 100 }
  const baseForm: FormData = { ...DEFAULT_FORM, submitterEmail: 't@example.com' }
  const ctvDeal = (over: Partial<DealEntry>): DealEntry => ({
    ...newDeal(), ssp: 'Index Exchange', channel: 'CTV', cpm: '10', theme: 'T',
    includeSegments: ['S'], appBundleListId: 'std-apps', ...over,
  })

  it('defaults to the curated list kind (block → blocklist)', () => {
    const d = ctvDeal({})
    const label = dealListLabel({ ...baseForm, deals: [d] }, d, [stdAppBlock])
    expect(label?.op).toBe('blocklist')
  })

  it('honors a per-deal Allow override flipping a curated block list to allowlist', () => {
    const d = ctvDeal({ appBundleListInclusion: 'Include' })
    const label = dealListLabel({ ...baseForm, deals: [d] }, d, [stdAppBlock])
    expect(label?.op).toBe('allowlist')
  })
})

describe('buildBatchPrompt — Index Exchange geo (country + zip/dma, no states)', () => {
  function ixGeoForm(geoInclude: import('../types/deal').GeoEntry[]): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'Trader', submitterEmail: 'trader@example.com',
      flightStartDate: '2099-06-01', flightEndDate: '2099-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL50001',
      deals: [{
        ...newDeal(), ssp: 'Index Exchange' as const, channel: 'Display' as const,
        cpm: '5.00', theme: 'Seg', includeSegments: ['Seg'], externalReferenceId: 'x',
        geoInclude,
      }],
    }
  }

  it('emits geo_countries (names) for country entries', () => {
    const out = buildBatchPrompt(ixGeoForm([{ id: 'g1', type: 'country', value: 'US' }]))
    expect(out).toMatch(/geo_countries: \["United States"\]/)
    expect(out).not.toMatch(/geo_states:/)
  })

  it('merges zip and dma entries into a single dma_codes list', () => {
    const out = buildBatchPrompt(ixGeoForm([
      { id: 'g1', type: 'zip', value: '10001, 90210' },
      { id: 'g2', type: 'dma', value: '602' },
    ]))
    // Comma/space lists split; zips and DMAs share IX's ZipCode key via dma_codes.
    expect(out).toMatch(/dma_codes: \[10001, 90210, 602\]/)
    expect(out).not.toMatch(/geo_states:/)
  })
})

// =============================================================================
// Magnite — API-backed deal creation via the ClearLine Curation Demand
// Management API (June 2026). The builder must emit the Cutlass MCP executor
// with platform routing (ctv → SpringServe, display/olv → DV+), required
// marketplace + publishers, and the PERCENT-unit rev share (live-verified
// 2026-07-21 — the old fraction scale booked 30% as 0.30%).
// =============================================================================

describe('buildMagnitePrompt (via generateDealPromptYaml)', () => {
  function magniteForm(channel: DealEntry['channel'], extra: Partial<FormData> = {}): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10001',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: 'House Seat' }],
      magniteConfig: { marketplace: 'Example CTV Marketplace', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' },
      deals: [{ ...newDeal(), ssp: 'Magnite' as const, channel, cpm: '25', theme: 'Weather', magniteSizes: ['15'] }],
      ...extra,
    }
  }

  it('emits the Magnite MCP executor with marketplace, the ALL publishers opt-in, dsps, and vendor-valid CTV pricing', () => {
    const form = magniteForm('CTV')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('mcp_magnite_mcp_magnite_execute_deal_from_prompt_inputs')
    expect(out).toContain('channel: ctv')
    expect(out).toContain('marketplace: "Example CTV Marketplace"')
    expect(out).toContain('publishers: "ALL"')   // always the explicit opt-in — never a literal list
    expect(out).toContain('- dsp: "The Trade Desk"')
    expect(out).toContain('buyers: ["House Seat"]')
    // #228: CTV routes to SpringServe, which rejects 'Market Rate with
    // Minimum' (the Cutlass MCP blocks it at prepare) — the default-config
    // CTV deal downgrades to Market Rate so the create succeeds. The deal's
    // $25 CPM must still never land on the publisher tab (Sun Bum, 2026-07).
    expect(out).toContain('price_type: Market Rate')
    expect(out).not.toContain('price_type: "Market Rate with Minimum"')
    expect(out).not.toMatch(/^floor:/m)
    expect(out).not.toContain('floor: 25')
    expect(out).not.toContain('price_type: CPM')
    expect(out).toContain('end_date: "2028-12-31"')
    // The retired manual/BrowserOS language must be gone.
    expect(out).not.toContain('MANUAL CREATE REQUIRED')
    expect(out).not.toContain('BrowserOS')
  })

  // ClearLine takes a buyer LIST per DSP and
  // resolves each ref independently, so one deal can be pinned to many DV360
  // buyers. Before this, the whole comma string shipped as ONE buyer token and
  // Cutlass rejected the create with buyer_unresolved.
  it('splits a comma-separated Seat ID into one buyers entry per seat', () => {
    const form = magniteForm('CTV', {
      dsps: [{ id: '1', dsp: 'DV360', seatId: '1413973141,850299280, 134 ,163531' }],
    })
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('- dsp: DV360')
    expect(out).toContain('buyers: [1413973141, 850299280, 134, 163531]')
    expect(out).toContain('4 buyer seats')
    // ANY unresolved ref blocks the whole create — the agent must not book a
    // deal carrying a partial buyer list.
    expect(out).toContain('buyer_unresolved')
  })

  it('keeps the single-seat wire (and its note) unchanged for a lone seat', () => {
    const form = magniteForm('CTV')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('buyers: ["House Seat"]')
    expect(out).toContain('# Buyer name or numeric id')
    expect(out).not.toContain('buyer seats')
  })

  it('blocks Audio until a verified feedTypes selection exists', () => {
    const form = magniteForm('Audio')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('# BLOCKED: Magnite Audio requires feedTypes')
    expect(out).toContain('#238.5')
    expect(out).not.toMatch(/^sizes:/m)
  })

  it('#228: CTV (SpringServe) downgrades Market Rate with Minimum to Market Rate; DV+ keeps MRwM with the floor', () => {
    // CTV — the vendor rejects MRwM; the prompt must say why it downgraded.
    const ctv = magniteForm('CTV')
    const ctvOut = generateDealPromptYaml(ctv, ctv.deals[0], 0)
    expect(ctvOut).toContain('price_type: Market Rate')
    expect(ctvOut).toContain("'Market Rate with Minimum' is DV+-only")
    expect(ctvOut).not.toMatch(/^floor:/m)
    // Display (DV+) — the default stays MRwM with the 0.10 minimum
    // (shipped by Cutlass as curatorPricing.minimumCpm, cutlass#718).
    const dvp = magniteForm('Display')
    const dvpOut = generateDealPromptYaml(dvp, dvp.deals[0], 0)
    expect(dvpOut).toContain('price_type: "Market Rate with Minimum"')
    expect(dvpOut).toContain('floor: 0.10')
  })

  it('#228: an explicit CPM price type stays CPM on CTV (SpringServe supports it)', () => {
    const form = magniteForm('CTV', {
      magniteConfig: { marketplace: 'Example CTV Marketplace', priceType: 'CPM' as const, floorCpm: '0.10' },
    })
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('price_type: CPM')
    expect(out).toContain('floor: 0.10')
  })

  it('routes Display/OLV to DV+ via the channel hint', () => {
    const form = magniteForm('Display')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('channel: display')
    expect(out).toContain('display/olv → DV+')
  })

  it('passes curatedDealFee through as PERCENT-unit rev share (25 = 25%, never 0.25)', () => {
    const form = magniteForm('CTV', { curatedDealFee: '25' })
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('rev_share_model: Percent')
    expect(out).toContain('rev_share_value: 25')
    expect(out).not.toContain('rev_share_value: 0.25')
  })

  it('omits rev share (MCP default + quality flag) when no fee is set', () => {
    const form = magniteForm('CTV')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).not.toContain('rev_share_value:')
    expect(out).toContain('# rev_share OMITTED')
  })

  it('emits audience segments on CTV (SpringServe) deals', () => {
    const form = magniteForm('CTV')
    form.deals[0].includeSegments = ['My Segment1']
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('audience_segments:')
    expect(out).toContain('"My Segment1"')
  })

  it('blocks audience segments on DV+ deals with a v3.0 warning instead of the arg', () => {
    const form = magniteForm('Display')
    form.deals[0].includeSegments = ['My Segment1']
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).not.toContain('audience_segments:')
    expect(out).toContain('DV+ audience segments are NOT supported')
    expect(out).toContain('#   include: My Segment1')
  })


  it('emits PER-DEAL DV+ sizes and flags a missing size list as <FILL> (display)', () => {
    const withSizes = magniteForm('Display')
    withSizes.deals[0].magniteSizes = ['15', '2']
    expect(generateDealPromptYaml(withSizes, withSizes.deals[0], 0)).toContain('sizes: [15, 2]')
    const noSizes = magniteForm('Display')
    noSizes.deals[0].magniteSizes = []
    expect(generateDealPromptYaml(noSizes, noSizes.deals[0], 0)).toContain('<FILL display formats')
    // OLV → video formats carried via the same sizes arg.
    const olv = magniteForm('OLV (Online Video)')
    olv.deals[0].magniteSizes = ['201', '204']
    expect(generateDealPromptYaml(olv, olv.deals[0], 0)).toContain('sizes: [201, 204]')
    // OTT → Streaming (SpringServe), which takes NO sizes at all. Even with
    // formats set on the deal card, none may reach the wire.
    const ott = magniteForm('OTT')
    ott.deals[0].magniteSizes = ['202']
    const ottOut = generateDealPromptYaml(ott, ott.deals[0], 0)
    expect(ottOut).not.toContain('sizes: [202]')
    expect(ottOut).toContain('channel: ott')
    // Native → native format ids via the same sizes arg.
    const nat = magniteForm('Native')
    nat.deals[0].magniteSizes = ['600']
    expect(generateDealPromptYaml(nat, nat.deals[0], 0)).toContain('sizes: [600]')
    // Audio → feedTypes note, never a sizes line.
    const audio = magniteForm('Audio')
    audio.deals[0].magniteSizes = []
    const audioOut = generateDealPromptYaml(audio, audio.deals[0], 0)
    expect(audioOut).toContain('feedTypes')
    expect(audioOut).not.toContain('sizes:')
    // CTV (SpringServe) deals never emit a sizes line.
    const ctv = magniteForm('CTV')
    ctv.deals[0].magniteSizes = []
    expect(generateDealPromptYaml(ctv, ctv.deals[0], 0)).not.toContain('sizes:')
  })

  it('appears in the batch prompt with its tool name (no manual-exclusion note)', () => {
    const form = magniteForm('CTV', { dealSheetRecipient: 'trader@example.com' })
    const out = buildBatchPrompt(form)
    expect(out).toContain('- ssp: magnite')
    expect(out).toContain('tool: mcp_magnite_mcp_magnite_execute_deal_from_prompt_inputs')
    expect(out).not.toContain('excluded from batch')
    expect(out).toContain('Per Magnite deal: surface the returned deal_id prominently')
  })
})


// =============================================================================
// IX reporting labels — client-preset-only + IX charset (2026-08-11).
// Traders couldn't re-save Deal Onboarding-created IX deals in the IX UI: every deal
// carried the legacy generic labels whose multi-line key=value `custom` block
// used `=` — outside IX's reporting-label charset ("Only letters, numbers,
// spaces, and $%&,-+./:?@\_`{|}"). Labels now ship ONLY for clients with a
// reporting labels, and every value is sanitized to that set.
// =============================================================================

describe('IX reporting labels — charset sanitation', () => {



  it('sanitizeIxLabelValue keeps the full IX-allowed set and strips the rest to single spaces', () => {
    // Every allowed special survives verbatim.
    expect(sanitizeIxLabelValue('a1 $%&,-+./:?@\\_`{|}')).toBe('a1 $%&,-+./:?@\\_`{|}')
    // Disallowed chars (=, !, #, parens, en dash, newlines) become spaces, runs collapse.
    expect(sanitizeIxLabelValue('curator=Partner')).toBe('curator Partner')
    expect(sanitizeIxLabelValue('Sun Bum (US!)')).toBe('Sun Bum US')
    expect(sanitizeIxLabelValue('A–B\nC')).toBe('A B C')
    expect(sanitizeIxLabelValue('  spaced   out  ')).toBe('spaced out')
    // A value that sanitizes to nothing renders empty (label dropped upstream).
    expect(sanitizeIxLabelValue('()!#=')).toBe('')
  })

  it('resolveReportingLabels sanitizes template-rendered values (and drops labels that sanitize empty)', () => {
    const form: FormData = { ...DEFAULT_FORM, brand: 'Energizer® Brands (US)', agency: 'Amazon Ads' }
    const deal: DealEntry = { ...newDeal(), externalReferenceId: 'Contoso - Lights - Display - AMZ' }
    const labels = resolveReportingLabels(form, deal, 'name')
    expect(labels.find(l => l.key === 'advertiser')?.value).toBe('Energizer Brands US')
    // Opportunity Name is charset-clean → passes through verbatim.
    expect(labels.find(l => l.key === 'externalReferenceID')?.value).toBe('Contoso - Lights - Display - AMZ')
    // Salesperson unset + submitter empty → custom renders 'submitter:' … which
    // is non-empty; salesperson itself renders empty and is dropped.
    expect(labels.some(l => l.key === 'salesperson')).toBe(false)
  })
})

// =============================================================================
// Environment (Web / In-App) targeting — 2026-08-11 audit. IX In-app deals
// shipped with Web included: Deal Onboarding never emitted the environment and the
// IX MCP's deal_type default (display/olv → App+Site) applied. Now: IX gets
// an explicit inventory_channels (cutlass#872 preserves it verbatim),
// PubMatic In-App carries BOTH app platforms (4 iOS + 5 Android — [4] alone
// shipped iOS-only), and SSPs with no environment wire emit a loud
// NOT-SUPPORTED marker instead of silently discarding the selection.
// =============================================================================

describe('Environment targeting per SSP', () => {
  function envForm(ssp: DealEntry['ssp'], inv: DealEntry['inventoryType'], channel: DealEntry['channel'] = 'Display'): FormData {
    const deal: DealEntry = {
      ...newDeal(), theme: 'Seg', channel, ssp, inventoryType: inv,
      includeSegments: ['Seg A'], cpm: '2.50', magniteSizes: ['300x250 (Medium Rectangle)'],
    }
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2027-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL00600', curatedDealFee: '25',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '111' }],
      magniteConfig: { marketplace: 'M', priceType: 'Market Rate' as const, floorCpm: '' },
      deals: [deal],
    }
  }

  it('IX In-App emits explicit inventory_channels [In-App]', () => {
    const out = generateDealPromptYaml(envForm('Index Exchange', 'In-App'), envForm('Index Exchange', 'In-App').deals[0], 0, 1)
    expect(out).toContain('inventory_channels: [In-App]')
  })

  it('IX Web Only emits explicit inventory_channels [Web]', () => {
    const form = envForm('Index Exchange', 'Web Only')
    expect(generateDealPromptYaml(form, form.deals[0], 0, 1)).toContain('inventory_channels: [Web]')
  })

  it('IX All omits inventory_channels — the deal_type default applies', () => {
    const form = envForm('Index Exchange', 'All')
    expect(generateDealPromptYaml(form, form.deals[0], 0, 1)).not.toContain('inventory_channels')
  })

  it('PubMatic In-App ships BOTH app platforms (4 iOS + 5 Android)', () => {
    const form = envForm('PubMatic', 'In-App')
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('platforms: [4, 5]')
  })

  it('SSPs with no environment wire emit the loud NOT-SUPPORTED marker for a narrowed environment', () => {
    // Xandr has left this list: Curate has an Inventory Type axis and the
    // profile carries it as supply_type_targets, so the environment now
    // reaches the wire instead of being dropped with a marker. Magnite's
    // DV+ channels still keep the marker (its device values carry no
    // web/app distinction); Streaming ships `environment` instead.
    for (const ssp of ['OpenX', 'Magnite', 'TripleLift'] as const) {
      const form = envForm(ssp, 'In-App')
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, ssp).toContain(`# NOT SUPPORTED on ${ssp}: Environment 'In-App'`)
    }
  })

  it('Audio fails closed on EVERY SSP — never silently booked as video', () => {
    // Audio has no verified create path anywhere. Three SSPs already blocked
    // it; Index, Media.net and TripleLift rode the OLV hint and produced a
    // VIDEO deal, and Xandr emitted ad_types:['audio'], a value the Curate
    // deal builder does not offer. A wrong-format deal that looks successful
    // is worse than a blocked one.
    for (const ssp of ['Index Exchange', 'Media.net', 'TripleLift', 'Xandr'] as const) {
      const form = envForm(ssp, 'All', 'Audio')
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, ssp).toContain(`# BLOCKED — UNSUPPORTED CHANNEL: Audio on ${ssp}`)
      expect(out, ssp).toContain('Report this deal as NOT CREATED')
    }
  })

  it('Xandr never emits the audio ad type — Curate has no such option', () => {
    const form = envForm('Xandr', 'All', 'Audio')
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).not.toContain('ad_types: [audio]')
  })

  it('TripleLift derives its channel from the DEAL, not the batch dropdown', () => {
    // A CTV deal in a mixed batch used to ship `channel: WEB` unless a trader
    // flipped the batch-level dropdown by hand — booking TV inventory against
    // the web supply pool.
    const ctv = envForm('TripleLift', 'All', 'CTV')
    expect(generateDealPromptYaml(ctv, ctv.deals[0], 0, 1)).toContain('channel: CTV')

    for (const channel of ['Display', 'OLV (Online Video)', 'OTT', 'Native'] as const) {
      const form = envForm('TripleLift', 'All', channel)
      expect(generateDealPromptYaml(form, form.deals[0], 0, 1), channel).toContain('channel: WEB')
    }
  })

  it('a forced TripleLift channel still overrides the per-deal derivation', () => {
    const form = envForm('TripleLift', 'All', 'Display')
    form.tripleliftConfig = { ...form.tripleliftConfig, channel: 'CTV' }
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('channel: CTV')
    expect(out).toContain('forced for the batch')
  })

  it('Xandr ships Inventory Type as supply_types instead of a marker', () => {
    const app = envForm('Xandr', 'In-App')
    const appOut = generateDealPromptYaml(app, app.deals[0], 0, 1)
    expect(appOut).toContain('supply_types: [mobile_app]')
    expect(appOut).not.toContain("# NOT SUPPORTED on Xandr: Environment 'In-App'")

    const web = envForm('Xandr', 'Web Only')
    expect(generateDealPromptYaml(web, web.deals[0], 0, 1)).toContain('supply_types: [web, mobile_web]')

    // All = no restriction, so nothing is emitted at all.
    const all = envForm('Xandr', 'All')
    expect(generateDealPromptYaml(all, all.deals[0], 0, 1)).not.toContain('supply_types:')
  })

  // OpenX derives distribution_channel from targeting.channel, and the MCP
  // hard-forces APP-only on CTV/OTT — so In-App IS applied there. The blanket
  // marker was telling traders to go set a restriction the deal already had,
  // and putting "NOT APPLIED" on a deal sheet for something that was applied.
  it('OpenX CTV/OTT In-App does NOT trip the marker — APP-only is forced by the channel', () => {
    for (const channel of ['CTV', 'OTT'] as const) {
      const form = envForm('OpenX', 'In-App', channel)
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, channel).not.toContain("# NOT SUPPORTED on OpenX: Environment 'In-App'")
    }
  })

  it('OpenX CTV Web Only STILL trips the marker — APP-only cannot honor it', () => {
    const form = envForm('OpenX', 'Web Only', 'CTV')
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain("# NOT SUPPORTED on OpenX: Environment 'Web Only'")
  })

  it('OpenX Display/OLV In-App STILL trips the marker — those ship WEB,APP', () => {
    for (const channel of ['Display', 'OLV (Online Video)'] as const) {
      const form = envForm('OpenX', 'In-App', channel)
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, channel).toContain("# NOT SUPPORTED on OpenX: Environment 'In-App'")
    }
  })

  it('the CTV exemption is OpenX-only — TripleLift has no environment wire at all', () => {
    for (const ssp of ['TripleLift'] as const) {
      const form = envForm(ssp, 'In-App', 'CTV')
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, ssp).toContain(`# NOT SUPPORTED on ${ssp}: Environment 'In-App'`)
    }
  })

  it('Magnite Streaming ships Inventory Type as `environment`, DV+ keeps the marker', () => {
    // Streaming encodes web-vs-app into the DEVICE values, so Inventory Type
    // has a real wire there — it selects the device set server-side.
    for (const channel of ['CTV', 'OTT'] as const) {
      const form = envForm('Magnite', 'In-App', channel)
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, channel).toContain('environment: In-App')
      expect(out, channel).not.toContain("# NOT SUPPORTED on Magnite: Environment 'In-App'")
    }
    // DV+ device values carry no web/app distinction, so it stays a marker.
    const dvPlus = envForm('Magnite', 'In-App', 'Display')
    const out = generateDealPromptYaml(dvPlus, dvPlus.deals[0], 0, 1)
    expect(out).toContain("# NOT SUPPORTED on Magnite: Environment 'In-App'")
  })

  it('All environments never trips the marker', () => {
    for (const ssp of ['OpenX', 'Xandr', 'Magnite', 'TripleLift'] as const) {
      const form = envForm(ssp, 'All')
      expect(generateDealPromptYaml(form, form.deals[0], 0, 1), ssp).not.toContain('NOT SUPPORTED on ' + ssp + ': Environment')
    }
  })
})

// =============================================================================
// Regression — failed-batch shape: PubMatic fee shape + Magnite
// full-marketplace pricing. Deal Onboarding must emit margin-only commercial intent,
// never raw SSP fee internals or a forced CPM floor.
// =============================================================================

// =============================================================================
// Per-deal IAB categories + per-deal file scoping (2026-07 restructure)
// =============================================================================

describe('per-deal IAB categories in prompts', () => {
  function iabForm(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10001',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
      deals: [
        { ...newDeal(), ssp: 'Index Exchange' as const, channel: 'Display' as const, cpm: '5', theme: 'Cold & Flu' },
        { ...newDeal(), ssp: 'Index Exchange' as const, channel: 'Display' as const, cpm: '5', theme: 'Beach Getaways' },
      ],
    }
  }

  it('each toggle-ON deal infers its OWN categories from its own theme', () => {
    // Inference is opt-in per deal (autoInferIab, default OFF) — the fixture
    // opts both deals in explicitly.
    const form = iabForm()
    form.deals[0].autoInferIab = true
    form.deals[1].autoInferIab = true
    const flu = generateDealPromptYaml(form, form.deals[0], 0)
    const beach = generateDealPromptYaml(form, form.deals[1], 1)
    // These are IX deals, so the inferred IAB names ship as their curated
    // contentGenre translations (cutlass#714): Health & Fitness → the live
    // catalog genre 'Health and wellness'; Travel → 'Travel'. The raw IAB
    // name must never reach an IX prompt — it would fail the create.
    expect(flu).toContain('iab_categories:')
    expect(flu).toContain('- "Health and wellness"')
    expect(flu).not.toContain('"Health & Fitness"')
    expect(flu).not.toContain('- Travel')
    expect(beach).toContain('iab_categories:')
    expect(beach).toContain('- Travel')
    expect(beach).not.toContain('"Health and wellness"')
  })

  it('an explicit per-deal pick overrides inference; empty pick emits no categories', () => {
    const form = iabForm()
    form.deals[0].iabCategories = ['News']
    form.deals[1].iabCategories = []
    const first = generateDealPromptYaml(form, form.deals[0], 0)
    expect(first).toContain('- News')
    expect(first).not.toContain('"Health & Fitness"')
    expect(generateDealPromptYaml(form, form.deals[1], 1)).not.toContain('iab_categories')
  })

  it('a stale campaign-level list never reaches the prompt — only per-deal/inferred categories emit (2026-07 live incident)', () => {
    // The campaign field is retired as a shipping input; legacy values fold
    // onto the deals at load. If one still slips through (stale cached
    // client), the prompt must NOT stamp it onto a pick-less deal — with the
    // toggle on, the deal's OWN inference emits instead; with it off, nothing.
    const form = iabForm()
    form.iabCategories = ['Auto Parts', 'Car Culture']
    form.deals[0].autoInferIab = true
    const flu = generateDealPromptYaml(form, form.deals[0], 0)
    // Inferred 'Health & Fitness' emits as its IX contentGenre catalog name.
    expect(flu).toContain('"Health and wellness"')
    expect(flu).not.toContain('Auto Parts')
    expect(flu).not.toContain('Car Culture')
    // Toggle off: the stale campaign list still never leaks — no iab lines.
    form.deals[0].autoInferIab = undefined
    const off = generateDealPromptYaml(form, form.deals[0], 0)
    expect(off).not.toMatch(/^\s*iab_categories:/m)
    expect(off).not.toContain('Auto Parts')
  })

  // The DEFAULT-OFF contract: a deal whose theme WOULD infer, but with no
  // explicit picks and no toggle, emits NO category lines on ANY SSP builder
  // — nothing ships, so nothing can appear in a deal-sheet email either.
  it('toggle OFF (default): no iab/content-category lines on any SSP builder', () => {
    for (const ssp of ['Index Exchange', 'OpenX', 'PubMatic', 'Xandr', 'Media.net', 'TripleLift', 'Magnite'] as const) {
      const form = iabForm()
      form.deals[0].ssp = ssp
      const out = generateDealPromptYaml(form, form.deals[0], 0)
      expect(out, `${ssp} must not emit include categories with the toggle off`).not.toMatch(/^\s*iab_categories:/m)
      expect(out, `${ssp} must not emit content categories with the toggle off`).not.toMatch(/^\s*content_categories:/m)
      expect(out, `${ssp} must not emit a category NOT-SUPPORTED marker with the toggle off`).not.toContain('NOT SUPPORTED: IAB category(ies)')
    }
  })

  it('toggle ON: the inferred names emit as each SSP catalog\'s own (mapped) spelling', () => {
    // 'Cold & Flu' infers 'Health & Fitness' — per-SSP that ships as the
    // catalog's exact name (or a loud NOT-SUPPORTED marker on OpenX, where
    // v2 splits it — never a doomed token).
    const expected: [DealEntry['ssp'], (out: string) => void][] = [
      ['Index Exchange', out => expect(out).toContain('- "Health and wellness"')],
      ['PubMatic', out => expect(out).toContain('- "Health & Fitness"')],
      ['Xandr', out => expect(out).toContain('- Health')],
      ['Media.net', out => expect(out).toContain('- "Health & Fitness"')],
      ['OpenX', out => expect(out).toContain('# NOT SUPPORTED: IAB category(ies) ["Health & Fitness"]')],
    ]
    for (const [ssp, check] of expected) {
      const form = iabForm()
      form.deals[0].ssp = ssp
      form.deals[0].autoInferIab = true
      check(generateDealPromptYaml(form, form.deals[0], 0))
    }
  })
})

// Per-deal IAB EXCLUDES (DealEntry.iabCategoriesExclude, explicit-only). The
// full per-SSP arg-name matrix lives in contractGolden.test.ts (pinned against
// cutlass-contract.json); this suite covers the emission mechanics — includes
// untouched, custom genre names verbatim, the unsupported-SSP comment, and the
// batch prompt's Required-final-summary follow-up line.
describe('per-deal IAB excludes in prompts', () => {
  function exForm(ssp: DealEntry['ssp']): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10002',
      curatedDealFee: '25',
      dealSheetRecipient: 'trader@example.com',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
      deals: [
        // autoInferIab: this suite exercises the include-inference ↔ exclude
        // interplay, and inference is opt-in per deal (default OFF).
        { ...newDeal(), ssp, channel: 'Display' as const, cpm: '5', theme: 'Cold & Flu', autoInferIab: true, iabCategoriesExclude: ['Crime', 'Kids and family'] },
      ],
    }
  }

  it('IX emits excluded_iab_categories WITHOUT touching the include emission', () => {
    const out = generateDealPromptYaml(exForm('Index Exchange'), exForm('Index Exchange').deals[0], 0)
    // Include block: still the deal's own inference (Cold & Flu → Health &
    // Fitness), shipped as its curated contentGenre translation (cutlass#714).
    expect(out).toContain('iab_categories:')
    expect(out).toContain('- "Health and wellness"')
    // Exclude block: SSP-native genre strings, fixture-verified against the
    // live key-11 catalog and emitted in its canonical spelling (an
    // unverifiable name becomes a loud NOT-SUPPORTED comment, never a token).
    expect(out).toMatch(/^excluded_iab_categories:.*contentgenre NONE_OF/m)
    expect(out).toContain('- Crime')
    expect(out).toContain('- "Kids and family"')
  })

  // a live batch DEAL00188 deal 12 (2026-08-13): the trader's picks mixed one
  // key-11 label ("Health and wellness") with four key-1066 labels. The old
  // coverage rule counted the 1066 labels as genre pass-throughs, selected
  // key 11, and shipped them verbatim on the wrong key — killing the deal at
  // the MCP. Fixture-verified coverage must select key 1066 (4/5 includes),
  // emit the four 1066 names, and flag the genre-only name NOT-SUPPORTED.
  it('a mixed-key IX pick selects the key covering more includes and flags the rest (DEAL00188 deal 12 regression)', () => {
    const form = exForm('Index Exchange')
    form.deals[0] = {
      ...form.deals[0],
      autoInferIab: false,
      iabCategoriesExclude: [],
      iabCategories: ['Health and wellness', "Men's Health", 'Health/Lowfat Cooking', "Women's Health", 'Senor Health'],
    }
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('iabContentCategory (key 1066) catalog names')
    expect(out).toContain(`- "Men's Health"`)
    expect(out).toContain(`- "Women's Health"`)
    expect(out).toContain('- "Health/Lowfat Cooking"')
    expect(out).toContain('- "Senor Health"') // IX's own catalog spelling — the vendor's typo, verbatim
    expect(out).toMatch(/NOT SUPPORTED:.*Health and wellness/)
    expect(out).not.toMatch(/^\s*- "Health and wellness"/m)
  })

  it('PubMatic emits exclude_iab_categories as its own block', () => {
    const form = exForm('PubMatic')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toMatch(/^exclude_iab_categories:/m)
    expect(out).toContain('- Crime')
  })

  // Colliding value: includes can be INFERRED (theme "Beach Sports" infers
  // Travel) while the same category sits in the explicit exclude list. Emitting
  // it on both sides would fail the deal at the SSP MCP's include/exclude
  // conflict gate mid-batch — the explicit exclude must win: the include
  // emission drops it (case-insensitively) while the exclude block still
  // carries the trader's verbatim value.
  it('an explicit exclude beats a colliding inferred include on IX and PubMatic', () => {
    for (const ssp of ['Index Exchange', 'PubMatic'] as const) {
      const form = exForm(ssp)
      form.deals[0].theme = 'Beach Sports' // infers Sports + Travel
      form.deals[0].iabCategoriesExclude = ['travel', 'Crime'] // lowercase: the filter is case-insensitive
      const out = generateDealPromptYaml(form, form.deals[0], 0)
      // Include block survives with only the non-colliding category…
      // (PubMatic's key carries a trailing #233.4 canonicalization comment.)
      expect(out).toMatch(/^iab_categories:/m)
      expect(out).toContain('- Sports')
      expect(out).toContain('- Crime')
      if (ssp === 'Index Exchange') {
        // IX is fixture-verified on the selected key: the lowercase exclude
        // ships in the catalog's canonical spelling ('Travel'), and it must
        // appear ONLY in the exclude block — never in the include emission.
        expect(out).toMatch(/^excluded_iab_categories:/m)
        const includeAt = out.indexOf('iab_categories:')
        const excludeAt = out.indexOf('excluded_iab_categories:')
        const travelAt = out.indexOf('- Travel')
        expect(travelAt).toBeGreaterThan(excludeAt)
        expect(excludeAt).toBeGreaterThan(includeAt)
        expect(out.match(/- Travel/g)).toHaveLength(1)
      } else {
        // PubMatic keeps the verbatim pass-through contract: the include
        // (capital T) never emits, the exclude carries the trader's value.
        expect(out).toMatch(/^exclude_iab_categories:/m)
        expect(out).not.toContain('- Travel')
        expect(out).toContain('- travel')
      }
    }
  })

  it('a full collision empties the include emission entirely — never both sides', () => {
    const form = exForm('Index Exchange')
    // Cold & Flu infers exactly ["Health & Fitness"], which the brief excludes.
    form.deals[0].iabCategoriesExclude = ['Health & Fitness']
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).not.toMatch(/^iab_categories:/m) // anchored: excluded_iab_categories doesn't match
    expect(out).toMatch(/^excluded_iab_categories:/m)
    // The exclude ships as the curated contentGenre translation (cutlass#714),
    // never the raw IAB name (which would fail exact-match resolution).
    expect(out).toContain('- "Health and wellness"')
    expect(out).not.toContain('- "Health & Fitness"')
  })

  it('an unsupported SSP gets the loud trader-UI comment, never an exclude arg', () => {
    const form = exForm('Magnite')
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('# IAB/content EXCLUSIONS requested but NOT supported by the Magnite create API — trader must apply in the SSP UI: Crime, Kids and family')
    expect(out).not.toMatch(/^\s*excluded?_iab_categories:/m)
  })

  it('no emission at all when the deal carries no excludes (undefined AND [])', () => {
    for (const empty of [undefined, []] as const) {
      const form = exForm('Index Exchange')
      form.deals[0].iabCategoriesExclude = empty as string[] | undefined
      const out = generateDealPromptYaml(form, form.deals[0], 0)
      expect(out).not.toContain('excluded_iab_categories')
      expect(out).not.toContain('IAB/content EXCLUSIONS')
    }
  })

  it('batch prompt adds the Required-final-summary follow-up line only when a deal carries excludes', () => {
    const withEx = buildBatchPrompt(exForm('OpenX'))
    expect(withEx).toContain('Per deal with IAB/content EXCLUSIONS:')
    expect(withEx).toContain('TRADER UI FOLLOW-UP')
    const form = exForm('OpenX')
    form.deals[0].iabCategoriesExclude = undefined
    expect(buildBatchPrompt(form)).not.toContain('Per deal with IAB/content EXCLUSIONS:')
  })
})

// Per-SSP catalog-verified IAB emission (2026-07-14 live audit): every
// category name Deal Onboarding emits is canonicalized against the target SSP's
// REAL catalog (checked-in fixtures under sspIabCatalogs/), and IX resolves
// each deal's names on exactly ONE targeting key (contentGenre XOR
// iabContentCategory — never mixed, cutlass#831). sspIabCatalogs.test.ts
// replays all 26 picker names per SSP; these are the golden emission shapes.
describe('per-SSP IAB catalog-verified emission (2026-07-14 audit)', () => {
  function iabSspForm(ssp: DealEntry['ssp'], iabCategories: string[], iabCategoriesExclude?: string[]): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10002',
      curatedDealFee: '25',
      dealSheetRecipient: 'trader@example.com',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
      deals: [
        { ...newDeal(), ssp, channel: 'Display' as const, cpm: '5', theme: 'Audience', iabCategories, iabCategoriesExclude },
      ],
    }
  }
  const gen = (form: FormData) => generateDealPromptYaml(form, form.deals[0], 0)

  it('IX: an all-genre-coverable deal stays on contentGenre (key 11) — unchanged wire', () => {
    const out = gen(iabSspForm('Index Exchange', ['News', 'Travel', 'Style & Fashion']))
    expect(out).toContain('contentGenre (key 11)')
    expect(out).toContain('- News')
    expect(out).toContain('- Travel')
    expect(out).toContain('- Fashion') // curated genre translation
    expect(out).not.toContain('iabContentCategory (key 1066)')
  })

  it("IX: a deal containing 'Society' (1066-only) emits ALL names as 1066 names — never a genre/1066 mix", () => {
    const out = gen(iabSspForm('Index Exchange', ['Society', 'Style & Fashion']))
    expect(out).toContain('iabContentCategory (key 1066)')
    expect(out).toContain('- Society')
    expect(out).toContain('- "Style & Fashion"') // verbatim 1066 name…
    expect(out).not.toMatch(/^\s*- Fashion\s*$/m) // …NEVER its genre translation on this key
    expect(out).not.toContain('# NOT SUPPORTED')
  })

  it("IX: 'Law, Gov & Politics' bridges to the 1066 spelling \"Law, Gov't & Politics\"", () => {
    const out = gen(iabSspForm('Index Exchange', ['Law, Gov & Politics']))
    expect(out).toContain('iabContentCategory (key 1066)')
    expect(out).toContain(`- "Law, Gov't & Politics"`)
    expect(out).not.toMatch(/^\s*- "Law, Gov & Politics"\s*$/m)
  })

  it('IX: a mixed-uncoverable deal emits the MAJORITY key and NOT-SUPPORTED-comments the rest', () => {
    // 1066 covers Society + Real Estate (2); contentGenre covers only
    // Consumer Banking (1) → key 1066 wins; Consumer Banking comments loudly.
    const out = gen(iabSspForm('Index Exchange', ['Society', 'Real Estate', 'Consumer Banking']))
    expect(out).toContain('iabContentCategory (key 1066)')
    expect(out).toContain('- Society')
    expect(out).toContain('- "Real Estate"')
    expect(out).toContain('# NOT SUPPORTED: IAB category(ies) ["Consumer Banking"]')
    expect(out).not.toContain('- "Business and financial"')
  })

  it('IX: includes and excludes always land on the SAME key', () => {
    // 'Insurance' (exclude) resolves only on 1066 → the include 'News'
    // (coverable on both keys) rides 1066 with it, and the exclude applies as
    // iabContentCategory NONE_OF.
    const out = gen(iabSspForm('Index Exchange', ['News'], ['Insurance']))
    expect(out).toContain('iabContentCategory (key 1066)')
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('- News')
    expect(out).toMatch(/^excluded_iab_categories:.*iabContentCategory NONE_OF/m)
    expect(out).toContain('- Insurance')
    expect(out).not.toContain('contentgenre NONE_OF')
  })

  it('IX: an exclude-heavy vote never flips the key away from the include — a deal must not invert to all-inventory-except', () => {
    // Include 'Consumer Banking' covers ONLY contentGenre; excludes Society +
    // Real Estate cover ONLY 1066 (2 vs 1 on raw counts). INCLUDE coverage
    // outranks total coverage: the deal stays on contentGenre, the include
    // ships, and the excludes surface as trader follow-ups — never an empty
    // include list alongside live NONE_OF excludes (the FIX 3 inversion).
    const out = gen(iabSspForm('Index Exchange', ['Consumer Banking'], ['Society', 'Real Estate']))
    expect(out).toContain('contentGenre (key 11)')
    expect(out).toContain('- "Business and financial"')
    expect(out).not.toMatch(/^excluded_iab_categories:/m)
    expect(out).toContain('# NOT SUPPORTED: IAB category exclusion(s) [Society, "Real Estate"]')
    expect(out).toContain('trader UI follow-up')
  })

  it('OpenX: picker names canonicalize to exact live IAB v2 catalog names', () => {
    const out = gen(iabSspForm('OpenX', ['News', 'Careers & Employment', 'Family & Parenting', 'Travel']))
    expect(out).toContain('iab_categories: ["News and Politics", Careers, "Family and Relationships", Travel]')
    expect(out).not.toContain('Careers & Employment')
    // 'Parenting' alone (the old silent contains-narrowing) never emits.
    expect(out).not.toMatch(/iab_categories:.*[^d ]Parenting/)
  })

  it("OpenX: 'News' and 'Law, Gov & Politics' both canonicalize to the v2 successor 'News and Politics' and dedupe", () => {
    const out = gen(iabSspForm('OpenX', ['News', 'Law, Gov & Politics']))
    expect(out).toContain('iab_categories: ["News and Politics"]')
  })

  it('OpenX: names with no defensible v2 equivalent emit the loud NOT-SUPPORTED marker, never a doomed token', () => {
    const out = gen(iabSspForm('OpenX', ['Health & Fitness', 'Society', 'Travel']))
    expect(out).toContain('iab_categories: [Travel]')
    expect(out).toContain('# NOT SUPPORTED: IAB category(ies) ["Health & Fitness", Society]')
    expect(out).toContain(`'Healthy Living' / 'Medical Health'`)
    // The doomed names never reach the arg — only the [Travel] list above.
    expect(out).not.toMatch(/iab_categories:.*Health & Fitness/)
    expect(out).not.toMatch(/iab_categories:.*Society/)
  })

  it('Xandr: picker names canonicalize to exact live universal-catalog entities — never a fuzzy app-store promote', () => {
    const out = gen(iabSspForm('Xandr', ['Style & Fashion', 'Technology & Computing', 'News']))
    expect(out).toContain('- "Fashion & Style"')
    expect(out).toContain('- "Computers & Electronics"')
    expect(out).toContain('- News')
    expect(out).not.toContain('Windows Store') // the live fuzzy-promote defect
    expect(out).not.toContain('- "Style & Fashion"')
  })

  it('Xandr: unsupported names emit the loud marker — the fail-open resolver would otherwise silently DROP them', () => {
    const out = gen(iabSspForm('Xandr', ['Law, Gov & Politics']))
    expect(out).not.toMatch(/^iab_categories:/m)
    expect(out).toContain('# NOT SUPPORTED: IAB category(ies) ["Law, Gov & Politics"]')
    expect(out).toContain('silently DROP')
  })

  it('Media.net: canonical spellings + the loud marker for the finance sub-lines', () => {
    const out = gen(iabSspForm('Media.net', ['Law, Gov & Politics', 'Careers & Employment', 'News', 'Life Insurance']))
    expect(out).toMatch(/^content_categories:/m)
    expect(out).toContain(`- "Law, Gov't & Politics"`)
    expect(out).toContain('- Careers')
    expect(out).toContain('- News')
    expect(out).toContain('# NOT SUPPORTED: IAB category(ies) ["Life Insurance"]')
    expect(out).not.toContain('- "Life Insurance"')
    expect(out).not.toContain('- "Law, Gov & Politics"')
  })
})

describe('per-deal file scoping (UploadedFile.appliesTo)', () => {
  function fileForm(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL10001',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
      domainLists: [{ id: 'f1', name: 'news-sites.csv', size: 10, path: '/x/f1.csv', inclusionType: 'Include' as const }],
      deals: [
        { ...newDeal(), id: 'd-one', ssp: 'Index Exchange' as const, channel: 'Display' as const, cpm: '5', theme: 'One' },
        { ...newDeal(), id: 'd-two', ssp: 'Index Exchange' as const, channel: 'Display' as const, cpm: '5', theme: 'Two' },
      ],
    }
  }

  it('an unscoped file applies to every matching deal (pre-existing behavior)', () => {
    const form = fileForm()
    expect(generateDealPromptYaml(form, form.deals[0], 0)).toContain('news-sites.csv')
    expect(generateDealPromptYaml(form, form.deals[1], 1)).toContain('news-sites.csv')
  })

  it('a file scoped via appliesTo only reaches the assigned deals', () => {
    const form = fileForm()
    form.domainLists[0].appliesTo = ['d-two']
    expect(generateDealPromptYaml(form, form.deals[0], 0)).not.toContain('news-sites.csv')
    expect(generateDealPromptYaml(form, form.deals[1], 1)).toContain('news-sites.csv')
  })

  it('an explicit per-deal list selection bypasses the appliesTo filter', () => {
    const form = fileForm()
    form.domainLists[0].appliesTo = ['d-two']
    form.deals[0].domainListId = 'f1'
    expect(generateDealPromptYaml(form, form.deals[0], 0)).toContain('news-sites.csv')
  })
})


// =============================================================================
// SSP-scoped always-exclude segments — a partner block list is IX-only.
// =============================================================================


// =============================================================================
// Ad-duration targeting — resolution edge cases + the batch reporting
// contract. The per-SSP wire matrix (arg names, NOT-SUPPORTED comments,
// Display emits nothing) lives in contractGolden.test.ts against the
// CI-checked cutlass-contract.json; these tests cover the pieces around it.
// =============================================================================

describe('ad-duration targeting — resolution + batch summary contract', () => {
  function durForm(ssp: DealEntry['ssp'], channel: DealEntry['channel'], dur: Partial<Pick<DealEntry, 'adDurations' | 'maxAdDurationSecs'>>): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T', submitterEmail: 't@example.com',
      flightStartDate: '2027-01-01', flightEndDate: '2028-12-31',
      agency: 'A', brand: 'B', campaignId: 'DEAL11001',
      dealSheetRecipient: 'trader@example.com',
      curatedDealFee: '25',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
      magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' },
      deals: [{ ...newDeal(), ssp, channel, cpm: '5', theme: 'Audience', ...dur }],
    }
  }
  const SUMMARY_LINE = 'Per deal with ad-duration targeting'

  it('resolveAdDuration sorts, dedupes and drops malformed entries (QA flags them loudly upstream)', () => {
    const form = durForm('Index Exchange', 'CTV', { adDurations: ['30', '15', '15', 'abc', '-6', ''] })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('max_ad_durations: [15, 30]')
  })

  // Strict strconv.Atoi-parity parsing (/^\d+$/ — same pattern as
  // dealUpdateOps' parseDurationSecondsList): entries the Go QA layer flags
  // as invalid must be DROPPED, never mangled by lenient parseInt ('1e3'→1,
  // '15.5'→15, '15s'→15) into a value the trader never typed. The drop is
  // surfaced by the qa_ad_duration warning — the single truthful signal.
  it('drops (never mangles) 1e3/15.5/15s-style allowed entries — no parseInt prefix-parse', () => {
    const form = durForm('Index Exchange', 'CTV', { adDurations: ['1e3', '15.5', '15s', '30'] })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('max_ad_durations: [30]')
    expect(out).not.toContain('max_ad_durations: [1,')
    expect(out).not.toMatch(/max_ad_durations: \[\s*15\b/)
  })

  it('drops (never mangles) a malformed max cap — Magnite must not emit an exact-1-second range from "1e3"', () => {
    const form = durForm('Magnite', 'CTV', { maxAdDurationSecs: '1e3' })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).not.toMatch(/^\s*ad_duration_(min|max):/m)
    expect(out).not.toContain('ad_duration_max: 1')
  })

  it('OpenX emits no duration args (and no duration-gate channel comment) when the only duration value is malformed', () => {
    const form = durForm('OpenX', 'CTV', { maxAdDurationSecs: '15.5' })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).not.toContain('adunit_max_duration')
    // The channel line itself is now ALWAYS emitted (cutlass#726 — it drives
    // the rendering context), but it must carry the rendering-context comment,
    // not the duration-gate comment: no duration args survived.
    expect(out).not.toMatch(/^\s*channel:.*ox_duration_requires_video_channel/m)
    expect(out).toMatch(/^ {2}channel: CTV\b/m)
  })

  it('resolveAdDuration returns null when nothing survives strict parsing', () => {
    const deal: DealEntry = { ...newDeal(), channel: 'CTV', adDurations: ['1e3', '15.5', '15s'], maxAdDurationSecs: '2.5' }
    expect(resolveAdDuration(deal)).toBeNull()
  })

  it('resolveAdDuration strict-parses the max cap independently of the allowed list', () => {
    const deal: DealEntry = { ...newDeal(), channel: 'CTV', adDurations: [], maxAdDurationSecs: '1e3' }
    expect(resolveAdDuration(deal)).toBeNull()
    const ok: DealEntry = { ...newDeal(), channel: 'CTV', adDurations: [], maxAdDurationSecs: '30' }
    expect(resolveAdDuration(ok)).toEqual({ allowed: [], maxSecs: 30, lo: undefined, hi: 30 })
  })

  it('IX max-only cap emits the bucket-discovery instruction (account buckets are runtime-resolved)', () => {
    const form = durForm('Index Exchange', 'CTV', { maxAdDurationSecs: '30' })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('# Ad-duration cap (max 30s): IX targets an allowed-list of MAX-duration buckets')
    expect(out).toContain('ix_list_targeting_values')
    expect(out).toContain('max_ad_durations: [<every account max-duration bucket <= 30 — resolve via ix_list_targeting_values>]')
  })

  it('a contiguous allowed list emits NO widening warning (nothing in-between is admitted)', () => {
    const form = durForm('Magnite', 'CTV', { adDurations: ['15', '16'] })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('ad_duration_min: 15')
    expect(out).toContain('ad_duration_max: 16')
    expect(out).not.toContain('widens to')
  })

  it('a gapped allowed list names a concrete admitted in-between length', () => {
    const form = durForm('Magnite', 'CTV', { adDurations: ['15', '30'] })
    const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
    expect(out).toContain('widens to 15-30s')
    expect(out).toContain('(e.g. 16s)')
  })

  it('OTT and OLV channels resolve durations like CTV and emit the gate channel enum (OLV shortened)', () => {
    for (const [channel, gateValue] of [['OTT', 'OTT'], ['OLV (Online Video)', 'OLV']] as const) {
      const form = durForm('OpenX', channel, { adDurations: ['15', '30'] })
      const out = generateDealPromptYaml(form, form.deals[0], 0, 1)
      expect(out, channel).toContain('adunit_max_duration_start: 15')
      expect(out, channel).toContain('adunit_max_duration_end: 30')
      // The OpenX MCP's video gate reads targeting.channel ONLY and compares
      // exactly against CTV/OLV/OTT — the 'OLV (Online Video)' form label
      // must arrive shortened or the whole create is blocked.
      expect(out, channel).toMatch(new RegExp(`^ {2}channel: ${gateValue}\\b.*ox_duration_requires_video_channel`, 'm'))
    }
  })

  it('batch prompt requires APPLIED / NOT APPLIED duration reporting when a deal carries durations', () => {
    const out = buildBatchPrompt(durForm('PubMatic', 'CTV', { adDurations: ['15', '30'] }))
    expect(out).toContain(SUMMARY_LINE)
    expect(out).toContain('NOT APPLIED')
  })

  it('batch prompt omits the duration summary line when no deal carries durations', () => {
    const out = buildBatchPrompt(durForm('Index Exchange', 'CTV', {}))
    expect(out).not.toContain(SUMMARY_LINE)
  })

  it('stray durations on a Display deal do NOT fire the summary line (nothing was emitted; QA flags the field)', () => {
    const out = buildBatchPrompt(durForm('Index Exchange', 'Display', { adDurations: ['15', '30'] }))
    expect(out).not.toContain(SUMMARY_LINE)
    expect(out).not.toContain('max_ad_durations')
  })
})

// =============================================================================
// Sheet-only rows — P1: a follow-up batch listing already-live deals must
// NEVER re-create them. Mirrors the SNAP fixture in dealBrief.test.ts: the
// brief has always separated sheet-only rows (already_created_for_sheet);
// the prompt is what Cutlass EXECUTES, so it must make the same split.
// =============================================================================

describe('buildBatchPrompt — sheet-only rows never emit a create entry', () => {
  const PM_USERS = 'Partner_Pubmatic_Yahoo_Soundwave_SNAP_NA_SNAP users_Display_All_US_DEAL07238_B14'
  const PM_PROXY = 'Partner_Pubmatic_Yahoo_Soundwave_SNAP_NA_SNAP proxy users_Display_All_US_DEAL07238_B14'
  const OX_USERS = 'Partner_OpenX_Yahoo_Soundwave_SNAP_NA_SNAP users_Display_All_US_DEAL07238_B14'
  const OX_PROXY = 'Partner_OpenX_Yahoo_Soundwave_SNAP_NA_SNAP proxy users_Display_All_US_DEAL07238_B14'

  // 2 PubMatic creates + 2 already-live OpenX rows riding the sheet only.
  function snapFollowUpForm(): FormData {
    const mk = (over: Partial<DealEntry>): DealEntry => ({ ...newDeal(), channel: 'Display', cpm: '2.50', ...over })
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
      dsps: [{ id: '1', dsp: 'Yahoo', seatId: '6615' }],
      deals: [
        mk({ ssp: 'PubMatic', theme: 'SNAP users', nameOverride: PM_USERS }),
        mk({ ssp: 'PubMatic', theme: 'SNAP proxy users', nameOverride: PM_PROXY }),
        mk({ ssp: 'OpenX', theme: 'SNAP users', nameOverride: OX_USERS, sheetOnly: true }),
        mk({ ssp: 'OpenX', theme: 'SNAP proxy users', nameOverride: OX_PROXY, sheetOnly: true }),
      ],
    }
  }

  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

  it('emits exactly 2 create entries (tool/prompt_inputs) — never one per sheet-only row', () => {
    const out = buildBatchPrompt(snapFollowUpForm())
    // Create entries carry a 4-space-indented tool: line + a prompt_inputs body.
    expect(out.match(/^    tool: mcp_/gm)).toHaveLength(2)
    expect(out.match(/prompt_inputs: \|/g)).toHaveLength(2)
    // No OpenX create routing anywhere in the prompt.
    expect(out).not.toContain('mcp_openx')
  })

  it('embeds each sheet-only name exactly once, ONLY inside already_created_for_sheet', () => {
    const out = buildBatchPrompt(snapFollowUpForm())
    const sectionStart = out.indexOf('already_created_for_sheet:')
    expect(sectionStart).toBeGreaterThan(-1)
    for (const name of [OX_USERS, OX_PROXY]) {
      expect(count(out, name)).toBe(1)
      expect(out.indexOf(name)).toBeGreaterThan(sectionStart)
    }
    // The audit gate (moc.go promptEmbedsName) binds ALL audited names — the
    // create names must still be present too.
    expect(out).toContain(PM_USERS)
    expect(out).toContain(PM_PROXY)
    // Rows carry the brief's vocabulary so agent + brief + prompt agree.
    expect(out.match(/status: already_created/g)).toHaveLength(2)
  })

  it('carries the explicit do-not-create instruction above the section', () => {
    const out = buildBatchPrompt(snapFollowUpForm())
    const instruction = out.indexOf('Do NOT create, update, or call any SSP tool for them')
    expect(instruction).toBeGreaterThan(-1)
    expect(instruction).toBeLessThan(out.indexOf('already_created_for_sheet:'))
    expect(out).toContain('include each on the deal sheet and in the')
  })

  it('critical_actions authorizes exactly 2 creates + the send_email finalizer', () => {
    const out = buildBatchPrompt(snapFollowUpForm())
    const block = out.slice(out.indexOf('Audit declaration (typed critical_actions list)'))
    expect(block.match(/^- tool: /gm)).toHaveLength(3)
    expect(block.match(/^- tool: mcp_pubmatic_mcp_pm_execute_deal_from_prompt_inputs$/gm)).toHaveLength(2)
    expect(block).toContain('- tool: mcp_sendgrid_send_email')
    expect(block).not.toContain('mcp_openx')
    // Sheet-only names must not appear as create identifiers.
    expect(block).not.toContain(OX_USERS)
    expect(block).not.toContain(OX_PROXY)
  })

  it('deal sheet + email speak the truthful split, and the sheet includes the live rows', () => {
    const out = buildBatchPrompt(snapFollowUpForm())
    expect(out).toContain('(2 new + 2 already created)')
    expect(out).toContain('PLUS every already_created_for_sheet row')
    expect(out).toContain('NO create/update tool was called for any already_created_for_sheet row')
    // Deal N of M headers count creates only — mirroring the brief's indexing.
    expect(out).toContain('# Deal 1 of 2')
    expect(out).toContain('# Deal 2 of 2')
  })

  it('a batch with no sheet-only rows is unchanged (no section, plain count)', () => {
    const form = snapFollowUpForm()
    form.deals = form.deals.filter(d => !d.sheetOnly)
    const out = buildBatchPrompt(form)
    expect(out).not.toContain('already_created_for_sheet')
    expect(out).toContain('(2 deals)')
  })

  it('an all-sheet-only batch emits no create entries but still builds sheet + email', () => {
    const form = snapFollowUpForm()
    form.deals = form.deals.filter(d => d.sheetOnly)
    const out = buildBatchPrompt(form)
    expect(out).toContain('deals: []')
    expect(out.match(/prompt_inputs: \|/g)).toBeNull()
    expect(out).toContain('already_created_for_sheet:')
    expect(out).toContain('final_step:')
    expect(out).toContain('- tool: mcp_sendgrid_send_email')
  })
})

describe('buildCriticalActionsBlock — sheet-only rows', () => {
  it('authorizes a create tool ONLY for non-sheet-only deals', () => {
    const create = { ...newDeal(), ssp: 'Index Exchange' as const, channel: 'CTV' as const, externalReferenceId: 'IX-new' }
    const live = { ...newDeal(), ssp: 'OpenX' as const, channel: 'Display' as const, externalReferenceId: 'OX-live', sheetOnly: true }
    const form = { ...DEFAULT_FORM, dealSheetRecipient: 'trader@example.com', deals: [create, live] }
    const block = buildCriticalActionsBlock(form)
    // 2 tool entries: the IX create + the send_email finalizer. No OpenX.
    expect(block.match(/^- tool: /gm)).toHaveLength(2)
    expect(block).toContain('mcp_indexexchange_mcp_ix_execute_deal_from_prompt_inputs')
    expect(block).not.toContain('mcp_openx')
    expect(block).not.toContain('OX-live')
    expect(block).toContain('1 new + 1 already created')
  })
})

// =============================================================================
// Multi-DSP expansion (LOCKED): each selected DSP yields its own deal with its
// own name-slot code (slot 3) and its own seat id in prompt_inputs. Mirrors
// generateNamedDeals in internal/validation/rules.go — the moc.go gate
// compares the two sets 1:1.
// =============================================================================

describe('buildBatchPrompt — multi-DSP expansion', () => {
  function multiDspForm(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T',
      submitterEmail: 't@example.com',
      flightStartDate: '2099-01-01',
      flightEndDate: '2099-12-31',
      agency: 'Ideon',
      brand: 'Acme',
      campaignId: 'DEAL00500',
      attributionCode: 'B14',
      dealSheetRecipient: 'trader@example.com',
      curatedDealFee: '25',
      multipleDsps: true,
      dsps: [
        { id: '1', dsp: 'The Trade Desk', seatId: '111' },
        { id: '2', dsp: 'DV360', seatId: '222' },
      ],
      deals: [{ ...newDeal(), ssp: 'Index Exchange', channel: 'Display', theme: 'Digital Consumer', cpm: '2.50' }],
    }
  }

  it('emits one create entry per (deal × DSP) pair, names differing only in slot 3', () => {
    const out = buildBatchPrompt(multiDspForm())
    expect(out).toContain('name: "Curator_Index_TTD_Ideon_Acme_NA_Digital Consumer_Display_All_US_DEAL00500_B14"')
    expect(out).toContain('name: "Curator_Index_DV360_Ideon_Acme_NA_Digital Consumer_Display_All_US_DEAL00500_B14"')
    expect(out).toContain('# Deal 1 of 2')
    expect(out).toContain('# Deal 2 of 2')
  })

  it('each expanded deal carries its OWN DSP seat id in prompt_inputs (rule 16)', () => {
    const out = buildBatchPrompt(multiDspForm())
    const ttdBlock = out.slice(out.indexOf('_TTD_'), out.indexOf('_DV360_'))
    expect(ttdBlock).toContain('seat_name: 111')
    const dvBlock = out.slice(out.indexOf('name: "Curator_Index_DV360_'))
    expect(dvBlock).toContain('seat_name: 222')
    expect(dvBlock).toContain('dsp_name: DV360')
  })

  it('critical_actions lists one create action per expanded deal', () => {
    const block = buildCriticalActionsBlock(multiDspForm())
    const creates = block.split('\n').filter(l => l.startsWith('- tool: mcp_indexexchange'))
    expect(creates).toHaveLength(2)
  })

  it('multipleDsps=false pins the batch to the first DSP only', () => {
    const form = { ...multiDspForm(), multipleDsps: false }
    const out = buildBatchPrompt(form)
    expect(out).toContain('_TTD_')
    expect(out).not.toContain('_DV360_')
  })


  it('buildBatchBrief expands identically (deal_name set matches the prompt)', async () => {
    const { buildBatchBrief } = await import('./dealBrief')
    const brief = buildBatchBrief(multiDspForm())
    expect(brief.deals.map(d => d.deal_name)).toEqual([
      'Curator_Index_TTD_Ideon_Acme_NA_Digital Consumer_Display_All_US_DEAL00500_B14',
      'Curator_Index_DV360_Ideon_Acme_NA_Digital Consumer_Display_All_US_DEAL00500_B14',
    ])
  })

  it('REGRESSION: sheet-only rows NEVER expand — one row on the first active DSP, no fabricated names', () => {
    // A deal created before multi-DSP expansion, carried as sheetOnly with no
    // nameOverride: expanding it would put an "already created" _DV360_ deal
    // that never existed on the client deal-sheet email.
    const form = multiDspForm()
    form.deals = form.deals.map(d => ({ ...d, sheetOnly: true }))
    const out = buildBatchPrompt(form)
    expect(out).toContain('deals: []')
    const sheetSection = out.slice(out.indexOf('already_created_for_sheet:'))
    expect(sheetSection).toContain('name: "Curator_Index_TTD_Ideon_Acme_NA_Digital Consumer_Display_All_US_DEAL00500_B14"')
    expect(out).not.toContain('_DV360_')
    const sheetRows = sheetSection.split('\n').filter(l => l.trim().startsWith('- ssp:'))
    expect(sheetRows).toHaveLength(1)
  })

  it('REGRESSION: buildBatchBrief sheet rows do not expand either (gate parity with the audit)', async () => {
    const { buildBatchBrief } = await import('./dealBrief')
    const form = multiDspForm()
    form.deals = [
      { ...form.deals[0], sheetOnly: true },
      { ...newDeal(), ssp: 'Index Exchange', channel: 'Display', theme: 'New Seg', cpm: '2.50' },
    ]
    const brief = buildBatchBrief(form)
    expect(brief.already_created_for_sheet.map(r => r.deal_name)).toEqual([
      'Curator_Index_TTD_Ideon_Acme_NA_Digital Consumer_Display_All_US_DEAL00500_B14',
    ])
    expect(brief.deals.map(d => d.deal_name)).toEqual([
      'Curator_Index_TTD_Ideon_Acme_NA_New Seg_Display_All_US_DEAL00500_B14',
      'Curator_Index_DV360_Ideon_Acme_NA_New Seg_Display_All_US_DEAL00500_B14',
    ])
  })

  it('Media.net: each expanded deal ships ONLY its own DSP in demand_partners', () => {
    const form = multiDspForm()
    form.deals = [{ ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Digital Consumer', cpm: '2.50' }]
    const out = buildBatchPrompt(form)
    const dpLines = out.split('\n').filter(l => l.trim().startsWith('demand_partners:'))
    expect(dpLines).toHaveLength(2)
    expect(dpLines[0]).toContain('["The Trade Desk"]')
    expect(dpLines[0]).not.toContain('DV360')
    expect(dpLines[1]).toContain('[DV360]')
    expect(dpLines[1]).not.toContain('The Trade Desk')
  })

  it('Media.net: multipleDsps off ignores a stale second DSP row', () => {
    const form = multiDspForm()
    form.multipleDsps = false
    form.deals = [{ ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Digital Consumer', cpm: '2.50' }]
    const out = buildBatchPrompt(form)
    expect(out).toContain('demand_partners: ["The Trade Desk"]')
    expect(out).not.toContain('DV360')
  })

  it('Media.net: seat-level buyer scoping is disclosed as NOT APPLIED, never emitted in the phantom seat_id shape', () => {
    const form = multiDspForm()
    form.multipleDsps = false
    form.deals = [{ ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Digital Consumer', cpm: '2.50' }]
    const out = generateDealPromptYaml(form, form.deals[0], 0)
    expect(out).toContain('seat-level buyer scoping')
    expect(out).toContain('NOT APPLIED')
    expect(out).toContain('cutlass#755')
    expect(out).not.toMatch(/^whitelisted_seats:/m)
    expect(out).not.toMatch(/^\s*seat_id:/m)
  })

  it('Media.net: per-DSP deal_ids stay distinct under a ≥30-char data partner (truncation-proof)', () => {
    const form = multiDspForm()
    form.dataPartner = 'An Extremely Long Data Partner Name Indeed'
    form.deals = [{ ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Digital Consumer', cpm: '2.50' }]
    const out = buildBatchPrompt(form)
    const ids = out.split('\n').filter(l => l.trim().startsWith('deal_id:')).map(l => l.trim())
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toEqual(ids[1])
  })
})

describe('buildBatchPrompt — Media.net deal_id uniqueness', () => {
  function mnBatchForm(): FormData {
    return {
      ...DEFAULT_FORM,
      submitterName: 'T',
      submitterEmail: 't@example.com',
      flightStartDate: '2099-01-01',
      flightEndDate: '2099-12-31',
      agency: 'Ideon',
      brand: 'Acme',
      campaignId: 'DEAL00500',
      attributionCode: 'B14',
      dealSheetRecipient: 'trader@example.com',
      curatedDealFee: '25',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '111' }],
      deals: [],
    }
  }

  it('REGRESSION: Web vs In-App deals with the same theme emit DISTINCT deal_ids', () => {
    const form = mnBatchForm()
    form.deals = [
      { ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Pets', cpm: '2.50', inventoryType: 'Web Only' },
      { ...newDeal(), ssp: 'Media.net', channel: 'Display', theme: 'Pets', cpm: '2.50', inventoryType: 'In-App' },
    ]
    const out = buildBatchPrompt(form)
    const ids = out.split('\n').filter(l => l.trim().startsWith('deal_id:')).map(l => l.trim())
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toEqual(ids[1])
    expect(out).not.toContain('<UNSET-DUPLICATE-MEDIANET-DEAL-ID>')
  })

  it('flags genuinely colliding Media.net deals with a fail-closed <UNSET…> token', () => {
    const form = mnBatchForm()
    // Two identical MN rows — same tuple, same deal_id. The <UNSET…> token is
    // caught by the /api/moc/create unresolved-placeholder gate, so the batch
    // can never reach MOC.
    const dupe = { ...newDeal(), ssp: 'Media.net' as const, channel: 'Display' as const, theme: 'Pets', cpm: '2.50' }
    form.deals = [dupe, { ...dupe, id: 'other' }]
    const out = buildBatchPrompt(form)
    expect(out).toContain('<UNSET-DUPLICATE-MEDIANET-DEAL-ID>')
  })

})

describe('buildXandrPrompt — deal code uniqueness (via buildBatchPrompt)', () => {
  function xnForm(deals: FormData['deals']): FormData {
    return {
      ...DEFAULT_FORM,
      agency: 'Ideon',
      brand: 'Acme',
      campaignId: 'DEAL00500',
      attributionCode: 'B14',
      dealSheetRecipient: 'trader@example.com',
      curatedDealFee: '25',
      dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '111' }],
      xandrConfig: { ...DEFAULT_FORM.xandrConfig, dealCode: 'ACME-Q3', insertionOrder: 'Example – Marketplace Pro' },
      deals,
    }
  }
  const xnDeal = (theme: string) =>
    ({ ...newDeal(), ssp: 'Xandr' as const, channel: 'Display' as const, theme, cpm: '2.50' })

  it('REGRESSION: >1 Xandr deal + form dealCode → per-deal prefixed codes, not duplicates', () => {
    const out = buildBatchPrompt(xnForm([xnDeal('Pets'), xnDeal('Autos')]))
    const codes = out.split('\n').filter(l => l.trim().startsWith('code:')).map(l => l.trim())
    expect(codes).toHaveLength(2)
    expect(codes[0]).toContain('ACME-Q3-1')
    expect(codes[1]).toContain('ACME-Q3-2')
  })

  it('a single Xandr deal keeps the bare form dealCode', () => {
    const out = buildBatchPrompt(xnForm([xnDeal('Pets')]))
    const codes = out.split('\n').filter(l => l.trim().startsWith('code:')).map(l => l.trim())
    expect(codes).toHaveLength(1)
    expect(codes[0]).toContain('code: ACME-Q3 ')
    expect(codes[0]).not.toContain('ACME-Q3-1')
  })

  it('no form dealCode → each deal falls back to its (unique) deal name', () => {
    const form = xnForm([xnDeal('Pets'), xnDeal('Autos')])
    form.xandrConfig = { ...form.xandrConfig, dealCode: '' }
    const out = buildBatchPrompt(form)
    const codes = out.split('\n').filter(l => l.trim().startsWith('code:')).map(l => l.trim())
    expect(codes).toHaveLength(2)
    expect(codes[0]).toContain('_Pets_')
    expect(codes[1]).toContain('_Autos_')
    expect(codes[0]).not.toEqual(codes[1])
  })

  it('multi-DSP expansion of one Xandr deal also gets distinct prefixed codes', () => {
    const form = xnForm([xnDeal('Pets')])
    form.multipleDsps = true
    form.dsps = [
      { id: '1', dsp: 'The Trade Desk', seatId: '111' },
      { id: '2', dsp: 'DV360', seatId: '222' },
    ]
    const out = buildBatchPrompt(form)
    const codes = out.split('\n').filter(l => l.trim().startsWith('code:')).map(l => l.trim())
    expect(codes).toHaveLength(2)
    expect(codes[0]).toContain('ACME-Q3-1')
    expect(codes[1]).toContain('ACME-Q3-2')
  })
})

// =============================================================================
// #221 — collectSubmitListIds: the submit-time attachment union. A per-deal
// standard-list pick MUST ride POST /api/moc/create listIds even when the
// batch-level applied lists are empty — the old call sites built listIds from
// form.appliedDomainListIds/appliedAppBundleListIds only, so the prompt
// referenced the list by name but the file never reached MOC
// (IX/OpenX/PubMatic missing_domain_file; Media.net created the deal LIVE
// without its list).
// =============================================================================
describe('collectSubmitListIds — per-deal standard lists join the submit attachment set (#221)', () => {
  const STD_DOMAIN_BLOCK: StandardList = { id: 'std-longtail', name: 'Longtail Block List', kind: 'block', scope: 'domain', line_count: 100 }
  const STD_DOMAIN_ALLOW: StandardList = { id: 'std-news', name: 'Preferred News Sites', kind: 'allow', scope: 'domain', line_count: 10 }
  const STD_BUNDLE_BLOCK: StandardList = { id: 'std-bundles', name: 'Bad Bundles', kind: 'block', scope: 'app_bundle', line_count: 5 }
  const ALL_LISTS = [STD_DOMAIN_BLOCK, STD_DOMAIN_ALLOW, STD_BUNDLE_BLOCK]

  const mkDeal = (over: Partial<DealEntry>): DealEntry =>
    ({ ...newDeal(), ssp: 'Index Exchange', channel: 'Display', theme: 'T', cpm: '5', ...over })
  const mkForm = (over: Partial<FormData>): FormData =>
    ({ ...DEFAULT_FORM, submitterEmail: 't@example.com', campaignId: 'DEAL50001', ...over })

  it('includes a per-deal standard-list id when the batch-applied lists are EMPTY (the #221 defect)', () => {
    const form = mkForm({
      appliedDomainListIds: [],
      appliedAppBundleListIds: [],
      deals: [mkDeal({ domainListId: 'std-longtail' })],
    })
    expect(collectSubmitListIds(form, ALL_LISTS)).toEqual(['std-longtail'])
  })

  it('unions batch-applied ids with per-deal picks and dedups', () => {
    const form = mkForm({
      appliedDomainListIds: ['std-longtail'],
      appliedAppBundleListIds: ['std-bundles'],
      deals: [
        mkDeal({ domainListId: 'std-longtail' }),               // dup of applied
        mkDeal({ domainListId: 'std-news' }),                   // per-deal only
        mkDeal({ channel: 'CTV', appBundleListId: 'std-bundles' }), // dup of applied
      ],
    })
    expect(collectSubmitListIds(form, ALL_LISTS).sort()).toEqual(['std-bundles', 'std-longtail', 'std-news'])
  })


  it("excludes '' (explicit no-list), unknown ids, and ad-hoc upload ids (those ride filePaths)", () => {
    const upload: import('../types/deal').UploadedFile = { id: 'up-1', name: 'oneoff.csv', size: 1, path: '/tmp/up-1.csv', inclusionType: 'Exclude' }
    const form = mkForm({
      domainLists: [upload],
      deals: [
        mkDeal({ domainListId: '' }),        // explicitly none
        mkDeal({ domainListId: 'up-1' }),    // ad-hoc upload, not a standard list
        mkDeal({ domainListId: 'ghost' }),   // unknown id → resolves to no file in the prompt
      ],
    })
    expect(collectSubmitListIds(form, ALL_LISTS)).toEqual([])
  })

  it('excludes wrong-scope ids (a domain pick pointing at an app-bundle list resolves to no file)', () => {
    const form = mkForm({ deals: [mkDeal({ domainListId: 'std-bundles' })] })
    expect(collectSubmitListIds(form, ALL_LISTS)).toEqual([])
  })

  it('ignores sheet-only and SSP-less deals — they emit no prompt_inputs', () => {
    const form = mkForm({
      deals: [
        mkDeal({ domainListId: 'std-longtail', sheetOnly: true }),
        mkDeal({ domainListId: 'std-news', ssp: '' as never }),
      ],
    })
    expect(collectSubmitListIds(form, ALL_LISTS)).toEqual([])
  })
})

// =============================================================================
// #220 — per-SSP list disclosure. Xandr has NO list emission path (no
// list-file ingestion; Curate deal lists only) and TripleLift only has the
// post-create tl_merge_deal_domains ADVERTISER-domain merge (cutlass#731) —
// both used to silently drop a resolved list while the deal card claimed
// "Resolves to: <list>".
// =============================================================================
describe('Xandr/TripleLift list disclosure (#220)', () => {
  const STD_BLOCK: StandardList = { id: 'std-longtail', name: 'Longtail Block List', kind: 'block', scope: 'domain', line_count: 100 }
  const STD_ALLOW: StandardList = { id: 'std-news', name: 'Preferred News Sites', kind: 'allow', scope: 'domain', line_count: 10 }
  const STD_BUNDLES: StandardList = { id: 'std-bundles', name: 'Bad Bundles', kind: 'block', scope: 'app_bundle', line_count: 5 }
  const LISTS = [STD_BLOCK, STD_ALLOW, STD_BUNDLES]

  const mkDeal = (over: Partial<DealEntry>): DealEntry =>
    ({ ...newDeal(), channel: 'Display', theme: 'T', cpm: '5', ...over })
  const mkForm = (deals: DealEntry[]): FormData => ({
    ...DEFAULT_FORM,
    submitterName: 'T', submitterEmail: 't@example.com',
    flightStartDate: '2027-01-01', flightEndDate: '2027-06-30',
    agency: 'A', brand: 'B', campaignId: 'DEAL50002', dealSheetRecipient: 'trader@example.com',
    curatedDealFee: '25',
    dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: '123' }],
    deals,
  })
  const gen = (deal: DealEntry): string => generateDealPromptYaml(mkForm([deal]), deal, 0, 1, LISTS)

  it('Xandr: a resolved block list emits a loud LIST NOT APPLIED comment, never a file arg', () => {
    const out = gen(mkDeal({ ssp: 'Xandr', domainListId: 'std-longtail' }))
    expect(out).toContain('# LIST NOT APPLIED: "Longtail Block List" (blocklist, site list)')
    expect(out).toContain('Curate deal list')
    expect(out).toContain('report this list as NOT APPLIED in the final summary')
    expect(out).not.toContain('domain_file_path')
    expect(out).not.toContain('app_bundle_file_path')
  })

  it('Xandr: no list → no NOT-APPLIED comment', () => {
    expect(gen(mkDeal({ ssp: 'Xandr' }))).not.toContain('LIST NOT APPLIED')
  })

  it('TripleLift: a block list emits the post-create tl_merge_deal_supply_domains instruction with the REAL signature args + the #731 dimension pin', () => {
    const out = gen(mkDeal({ ssp: 'TripleLift', domainListId: 'std-longtail' }))
    // #731 fixed: SUPPLY-domain inventory targeting — never the
    // advertiser-domain brand-safety tool for a site list.
    expect(out).toContain('mcp_triplelift_mcp_tl_merge_deal_supply_domains(')
    expect(out).not.toContain('tl_merge_deal_domains(')
    expect(out).toContain('values_file: Longtail Block List')
    expect(out).toContain('values_sha256:')
    expect(out).toContain('expected_count:')
    expect(out).toContain('merge_mode: add')
    expect(out).toContain('action: EXCLUDE')
    expect(out).toContain('blocklist ⇒ excluded:true supply leaf')
    // The #731 dimension pin — the supply leaf, with the advertiser dimension
    // called out as separate.
    expect(out).toContain('targetingExpression binding EB_SUPPLY_DOMAIN_ID')
    expect(out).toContain('never conflate')
    // Delivery is reported via the post-create merge verification.
    expect(out).toContain('applied POST-CREATE to supply-domain targeting')
  })

  it('TripleLift: an allow list emits action: INCLUDE as an excluded:false supply leaf', () => {
    const out = gen(mkDeal({ ssp: 'TripleLift', domainListId: 'std-news' }))
    expect(out).toContain('action: INCLUDE')
    expect(out).toContain('allowlist ⇒ excluded:false supply leaf')
  })

  it('TripleLift: an app-bundle list is NOT APPLIED — never merged into a domain field', () => {
    const out = gen(mkDeal({ ssp: 'TripleLift', channel: 'CTV', vcr: '80', appBundleListId: 'std-bundles' }))
    expect(out).toContain('LIST NOT APPLIED')
    expect(out).toContain('Bad Bundles')
    // The comment EXPLAINS why the merge tools are off-limits, but must not
    // instruct a call or reference the file as a mergeable value.
    expect(out).not.toContain('tl_merge_deal_supply_domains(')
    expect(out).not.toContain('tl_merge_deal_domains(')
    expect(out).not.toContain('values_file:')
  })

  it('buildBatchPrompt: Xandr/TL list-carrying batches get the Required-final-summary disclosure line', () => {
    const form = mkForm([
      mkDeal({ ssp: 'Xandr', theme: 'X', domainListId: 'std-longtail' }),
      mkDeal({ ssp: 'TripleLift', theme: 'TL', domainListId: 'std-longtail' }),
    ])
    const out = buildBatchPrompt(form, LISTS)
    expect(out).toContain('Per Xandr/TripleLift deal with a site or app-bundle list')
    expect(out).toContain('Never report such a list as fully applied')
  })

  it('buildBatchPrompt: an IX-only list batch does NOT get the Xandr/TL disclosure line', () => {
    const form = mkForm([mkDeal({ ssp: 'Index Exchange', domainListId: 'std-longtail' })])
    const out = buildBatchPrompt(form, LISTS)
    expect(out).not.toContain('Per Xandr/TripleLift deal with a site or app-bundle list')
  })

  it('dealListLabel discloses per SSP: applied / post_create_supply_domain / not_applied', () => {
    const cases: Array<[DealEntry['ssp'], Partial<DealEntry>, string]> = [
      ['Index Exchange', { domainListId: 'std-longtail' }, 'applied'],
      ['OpenX', { domainListId: 'std-longtail' }, 'applied'],
      ['PubMatic', { domainListId: 'std-longtail' }, 'applied'],
      ['Magnite', { domainListId: 'std-longtail' }, 'applied'],
      ['Media.net', { domainListId: 'std-longtail' }, 'applied'],
      ['TripleLift', { domainListId: 'std-longtail' }, 'post_create_supply_domain'],
      ['Xandr', { domainListId: 'std-longtail' }, 'not_applied'],
    ]
    for (const [ssp, over, want] of cases) {
      const d = mkDeal({ ssp, ...over })
      const label = dealListLabel(mkForm([d]), d, LISTS)
      expect(label?.disclosure, `${ssp} disclosure`).toBe(want)
    }
  })

  it('dealListLabel: app-bundle lists are not_applied on TripleLift AND Media.net (no bundle dimension)', () => {
    for (const ssp of ['TripleLift', 'Media.net'] as const) {
      const d = mkDeal({ ssp, channel: 'CTV', vcr: '80', appBundleListId: 'std-bundles' })
      const label = dealListLabel(mkForm([d]), d, LISTS)
      expect(label?.disclosure, `${ssp} app-bundle disclosure`).toBe('not_applied')
    }
  })
})

describe('TripleLift global targeting guard', () => {
  it('blocks a deliberately-global create instead of improvising targetingExpression', () => {
    const deal = { ...newDeal(), ssp: 'TripleLift' as const, channel: 'Display' as const, theme: 'Global', cpm: '2.50', geoInclude: [], includeSegments: [] }
    const form: FormData = {
      ...DEFAULT_FORM,
      flightStartDate: '2027-01-01', flightEndDate: '2028-01-01', agency: 'A', brand: 'B', campaignId: 'DEAL12345',
      curatedDealFee: '25', feeType: 'Percentage of Media',
      dsps: [{ id: 'd', dsp: 'The Trade Desk', seatId: '123' }],
      tripleliftConfig: { ...DEFAULT_FORM.tripleliftConfig, dealPriceType: 'FLOOR', channel: 'WEB', allowPoliticalAds: false },
      deals: [deal],
    }
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain('# BLOCKED: TripleLift requires targetingExpression')
    expect(out).toContain('#238.6')
  })
})

// =============================================================================
// Publisher allowlists — "specific publishers only" per SSP.
// =============================================================================
describe('publisher allowlist emission', () => {
  const mkForm = (over: Partial<FormData>, deal: DealEntry): FormData => ({
    ...DEFAULT_FORM,
    submitterName: 'Trader', submitterEmail: 'trader@example.com',
    flightStartDate: '2099-06-01', flightEndDate: '2099-12-31',
    agency: 'A', brand: 'B', campaignId: 'DEAL40002',
    deals: [deal],
    ...over,
  })

  it('PubMatic: id-bearing entries ship as publisher_ids, name-only as publisher_names', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'PubMatic', channel: 'Display', includeSegments: ['Seg'], cpm: '5.00' }
    const form = mkForm({
      pubmaticConfig: {
        ...DEFAULT_FORM.pubmaticConfig,
        maxReach: false,
        publisherEntries: [
          { id: '161578', name: 'Paramount - Springserve' },
          { id: '165045' },
          { name: 'Some Unmatched Publisher' },
        ],
      },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain('publisher_ids: [161578, 165045]')
    expect(out).toMatch(/publisher_names:\n  - "Some Unmatched Publisher"/)
    expect(out).toContain('has_max_reach: 0')
  })

  it('PubMatic: legacy publisherNames still emit when no entries exist', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'PubMatic', channel: 'Display', includeSegments: ['Seg'], cpm: '5.00' }
    const form = mkForm({
      pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, maxReach: false, publisherNames: ['Roku - oRTB'] },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toMatch(/publisher_names:\n  - "Roku - oRTB"/)
    expect(out).not.toContain('publisher_ids:')
  })

  it('OpenX: id entries emit publisher_ids INTERSECTS; name-only ids are never emitted', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'OpenX', channel: 'Display', includeSegments: ['Seg'], cpm: '5.00' }
    const form = mkForm({
      openxConfig: {
        ...DEFAULT_FORM.openxConfig,
        allPublishers: false,
        publisherEntries: [{ id: '557339752', name: 'GAM UNDESTO S.L. - CTA' }, { id: '541153841' }],
      },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain('publisher_ids: [557339752, 541153841]')
    expect(out).not.toContain('excluded_publisher_ids:')
  })

  it('OpenX: include + exclude ships a BLOCKED marker and neither list', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'OpenX', channel: 'Display', includeSegments: ['Seg'], cpm: '5.00' }
    const form = mkForm({
      openxConfig: {
        ...DEFAULT_FORM.openxConfig,
        allPublishers: false,
        publisherEntries: [{ id: '557339752' }],
        excludedPublisherIds: ['541153841'],
      },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain('# BLOCKED: publisher include list AND excluded_publisher_ids are both set')
    expect(out).not.toMatch(/^publisher_ids:/m)
    expect(out).not.toContain('excluded_publisher_ids:')
  })


  it('IX/OpenX: Max publishers ON leaves leftover entries inert', () => {
    const oxDeal: DealEntry = { ...newDeal(), ssp: 'OpenX', channel: 'Display', includeSegments: ['Seg'], cpm: '5.00' }
    const oxOut = generateDealPromptYaml(mkForm({
      openxConfig: { ...DEFAULT_FORM.openxConfig, publisherEntries: [{ id: '557339752' }] },
    }, oxDeal), oxDeal, 0)
    expect(oxOut).not.toMatch(/^publisher_ids:/m)

    const ixDeal: DealEntry = { ...newDeal(), ssp: 'Index Exchange', channel: 'Display', includeSegments: ['Seg'], cpm: '5.00' }
    const ixOut = generateDealPromptYaml(mkForm({
      ixConfig: { ...DEFAULT_FORM.ixConfig, publisherEntries: [{ id: '185106' }] },
    }, ixDeal), ixDeal, 0)
    expect(ixOut).not.toContain('185106')
  })

  it('Magnite: toggle off ships the explicit list — ids bare, names quoted — never "ALL"', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'Magnite', channel: 'CTV', includeSegments: ['Seg'], cpm: '10.00' }
    const form = mkForm({
      magniteConfig: {
        ...DEFAULT_FORM.magniteConfig,
        marketplace: 'Example CTV',
        allPublishers: false,
        publisherEntries: [{ id: '60315', name: 'Paramount' }, { name: 'Tubi' }, { name: 'Vizio Inc.' }],
      },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    // quote() leaves simple tokens bare and quotes spaced names.
    expect(out).toContain('publishers: [60315, Tubi, "Vizio Inc."]')
    expect(out).not.toContain('publishers: "ALL"')
  })

  it('Magnite: default toggle keeps the byte-identical ALL line', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'Magnite', channel: 'CTV', includeSegments: ['Seg'], cpm: '10.00' }
    const form = mkForm({
      magniteConfig: { ...DEFAULT_FORM.magniteConfig, marketplace: 'Example CTV' },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain('publishers: "ALL"    # verbatim — explicit opt-in; the MCP expands to every eligible marketplace publisher')
  })

  it('Magnite: toggle off with an EMPTY list still ships ALL (audit blocks first — never an empty list)', () => {
    const deal: DealEntry = { ...newDeal(), ssp: 'Magnite', channel: 'CTV', includeSegments: ['Seg'], cpm: '10.00' }
    const form = mkForm({
      magniteConfig: { ...DEFAULT_FORM.magniteConfig, marketplace: 'Example CTV', allPublishers: false },
    }, deal)
    const out = generateDealPromptYaml(form, deal, 0)
    expect(out).toContain('publishers: "ALL"')
  })

})

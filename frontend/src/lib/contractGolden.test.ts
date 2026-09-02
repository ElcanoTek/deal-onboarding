// =============================================================================
// Deal Onboarding ↔ Cutlass-dev contract golden matrix — Deal Onboarding's half.
//
// The Cutlass-side facts (tool names, enum ints, fail-closed blocker codes,
// fee keys) live in cutlass-contract.json — THE machine-readable contract.
// CI (.github/workflows/contract.yml) runs scripts/check-cutlass-contract.mjs
// against a real cutlass@dev checkout to verify the fixture still matches
// Cutlass, and this suite asserts Deal Onboarding's prompt emission against the same
// fixture — so a tool-shape change on either side fails a CI check, not a
// live create.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { DealEntry, DEFAULT_FORM, FormData, newDeal, UploadedFile } from '../types/deal'
import { buildBatchPrompt, generateDealPromptYaml, IX_IAB_NOT_SUPPORTED, IX_IAB_TO_CONTENT_GENRE, IX_IAB_TO_IAB_CONTENT_CATEGORY, standardListAsFile, XANDR_BUYER_CANONICAL, XANDR_SEAT_ROUTED_DSPS } from './dealPromptYaml'
import { IAB_OPTIONS } from './inferIab'
import { catalogHasLabel, IX_IAB_CONTENT_CATEGORY_CATALOG } from './sspIabCatalogs'
import { buildBatchBrief, DEAL_BRIEF_SCHEMA_VERSION, validateBrief } from './dealBrief'
import contract from './cutlass-contract.json'

const MN = contract.ssps['Media.net']
const OX = contract.ssps['OpenX']
const TL = contract.ssps['TripleLift']
const XN = contract.ssps['Xandr']
const MG = contract.ssps['Magnite']
const PM = contract.ssps['PubMatic']
const IX = contract.ssps['Index Exchange']

// Shared minimal form: one deal on the SSP under test, every required field
// filled, so each suite can assert one emission at a time.

type Channel = ReturnType<typeof newDeal>['channel']

function baseForm(ssp: string, channel: Channel, extra: Partial<FormData> = {}): FormData {
  return {
    ...DEFAULT_FORM,
    submitterName: 'T',
    submitterEmail: 't@example.com',
    flightStartDate: '2027-01-01',
    flightEndDate: '2028-12-31',
    agency: 'A',
    brand: 'B',
    campaignId: 'DEAL09001',
    dealSheetRecipient: 'trader@example.com',
    curatedDealFee: '25',
    dsps: [{ id: '1', dsp: 'The Trade Desk', seatId: 'Curator Seat' }],
    deals: [{ ...newDeal(), ssp: ssp as never, channel, cpm: '5', theme: 'Audience' }],
    ...extra,
  }
}

function gen(form: FormData): string {
  return generateDealPromptYaml(form, form.deals[0], 0, 1)
}

// -----------------------------------------------------------------------------
// Media.net — ad_format ints on the VENDOR enum (Banner=0, Native=1, Video=2,
// Select API Guide v9.4 p.12-13/p.23). This suite once pinned the INVERTED
// enum and actively locked the bug in (#222/cutlass#719) — the raw
// integer literals below are deliberate: a fixture flip alone cannot satisfy
// them.
// -----------------------------------------------------------------------------
describe('contract: Media.net ad_format ints (Banner=0, Native=1, Video=2 — vendor enum)', () => {
  // Explicit ad_format selection.
  it('Banner → 0', () => {
    const f = baseForm('Media.net', 'Display', { medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    expect(gen(f)).toContain(`ad_format: ${MN.adFormat.Banner}    # 0=Banner, 1=Native, 2=Video`)
  })
  it('Video → 2 (NOT 1)', () => {
    const f = baseForm('Media.net', 'OLV (Online Video)', { medianetConfig: { adFormat: 'Video (2)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    const out = gen(f)
    expect(MN.adFormat.Video).toBe(2)
    expect(out).toContain('ad_format: 2')
    expect(out).not.toContain('ad_format: 1')
  })
  it('Native → 1 (NOT 2)', () => {
    const f = baseForm('Media.net', 'Native', { medianetConfig: { adFormat: 'Native (1)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    const out = gen(f)
    expect(MN.adFormat.Native).toBe(1)
    expect(out).toContain('ad_format: 1')
    expect(out).not.toContain('ad_format: 2')
  })
  it('persisted OLD dropdown labels still resolve to the NEW correct ints', () => {
    // Matching is substring-based ('Video'/'Native'), so form state persisted
    // under the pre-fix labels must resolve to the vendor ints — not the old.
    const f = baseForm('Media.net', 'OLV (Online Video)', { medianetConfig: { adFormat: 'Video (1)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    expect(gen(f)).toContain('ad_format: 2')
  })
  // Channel-derived fallback (no explicit ad_format): OLV/CTV/OTT are Video(2).
  it('OLV channel fallback → Video 2', () => {
    expect(MN.channelAdFormat.olv).toBe('Video')
    const f = baseForm('Media.net', 'OLV (Online Video)', { medianetConfig: { adFormat: '', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    expect(gen(f)).toContain('ad_format: 2')
  })
  it('CTV channel fallback → Video 2', () => {
    expect(MN.channelAdFormat.ctv).toBe('Video')
    const f = baseForm('Media.net', 'CTV', { medianetConfig: { adFormat: '', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    expect(gen(f)).toContain('ad_format: 2')
  })
  it('margin fails closed (no 30 fabrication) when no fee anywhere', () => {
    const f = baseForm('Media.net', 'Display', {
      curatedDealFee: '',
      medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '' },
    })
    const out = gen(f)
    expect(out).toContain('# margin: OMITTED')
    expect(out).not.toMatch(/^margin: 30/m)
  })
  it('never ships a literal @file as a create-time targeting value; instructs a post-create merge instead', () => {
    const f = baseForm('Media.net', 'Display', {
      medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' },
      domainLists: [{ id: 'up-sites', name: 'news_sites.csv', size: 10, path: '/input/up-sites.csv', inclusionType: 'Include' }],
    })
    const out = gen(f)
    // The old broken behaviour: values: ["@/input/news_sites.csv"] as a create arg.
    expect(out).not.toContain('values: ["@')
    expect(out).not.toContain('@/input/up-sites.csv')
    // The corrected behaviour: a post-create merge instruction naming the list,
    // routed through the dedicated INVENTORY-targeting merge tool.
    expect(out).toContain('POST-CREATE TARGETING')
    expect(out).toContain(`mcp_${MN.server}_${MN.domainsMergeTool}`)
    expect(out).toContain('news_sites.csv')
  })
  it('web domain file → the INVENTORY merge tool with ONLY real args (no phantom target:)', () => {
    // #224/cutlass#720: the old emission instructed the ADVERTISER-
    // whitelist tool with phantom target:/is_excluded args that FastMCP
    // silently dropped — domains landed on whitelisted_domains and inventory
    // targeting was never applied. The rewritten block must name the real
    // publisher-domains tool and emit only args that exist on its signature.
    const f = baseForm('Media.net', 'Display', {
      medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' },
      domainLists: [{ id: 'up-sites', name: 'block_sites.csv', size: 10, path: '/input/up-sites.csv', inclusionType: 'Exclude' }],
    })
    const out = gen(f)
    expect(MN.domainsMergeTool).toBe(MN.domainsMerge.tool)
    expect(out).toContain(`mcp_${MN.server}_${MN.domainsMerge.tool}`)
    // The advertiser-whitelist tool must not be named anywhere.
    expect(out).not.toContain(`_${MN.advertiserWhitelistTool}`)
    // Real args, with the exclusion direction derived from inclusionType.
    expect(out).toContain('values_file: block_sites.csv')
    expect(out).toContain('values_sha256:')
    expect(out).toContain('expected_count:')
    expect(out).toContain('is_excluded: true')
    expect(out).toContain('merge_mode: add')
    // The phantom arg the old emission carried — gone for good.
    expect(out).not.toContain('target:')
  })
  it('arg-lint: every arg in the merge-tool instruction block is a real tool parameter', () => {
    // The parameters-not-existence check at the emission layer: parse each
    // `key:` line between the tool call's parentheses and assert membership
    // in the contract-pinned parameter set (which CI verifies against the
    // real cutlass signature). Fails on the old emission ('target' was never
    // a parameter of any Media.net merge tool).
    const f = baseForm('Media.net', 'Display', {
      medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' },
      domainLists: [{ id: 'up-sites', name: 'news_sites.csv', size: 10, path: '/input/up-sites.csv', inclusionType: 'Include' }],
    })
    const out = gen(f)
    const call = out.split(`mcp_${MN.server}_${MN.domainsMerge.tool}(`)[1]
    expect(call).toBeDefined()
    const block = call.split('#   )')[0]
    const keys = [...block.matchAll(/^#\s+(\w+):/gm)].map(m => m[1])
    expect(keys.length).toBeGreaterThanOrEqual(6)
    for (const key of keys) {
      expect(MN.domainsMerge.args).toContain(key)
    }
  })
  it('app-bundle file → LIST NOT APPLIED disclosure (unsupported_targeting_op), never any MN merge tool', () => {
    // Media.net has no app-bundle targeting field (app_categories are
    // category ids, not bundle ids). The emission is a LIST DISCLOSURE — the
    // deal IS created and the list reported NOT APPLIED (#224) — so it
    // uses TripleLift's "# LIST NOT APPLIED:" phrasing, NOT "# BLOCKED": the
    // server submit gate treats a "# BLOCKED" line as a hard don't-run marker,
    // and a mixed in-app batch with a bundle list must still submit
    // (#237.8). It must still name NO merge tool at all.
    const f = baseForm('Media.net', 'CTV', {
      medianetConfig: { adFormat: '', environments: [], marginType: 'Percentage (1)', marginValue: '25' },
      appBundleLists: [{ id: 'bundles', name: 'app_bundles.csv', size: 10, path: '/input/bundles.csv', inclusionType: 'Exclude' }],
    })
    const out = gen(f)
    expect(out).toContain('LIST NOT APPLIED')
    // Must NOT be a hard "# BLOCKED" don't-run marker (that would false-422 the
    // whole batch at the server submit gate — #237.8).
    expect(out).not.toMatch(/^[ \t]*# BLOCKED/m)
    expect(out).toContain('unsupported_targeting_op')
    expect(out).not.toContain(MN.domainsMerge.tool)
    expect(out).not.toContain(`_${MN.advertiserWhitelistTool}`)
    expect(out).not.toContain('app_categories:')
    expect(out).not.toContain('target:')
  })
})

// -----------------------------------------------------------------------------
// OpenX — fee key, always-emit, revenue_method enum.
// -----------------------------------------------------------------------------
describe('contract: OpenX fee block', () => {
  it('uses partner_name_or_id, never the unrecognized partner_name', () => {
    // Fixture sanity: the canonical key is accepted by Cutlass, the rejected one is not.
    expect(OX.fee.acceptedPartnerKeys).toContain(OX.fee.canonicalPartnerKey)
    expect(OX.fee.acceptedPartnerKeys).not.toContain(OX.fee.rejectedPartnerKey)
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } })
    const out = gen(f)
    expect(out).toContain(`${OX.fee.canonicalPartnerKey}: Curator`)
    expect(out).not.toContain(`${OX.fee.rejectedPartnerKey}: `)
  })
  it('always emits a fee block (curator fee, no explicit partner) so ox_fee_required never fires spuriously', () => {
    const f = baseForm('OpenX', 'Display') // feePartner blank, curatedDealFee 25
    const out = gen(f)
    expect(out).toContain('fee:')
    expect(out).toContain('gross_share_percent: 25')
    expect(out).not.toMatch(/^\s*gross_share:/m)
  })
  it('marks an attachment-less deal RUN-OF-EXCHANGE (valid, trader-confirmed 2026-07-20) — never # BLOCKED', () => {
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } })
    const out = gen(f)  // no domain/app-bundle file attached
    expect(out).toContain('RUN-OF-EXCHANGE: no domain/app-bundle list on this deal')
    expect(out).not.toContain('BLOCKED: OpenX requires an inventory attachment')
  })
  it('revenue_method is the exact GraphQL enum PoM (never POM/REV_SHARE)', () => {
    expect(OX.fee.revenueMethodEnum).toContain('PoM') // the emitted literal is a member of the CI-checked enum
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator', revenueMethod: 'PoM' } })
    const out = gen(f)
    expect(out).toContain('revenue_method: PoM')
    expect(out).not.toContain('POM')
    expect(out).not.toContain('REV_SHARE')
  })
  it('Rev Share dropdown value still maps to a valid enum (PoM), not REV_SHARE', () => {
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator', revenueMethod: 'Rev Share' } })
    const out = gen(f)
    expect(out).toContain('revenue_method: PoM')
    expect(out).not.toContain('REV_SHARE')
  })
})

// -----------------------------------------------------------------------------
// TripleLift — curationFee, dealTypeId.
// -----------------------------------------------------------------------------
describe('contract: TripleLift required payload', () => {
  it('emits curationFee with the FEE_MODEL_TYPE_PERCENT shape', () => {
    const out = gen(baseForm('TripleLift', 'Display'))
    expect(out).toContain('curationFee:')
    expect(out).toContain(`type: ${TL.curationFeePercentType}`)
    expect(out).toContain('value: 25')
  })
  it('fails closed on curationFee when no fee is set', () => {
    const out = gen(baseForm('TripleLift', 'Display', { curatedDealFee: '' }))
    expect(out).toContain('# curationFee: OMITTED')
  })
  it('emits dealTypeId (required_fields)', () => {
    expect(TL.requiredFields).toContain('dealTypeId') // required by tl_create_deal, checked against Cutlass in CI
    expect(gen(baseForm('TripleLift', 'Display'))).toContain('dealTypeId: 1')
  })
  it('dealPriceValue fails closed (no silent 0.10) when no CPM', () => {
    const f = baseForm('TripleLift', 'Display', { defaultDisplayCpm: '', defaultVideoCpm: '' })
    f.deals[0].cpm = ''
    const out = gen(f)
    expect(out).toContain('<FILL dealPriceValue')
    expect(out).not.toContain('dealPriceValue: 0.1')
  })
})

// -----------------------------------------------------------------------------
// Xandr — margin fail-closed + catalog advertiser.
// -----------------------------------------------------------------------------
describe('contract: Xandr margin + catalog advertiser', () => {
  it('no hardcoded 30 fallback; emits the real curated fee', () => {
    const out = gen(baseForm('Xandr', 'Display'))
    expect(out).toContain(`${XN.marginArg}: 25`)
    expect(out).not.toContain('Defaults to 30 if omitted')
  })
  it('fails closed on margin when no fee anywhere', () => {
    const out = gen(baseForm('Xandr', 'Display', { curatedDealFee: '' }))
    expect(out).toContain(`# ${XN.marginArg}: OMITTED`)
  })
  it('a catalog IO emits the catalog advertiser_id', () => {
    const out = gen(baseForm('Xandr', 'Display', { xandrConfig: { ...DEFAULT_FORM.xandrConfig, insertionOrder: 'Example – Marketplace Pro' } }))
    expect(out).toContain('advertiser_id:')
  })
})

// -----------------------------------------------------------------------------
// Magnite — rev_share fail-closed (no 0.30 fabrication).
// -----------------------------------------------------------------------------
describe('contract: Magnite rev_share', () => {
  it('emits the real curated fee in PERCENT units (live-verified 2026-07-21 — the fraction reading booked 30% as 0.30%)', () => {
    expect(MG.revShareScale).toBe('percent') // 25 = 25%, NOT 0.25
    const out = gen(baseForm('Magnite', 'CTV', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }))
    expect(out).toContain(`${MG.revShareArg}: 25`)
    expect(out).not.toContain(`${MG.revShareArg}: 0.25`)
  })
  it('fails closed (no fabricated 30) when no fee source', () => {
    const f = baseForm('Magnite', 'Display', {
      curatedDealFee: '', defaultDisplayCpm: '', defaultVideoCpm: '',
      magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' },
    })
    f.deals[0].cpm = ''
    const out = gen(f)
    expect(out).toContain('# rev_share OMITTED')
    expect(out).not.toContain(`${MG.revShareArg}: 30`)
    expect(out).not.toContain(`${MG.revShareArg}: 0.30`)
  })
})

// -----------------------------------------------------------------------------
// Magnite — pricing is config-driven, never the deal CPM. (Sun Bum incident
// 2026-07: deals were created as the CPM price type with the $15 deal CPM as
// the floor — they should have been Market Rate.) Wire contract, mirroring
// ClearLine's own options: "Market Rate" → price_type only, NO floor key;
// "Market Rate with Minimum" (Curator default) → price_type + floor (0.10
// default); "CPM" → price_type: CPM + floor.
// -----------------------------------------------------------------------------
describe('contract: Magnite price type + publisher-tab floor', () => {
  it('every emitted price type is a member of the ClearLine enum (CI-checked)', () => {
    for (const pt of ['Market Rate', 'Market Rate with Minimum', 'CPM']) {
      expect(MG.priceTypes).toContain(pt)
    }
  })
  it('defaults to Market Rate with Minimum at 0.10 and never emits the deal CPM as the floor', () => {
    const f = baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } })
    f.deals[0].cpm = '15'
    const out = gen(f)
    expect(out).toContain('price_type: "Market Rate with Minimum"')
    expect(out).toContain('floor: 0.10')
    expect(out).not.toContain('floor: 15')
    expect(out).not.toContain('price_type: CPM')
  })
  it('blank priceType falls back to the Market Rate default (owner call 2026-07-21 — no floor)', () => {
    const f = baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: '' as const, floorCpm: '' } })
    const out = gen(f)
    expect(out).toContain('price_type: Market Rate')
    expect(out).not.toContain('Market Rate with Minimum')
    expect(out).not.toContain('floor:')
  })
  it('explicit MRwM keeps the quoted price type and the 0.10 floor default', () => {
    const f = baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '' } })
    const out = gen(f)
    expect(out).toContain('price_type: "Market Rate with Minimum"')
    expect(out).toContain('floor: 0.10')
  })
  it('Market Rate emits no floor key; CPM emits the fixed floor', () => {
    const mr = gen(baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate' as const, floorCpm: '0.10' } }))
    expect(mr).toContain('price_type: Market Rate')
    expect(mr).not.toMatch(/\bfloor:/)
    const cpm = gen(baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: 'CPM' as const, floorCpm: '2.50' } }))
    expect(cpm).toContain('price_type: CPM')
    expect(cpm).toContain('floor: 2.50')
  })
  it('brief floor mirrors the config floor (not the deal CPM) and zeroes under Market Rate', () => {
    const f = baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } })
    f.deals[0].cpm = '15'
    expect(buildBatchBrief(f).deals[0].floor).toBe(0.1)
    const mr = baseForm('Magnite', 'Display', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate' as const, floorCpm: '0.10' } })
    expect(buildBatchBrief(mr).deals[0].floor).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// Magnite — 'Market Rate with Minimum' is DV+-only (#228, cutlass#718).
// SpringServe (CTV) rejects MRwM and Cutlass blocks it at prepare
// (springServeBlockerCode, CI-pinned against magnite_mcp.py), so a default-
// config CTV deal MUST downgrade to Market Rate or every create fails closed.
// On DV+ the MRwM floor ships as the TOP-LEVEL curatorPricing.minimumCpm
// (minimumWireField) and a floor-less MRwM blocks (minimumMissingBlockerCode)
// — which is why the builder always pairs MRwM with a floor.
// -----------------------------------------------------------------------------
describe('contract: Magnite MRwM is DV+-only (CTV downgrades to Market Rate)', () => {
  const MRWM_CFG = { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }
  it('the fixture pins the Cutlass MRwM contract facts', () => {
    expect(MG.mrwm.springServeBlockerCode).toBe('price_type_unsupported_on_springserve')
    expect(MG.mrwm.minimumWireField).toBe('minimumCpm')
    expect(MG.mrwm.minimumMissingBlockerCode).toBe('mrwm_minimum_missing')
  })
  it('CTV + MRwM emits Market Rate with NO floor key (vendor-valid create)', () => {
    const out = gen(baseForm('Magnite', 'CTV', MRWM_CFG))
    expect(out).toContain('price_type: Market Rate')
    expect(out).not.toContain('price_type: "Market Rate with Minimum"')
    expect(out).not.toMatch(/^floor:/m)
  })
  it('DV+ (Display) + MRwM keeps the price type and ALWAYS pairs it with a floor', () => {
    const out = gen(baseForm('Magnite', 'Display', MRWM_CFG))
    expect(out).toContain('price_type: "Market Rate with Minimum"')
    expect(out).toMatch(/^floor: 0\.10/m)
  })
  it('CTV + explicit CPM keeps the CPM floor (SpringServe supports CPM)', () => {
    const out = gen(baseForm('Magnite', 'CTV', { magniteConfig: { marketplace: 'M', priceType: 'CPM' as const, floorCpm: '0.10' } }))
    expect(out).toContain('price_type: CPM')
    expect(out).toMatch(/^floor: 0\.10/m)
  })
  it('brief floor zeroes for the downgraded CTV deal to match the floor-less prompt', () => {
    const f = baseForm('Magnite', 'CTV', MRWM_CFG)
    expect(buildBatchBrief(f).deals[0].floor).toBe(0)
    // …while a DV+ deal in the same config keeps the 0.10 minimum.
    const dvp = baseForm('Magnite', 'Display', MRWM_CFG)
    expect(buildBatchBrief(dvp).deals[0].floor).toBe(0.1)
  })
})

// -----------------------------------------------------------------------------
// PubMatic + IndexExchange — no stale Curator identity leak.
// -----------------------------------------------------------------------------
describe('contract: PubMatic / IX identity fail-closed', () => {
  it('PubMatic emits owner ROLE only (type 7), never a hardcoded owner id', () => {
    const out = gen(baseForm('PubMatic', 'Display', { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } }))
    expect(out).toContain(`logged_in_owner_type_id: ${PM.owner.defaultOwnerTypeId}`)
  })
  it('PubMatic emits the real curated fee, never a fabricated 30', () => {
    const out = gen(baseForm('PubMatic', 'Display', { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } }))
    expect(out).toContain('feeValue: 25')
    expect(out).not.toMatch(/feeValue: 30\b/)
  })
  it('PubMatic fee fails closed with a <FILL placeholder when no fee is set (no 30 fabrication)', () => {
    const out = gen(baseForm('PubMatic', 'Display', { curatedDealFee: '', pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } }))
    expect(out).toContain('feeValue: <FILL curated deal fee')
    expect(out).not.toMatch(/feeValue: 30\b/)
  })
})

// -----------------------------------------------------------------------------
// Ad-duration targeting — the CTV "only 15s and 30s ads" / "max 30s" client
// requirement. Wire contract per SSP (arg names CI-checked against the Cutlass
// create-tool signatures via cutlass-contract.json): IX takes the allowed
// bucket list, OpenX/Magnite/Media.net take a contiguous range, Xandr takes
// the LOWER bound only, and PubMatic/TripleLift have NO duration API — those
// must emit the loud NOT-SUPPORTED comment, never a guessed arg or silence.
// -----------------------------------------------------------------------------
describe('contract: ad-duration targeting (create emission)', () => {
  type DurFields = Partial<Pick<DealEntry, 'adDurations' | 'maxAdDurationSecs'>>
  const withDur = (ssp: string, channel: Channel, dur: DurFields, extra: Partial<FormData> = {}): FormData => {
    const f = baseForm(ssp, channel, extra)
    f.deals[0] = { ...f.deals[0], ...dur }
    return f
  }
  const ALLOWED: DurFields = { adDurations: ['15', '30'] }
  const MAX_ONLY: DurFields = { maxAdDurationSecs: '30' }
  const MG_CFG: Partial<FormData> = { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }
  // Any duration-shaped ARG line (comments start with '#', so the loud
  // NOT-SUPPORTED / instruction comments don't trip this).
  const DURATION_ARG = /^\s*[a-z_]*duration[a-z_]*:/im

  it('IX CTV deal emits max_ad_durations (allowed-list of max-duration buckets)', () => {
    const out = gen(withDur('Index Exchange', 'CTV', ALLOWED))
    expect(out).toContain(`${IX.adDuration.createArg}: [15, 30]`)
  })
  // The OpenX MCP honors adunit_max_duration_* ONLY when targeting.channel is
  // one of _OX_AD_DURATION_CHANNELS (CI-pinned as requiresTargetingChannel) —
  // it never infers the channel from rendering_context/device_type, so a
  // duration prompt without `channel:` inside `targeting:` is a guaranteed
  // ox_duration_requires_video_channel blocker and the whole create aborts.
  const OX_TARGETING_CHANNEL_LINE = /^ {2}channel: (\w+)\b.*ox_duration_requires_video_channel/m
  it('OpenX CTV deal emits the adunit_max_duration_range bounds AND the targeting channel the gate requires', () => {
    const out = gen(withDur('OpenX', 'CTV', ALLOWED, { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } }))
    expect(out).toContain(`${OX.adDuration.createArgs[0]}: 15`)
    expect(out).toContain(`${OX.adDuration.createArgs[1]}: 30`)
    const m = out.match(OX_TARGETING_CHANNEL_LINE)
    expect(m?.[1]).toBe('CTV')
    expect(OX.adDuration.requiresTargetingChannel).toContain(m?.[1])
    // The channel line must land INSIDE the targeting block (the gate reads
    // targeting.channel, not a top-level arg).
    expect(out.indexOf('targeting:')).toBeGreaterThan(-1)
    expect(out.indexOf('  channel:')).toBeGreaterThan(out.indexOf('targeting:'))
  })
  it('OpenX max-only cap also carries the targeting channel (both duration branches are gated)', () => {
    const out = gen(withDur('OpenX', 'CTV', MAX_ONLY, { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } }))
    expect(out).toContain(`${OX.adDuration.createArgs[1]}: 30`)
    expect(out).toMatch(OX_TARGETING_CHANNEL_LINE)
  })
  it('OpenX OTT/OLV duration deals emit the exact gate enum values (OLV shortened from the form label)', () => {
    expect(OX.adDuration.requiresTargetingChannel).toEqual(['CTV', 'OLV', 'OTT'])
    for (const [channel, gateValue] of [['OTT', 'OTT'], ['OLV (Online Video)', 'OLV']] as const) {
      const out = gen(withDur('OpenX', channel as Channel, ALLOWED, { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } }))
      expect(out.match(OX_TARGETING_CHANNEL_LINE)?.[1], channel).toBe(gateValue)
    }
  })
  it('OpenX deal WITHOUT a duration requirement STILL emits the targeting channel (cutlass#726 — all-deals emission, canaried in this rollout)', () => {
    // FAILS OLD: channel emission was scoped to duration deals, so every
    // non-duration OLV/CTV/OTT brief reached the MCP channel-less and was
    // silently created as DISPLAY (Format=BANNER).
    expect(OX.targetingChannel.alwaysEmitted).toBe(true)
    for (const [channel, wireValue] of Object.entries(OX.targetingChannel.channelMap)) {
      const out = gen(baseForm('OpenX', channel as Channel, { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } }))
      const m = out.match(/^ {2}channel: (\w+)\b/m)
      expect(m?.[1], channel).toBe(wireValue)
      // Inside the targeting block, like the duration-gated line.
      expect(out.indexOf('  channel:'), channel).toBeGreaterThan(out.indexOf('targeting:'))
      // The non-duration line must NOT carry the duration-gate comment
      // (the Display-deal leak test below depends on that distinction).
      expect(out, channel).not.toMatch(OX_TARGETING_CHANNEL_LINE)
    }
  })
  it('Xandr CTV deal emits deal_creative_duration as the LOWER bound + the no-upper-cap warning', () => {
    const out = gen(withDur('Xandr', 'CTV', ALLOWED))
    expect(out).toContain(`${XN.adDuration.createArg}: 15`)
    expect(out).toContain('Xandr cannot cap ad length upward')
  })
  it('Xandr max-only cap is inexpressible — fails loud (NOT APPLIED), never approximated', () => {
    const out = gen(withDur('Xandr', 'CTV', MAX_ONLY))
    expect(out).not.toMatch(DURATION_ARG)
    expect(out).toContain('# NOT SUPPORTED on Xandr: ad-duration cap (max 30s)')
    expect(out).toContain('report as NOT APPLIED in the final summary')
  })
  it('Magnite CTV deal emits the contiguous min/max range + the list→range widening warning', () => {
    const out = gen(withDur('Magnite', 'CTV', ALLOWED, MG_CFG))
    expect(out).toContain(`${MG.adDuration.createArgs[0]}: 15`)
    expect(out).toContain(`${MG.adDuration.createArgs[1]}: 30`)
    expect(out).toContain('also admits in-between lengths')
  })
  it('Magnite max-only emits the MCP-documented min=1 convention (max without min fails closed)', () => {
    expect(MG.adDuration.maxRequiresMin).toBe(true) // CI-checked against the magnite_mcp fail-closed doc
    const out = gen(withDur('Magnite', 'CTV', MAX_ONLY, MG_CFG))
    expect(out).toContain(`${MG.adDuration.createArgs[0]}: 1 `)
    expect(out).toContain(`${MG.adDuration.createArgs[1]}: 30`)
  })
  it('Media.net CTV deal emits video_min/video_max WITH the unverified-semantics warning', () => {
    const out = gen(withDur('Media.net', 'CTV', ALLOWED, { medianetConfig: { ...DEFAULT_FORM.medianetConfig, marginValue: '25' } }))
    expect(out).toContain(`${MN.adDuration.createArgs[0]}: 15`)
    expect(out).toContain(`${MN.adDuration.createArgs[1]}: 30`)
    expect(out).toContain('UNVERIFIED SEMANTICS')
  })
  it('PubMatic CTV deal fails loud: NOT-SUPPORTED comment, no invented arg', () => {
    expect(PM.adDuration.supported).toBe(false) // CI-checked: pubmatic_mcp has no duration surface
    const out = gen(withDur('PubMatic', 'CTV', ALLOWED, { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } }))
    expect(out).toContain('# NOT SUPPORTED: ad-duration targeting (allowed durations [15, 30]s) — PubMatic has no deal-level ad-duration API;')
    expect(out).toContain('# cannot be applied on this SSP; report as NOT APPLIED in the final summary.')
    expect(out).not.toMatch(DURATION_ARG)
  })
  it('TripleLift CTV deal fails loud: NOT-SUPPORTED comment, no invented arg', () => {
    expect(TL.adDuration.supported).toBe(false) // CI-checked: triplelift_mcp has no duration surface
    const out = gen(withDur('TripleLift', 'CTV', MAX_ONLY))
    expect(out).toContain('# NOT SUPPORTED: ad-duration targeting (max 30s) — TripleLift has no deal-level ad-duration API;')
    expect(out).toContain('# cannot be applied on this SSP; report as NOT APPLIED in the final summary.')
    expect(out).not.toMatch(DURATION_ARG)
  })
  it('Display deal emits nothing duration-related on ANY SSP (stray values are QA-flagged, not emitted)', () => {
    for (const ssp of ['Index Exchange', 'OpenX', 'PubMatic', 'Xandr', 'TripleLift', 'Media.net', 'Magnite']) {
      const out = gen(withDur(ssp, 'Display', { adDurations: ['15', '30'], maxAdDurationSecs: '30' }))
      expect(out, ssp).not.toMatch(DURATION_ARG)
      expect(out.toLowerCase(), ssp).not.toContain('ad-duration')
      expect(out, ssp).not.toMatch(/max_ad_durations|adunit_max_duration|deal_creative_duration|ad_duration_min|ad_duration_max|video_min|video_max/)
      // The duration-gated OpenX targeting channel must not leak either.
      // (Scoped to the gate-commented line: TL/Xandr/Magnite/Media.net emit
      // their own legitimate channel args on every deal.)
      expect(out, ssp).not.toMatch(OX_TARGETING_CHANNEL_LINE)
    }
  })
  it('Audio deal (a video channel WITHOUT duration targeting) emits nothing duration-related', () => {
    const out = gen(withDur('Media.net', 'Audio', ALLOWED, { medianetConfig: { ...DEFAULT_FORM.medianetConfig, marginValue: '25' } }))
    expect(out).not.toMatch(DURATION_ARG)
    expect(out).not.toMatch(/video_min|video_max/)
  })
})

// -----------------------------------------------------------------------------
// IAB category EXCLUDES — the per-deal "exclude Crime + Kids and family"
// client requirement (DealEntry.iabCategoriesExclude, explicit-only). Names
// are live IX contentGenre catalog values: the IX builder is fixture-verified
// on BOTH keys (an unverifiable name emits a loud NOT-SUPPORTED comment, never
// a doomed token — the a live batch DEAL00188 mixed-key regression). Wire
// contract per SSP: create-time excludes exist on Index Exchange
// (excluded_iab_categories → contentgenre NONE_OF) and PubMatic
// (exclude_iab_categories) ONLY — both args CI-checked against the Cutlass
// create-tool signatures via cutlass-contract.json ssps[*].iabExclude (green
// once cutlass feat/create-time-iab-excludes merges). Every other SSP has no
// create-time IAB/genre exclude API, so exclusions must emit the loud
// trader-UI follow-up comment — never a guessed arg, never silence.
// -----------------------------------------------------------------------------
describe('contract: IAB category excludes (create emission)', () => {
  const EXCLUDES = ['Crime', 'Kids and family']
  // Per-SSP config so each builder renders its realistic prompt (mirrors the
  // configs the other suites use); the exclude emission itself is config-free.
  const SSP_CFG: Record<string, Partial<FormData>> = {
    'OpenX': { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } },
    'PubMatic': { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } },
    'Media.net': { medianetConfig: { ...DEFAULT_FORM.medianetConfig, marginValue: '25' } },
    'Magnite': { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } },
  }
  const withExcludes = (ssp: string): FormData => {
    const f = baseForm(ssp, 'Display', SSP_CFG[ssp] || {})
    f.deals[0] = { ...f.deals[0], iabCategoriesExclude: [...EXCLUDES] }
    return f
  }
  // Any exclude-shaped ARG line (comments start with '#', so the loud
  // trader-follow-up comment doesn't trip this).
  const EXCLUDE_ARG = /^\s*excluded?_iab_categories:/m

  it('IX emits excluded_iab_categories as a block list (contentgenre NONE_OF at create)', () => {
    const out = gen(withExcludes('Index Exchange'))
    expect(out).toMatch(new RegExp(`^${IX.iabExclude.createArg}:`, 'm'))
    expect(out).toContain('- Crime')
    expect(out).toContain('- "Kids and family"')
  })
  it('PubMatic emits exclude_iab_categories as a block list (server-side → excludeIabCategories)', () => {
    const out = gen(withExcludes('PubMatic'))
    expect(out).toMatch(new RegExp(`^${PM.iabExclude.createArg}:`, 'm'))
    expect(out).toContain('- Crime')
  })
  it('excludes never replace the include emission — both blocks coexist', () => {
    const f = withExcludes('Index Exchange')
    f.deals[0] = { ...f.deals[0], iabCategories: ['News'] }
    const out = gen(f)
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('- News')
    expect(out).toMatch(EXCLUDE_ARG)
  })
  it('unsupported SSPs emit the loud trader-UI follow-up comment and NO exclude arg', () => {
    for (const ssp of ['OpenX', 'Xandr', 'Media.net', 'Magnite', 'TripleLift']) {
      const out = gen(withExcludes(ssp))
      expect(out, ssp).toContain(`# IAB/content EXCLUSIONS requested but NOT supported by the ${ssp} create API — trader must apply in the SSP UI: Crime, Kids and family`)
      expect(out, ssp).toContain('report these as trader UI follow-ups in the final summary')
      expect(out, ssp).not.toMatch(EXCLUDE_ARG)
    }
  })
  it('no exclude emission anywhere when the deal carries none', () => {
    for (const ssp of ['Index Exchange', 'OpenX', 'PubMatic', 'Xandr', 'TripleLift', 'Media.net', 'Magnite']) {
      const out = gen(baseForm(ssp, 'Display', SSP_CFG[ssp] || {}))
      expect(out, ssp).not.toMatch(EXCLUDE_ARG)
      expect(out, ssp).not.toContain('IAB/content EXCLUSIONS')
    }
  })
})

// -----------------------------------------------------------------------------
// IX IAB→contentGenre curated map (cutlass#714) + single-key selection
// (cutlass#831). IX targeting key 11 "contentGenre" is a TV-GENRE taxonomy
// (94 live values, checked-in fixture pulled 2026-07-14), NOT IAB, and the
// Cutlass MCP resolves it EXACT-match only (fixture
// iabCategories.exactMatchMarker pins the source literal). Since cutlass#831
// the MCP ALSO resolves against key 1066 "iabContentCategory" (385 IAB names)
// — contentGenre first, then iabContentCategory, all-or-nothing per key,
// NEVER mixed on one deal. Deal Onboarding therefore selects ONE key per deal over
// includes+excludes together and emits ONLY catalog-verified names on it;
// names the selected key can't carry emit a loud NOT-SUPPORTED comment and
// NEVER a token (an unmapped name fails the whole create mid-batch). Every
// "old behavior" note below is the raw-IAB-name emission these tests fail
// against.
// -----------------------------------------------------------------------------
describe('contract: IX IAB→contentGenre curated map (cutlass#714) + single-key selection (cutlass#831)', () => {
  const ixForm = (deal: Partial<DealEntry>): FormData => {
    const f = baseForm('Index Exchange', 'Display')
    f.deals[0] = { ...f.deals[0], ...deal }
    return f
  }

  it("'Consumer Banking' emits the finance genre — never the raw IAB name, never the generic 'Consumer' TV genre", () => {
    // OLD: emitted `- "Consumer Banking"`, which the MCP contains-matched to
    // the semantically wrong 'Consumer' TV genre.
    const out = gen(ixForm({ iabCategories: ['Consumer Banking'] }))
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('- "Business and financial"')
    expect(out).not.toContain('Consumer Banking')
    expect(out).not.toMatch(/^\s*- "?Consumer"?\s*$/m)
  })

  it("'Health & Fitness' (an inference output — opt-in via autoInferIab) ships as the exact catalog genre 'Health and wellness'", () => {
    // OLD: emitted `- "Health & Fitness"`, which no longer resolves (exact-
    // match) and would fail the create — a live 'Cold & Flu' failure.
    // Inference is opt-in per deal now (default OFF), so the fixture sets
    // the toggle explicitly.
    const out = gen(ixForm({ theme: 'Cold & Flu', autoInferIab: true }))
    expect(out).toContain('- "Health and wellness"')
    expect(out).not.toContain('Health & Fitness')
  })

  it("a 1066-only name selects the iabContentCategory key and ships verbatim — never a NOT-SUPPORTED drop (cutlass#831)", () => {
    // OLD: 'Insurance' had no TV genre and emitted only a NOT-SUPPORTED
    // comment. The MCP now also resolves key 1066 (iabContentCategory), where
    // 'Insurance' exists verbatim — so the deal selects THAT key and ships it.
    const out = gen(ixForm({ iabCategories: ['Insurance'] }))
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('iabContentCategory (key 1066)')
    expect(out).toContain('- Insurance')
    expect(out).not.toContain('# NOT SUPPORTED')
  })

  it('a name supported on NEITHER key emits a NOT-SUPPORTED comment and NO token (never raises mid-create)', () => {
    // 'Auto Insurance': no TV genre AND no 1066 entry at this specificity
    // (key 1066 carries only the generic 'Insurance' — a parent would
    // silently WIDEN the category).
    const out = gen(ixForm({ iabCategories: ['Auto Insurance'] }))
    expect(out).not.toMatch(/^iab_categories:/m)
    expect(out).toContain('# NOT SUPPORTED: IAB category(ies) ["Auto Insurance"]')
    expect(out).toContain('TV-genre taxonomy')
    expect(out).toContain('never mixed')
    expect(out).not.toMatch(/^\s*- "?Auto Insurance"?\s*$/m)
  })

  it('single-key rule: a genre-coverable + 1066-only mix lands ENTIRELY on key 1066 — names never split across keys', () => {
    // OLD: 'Real Estate' was NOT-SUPPORTED. 'News' covers on BOTH keys,
    // 'Real Estate' only on 1066 → the whole deal selects 1066 and both ship.
    const out = gen(ixForm({ iabCategories: ['News', 'Real Estate'] }))
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('iabContentCategory (key 1066)')
    expect(out).toContain('- News')
    expect(out).toContain('- "Real Estate"')
    expect(out).not.toContain('# NOT SUPPORTED')
  })

  it('majority key wins when neither key covers everything; the minority name comments loudly (deterministic tie-break: contentGenre)', () => {
    // 'Consumer Banking' covers ONLY on contentGenre (no 1066 entry);
    // 'Society' covers ONLY on 1066 (no TV genre). 1 vs 1 → tie → contentGenre;
    // 'Society' is omitted with the loud marker, never a doomed token.
    const out = gen(ixForm({ iabCategories: ['Consumer Banking', 'Society'] }))
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('contentGenre (key 11)')
    expect(out).toContain('- "Business and financial"')
    expect(out).toContain('# NOT SUPPORTED: IAB category(ies) [Society]')
    expect(out).not.toMatch(/^\s*- "?Society"?\s*$/m)
  })

  it('excludes translate through the same key selection (includes+excludes always land on ONE key)', () => {
    // 'Personal Finance' covers on both keys; 'Insurance' only on 1066 → the
    // deal (include side empty) selects 1066 and BOTH excludes ship verbatim.
    const out = gen(ixForm({ iabCategoriesExclude: ['Personal Finance', 'Insurance'] }))
    expect(out).toMatch(new RegExp(`^${IX.iabExclude.createArg}:`, 'm'))
    expect(out).toContain('iabContentCategory NONE_OF')
    expect(out).toContain('- "Personal Finance"')
    expect(out).toContain('- Insurance')
    expect(out).not.toContain('# NOT SUPPORTED')
  })

  it("an exclude the deal's selected key can't carry → trader UI follow-up comment, no token", () => {
    // Include 'Consumer Banking' pins the deal to contentGenre (its only key);
    // exclude 'Society' resolves only on 1066 → omitted with the loud
    // follow-up (never mixed onto a second key).
    const out = gen(ixForm({ iabCategories: ['Consumer Banking'], iabCategoriesExclude: ['Society'] }))
    expect(out).toContain('- "Business and financial"')
    expect(out).toContain('# NOT SUPPORTED: IAB category exclusion(s) [Society]')
    expect(out).toContain('trader UI follow-up')
    expect(out).not.toMatch(/^\s*- "?Society"?\s*$/m)
  })

  it('genre-level include↔exclude collision keeps the INCLUDE + emits a loud marker — never a silent all-genres-except deal (FIX 3)', () => {
    // Both IAB names map to 'Business and financial'. The OLD fold silently
    // dropped the include and shipped ONLY excluded_iab_categories → the live
    // deal targeted EVERY genre except Business and financial (near-opposite
    // of "business only"), with zero marker. Now the include keeps the genre
    // (the deal stays genre-targeted), the exclude drops it, and the
    // contradiction is surfaced loudly.
    const out = gen(ixForm({ iabCategories: ['Business'], iabCategoriesExclude: ['Personal Finance'] }))
    // Include block ships the genre (deal is NOT widened to all-genres-except).
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('- "Business and financial"')
    // The colliding genre is NOT emitted as an exclude (would trip the MCP
    // conflict gate) — and with no other exclude genre, no exclude block ships.
    expect(out).not.toMatch(new RegExp(`^${IX.iabExclude.createArg}:`, 'm'))
    // Loud, non-silent marker naming both source names + the shared genre.
    expect(out).toContain('# GENRE CONFLICT: include [Business] and exclude ["Personal Finance"] BOTH map to the IX contentGenre "Business and financial"')
    expect(out).toContain('never silently widened to all-genres-except')
    expect(out).toContain('trader UI follow-up in the final summary')
  })

  it('a collision that would empty the include list still ships the include genre + marker (never all-genres-except)', () => {
    // include=['Consumer Banking'] + exclude=['Personal Finance'] → both
    // 'Business and financial'. Folding must NOT empty the include and flip
    // to all-genres-except.
    const out = gen(ixForm({ iabCategories: ['Consumer Banking'], iabCategoriesExclude: ['Personal Finance'] }))
    expect(out).toMatch(/^iab_categories:/m)
    expect(out).toContain('- "Business and financial"')
    expect(out).not.toMatch(new RegExp(`^${IX.iabExclude.createArg}:`, 'm'))
    expect(out).toContain('# GENRE CONFLICT:')
  })

  it('two DISTINCT includes mapping to one genre dedupe quietly — no conflict marker, no exclude', () => {
    // Business + Consumer Banking both → 'Business and financial': a benign
    // merge, not a contradiction. One genre token, no GENRE CONFLICT noise.
    const out = gen(ixForm({ iabCategories: ['Business', 'Consumer Banking'] }))
    expect(out).toMatch(/^iab_categories:/m)
    expect((out.match(/- "Business and financial"/g) || []).length).toBe(1)
    expect(out).not.toContain('# GENRE CONFLICT')
  })

  it('every IAB_OPTIONS name is covered on a key (genre map / 1066 bridge / 1066 verbatim) or explicitly NOT-SUPPORTED — no silent gaps', () => {
    for (const name of IAB_OPTIONS) {
      const genreMapped = name in IX_IAB_TO_CONTENT_GENRE
      const catBridged = name in IX_IAB_TO_IAB_CONTENT_CATEGORY
      const catVerbatim = catalogHasLabel(IX_IAB_CONTENT_CATEGORY_CATALOG, name)
      const unsupported = IX_IAB_NOT_SUPPORTED.has(name)
      expect(genreMapped || catBridged || catVerbatim || unsupported, `IAB_OPTIONS name '${name}' must be curated one way or the other`).toBe(true)
      // NOT-SUPPORTED means supported on NEITHER key — never overlapping a
      // covered name (that would silently drop a resolvable category).
      expect(unsupported && (genreMapped || catBridged || catVerbatim), `IAB_OPTIONS name '${name}' must not be both covered and NOT-SUPPORTED`).toBe(false)
      // The 1066 bridge exists only for names the fixture does NOT already
      // carry verbatim (a redundant bridge would mask catalog drift).
      expect(catBridged && catVerbatim, `IAB_OPTIONS name '${name}' must not be both 1066-bridged and a verbatim 1066 hit`).toBe(false)
    }
    // The genre map's values are catalog GENRES, never IAB names that would
    // fail exact-match resolution (identity entries like Automotive/News/
    // Travel are legitimate: those strings exist verbatim in the live genre
    // catalog — sspIabCatalogs.test.ts pins every target against the fixture).
    for (const [iabName, genre] of Object.entries(IX_IAB_TO_CONTENT_GENRE)) {
      expect(IX_IAB_NOT_SUPPORTED.has(genre), `mapped genre '${genre}' (from '${iabName}') must not be a NOT-SUPPORTED name`).toBe(false)
    }
  })
})

// -----------------------------------------------------------------------------
// Xandr buyer routing (#231 / cutlass#734). The MCP resolves buyer
// NAMES via GET /platform-member (fails loud on ambiguity) and takes NUMERIC
// ids through a no-lookup escape hatch (fixture buyer.numericEscapeHatchMarker
// pins the docstring). Deal Onboarding routes deterministically: curated house buyer
// member id where one exists, the trader's numeric seat id for DSPs with no
// house member (DV360/Amazon), else the quoted name for loud server-side
// resolution. OLD behavior always sent the brand name — these tests fail on it.
// -----------------------------------------------------------------------------
describe('contract: Xandr buyer routing (#231 — numeric ids, never fuzzy names)', () => {
  const withDsp = (dsp: string, seatId: string): FormData => {
    const f = baseForm('Xandr', 'Display')
    f.dsps = [{ id: '1', dsp, seatId }]
    return f
  }

  it('The Trade Desk emits the house buyer member id 1088, not the brand name', () => {
    const out = gen(baseForm('Xandr', 'Display'))
    expect(out).toMatch(/^buyer: 1088\b/m)
    expect(out).not.toContain('buyer: "The Trade Desk"')
  })

  it('Yahoo DSP emits its house buyer member id 2975', () => {
    const out = gen(withDsp('Yahoo DSP', 'Curator Seat'))
    expect(out).toMatch(/^buyer: 2975\b/m)
  })

  it('the emitted ids agree with the fixture houseBuyerMembers (live-probed)', () => {
    expect(XANDR_BUYER_CANONICAL['The Trade Desk']).toBe(String(XN.buyer.houseBuyerMembers['The Trade Desk']))
    expect(XANDR_BUYER_CANONICAL['Yahoo DSP']).toBe(String(XN.buyer.houseBuyerMembers['Yahoo DSP']))
    // Every curated id is numeric — the escape-hatch precondition.
    for (const [dsp, id] of Object.entries(XANDR_BUYER_CANONICAL)) {
      expect(/^\d+$/.test(id), `XANDR_BUYER_CANONICAL['${dsp}'] must be a numeric member id`).toBe(true)
    }
  })

  it('DV360 (no house buyer member) routes by the trader NUMERIC seat id', () => {
    const out = gen(withDsp('DV360', '789012'))
    expect(out).toMatch(/^buyer: 789012\b/m)
    expect(out).not.toContain('buyer: "DV360"')
    expect(XANDR_SEAT_ROUTED_DSPS.has('DV360')).toBe(true)
  })

  it('DV360 with a NON-numeric seat falls back to the name (MCP fails loud) — never a guessed id', () => {
    const out = gen(withDsp('DV360', 'Curator Seat'))
    expect(out).toMatch(/^buyer: DV360\b/m)
    expect(out).not.toMatch(/^buyer: \d+\b/m)
    expect(out).toContain('fails loud on ambiguity')
  })

  it('an unknown DSP still emits the quoted name for loud server-side resolution', () => {
    const out = gen(withDsp('PulsePoint', '562277-5529'))
    expect(out).toContain('buyer: PulsePoint')
    expect(out).not.toMatch(/^buyer: \d+$/m)
  })
})

// -----------------------------------------------------------------------------
// File-targeting column arg (#227). A file with NO detected value
// column must OMIT the *_column arg entirely: cutlass split_rows then decides
// the header/data split itself and a headerless list keeps row 0. The OLD
// emission guessed 'Sites'/'Bundles' (or, upstream, fabricated headers[0] from
// the first data row — the #675 row-0 data-loss class); these tests fail on it.
// -----------------------------------------------------------------------------
describe('contract: file-targeting column arg (#227 — no fabricated column)', () => {
  const fileForm = (file: Partial<UploadedFile>): FormData => baseForm('Index Exchange', 'Display', {
    domainLists: [{ id: 'u1', name: 'raw_domains.csv', size: 9, path: '/p/u1.csv', inclusionType: 'Include', ...file }],
  })

  it('no detected column → the *_column arg is OMITTED (headerless list keeps every row server-side)', () => {
    const out = gen(fileForm({ headers: ['example.com'], detectedColumn: '' }))
    expect(out).toMatch(/^domain_file_path: "?raw_domains\.csv"?/m)
    expect(out).not.toMatch(/domain_column:/)
    expect(out).toMatch(/^domain_match_operator: allowlist/m)
  })

  it('a legacy pre-detection upload (detectedColumn undefined) also omits the column', () => {
    const out = gen(fileForm({}))
    expect(out).toMatch(/^domain_file_path:/m)
    expect(out).not.toMatch(/domain_column:/)
  })

  it('a real matched header still maps its column', () => {
    const out = gen(fileForm({ headers: ['Domain', 'Notes'], detectedColumn: 'Domain' }))
    expect(out).toMatch(/^domain_column: Domain$/m)
  })

  it('standard lists still pin their canonical column (their CSVs carry a literal Sites/Bundles header row)', () => {
    expect(standardListAsFile({ id: 's1', name: 'Block List', kind: 'block', scope: 'domain', line_count: 3 }).detectedColumn).toBe('Sites')
    expect(standardListAsFile({ id: 's2', name: 'CTV Apps', kind: 'allow', scope: 'app_bundle', line_count: 5 }).detectedColumn).toBe('Bundles')
  })
})

// -----------------------------------------------------------------------------
// Structured brief — ad_duration rides the brief schema v1.1 field names.
// -----------------------------------------------------------------------------
describe('contract: brief ad_duration (schema v1.1)', () => {
  it('fixture sanity: the field + property names Deal Onboarding emits are the CI-checked schema names', () => {
    expect(contract.brief.schemaVersion).toBe('1.1')
    // The emitted constant must track the fixture, which the checker diffs
    // against cutlass deal-brief.schema.yaml's version line — closing the
    // loop cutlass schema -> fixture -> emitted doc, so a brief can never
    // again self-declare a schema version that predates a field it carries.
    expect(DEAL_BRIEF_SCHEMA_VERSION).toBe(contract.brief.schemaVersion)
    expect(contract.brief.adDurationField).toBe('ad_duration')
    expect(contract.brief.adDurationProps).toEqual(['allowed_durations', 'min_seconds', 'max_seconds'])
  })
  it('CTV deal with an allowed list carries ad_duration.allowed_durations (integers)', () => {
    const f = baseForm('Index Exchange', 'CTV')
    f.deals[0] = { ...f.deals[0], adDurations: ['15', '30'] }
    const doc = buildBatchBrief(f)
    // The doc that actually ships self-declares the ad_duration-capable
    // schema version (not a wired constant elsewhere — the emitted field).
    expect(doc.schema_version).toBe(contract.brief.schemaVersion)
    expect(doc.deals[0].ad_duration).toEqual({ allowed_durations: [15, 30] })
    for (const key of Object.keys(doc.deals[0].ad_duration!)) {
      expect(contract.brief.adDurationProps).toContain(key)
    }
    expect(validateBrief(doc).ok).toBe(true)
  })
  it('max-only requirement carries ad_duration.max_seconds alone (no fabricated min)', () => {
    const f = baseForm('Magnite', 'CTV', { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } })
    f.deals[0] = { ...f.deals[0], maxAdDurationSecs: '30' }
    const doc = buildBatchBrief(f)
    expect(doc.deals[0].ad_duration).toEqual({ max_seconds: 30 })
  })
  it('Display deal never carries ad_duration (a duration on Display is a brief validation error)', () => {
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } })
    f.deals[0] = { ...f.deals[0], adDurations: ['15', '30'], maxAdDurationSecs: '30' }
    const doc = buildBatchBrief(f)
    expect(doc.deals[0].ad_duration).toBeUndefined()
    expect('ad_duration' in doc.deals[0]).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Structured brief — carries the Cutlass validate_brief REQUIRED_DEAL_FIELDS.
// -----------------------------------------------------------------------------
describe('contract: structured brief vs validate_brief', () => {
  it('every create deal carries ssp, channel, deal_name, recommended_bid + floor', () => {
    // The Cutlass validate_brief required set + the schema's per-deal required list.
    expect(contract.brief.validateBriefRequiredFields).toEqual(['ssp', 'channel', 'deal_name', 'recommended_bid'])
    expect(contract.brief.schemaRequiredDealFields).toContain('floor')
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } })
    const doc = buildBatchBrief(f)
    expect(doc.partner).toBeTruthy()
    for (const d of doc.deals) {
      expect(d.ssp).toBeTruthy()
      expect(d.channel).toBeTruthy()
      expect(d.deal_name).toBeTruthy()
      expect(d.recommended_bid).toBeTruthy()
      expect(typeof d.floor).toBe('number')
    }
    expect(validateBrief(doc).ok).toBe(true)
  })
  it('recommended_bid uses the channel-canonical range', () => {
    const f = baseForm('OpenX', 'CTV', { openxConfig: { ...DEFAULT_FORM.openxConfig, feePartner: 'Curator' } })
    const doc = buildBatchBrief(f)
    expect(doc.deals[0].recommended_bid).toBe('$25-$35')
  })
})

// -----------------------------------------------------------------------------
// Auto-derived format/platform defaults — an untouched form must emit
// channel-correct values, not a stale pre-checked Banner/Desktop set.
// -----------------------------------------------------------------------------
describe('contract: channel-derived defaults on an untouched form', () => {
  it('PubMatic CTV deal derives Video format + CTV platform when nothing is picked', () => {
    // cutlass#727 (live-verified 2026-07-09): Video is ad-format id 13; the
    // legacy 12 was silently normalized to 13 server-side. The raw literals
    // are deliberate — a fixture flip alone cannot satisfy them.
    const f = baseForm('PubMatic', 'CTV', { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } })
    const out = gen(f)
    expect(PM.adFormat.Video).toBe(13)
    expect(out).toContain('ad_formats: [13]')
    expect(out).toContain('platforms: [7]')
    expect(out).not.toContain('ad_formats: [12]')
    expect(out).not.toContain('ad_formats: [3]')
  })
  it('PubMatic OLV/OTT deals also derive Video 13 (never the legacy 12)', () => {
    for (const channel of ['OLV (Online Video)', 'OTT'] as const) {
      const f = baseForm('PubMatic', channel, { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } })
      const out = gen(f)
      expect(out).toContain('ad_formats: [13]')
      expect(out).not.toContain('ad_formats: [12]')
    }
  })
  it('PubMatic legacy persisted "Video (12)" pick aliases to 13 on the wire', () => {
    // Mirrors the 'CTV (5)' platform alias: forms persisted in localStorage
    // before the enum fix still resolve to the real Video id — those forms
    // MEANT video, even though 12 is Native on the wire today. Only the
    // explicit 'Native (12)' label maps to 12.
    const f = baseForm('PubMatic', 'Display', {
      pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'], adFormats: ['Video (12)'] },
    })
    const out = gen(f)
    expect(out).toContain('ad_formats: [13]')
    expect(out).not.toContain('ad_formats: [12]')
  })
  it('PubMatic Native deal derives Native 12 (adType catalog, 2026-08-03)', () => {
    // 12 = Native per PubMatic's own /v1/common/adType catalog. The old
    // fail-closed <FILL> (cutlass#754 "vendor-blocked") is retired; the old
    // 'Native (13)' label that booked live VIDEO deals stays dead.
    expect(PM.adFormat.Native).toBe(12)
    expect(PM.adFormat.allowedIds).toEqual([3, 12, 13])
    const f = baseForm('PubMatic', 'Native', { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } })
    const out = gen(f)
    expect(out).toContain('ad_formats: [12]')
    expect(out).toContain('channel: native')
    expect(out).not.toContain('ad_formats: <FILL')
    expect(out).not.toContain('ad_formats: [13]')
    expect(out).not.toContain('ad_formats: [3]')
  })
  it('PubMatic Audio deal still fails CLOSED — Audio (14) is uiEnabled=0 in the adType catalog', () => {
    const f = baseForm('PubMatic', 'Audio', { pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, publisherNames: ['Pub'] } })
    const out = gen(f)
    expect(out).toContain('ad_formats: <FILL')
    expect(out).not.toContain('ad_formats: [')
  })
  it('Media.net OLV deal derives Video ad_format (2) when the dropdown is on Auto', () => {
    const f = baseForm('Media.net', 'OLV (Online Video)', { medianetConfig: { ...DEFAULT_FORM.medianetConfig, marginValue: '25' } })
    expect(gen(f)).toContain('ad_format: 2')
  })
  it('Xandr deal code falls back to the deal name when blank', () => {
    const f = baseForm('Xandr', 'Display')
    const out = gen(f)
    // Slot vocabulary per docs/DEAL_NAMING.md: Xandr's name-slot code is
    // "Xandr" (the legacy XN abbreviation is retired).
    expect(out).toMatch(/code: .*Curator_Xandr/)
  })
})

// -----------------------------------------------------------------------------
// Geo — the US-default policy (geoPolicy.ts) end-to-end: a deal that specifies
// NO geo is seeded country=US at write time (newDeal/parser), so every
// SSP's create prompt must carry its geo arg with the US value, in exactly the
// shape the contract pins against the real MCP signatures. A deal WITH geo
// passes through untouched (CA here).
// -----------------------------------------------------------------------------
describe('contract: geo — US default when nothing is given, pass-through when specified', () => {
  // baseForm builds its deal via newDeal(), which seeds the US default.
  it('Index Exchange emits country full name (MCP alias-resolves to USA)', () => {
    expect(gen(baseForm('Index Exchange', 'Display'))).toContain(IX.geo.usEmission)
  })
  it('OpenX emits targeting.geographic (NOT geo_countries — the MCP ignores those keys)', () => {
    const out = gen(baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, packageName: 'P', dealPrice: '2' } }))
    expect(out).toContain(OX.geo.usEmission)
    expect(out).not.toContain('geo_countries')
  })
  it('OpenX subnational geo emits the STRUCTURED includes.state/includes.country dict — never a flat 2-letter token (cutlass#724: SK ≠ Slovakia)', () => {
    const f = baseForm('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, packageName: 'P', dealPrice: '2' } })
    f.deals[0].geoInclude = [{ id: 'g1', type: 'state', value: 'Saskatchewan' }]
    const out = gen(f)
    expect(out).toMatch(/geographic:\s*\n\s+includes:\s*\n\s+state: SK[^\n]*\n\s+country: CA/)
    expect(out).not.toMatch(/geographic: \[SK\]/)
    // The fail-closed blocker codes the MCP guards this contract with are
    // pinned in the fixture and extracted from mcp/openx_mcp.py source by
    // scripts/check-cutlass-contract.mjs — renaming one in Cutlass fails CI.
    expect(OX.geo.failClosedCodes).toEqual([
      'unresolved_country', 'ambiguous_geo_token', 'subnational_geo_requires_country', 'country_roster_unavailable',
    ])
  })
  it('PubMatic emits ISO-2 geo_countries', () => {
    expect(gen(baseForm('PubMatic', 'Display'))).toContain(PM.geo.usEmission)
  })
  it('Xandr emits ISO-2 geo_countries', () => {
    expect(gen(baseForm('Xandr', 'Display'))).toContain(XN.geo.usEmission)
  })
  it('Media.net emits ISO-2 geo', () => {
    const f = baseForm('Media.net', 'Display', { medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } })
    expect(gen(f)).toContain(MN.geo.usEmission)
  })
  it('Magnite emits ISO-2 geo_countries_include', () => {
    const f = baseForm('Magnite', 'Display', {
      magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' },
    })
    expect(gen(f)).toContain(MG.geo.usEmission)
  })
  it('TripleLift routes the default through Step 1b country resolution into payload.country_ids', () => {
    const out = gen(baseForm('TripleLift', 'Display'))
    expect(out).toContain(TL.geo.usEmission)
    expect(out).toMatch(/Step 1b — |tl_list_countries.*\[US\]|map \[US\]/) // the ISO-2 token Step 1b resolves
  })

  it('an explicitly-geo\'d deal passes through untouched — no US injection', () => {
    const f = baseForm('Xandr', 'Display')
    f.deals[0].geoInclude = [{ id: 'g1', type: 'country', value: 'CA' }]
    const out = gen(f)
    expect(out).toContain('geo_countries: [CA]')
    expect(out).not.toContain('geo_countries: [US]')
  })

})

// -----------------------------------------------------------------------------
// TripleLift subnational geo (cutlass#732) — the OLD builder never referenced
// r.states/r.zips/r.dmas in the TL section: country=US+state=CA created a
// US-WIDE deal (silent widening) and ZIPs/DMAs vanished without a marker.
// Every test here FAILS on that builder. States now resolve through
// tl_list_regions into region_ids; ZIPs stay a fail-loud NOT-SUPPORTED manual
// block until the postal write canary (zipsEmitted=false); DMAs have no
// binding at all (dmasEmitted=false).
// -----------------------------------------------------------------------------
describe('contract: TripleLift state/ZIP/DMA geo (cutlass#732)', () => {
  it('country+state emits the tl_list_regions Step-1 resolution and a region_ids payload key', () => {
    const f = baseForm('TripleLift', 'Display')
    f.deals[0].geoInclude = [
      { id: 'g1', type: 'country', value: 'US' },
      { id: 'g2', type: 'state', value: 'CA' },
    ]
    const out = gen(f)
    expect(TL.subnationalGeo.regionListTool).toBe('tl_list_regions')
    expect(out).toContain(`mcp_${TL.server}_${TL.subnationalGeo.regionListTool}`)
    // Country-qualified ISO-3166-2 code — never a bare "CA" (California vs Canada).
    expect(out).toContain('[US-CA]')
    // countries consumed Step 1b, so regions ride Step 1c.
    expect(out).toContain(TL.subnationalGeo.statesEmission)
    expect(out).toContain('region_ids: [<numeric REGION ids from Step 1c>]')
    // Fail-loud resolution contract: an unresolvable state stops the deal.
    expect(out).toContain('HARD failure')
    expect(out).not.toContain('NOT SUPPORTED on TripleLift: state')
  })

  it('a states-only deal still resolves regions (dynamic Step-1 letters — no dangling Step 1b token)', () => {
    const f = baseForm('TripleLift', 'Display')
    f.deals[0].geoInclude = [{ id: 'g1', type: 'state', value: 'Texas' }]
    const out = gen(f)
    expect(out).toContain('region_ids: [<numeric REGION ids from Step 1b>]')
    expect(out).not.toContain('country_ids:')
  })



  it('DMAs emit the NOT-SUPPORTED manual block (no DMA binding exists)', () => {
    expect(TL.subnationalGeo.dmasEmitted).toBe(false)
    const f = baseForm('TripleLift', 'Display')
    f.deals[0].geoInclude = [
      { id: 'g1', type: 'country', value: 'US' },
      { id: 'g2', type: 'dma', value: '501' },
    ]
    const out = gen(f)
    expect(out).toContain('# NOT SUPPORTED on TripleLift: DMA targeting ([501])')
    expect(out).toContain('report it as NOT APPLIED in the final summary')
  })

})

// -----------------------------------------------------------------------------
// Geo EXCLUDES — fail closed, never emitted (#219). No per-SSP prompt
// builder emits geo exclusions, so Deal Onboarding (a) seeds the US include even on
// an exclude-only deal (the unseeded alternative serves GLOBALLY including
// the excluded geo), (b) never invents exclude-shaped wire keys, and (c) the
// geo_exclude_unsupported audit rule blocks any batch carrying one. The
// contract's per-SSP geoExclude.emitted=false facts pin (b)/(c); an SSP flips
// to emitted:true only together with rules.go geoExcludeEmittingSSPs, the
// prompt emission, and a live paused canary.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Silent-drop class (#226): segment EXCLUDES, viewability, language,
// and TL/Magnite IAB — one golden per (dimension, SSP) pair. Emitting SSPs
// pin the exact wire arg; non-emitting SSPs pin the loud NOT-SUPPORTED
// marker. Every "emits"/"marker" golden FAILS on the pre-fix builders, which
// emitted NOTHING for these pairs while QA reported them configured.
// -----------------------------------------------------------------------------
describe('contract: audience segment EXCLUDES on create (#226)', () => {
  const OX_EXTRA: Partial<FormData> = { openxConfig: { ...DEFAULT_FORM.openxConfig, packageName: 'P', dealPrice: '2' } }
  const MG_EXTRA: Partial<FormData> = { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }
  const MN_EXTRA: Partial<FormData> = { medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } }

  function withExcludes(ssp: string, channel: Channel = 'Display', extra: Partial<FormData> = {}): FormData {
    const f = baseForm(ssp, channel, extra)
    f.deals[0].excludeSegments = ['Bad Audience']
    if (channel === 'CTV') { f.deals[0].vcr = '80'; f.deals[0].cpm = '15' }
    return f
  }

  it('PubMatic emits excluded_segment_names (→ excludeAudienceSegments, the merge-tool wire shape)', () => {
    expect(PM.segmentsExclude.createArg).toBe('excluded_segment_names')
    expect(PM.segmentsExclude.sourceMarkers).toContain('excludeAudienceSegments')
    const out = gen(withExcludes('PubMatic'))
    expect(out).toContain('excluded_segment_names:')
    expect(out).toContain('- "Bad Audience"')
    expect(out).toContain('excludeAudienceSegments')
    expect(out).not.toContain('# NOT SUPPORTED on PubMatic: audience segment EXCLUSION')
  })

  it('Xandr emits excluded_segment_names (→ segment_targets action="exclude", the merge-tool element shape)', () => {
    expect(XN.segmentsExclude.createArg).toBe('excluded_segment_names')
    const out = gen(withExcludes('Xandr'))
    expect(out).toContain('excluded_segment_names:')
    expect(out).toContain('- "Bad Audience"')
    expect(out).toContain('action="exclude"')
  })

  it('Index Exchange keeps its excluded_segment_names emission (regression)', () => {
    expect(IX.segmentsExclude.createArg).toBe('excluded_segment_names')
    const out = gen(withExcludes('Index Exchange'))
    expect(out).toContain('excluded_segment_names:')
    expect(out).toContain('- "Bad Audience"')
  })

  it('Magnite CTV keeps audience_segments_block; DV+ keeps the loud manual comment (regression)', () => {
    expect(MG.segmentsExclude.createArg).toBe('audience_segments_block')
    const ctv = gen(withExcludes('Magnite', 'CTV', MG_EXTRA))
    expect(ctv).toContain('audience_segments_block:')
    const dvplus = gen(withExcludes('Magnite', 'Display', MG_EXTRA))
    expect(dvplus).not.toContain('audience_segments_block:')
    expect(dvplus).toContain('#   exclude: Bad Audience')
  })

  it('OpenX: F2 — NO exclude VALUES on the wire (would hard-fail the MCP); loud NOT-SUPPORTED marker, audit-blocked', () => {
    expect(OX.segmentsExclude.supported).toBe(false)
    expect(OX.segmentsExclude.blockerCode).toBe('ox_audience_exclude_unsupported')
    const out = gen(withExcludes('OpenX', 'Display', OX_EXTRA))
    // The field ships EMPTY (recognition only) — the trader's segment VALUES
    // are NEVER emitted (the MCP now hard-blocks them).
    expect(out).toContain('audience_segments_exclude: []')
    expect(out).not.toContain('    - "Bad Audience"')
    // Loud NOT-SUPPORTED marker naming the requested segment + the fail-closed code.
    expect(out).toContain('# NOT SUPPORTED on OpenX: audience segment EXCLUSION(s) ["Bad Audience"]')
    expect(out).toContain('ox_audience_exclude_unsupported')
  })

  it('Media.net: NO exclude wire exists — loud marker, never an invented arg', () => {
    expect(MN.segmentsExclude.supported).toBe(false)
    const out = gen(withExcludes('Media.net', 'Display', MN_EXTRA))
    expect(out).toContain('# NOT SUPPORTED on Media.net: audience segment EXCLUSION(s) ["Bad Audience"]')
    expect(out).toContain('include-only')
    expect(out).not.toContain('excluded_segment_names')
  })

  it('TripleLift: vendor-gated exclude leaf — loud marker with the escalation ref, never an invented leaf', () => {
    expect(TL.segmentsExclude.supported).toBe(false)
    expect(TL.segmentsExclude.escalation).toBe('cutlass#757')
    const out = gen(withExcludes('TripleLift'))
    expect(out).toContain('# NOT SUPPORTED on TripleLift: audience segment EXCLUSION(s) ["Bad Audience"]')
    expect(out).toContain('cutlass#757')
    expect(out).not.toContain('excluded_segment_names')
    expect(out).not.toContain('"excluded": true')
  })
})

describe('contract: viewability on create (#226)', () => {
  const MG_EXTRA: Partial<FormData> = { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }
  const MN_EXTRA: Partial<FormData> = { medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } }

  function withViewability(ssp: string, channel: Channel = 'Display', extra: Partial<FormData> = {}): FormData {
    const f = baseForm(ssp, channel, extra)
    f.deals[0].viewabilityTarget = '70'
    if (channel === 'CTV') { f.deals[0].vcr = '80'; f.deals[0].cpm = '15' }
    return f
  }

  it('emitting SSPs keep their wire args (regression: IX/OpenX/PubMatic/Media.net)', () => {
    expect(IX.viewability.createArg).toBe('viewability_threshold')
    expect(gen(withViewability('Index Exchange'))).toContain('viewability_threshold: 70')
    expect(OX.viewability.createArg).toBe('viewability_threshold')
    expect(gen(withViewability('OpenX', 'Display', { openxConfig: { ...DEFAULT_FORM.openxConfig, packageName: 'P', dealPrice: '2' } }))).toContain('viewability_threshold: 0.70')
    expect(PM.viewability.createArg).toBe('viewability_threshold')
    expect(gen(withViewability('PubMatic'))).toContain('viewability_threshold: 70')
    expect(MN.viewability.createArg).toBe('viewability_min')
    expect(gen(withViewability('Media.net', 'Display', MN_EXTRA))).toContain('viewability_min: 0.7')
  })

  it('Xandr: no viewability wire — loud marker, no invented arg (was: silently dropped while qa_viewability passed)', () => {
    expect(XN.viewability.supported).toBe(false)
    const out = gen(withViewability('Xandr'))
    expect(out).toContain('# NOT SUPPORTED on Xandr: viewability target 70%')
    expect(out).not.toContain('viewability_threshold')
  })

  it('TripleLift: no viewability wire — loud marker, no invented arg', () => {
    expect(TL.viewability.supported).toBe(false)
    const out = gen(withViewability('TripleLift'))
    expect(out).toContain('# NOT SUPPORTED on TripleLift: viewability target 70%')
    expect(out).not.toContain('viewability_threshold')
    expect(out).not.toContain('viewability_min')
  })

  it('Magnite CTV (SpringServe): the DV+-only manual comment must NOT vanish silently — loud marker instead', () => {
    expect(MG.viewability.supported).toBe(false)
    expect(MG.viewability.dvPlusManual).toBe(true)
    const out = gen(withViewability('Magnite', 'CTV', MG_EXTRA))
    expect(out).toContain('# NOT SUPPORTED on Magnite (SpringServe CTV): viewability target 70%')
    const dvplus = gen(withViewability('Magnite', 'Display', MG_EXTRA))
    expect(dvplus).toContain('# Viewability target 70%: pass via raw targeting')
  })

  it('no viewability target → nothing viewability-related on the no-wire SSPs', () => {
    for (const ssp of ['Xandr', 'TripleLift'] as const) {
      expect(gen(baseForm(ssp, 'Display'))).not.toContain('viewability')
    }
  })
})

describe('contract: language on create (#226 — qa_pm_language false-green class)', () => {
  const MN_EXTRA: Partial<FormData> = { medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '25' } }
  const MG_EXTRA: Partial<FormData> = { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }

  function withLanguage(ssp: string, extra: Partial<FormData> = {}): FormData {
    const f = baseForm(ssp, 'Display', extra)
    f.deals[0].language = 'English'
    return f
  }

  it('OpenX emits targeting.languages (→ technographic.language) — the wire that sat unused', () => {
    expect(OX.language.sourceMarkers).toContain('languages')
    const out = gen(withLanguage('OpenX', { openxConfig: { ...DEFAULT_FORM.openxConfig, packageName: 'P', dealPrice: '2' } }))
    expect(out).toContain('languages: [English]')
    expect(out).toContain('technographic.language')
  })

  it('Media.net emits device_languages — the wire that sat unused', () => {
    expect(MN.language.createArg).toBe('device_languages')
    const out = gen(withLanguage('Media.net', MN_EXTRA))
    expect(out).toContain('device_languages: [English]')
  })

  it.each([
    ['Index Exchange', {}],
    ['PubMatic', {}],
    ['Xandr', {}],
    ['TripleLift', {}],
    ['Magnite', MG_EXTRA],
  ] as Array<[string, Partial<FormData>]>)('%s: no language wire — loud marker, no invented arg', (ssp, extra) => {
    const fixture = ({ 'Index Exchange': IX, PubMatic: PM, Xandr: XN, TripleLift: TL, Magnite: MG } as const)[ssp as never] as typeof IX
    expect(fixture.language.supported).toBe(false)
    const out = gen(withLanguage(ssp, extra))
    expect(out).toContain(`# NOT SUPPORTED on ${ssp}: language targeting (English)`)
    expect(out).not.toContain('languages:')
    expect(out).not.toContain('device_languages')
  })

  it('no language set → nothing language-related anywhere', () => {
    for (const ssp of ['Index Exchange', 'PubMatic', 'Xandr', 'OpenX'] as const) {
      const extra = ssp === 'OpenX' ? { openxConfig: { ...DEFAULT_FORM.openxConfig, packageName: 'P', dealPrice: '2' } } : {}
      expect(gen(baseForm(ssp, 'Display', extra))).not.toContain('language')
    }
  })
})

describe('contract: Required-final-summary reporting lines (#226/#244)', () => {
  // Each line fires only when a create deal actually carries the dimension —
  // the reporting contract that forces the agent to close the loop on every
  // emitted arg or NOT-SUPPORTED marker. buildBatchPrompt is the produce
  // surface MOC executes.
  it('viewability/language/segment-exclude/geo-exclude/TL-IAB lines fire exactly when carried', async () => {
    const { buildBatchPrompt } = await import('./dealPromptYaml')
    const bare = buildBatchPrompt(baseForm('Index Exchange', 'Display'))
    expect(bare).not.toContain('Per deal with a viewability target:')
    expect(bare).not.toContain('Per deal with language targeting:')
    expect(bare).not.toContain('Per deal with audience segment EXCLUSIONS:')
    expect(bare).not.toContain('Per deal with geo EXCLUSIONS:')
    expect(bare).not.toContain('Per TripleLift/Magnite deal with IAB categories:')

    const f = baseForm('PubMatic', 'Display')
    f.deals[0].viewabilityTarget = '70'
    f.deals[0].language = 'English'
    f.deals[0].excludeSegments = ['Bad Audience']
    f.deals[0].geoInclude = [{ id: 'g1', type: 'country', value: 'US' }]
    f.deals[0].geoExclude = [{ id: 'g2', type: 'state', value: 'California' }]
    const out = buildBatchPrompt(f)
    expect(out).toContain('Per deal with a viewability target:')
    expect(out).toContain('Per deal with language targeting:')
    expect(out).toContain('Per deal with audience segment EXCLUSIONS:')
    expect(out).toContain('Per deal with geo EXCLUSIONS:')

    const tl = baseForm('TripleLift', 'Display')
    tl.deals[0].iabCategories = ['News']
    expect(buildBatchPrompt(tl)).toContain('Per TripleLift/Magnite deal with IAB categories:')
  })
})

describe('contract: TripleLift/Magnite IAB includes fail LOUD (#226 item C)', () => {
  const MG_EXTRA: Partial<FormData> = { magniteConfig: { marketplace: 'M', priceType: 'Market Rate with Minimum' as const, floorCpm: '0.10' } }

  it('TripleLift: an explicit IAB pick emits the vendor-gated NOT-SUPPORTED marker (never a guessed node) — buildTripleLiftPrompt used to reference iabResolved NOWHERE', () => {
    expect(TL.iabCategories.supported).toBe(false)
    expect(TL.iabCategories.escalation).toBe('cutlass#757')
    const f = baseForm('TripleLift', 'Display')
    f.deals[0].iabCategories = ['News']
    const out = gen(f)
    expect(out).toContain('# NOT SUPPORTED on TripleLift: IAB categories [News]')
    expect(out).toContain('cutlass#757')
    expect(out).not.toContain('iabCategoryTargeting')
  })

  it('Magnite: an explicit IAB pick emits the NOT-SUPPORTED marker (no ClearLine content-category surface)', () => {
    expect(MG.iabCategories.supported).toBe(false)
    const f = baseForm('Magnite', 'Display', MG_EXTRA)
    f.deals[0].iabCategories = ['News']
    const out = gen(f)
    expect(out).toContain('# NOT SUPPORTED on Magnite: IAB categories [News]')
  })

  it('no IAB set → no IAB marker on TripleLift', () => {
    const f = baseForm('TripleLift', 'Display')
    f.deals[0].iabCategories = []
    expect(gen(f)).not.toContain('NOT SUPPORTED on TripleLift: IAB categories')
  })
})

// -----------------------------------------------------------------------------
// List delivery on Xandr / TripleLift (#220, cutlass#731) — the
// fixture facts are CI-verified against cutlass@dev by check-cutlass-contract
// (tl_merge_deal_domains membership + its real parameter set + the
// advertiserDomainTargeting docstring dimension pin; xandr_merge_deal_lists
// membership + the publisher_targets platform-prohibition literal). This
// suite asserts Deal Onboarding's emission against the same facts: Xandr NEVER emits
// a file arg (loud LIST NOT APPLIED instead), TripleLift instructs the pinned
// post-create merge with only real parameters and the dimension caveat.
// -----------------------------------------------------------------------------
describe('contract: Xandr/TripleLift list delivery (#220)', () => {
  const BLOCK_LIST = { id: 'up-block', name: 'Longtail Block List', size: 10, path: '/input/up-block.csv', inclusionType: 'Exclude' as const }

  it('Xandr: lists.supported=false ⇒ LIST NOT APPLIED comment, never a *_file_path arg', () => {
    expect(XN.lists.supported).toBe(false)
    const f = baseForm('Xandr', 'Display', { domainLists: [BLOCK_LIST] })
    const out = gen(f)
    expect(out).toContain('# LIST NOT APPLIED')
    expect(out).toContain('Longtail Block List')
    // The manual path the comment points at is the contract-pinned deal-list surface.
    expect(XN.lists.dealListMergeTool).toBe('xandr_merge_deal_lists')
    expect(out).toContain('xandr_merge_deal_lists')
    expect(out).not.toContain('domain_file_path')
    expect(out).not.toContain('app_bundle_file_path')
    expect(out).not.toContain('values_file:')
  })


  it('TripleLift merge-block arg-lint: every instructed arg is a real tool parameter (CI-pinned signature)', () => {
    const f = baseForm('TripleLift', 'Display', { domainLists: [BLOCK_LIST] })
    const out = gen(f)
    const call = out.split(`mcp_${TL.server}_${TL.lists.postCreateMergeTool}(`)[1]
    expect(call).toBeDefined()
    const block = call.split('#   )')[0]
    const keys = [...block.matchAll(/^#\s+(\w+):/gm)].map(m => m[1])
    expect(keys.length).toBeGreaterThanOrEqual(5)
    for (const key of keys) {
      expect(TL.lists.mergeArgs).toContain(key)
    }
  })
})

// -----------------------------------------------------------------------------
// CREATE protocol finalizer — final_step / followup_step (#236.1).
// The update flow's build_deal_sheet call has been contract-pinned since #163,
// but the CREATE batch prompt's final_step block was blind: it emitted phantom
// partner:/campaign_id: args that build_deal_sheet never accepted (the real
// param is client_name; there is no campaign_id param at all). These suites
// pin Deal Onboarding's emission to cutlass-contract.json createProtocol, and
// check-cutlass-contract.mjs pins the same fixture facts against the real
// cutlass tool signatures + multi-deal-creation.yaml — so either side drifting
// fails CI, not a live batch.
// -----------------------------------------------------------------------------
describe('contract: CREATE final_step / followup_step (#236.1)', () => {
  const CP = contract.createProtocol

  function batch(form: FormData): string {
    return buildBatchPrompt(form)
  }
  function finalStepBlock(out: string): string {
    const start = out.indexOf('final_step:')
    const end = out.indexOf('followup_step:')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return out.slice(start, end)
  }
  function followupBlock(out: string): string {
    const start = out.indexOf('followup_step:')
    expect(start).toBeGreaterThanOrEqual(0)
    // Ends at the blank line before the critical_actions block.
    return out.slice(start).split('\n\n')[0]
  }
  // The instructed arg keys of a step block (comment lines excluded).
  function argKeys(block: string): string[] {
    return [...block.matchAll(/^ {4}([a-z_]+):/gm)].map(m => m[1])
  }

  it('final_step calls the protocol-canonical sheet tool', () => {
    const out = batch(baseForm('OpenX', 'Display'))
    expect(finalStepBlock(out)).toContain(`  tool: ${CP.primarySheetTool}`)
  })

  it('arg-lint: every final_step arg is a real build_deal_sheet parameter (CI-pinned signature)', () => {
    const out = batch(baseForm('OpenX', 'Display'))
    const keys = argKeys(finalStepBlock(out))
    expect(keys.length).toBeGreaterThanOrEqual(3)
    for (const key of keys) {
      expect(CP.finalStep.args).toContain(key)
    }
  })


  it('campaign id rides output_filename (campaign-prefixed sheet name) — never the phantom campaign_id:', () => {
    const out = batch(baseForm('OpenX', 'Display'))
    const block = finalStepBlock(out)
    expect(block).not.toMatch(/^ {4}campaign_id:/m)
    const nameLine = block.match(/^ {4}output_filename: "?([^"\n]*?)"?$/m)
    expect(nameLine).not.toBeNull()
    expect(nameLine![1].startsWith('DEAL09001_')).toBe(true)
    expect(nameLine![1].endsWith('.xlsx')).toBe(true)
  })

  it('no campaign id → no output_filename override (server default filename)', () => {
    const out = batch(baseForm('OpenX', 'Display', { campaignId: '' }))
    expect(finalStepBlock(out)).not.toMatch(/^ {4}output_filename:/m)
  })

  it('followup_step calls the protocol-canonical email tool with real send_email args only', () => {
    const out = batch(baseForm('OpenX', 'Display'))
    const block = followupBlock(out)
    expect(block).toContain(`  tool: ${CP.primaryEmailTool}`)
    const keys = argKeys(block)
    expect(keys).toContain('to_email')
    for (const key of keys) {
      expect(CP.followupStep.args).toContain(key)
    }
  })

  it('fixture self-consistency: finalizer tools compose sharedTools server + tool names', () => {
    const { dealSheet, sendgrid } = contract.sharedTools
    expect(CP.primarySheetTool).toBe(`mcp_${dealSheet.server}_${CP.finalStep.tool}`)
    expect(CP.finalStep.tool).toBe(dealSheet.buildTool)
    expect(CP.primaryEmailTool).toBe(`mcp_${sendgrid.server}_${CP.followupStep.tool}`)
    expect(CP.followupStep.tool).toBe(sendgrid.sendTool)
  })
})

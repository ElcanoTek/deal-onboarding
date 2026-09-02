import { describe, it, expect } from 'vitest'
import { hydrateForm } from './useFormState'
import { generateDealName } from './useDealMatrix'
import { DEFAULT_FORM, migrateCampaignIabCategories, newDeal } from '../types/deal'
import type { FormData } from '../types/deal'

// Regression: saves written before the per-SSP geo change hold geo as the
// legacy {country, state} shape. Loading one must migrate it to {type, value}
// rather than leaving g.value undefined (which crashed the whole app on
// refresh — generateDealName reads g.value.trim() on every render).
describe('hydrateForm — legacy geo migration', () => {
  it('converts legacy {country,state} geo to typed entries and survives name generation', () => {
    const legacy = {
      deals: [{
        id: 'd1', theme: 'Warm', ssp: 'Index Exchange', channel: 'Display',
        geoInclude: [{ id: 'g1', country: 'US', state: 'California' }],
      }],
      defaultGeoInclude: [{ id: 'gg', country: 'US', state: '' }],
    } as unknown as Partial<FormData>

    const form = hydrateForm(legacy)

    // A legacy entry carrying both country + state expands to two typed entries.
    expect(form.deals[0].geoInclude).toEqual([
      expect.objectContaining({ type: 'country', value: 'US' }),
      expect.objectContaining({ type: 'state', value: 'California' }),
    ])
    // Campaign-default geos are folded onto the deals and cleared (the
    // Campaign Defaults section is retired) — this deal already carries its
    // own geo, so the default simply clears.
    expect(form.defaultGeoInclude).toEqual([])

    // The actual crash repro — must not throw.
    expect(() => generateDealName(form, form.deals[0])).not.toThrow()
  })

  it('folds campaign-default geos onto geo-less deals and clears the defaults', () => {
    const legacy = {
      deals: [
        { id: 'd1', theme: 'HasGeo', geoInclude: [{ id: 'g1', type: 'state', value: 'Texas' }] },
        { id: 'd2', theme: 'NoGeo', geoInclude: [] },
      ],
      defaultGeoInclude: [{ id: 'gg', type: 'country', value: 'US' }],
    } as unknown as Partial<FormData>

    const form = hydrateForm(legacy)
    // The deal with its own geo keeps it; the geo-less deal inherits the default.
    expect(form.deals[0].geoInclude).toEqual([expect.objectContaining({ type: 'state', value: 'Texas' })])
    expect(form.deals[1].geoInclude).toEqual([expect.objectContaining({ type: 'country', value: 'US' })])
    // Hidden campaign defaults are gone — the deal cards now show the truth.
    expect(form.defaultGeoInclude).toEqual([])
  })

  it('passes already-typed geo through unchanged', () => {
    const form = hydrateForm({
      deals: [{ id: 'd1', geoInclude: [{ id: 'g1', type: 'zip', value: '10001' }] }],
    } as unknown as Partial<FormData>)
    expect(form.deals[0].geoInclude).toEqual([expect.objectContaining({ type: 'zip', value: '10001' })])
  })
})

// The campaign-level iabCategories editor is retired, and effectiveIabCategories
// no longer falls back to the field — a persisted draft carrying a hidden list
// silently shipped it on every auto deal (a 2026-07 automotive-category
// incident). The fold makes the legacy values visible per-deal instead of
// silently dropping them.
describe('migrateCampaignIabCategories — legacy campaign IAB fold', () => {
  it('folds the campaign list onto auto (undefined) deals only and clears the field', () => {
    const form: FormData = {
      ...DEFAULT_FORM,
      iabCategories: ['Car Culture', 'Auto Parts'],
      deals: [
        { ...newDeal(), theme: 'Auto' },
        { ...newDeal(), theme: 'Picked', iabCategories: ['News'] },
        { ...newDeal(), theme: 'None', iabCategories: [] },
      ],
    }
    const out = migrateCampaignIabCategories(form)
    expect(out.deals[0].iabCategories).toEqual(['Car Culture', 'Auto Parts'])
    // Explicit picks AND explicit "none" are trader decisions — untouched.
    expect(out.deals[1].iabCategories).toEqual(['News'])
    expect(out.deals[2].iabCategories).toEqual([])
    // Hidden campaign values are gone — the deal cards now show the truth.
    expect(out.iabCategories).toEqual([])
  })

  it('no-op on an empty campaign list — auto deals stay auto (undefined)', () => {
    const form: FormData = { ...DEFAULT_FORM, deals: [{ ...newDeal(), theme: 'Auto' }] }
    const out = migrateCampaignIabCategories(form)
    expect(out).toBe(form)
    expect(out.deals[0].iabCategories).toBeUndefined()
  })

  // With zero deals there is nothing to fold onto — clearing the field here
  // would silently drop the legacy list AND blind the fail-closed Go backstop
  // (iab_campaign_retired only fires on a non-empty value). Keep it in place;
  // a later entry-point run folds it once deals exist.
  it('keeps the campaign list when there are no deals to fold onto', () => {
    const form: FormData = { ...DEFAULT_FORM, iabCategories: ['Auto Parts'], deals: [] }
    const out = migrateCampaignIabCategories(form)
    expect(out).toBe(form)
    expect(out.iabCategories).toEqual(['Auto Parts'])
  })
})

describe('hydrateForm — legacy campaign IAB migration', () => {
  it('loads a persisted draft with the list folded per-deal and the form field cleared', () => {
    const legacy = {
      iabCategories: ['Car Culture'],
      deals: [
        { id: 'd1', theme: 'Auto' },
        { id: 'd2', theme: 'Picked', iabCategories: ['News'] },
      ],
    } as unknown as Partial<FormData>

    const form = hydrateForm(legacy)
    expect(form.deals[0].iabCategories).toEqual(['Car Culture'])
    expect(form.deals[1].iabCategories).toEqual(['News'])
    expect(form.iabCategories).toEqual([])
  })
})

describe('hydrateForm — seeded format-default migration', () => {
  it('resets the old pre-checked PubMatic/Media.net defaults to empty = auto', () => {
    const form = hydrateForm({
      pubmaticConfig: {
        maxReach: false, publisherNames: ['Pub'], maxAllowedPublishers: '',
        publisherBlockList: [], adFormats: ['Banner (3)'], platforms: ['Desktop (1)'],
      },
      medianetConfig: { adFormat: 'Banner (0)', environments: [], marginType: 'Percentage (1)', marginValue: '30' },
    } as unknown as Partial<FormData>)
    expect(form.pubmaticConfig.adFormats).toEqual([])
    expect(form.pubmaticConfig.platforms).toEqual([])
    expect(form.medianetConfig.adFormat).toBe('')
  })

  it('keeps deliberate non-seeded selections', () => {
    const form = hydrateForm({
      pubmaticConfig: {
        maxReach: false, publisherNames: ['Pub'], maxAllowedPublishers: '',
        publisherBlockList: [], adFormats: ['Video (12)'], platforms: ['Desktop (1)', 'CTV (7)'],
      },
      medianetConfig: { adFormat: 'Video (2)', environments: [], marginType: 'Percentage (1)', marginValue: '30' },
    } as unknown as Partial<FormData>)
    expect(form.pubmaticConfig.adFormats).toEqual(['Video (12)'])
    expect(form.pubmaticConfig.platforms).toEqual(['Desktop (1)', 'CTV (7)'])
    expect(form.medianetConfig.adFormat).toBe('Video (2)')
  })
})

// The per-deal auto-infer toggle (IAB inference is opt-in, default OFF) must
// survive persistence round-trips — and hydration must never invent it: a
// deal saved without the field stays OFF.
describe('hydrateForm — autoInferIab round-trip', () => {
  it('preserves the toggle where set and leaves it absent (off) elsewhere', () => {
    const stored = {
      deals: [
        { ...newDeal(), theme: 'Opted in', autoInferIab: true },
        { ...newDeal(), theme: 'Default off' },
      ],
    } as Partial<FormData>
    const out = hydrateForm(stored)
    expect(out.deals[0].autoInferIab).toBe(true)
    expect(out.deals[1].autoInferIab).toBeUndefined()
  })

  it('newDeal() omits the toggle — new deals start with inference OFF', () => {
    expect('autoInferIab' in newDeal()).toBe(false)
  })
})

// The Campaign Defaults section (the only defaultLanguage editor) is retired,
// but resolve() still falls back to the field — a hidden 'Spanish' shipped on
// every deal while each card's Language select showed "— None —" (2026-07-15
// report: SignalForge template seeds it). Hydration folds it onto the deals.
describe('hydrateForm — legacy defaultLanguage migration', () => {
  it('folds the campaign default onto language-less deals and clears it', () => {
    const out = hydrateForm({
      deals: [
        { ...newDeal(), theme: 'HasLang', language: 'French' },
        { ...newDeal(), theme: 'NoLang' },
      ],
      defaultLanguage: 'Spanish',
    } as Partial<FormData>)
    expect(out.deals[0].language).toBe('French')
    expect(out.deals[1].language).toBe('Spanish')
    expect(out.defaultLanguage).toBe('')
  })

  it('keeps the value in place when there are no deals to fold onto', () => {
    const out = hydrateForm({ deals: [], defaultLanguage: 'Spanish' } as Partial<FormData>)
    expect(out.defaultLanguage).toBe('Spanish')
  })
})

describe('hydrateForm — deal-sheet recipient scrub (admin-identity regression)', () => {
  it('drops recipient tokens that can never validate, keeping real addresses', () => {
    const form = hydrateForm({ dealSheetRecipient: 'elyse@example.com, admin' } as Partial<FormData>)
    expect(form.dealSheetRecipient).toBe('elyse@example.com')
  })

  it('scrubs to empty when nothing valid remains', () => {
    const form = hydrateForm({ dealSheetRecipient: 'admin' } as Partial<FormData>)
    expect(form.dealSheetRecipient).toBe('')
  })

  it('leaves valid multi-recipient values untouched', () => {
    const form = hydrateForm({ dealSheetRecipient: 'a@x.com, b@y.com' } as Partial<FormData>)
    expect(form.dealSheetRecipient).toBe('a@x.com, b@y.com')
  })
})

// The DEAL07300 submit block (2026-08-24): an LLM-authored draft put the
// upload ATTACHMENT id into appliedAppBundleListIds. Applied arrays hold
// standard-list REGISTRY ids only — an upload id there is invisible in the UI
// (chips resolve against the live registry) and failed the /api/moc/create
// standard-list gate on every retry. hydrateForm is the single funnel every
// saved form passes (localStorage, restored drafts).

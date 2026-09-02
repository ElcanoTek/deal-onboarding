import { describe, expect, it } from 'vitest'
import src from './DealsList.tsx?raw'

describe('DealsList — typed exclusion override (#256)', () => {
  it('shows only trader override failures and keeps the input mounted while typing', () => {
    expect(src).toContain("e.field === 'defaultGeoExclude'")
    expect(src).toContain('!/competitive-separation|client contractual/i.test(e.message)')
    expect(src).toContain('!!exclusionBlock || !!deal.exclusionOverride?.acknowledgement')
  })

  it('binds the acknowledgement to the current SSP and clears it when routing changes', () => {
    expect(src).toContain('Type exactly: <code>{exclusionOverridePhrase(deal.ssp)}</code>')
    expect(src).toContain("exclusionOverride: { ssp: deal.ssp, acknowledgement: e.target.value }")
    expect(src.match(/exclusionOverride: undefined/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

// PR B — per-deal IAB auto-infer toggle + per-SSP catalog picker. There is no
// component-render harness in this repo (no jsdom/testing-library), so these
// are source pins on the card-state contract; the behavioral truth tables
// live in inferIab.test.ts / dealPromptYaml.test.ts / sspIabCatalogs.test.ts.
describe('DealsList — IAB auto-infer toggle card states (source pins)', () => {
  it('renders the opt-in toggle and writes it as true/undefined (never false noise)', () => {
    expect(src).toContain('Auto-infer IAB categories')
    expect(src).toContain("patchDeal(deal.id, { autoInferIab: e.target.checked || undefined })")
  })

  it('states: off+no picks muted text · on+no picks inferred review label · custom picks · Clear picks resets to toggle-governed', () => {
    expect(src).toContain('No IAB categories — none will be applied to this deal.')
    expect(src).toContain("'inferred — review before submit'")
    expect(src).toContain('Clear picks')
    expect(src).toContain("patchDeal(deal.id, { iabCategories: undefined })")
  })

  it('per-SSP capability: TL/Magnite render the notSupportedReason; excludes picker gated by capability', () => {
    expect(src).toContain("IAB categories: not supported by this SSP's API — {cap.notSupportedReason}")
    expect(src).toContain("cap.excludes !== 'none' && (")
    expect(src).toContain('excludes applied post-create (${cap.excludesVia})')
  })

  it('picker is catalog-sourced and free text validates against the SSP catalog (inline error chip)', () => {
    expect(src).toContain('sspIabPickerOptions(ssp)')
    expect(src).toContain('sspCatalogHasLabel(deal.ssp, name)')
    expect(src).toContain('chip--invalid')
  })

  it('unsupported chips strike through via the SAME partition the builders use; IX split-key warning reuses it', () => {
    expect(src).toContain('sspIabPartitionForUi(deal.ssp, effective, excludes)')
    expect(src).toContain('not supported on {deal.ssp}')
    expect(src).toContain('partition.ixSplitNames.length > 0')
  })
})

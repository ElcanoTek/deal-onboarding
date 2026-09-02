// Golden deal-naming cases — the SAME fixture the Go suite reads
// (internal/validation/deal_naming_golden_test.go ← testdata/deal_naming_golden.json),
// so the two generators can never drift silently again.

import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, DealEntry, DspEntry, FormData, GeoEntry, newDeal } from '../types/deal'
import { expandDealDsps, generateDealName } from './dealNameSlots'
// Relative import of the SHARED fixture (resolveJsonModule) — the same file
// internal/validation/deal_naming_golden_test.go reads.
import goldenFixture from '../../../internal/validation/testdata/deal_naming_golden.json'

interface GoldenGeo {
  id?: string
  type: GeoEntry['type']
  value: string
}

interface GoldenDeal {
  id?: string
  ssp: string
  theme: string
  channel: string
  inventoryType?: string
  geoInclude?: GoldenGeo[]
  nameOverride?: string
  sheetOnly?: boolean
}

interface GoldenCase {
  name: string
  description: string
  form: {
    dataPartner?: string
    agency: string
    brand: string
    campaignId: string
    attributionCode?: string
    multipleDsps?: boolean
    dsps: Array<{ id?: string; dsp: string; seatId?: string }>
    defaultInventoryType?: string
    defaultGeoInclude?: GoldenGeo[]
    deals: GoldenDeal[]
  }
  expect: {
    names: string[]
  }
}

const golden = goldenFixture as unknown as { cases: GoldenCase[] }

function hydrateGeo(entries: GoldenGeo[] | undefined): GeoEntry[] {
  return (entries || []).map((g, i) => ({ id: g.id || `g${i}`, type: g.type, value: g.value }))
}

function hydrateForm(tc: GoldenCase): { form: FormData } {
  const f = tc.form
  const dsps: DspEntry[] = f.dsps.map((d, i) => ({ id: d.id || String(i + 1), dsp: d.dsp, seatId: d.seatId || '' }))
  const deals: DealEntry[] = f.deals.map((d, i) => ({
    ...newDeal(),
    id: d.id || `d${i + 1}`,
    ssp: d.ssp as DealEntry['ssp'],
    theme: d.theme,
    channel: d.channel as DealEntry['channel'],
    inventoryType: (d.inventoryType || '') as DealEntry['inventoryType'],
    geoInclude: hydrateGeo(d.geoInclude),
    nameOverride: d.nameOverride || '',
    sheetOnly: !!d.sheetOnly,
  }))
  const form: FormData = {
    ...DEFAULT_FORM,
    dataPartner: f.dataPartner || '',
    agency: f.agency,
    brand: f.brand,
    campaignId: f.campaignId,
    attributionCode: f.attributionCode || '',
    multipleDsps: !!f.multipleDsps,
    dsps,
    defaultInventoryType: (f.defaultInventoryType || '') as FormData['defaultInventoryType'],
    defaultGeoInclude: hydrateGeo(f.defaultGeoInclude),
    deals,
  }
  return { form }
}

describe('deal-naming golden fixture (shared with Go)', () => {
  it('fixture loads and has cases', () => {
    expect(golden.cases.length).toBeGreaterThan(0)
  })

  for (const tc of golden.cases) {
    describe(tc.name, () => {
      const { form } = hydrateForm(tc)

      it('generates the exact expected names (byte parity with Go)', () => {
        const pairs = expandDealDsps(form.deals, form)
        const names = pairs.map(({ deal, dsp }) => generateDealName(form, deal, { dsp }))
        expect(names).toEqual(tc.expect.names)
      })

      it('every generated (non-override) name has exactly 12 slots', () => {
        const pairs = expandDealDsps(form.deals, form)
        for (const { deal, dsp } of pairs) {
          if ((deal.nameOverride || '').trim()) continue
          const name = generateDealName(form, deal, { dsp })
          expect(name.split('_')).toHaveLength(12)
        }
      })

    })
  }
})

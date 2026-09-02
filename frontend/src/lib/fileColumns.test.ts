import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { detectFileColumns, pastedListToCsv, pickColumn } from './fileColumns'

function xlsxFile(rows: (string | number)[][], name = 'list.xlsx'): File {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([buf], name)
}

// Cross-scope column detection: a file dropped in the WRONG bucket must still
// resolve to its real value column, not headers[0]. Live-confirmed 2026-06-30:
// a CTV app-bundle allow list (cols Publisher / App Name / Bundle ID) detected
// under the domain scope picked "Publisher" (headers[0]) → allowlisted 1 bundle.
describe('detectFileColumns cross-scope fallback', () => {
  it('finds "Bundle ID" even when an app-bundle file is added under the domain scope', async () => {
    const csv = 'Publisher,App Name,Bundle ID\nUnruly Media,10 Tampa Bay,63489\n'
    const file = new File([csv], 'raptive_allow_list.csv', { type: 'text/csv' })
    const { detected } = await detectFileColumns(file, 'domain')
    expect(detected).toBe('Bundle ID')
    expect(detected).not.toBe('Publisher')
  })

  it('still prefers the requested scope when it has its own match', async () => {
    const csv = 'Domain,Bundle ID\nexample.com,63489\n'
    const file = new File([csv], 'sites.csv', { type: 'text/csv' })
    const { detected } = await detectFileColumns(file, 'domain')
    expect(detected).toBe('Domain')
  })
})

// Headerless files (issue #227): when NEITHER scope's patterns match, row 0 is
// almost certainly real data — detected must be '' so the prompt omits the
// *_column arg and cutlass split_rows keeps every row. The old headers[0]
// fallback fabricated a "column" from the first domain/bundle, which made
// split_rows treat row 0 as a header and silently drop the first list entry
// (the #675 data-loss class re-introduced client-side).
describe('detectFileColumns headerless files (issue #227)', () => {
  it('headerless single-column CSV → detected "" (old fallback fabricated "example.com")', async () => {
    const csv = 'example.com\nfoo.com\nbar.net\n'
    const { headers, detected } = await detectFileColumns(new File([csv], 'raw_domains.csv'), 'domain')
    expect(detected).toBe('')
    expect(detected).not.toBe('example.com')
    // Row 0 still surfaces as a picker option so the trader CAN override.
    expect(headers).toEqual(['example.com'])
  })

  it("BOM'd headerless CSV → detected \"\" (old fallback fabricated the BOM'd first domain)", async () => {
    const csv = '\uFEFF' + 'example.com\nfoo.com\n'
    const { detected } = await detectFileColumns(new File([csv], 'bom_domains.csv'), 'domain')
    expect(detected).toBe('')
  })

  it("BOM'd REAL header still maps its column — clean of the BOM", async () => {
    const csv = '\uFEFF' + 'Domain,Notes\nexample.com,keep\n'
    const { detected } = await detectFileColumns(new File([csv], 'bom_header.csv'), 'domain')
    expect(detected).toBe('Domain')
  })

  it('headerless single-column XLSX → detected ""', async () => {
    const file = xlsxFile([['com.hulu.plus'], ['com.fubotv.vix'], ['523428113']], 'bundles.xlsx')
    const { detected } = await detectFileColumns(file, 'app_bundle')
    expect(detected).toBe('')
    expect(detected).not.toBe('com.hulu.plus')
  })

  it('real-header XLSX still maps its column', async () => {
    const file = xlsxFile([['Bundle ID', 'App Name'], ['com.hulu.plus', 'Hulu']], 'bundles.xlsx')
    const { detected } = await detectFileColumns(file, 'app_bundle')
    expect(detected).toBe('Bundle ID')
  })

  it('multi-column CSV whose real header matches no pattern → detected "" (never headers[0], never a "Sites" guess)', async () => {
    const csv = 'Publisher,Country\nUnruly Media,US\n'
    const { detected } = await detectFileColumns(new File([csv], 'unrecognized.csv'), 'domain')
    expect(detected).toBe('')
  })

  it('unreadable/empty file → detected "" (old fallback guessed the scope default "Sites"/"Bundles")', async () => {
    const empty = await detectFileColumns(new File([''], 'empty.csv'), 'domain')
    expect(empty.detected).toBe('')
    const unknownExt = await detectFileColumns(new File(['example.com'], 'list.unknown'), 'app_bundle')
    expect(unknownExt.detected).toBe('')
  })
})

// Manual-entry path: a pasted blob of domains / bundles is turned into a
// one-column CSV that flows through the same upload + column-detection pipeline
// as an uploaded file. These pin the parsing + the detection-friendly header.

describe('pastedListToCsv', () => {
  it('builds a domain CSV (detected-friendly header), trimmed + deduped, order preserved', () => {
    const { csv, count } = pastedListToCsv('univision.com\n telemundo.com \nunivision.com\n', 'domain')
    expect(count).toBe(2)
    expect(csv).toBe('domain\nunivision.com\ntelemundo.com')
  })

  it('splits on commas, tabs, and spaces and preserves bundle-id case', () => {
    const { csv, count } = pastedListToCsv('com.fubotv.vix, B072QYQ43R\tb072qyq43r 162057', 'app_bundle')
    expect(count).toBe(4)
    expect(csv.split('\n')[0]).toBe('app bundle ids')
    // Case-distinct ASINs are both retained (bundle IDs are case-sensitive).
    expect(csv).toContain('B072QYQ43R')
    expect(csv).toContain('b072qyq43r')
  })

  it('returns count 0 for blank input', () => {
    expect(pastedListToCsv('   \n  \n', 'domain').count).toBe(0)
  })

  it('synthesized headers are resolved by pickColumn (no manual column fix needed)', () => {
    expect(pickColumn(['domain'], 'domain')).toBe('domain')
    expect(pickColumn(['app bundle ids'], 'app_bundle')).toBe('app bundle ids')
  })
})

// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Column-header detection for uploaded domain / app-bundle list files.
//
// The IX (and other SSP) MCPs want the file path PLUS the column header
// inside the spreadsheet that holds the URL or bundle ID. Deal Onboarding used
// to hardcode "Sites" for domain and "Bundles" for app-bundle — but the
// real-world files from the SS-Optimum brief had "Domain" and "Bundle ID"
// columns, forcing the runner agent to inspect and override every run.
//
// This helper reads the first row of the uploaded file (xlsx/xls via
// SheetJS, csv/tsv/txt by line split) and picks the best-matching column
// using a per-scope priority list. When NOTHING matches (either scope),
// detected is '' — the file is almost certainly a HEADERLESS list whose
// row 0 is real data, and the old headers[0] fallback fabricated a
// "column" from the first domain/bundle. That fabricated name defeated
// cutlass split_rows' header heuristic (row 0 matched the requested
// column, got treated as a header, and the first list entry was silently
// dropped — issue #227, the #675 data-loss class). With detected='' the
// prompt omits the *_column arg entirely and split_rows decides the
// header/data split itself (a headerless file keeps every row). The
// trader can still set a column manually in the UI for a real-but-
// unrecognized header.

type Scope = 'domain' | 'app_bundle'

/** Header written into a CSV synthesized from a manually pasted list. Chosen so
 *  detectFileColumns() resolves the single column without trader intervention:
 *  "domain" matches DOMAIN_HEADER_PATTERNS, "app bundle ids" matches
 *  APP_BUNDLE_HEADER_PATTERNS. */
export function pastedListHeader(scope: Scope): string {
  return scope === 'domain' ? 'domain' : 'app bundle ids'
}

/** Turn a pasted blob of domains / app-bundle IDs into a single-column CSV.
 *  Accepts newline-, comma-, tab-, or space-separated values; trims each, drops
 *  blanks, and de-duplicates preserving first-seen order (bundle IDs are
 *  case-sensitive, so dedupe is case-exact). Returns the CSV text (header + one
 *  value per line) and the unique entry count. */
export function pastedListToCsv(text: string, scope: Scope): { csv: string; count: number } {
  const seen = new Set<string>()
  const values: string[] = []
  for (const raw of text.split(/[\n,\t ]+/)) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    values.push(v)
  }
  const header = pastedListHeader(scope)
  const csv = [header, ...values].join('\n')
  return { csv, count: values.length }
}

const DOMAIN_HEADER_PATTERNS = [
  /^domains?$/i,
  /^sites?$/i,
  /^urls?$/i,
  /^websites?$/i,
  /^hosts?$/i,
  /^hostnames?$/i,
]

const APP_BUNDLE_HEADER_PATTERNS = [
  /^bundle[\s_-]?ids?$/i,
  /^app[\s_-]?bundle[\s_-]?ids?$/i,
  /^app[\s_-]?bundles?$/i,
  /^bundles?$/i,
  /^app[\s_-]?ids?$/i,
  /^packages?$/i,
  /^package[\s_-]?names?$/i,
]

/** Return the highest-priority header that matches the scope's patterns,
 *  or undefined when none match. Earlier patterns win. */
export function pickColumn(headers: string[], scope: Scope): string | undefined {
  const patterns = scope === 'domain' ? DOMAIN_HEADER_PATTERNS : APP_BUNDLE_HEADER_PATTERNS
  for (const re of patterns) {
    const hit = headers.find(h => re.test(h.trim()))
    if (hit) return hit
  }
  return undefined
}

/** Read the first row of a CSV/TSV/TXT string and return non-empty headers.
 *  Strips a leading UTF-8 BOM (U+FEFF) so a BOM'd real header (e.g. a BOM-prefixed
 *  "Domain") still pattern-matches AND the returned header is the
 *  clean column name the MCP will look up. */
function parseDelimitedHeaders(text: string, delimiter: string): string[] {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || ''
  return firstLine
    .split(delimiter)
    .map(h => h.replace(/^"|"$/g, '').trim())
    .filter(Boolean)
}

/** Detect column headers + best-match column for a freshly-uploaded file.
 *  Returns empty headers when the file format isn't readable. */
export async function detectFileColumns(file: File, scope: Scope): Promise<{ headers: string[]; detected: string }> {
  const lower = file.name.toLowerCase()
  const ext = lower.slice(lower.lastIndexOf('.') + 1)
  let headers: string[] = []
  try {
    if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const firstSheetName = wb.SheetNames[0]
      if (firstSheetName) {
        const sheet = wb.Sheets[firstSheetName]
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, raw: false })
        const first = rows[0] || []
        headers = first.map(c => String(c ?? '').trim()).filter(Boolean)
      }
    } else if (ext === 'tsv') {
      headers = parseDelimitedHeaders(await file.text(), '\t')
    } else if (ext === 'csv' || ext === 'txt') {
      // .txt could be comma- or tab-delimited; try comma first, fall back to tab.
      const text = await file.text()
      const commaHeaders = parseDelimitedHeaders(text, ',')
      headers = commaHeaders.length > 1 ? commaHeaders : parseDelimitedHeaders(text, '\t')
    }
  } catch {
    // Detection is best-effort — a corrupted or empty file just means
    // no column detected: the prompt omits the column arg and the MCP
    // decides the header/data split itself.
    headers = []
  }
  // Prefer the requested scope's value-column. If it has no match, try the
  // OTHER scope's patterns: a file dropped in the wrong bucket (e.g. a CTV
  // app-bundle list with a "Bundle ID" column added under the domain scope)
  // still resolves to its real value column instead of a non-targeting field
  // like "Publisher" (live-confirmed 2026-06-30: that allowlisted only 1
  // bundle). When NEITHER scope matches, detected is '' — NEVER headers[0]
  // (for a headerless list that fabricates a "column" from the first data
  // row, and naming row 0's value as the column makes cutlass split_rows
  // treat row 0 as a header and silently drop the first entry — issue #227)
  // and NEVER a hardcoded 'Sites'/'Bundles' guess (a name absent from a real
  // header row fails extraction loudly mid-run). The prompt omits the
  // *_column arg instead; split_rows keeps every row of a headerless file.
  const otherScope: Scope = scope === 'domain' ? 'app_bundle' : 'domain'
  const detected = pickColumn(headers, scope) || pickColumn(headers, otherScope) || ''
  return { headers, detected }
}

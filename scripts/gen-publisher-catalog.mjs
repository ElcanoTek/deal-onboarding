#!/usr/bin/env node
// Regenerate catalogs/publisher-catalog.json from a trader-maintained
// publisher workbook (one sheet per SSP). The shipped catalog is a tiny
// synthetic placeholder — run this against your own SSP publisher exports. Run from the repo root:
//
//   node scripts/gen-publisher-catalog.mjs "/path/to/Platform Publisher List.xlsx"
//
// Commit the resulting JSON — the snapshot ships with the repo and powers
// the allowlist chips' advisory validation + the publisher_known_list audit
// check. Refresh whenever the trader re-exports the workbook.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const XLSX = await import(new URL('../frontend/node_modules/xlsx/xlsx.mjs', import.meta.url))

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/gen-publisher-catalog.mjs <workbook.xlsx>')
  process.exit(1)
}

// Sheet/header contract of the trader workbook — tolerant of case/spacing,
// pinned vocabulary (a renamed sheet is skipped loudly, never guessed).
const CONTRACT = [
  ['index', 'index publisher list', 'partner_id', 'partner_name'],
  ['openx', 'openx publisher list', 'supply account id', 'supply account name'],
  ['pubmatic', 'pubmatic publisher list', 'publisher id', 'publisher'],
  ['magnite_ctv', 'magnite ctv publisher list', 'seller id', 'seller name'],
  ['magnite_dvplus', 'magnite dv+ publisher list', 'account id', 'account'],
]
const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const wb = XLSX.read(readFileSync(src), { type: 'buffer' })
const slices = {}
const skippedSheets = []
for (const sheetName of wb.SheetNames) {
  const c = CONTRACT.find(([, sh]) => sh === norm(sheetName))
  if (!c) { skippedSheets.push(sheetName); continue }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null })
  let idCol = -1, nameCol = -1, headerRow = -1
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = (rows[r] || []).map(norm)
    const i = cells.indexOf(c[2]); const n = cells.indexOf(c[3])
    if (i >= 0 && n >= 0) { headerRow = r; idCol = i; nameCol = n; break }
  }
  if (headerRow < 0) { skippedSheets.push(`${sheetName} (headers not recognized)`); continue }
  const entries = []
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || []
    const rawID = String(row[idCol] ?? '').trim()
    const id = /^\d+$/.test(rawID) ? rawID : ''
    let name = String(row[nameCol] ?? '').trim()
    if (/^#(n\/a|ref!?|value!?)$/i.test(name)) name = ''
    if (!id && !name) continue
    entries.push(id ? (name ? { id, name } : { id }) : { name })
  }
  slices[c[0]] = entries
}

if (Object.keys(slices).length === 0) {
  console.error('no recognizable sheets — expected tabs like "Index Publisher List"')
  process.exit(1)
}

mkdirSync(new URL('../catalogs', import.meta.url), { recursive: true })
const out = new URL('../catalogs/publisher-catalog.json', import.meta.url)
writeFileSync(out, JSON.stringify({
  as_of: new Date().toISOString().slice(0, 10),
  source: `${src.split('/').pop()} — operator publisher export; refresh with scripts/gen-publisher-catalog.mjs and commit`,
  slices,
}, null, 1))

console.log('wrote catalogs/publisher-catalog.json')
for (const [k, v] of Object.entries(slices)) console.log(`  ${k}: ${v.length} publishers`)
if (skippedSheets.length) console.log(`  skipped sheets: ${skippedSheets.join(', ')}`)

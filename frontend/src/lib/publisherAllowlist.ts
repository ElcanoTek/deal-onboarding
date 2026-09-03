// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import type { PublisherAllowlistEntry } from '../types/deal'

/** Publisher-allowlist entry parsing — the pure logic behind the
 *  PublisherAllowlist component. Entries store exactly what ships on the wire
 *  ({id?, name?}); every entry is verified fail-closed against the SSP's live
 *  catalog at booking (an unresolved publisher blocks the create), so there
 *  is no client-side publisher database. */

/** parsePublisherInput turns pasted text into entries. Lines are the primary
 *  separator. Within a line:
 *  - all digits                → id-only entry
 *  - "id <TAB> name" (either order) → id + name pair
 *  - digits-only comma list ("123, 456") → one id entry each
 *  - anything else            → name entry, verbatim
 *  Commas do NOT split names — real publishers contain commas ("TStack, Inc."). */
export function parsePublisherInput(text: string): PublisherAllowlistEntry[] {
  const out: PublisherAllowlistEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const cells = line.split('\t').map(c => c.trim()).filter(Boolean)
    if (cells.length >= 2) {
      const idCell = cells.find(c => /^\d+$/.test(c))
      const nameCell = cells.find(c => !/^\d+$/.test(c))
      if (idCell && nameCell) {
        out.push({ id: idCell, name: nameCell })
        continue
      }
      if (idCell && !nameCell) {
        for (const c of cells) if (/^\d+$/.test(c)) out.push({ id: c })
        continue
      }
      // Multiple non-numeric cells on one line: treat the line as one name.
      out.push({ name: line })
      continue
    }
    if (/^\d+$/.test(line)) {
      out.push({ id: line })
      continue
    }
    if (/^\d+(\s*,\s*\d+)+$/.test(line)) {
      for (const c of line.split(',')) out.push({ id: c.trim() })
      continue
    }
    out.push({ name: line })
  }
  return out
}

/** entriesFromRows lifts spreadsheet rows (SheetJS header:1 output) into
 *  entries by joining each row's cells with tabs and reusing the line parser,
 *  so a dropped .xlsx/.csv of "id, name" columns behaves like a paste. */
export function entriesFromRows(rows: unknown[][]): PublisherAllowlistEntry[] {
  const text = rows
    .map(row => (row || []).map(c => String(c ?? '').trim()).filter(Boolean).join('\t'))
    .filter(Boolean)
    .join('\n')
  const entries = parsePublisherInput(text)
  // A multi-column row with no numeric cell parses as one tab-joined "name" —
  // real publisher names never contain tabs, so that's a header row. Drop it.
  return entries.filter(e => !(e.name || '').includes('\t'))
}

/** dedupeEntries drops repeats by id (or lowercased name for name-only rows),
 *  keeping first occurrence order. */
export function dedupeEntries(entries: PublisherAllowlistEntry[]): PublisherAllowlistEntry[] {
  const seen = new Set<string>()
  const out: PublisherAllowlistEntry[] = []
  for (const e of entries) {
    const id = (e.id || '').trim()
    const name = (e.name || '').trim()
    if (!id && !name) continue
    const key = id ? `#${id}` : name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

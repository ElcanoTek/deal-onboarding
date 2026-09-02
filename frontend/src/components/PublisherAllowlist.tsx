import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import type { PublisherAllowlistEntry } from '../types/deal'
import { dedupeEntries, entriesFromRows, parsePublisherInput } from '../lib/publisherAllowlist'
import {
  buildCatalogLookup,
  resolveAgainstCatalog,
  suggestName,
  usePublisherCatalog,
  wrongCardHint,
  type CatalogSlice,
} from '../lib/publisherCatalog'

interface Props {
  /** Entries as they'll ship — the SSP config field this component edits. */
  entries: PublisherAllowlistEntry[]
  onChange: (entries: PublisherAllowlistEntry[]) => void
  /** SSPs whose wire takes IDs only (OpenX): name-only entries render as errors. */
  idRequired?: boolean
  inputId?: string
  /** Audit error for this field, rendered above the input. */
  error?: string
  /** Known-publisher-list slice(s) to validate against (advisory). */
  catalogSlices?: CatalogSlice[]
}

/** PublisherAllowlist — the "specific publishers" input, identical on every
 *  SSP card: a drop zone for the approved-list file (.xlsx/.csv/.txt) plus an
 *  "or paste" affordance, entries shown as removable chips. There is no
 *  publisher database in Deal Onboarding: every entry is verified against the SSP's
 *  live catalog when the deals book, and any publisher that doesn't resolve
 *  blocks the create. */
export function PublisherAllowlist({ entries, onChange, idRequired, inputId, error, catalogSlices }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileMsg, setFileMsg] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  // Known publisher list (advisory): auto-fills ids, flags unknown entries,
  // suggests near-miss names, and detects a wrong-SSP paste. Absent catalog
  // = plain chips; booking-time verification is unaffected either way.
  const catalog = usePublisherCatalog()
  const lookup = useMemo(
    () => (catalog && catalogSlices?.length ? buildCatalogLookup(catalog, catalogSlices) : null),
    [catalog, catalogSlices],
  )
  const resolved = useMemo(
    () => entries.map(e => (lookup ? resolveAgainstCatalog(e, lookup) : { entry: e, known: true })),
    [entries, lookup],
  )
  const suggestions = useMemo(() => {
    if (!lookup) return []
    const out: { from: string; to: string }[] = []
    for (const r of resolved) {
      if (r.known || (r.entry.id || '').trim() !== '') continue
      const to = suggestName(r.entry.name || '', lookup)
      if (to) out.push({ from: r.entry.name || '', to })
      if (out.length >= 3) break
    }
    return out
  }, [resolved, lookup])
  const wrongCard = useMemo(() => {
    if (!catalog || !catalogSlices?.length) return undefined
    const unknownIds = resolved
      .filter(r => !r.known && (r.entry.id || '').trim() !== '')
      .map(r => (r.entry.id || '').trim())
    return wrongCardHint(unknownIds, catalog, catalogSlices)
  }, [resolved, catalog, catalogSlices])

  const addEntries = (incoming: PublisherAllowlistEntry[]) => {
    if (incoming.length === 0) return
    // Auto-fill from the known list at add time (a matched name gains its
    // exact id) so what persists in the form is what ships on the wire.
    const enriched = lookup ? incoming.map(e => resolveAgainstCatalog(e, lookup).entry) : incoming
    onChange(dedupeEntries([...entries, ...enriched]))
  }

  const submitPaste = () => {
    const parsed = parsePublisherInput(pasteText)
    if (parsed.length === 0) return
    addEntries(parsed)
    setPasteText('')
    setPasteOpen(false)
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setFileMsg('')
    try {
      if (/\.xlsx?$/i.test(file.name)) {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null })
        addEntries(entriesFromRows(rows))
      } else {
        addEntries(parsePublisherInput(await file.text()))
      }
    } catch (err) {
      setFileMsg(`Could not read ${file.name} (${String(err)})`)
    }
  }

  const remove = (idx: number) => onChange(entries.filter((_, i) => i !== idx))

  return (
    <div className="field-group">
      {error && <span className="field-error">{error}</span>}
      {entries.length > 0 && (
        <div className="list-library__bar" role="list" aria-label="Publisher allowlist">
          {resolved.map((r, i) => {
            const e = r.entry
            const label = e.name || e.id || ''
            const bad = idRequired && !(e.id || '').trim()
            const unlisted = !bad && !r.known
            return (
              <span
                key={`${e.id || ''}~${e.name || ''}~${i}`}
                className="list-library__chip"
                role="listitem"
                title={unlisted ? `Not on the known publisher list (snapshot ${lookup?.asOf}). Booking will verify it against the live SSP catalog.` : undefined}
              >
                <span className="list-library__chip-name">{label}</span>
                {(e.id || bad || unlisted) && (
                  <span
                    className="list-library__chip-scope"
                    style={bad
                      ? { color: 'var(--color-error, currentColor)' }
                      : unlisted ? { color: 'var(--color-warning, currentColor)' } : undefined}
                  >
                    {bad ? 'needs ID' : unlisted ? (e.id ? `#${e.id} · unlisted` : 'unlisted') : `#${e.id}`}
                  </span>
                )}
                <button type="button" className="list-library__chip-x" aria-label={`Remove ${label}`} onClick={() => remove(i)}>×</button>
              </span>
            )
          })}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>Clear all</button>
        </div>
      )}
      {wrongCard && (
        <span className="field-error" role="alert">{wrongCard}</span>
      )}
      {suggestions.map(s => (
        <span key={s.from} className="field-helper" style={{ color: 'var(--color-warning, currentColor)' }}>
          “{s.from}” isn't on the known list — did you mean “{s.to}”?
        </span>
      ))}

      <div
        className={`file-upload-dropzone${dragOver ? ' drag-over' : ''}${error ? ' field-input--error' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]) }}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload publisher list"
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
      >
        <input
          ref={fileRef}
          id={inputId}
          type="file"
          accept=".xlsx,.xls,.csv,.txt,.tsv"
          style={{ display: 'none' }}
          onChange={e => { void handleFile(e.target.files?.[0]); e.target.value = '' }}
        />
        <div className="dropzone-content">
          <svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
          <span className="dropzone-text">
            Drag & drop or <button type="button" className="dropzone-browse-btn" onClick={e => { e.stopPropagation(); fileRef.current?.click() }}>browse</button>
          </span>
          <span className="dropzone-hint">Accepts .xlsx, .csv, .txt — publisher {idRequired ? 'IDs (with or without names)' : 'names and/or IDs'}</span>
        </div>
      </div>

      {!pasteOpen ? (
        <button
          type="button"
          className="dropzone-browse-btn"
          style={{ marginTop: 'var(--space-2)', alignSelf: 'flex-start' }}
          onClick={() => setPasteOpen(true)}
        >
          or paste a list of publishers
        </button>
      ) : (
        <div style={{ marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <textarea
            className="field-input"
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            rows={5}
            placeholder={'Paste publishers, one per line — name, ID, or "ID\tname"'}
            aria-label="Pasted publisher list"
            style={{ fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
          />
          <div className="field-row" style={{ alignItems: 'center', gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={submitPaste} disabled={!pasteText.trim()}>Add publishers</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPasteOpen(false); setPasteText('') }}>Cancel</button>
          </div>
        </div>
      )}

      {fileMsg && <span className="field-error" role="alert">{fileMsg}</span>}
      <span className="field-helper">
        {idRequired
          ? 'This SSP targets by publisher ID — include each publisher’s ID.'
          : 'Every publisher is verified against the SSP when the deals book — a misspelled or unknown publisher blocks the create instead of booking without it.'}
      </span>
    </div>
  )
}

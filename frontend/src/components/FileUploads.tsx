// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useMemo, useRef, useState } from 'react'
import type { FormData as DealForm, StandardList, UploadedFile } from '../types/deal'
import { isVideoChannel } from '../types/deal'
import { dealListAssignments } from '../lib/dealPromptYaml'
import { detectFileColumns, pastedListToCsv } from '../lib/fileColumns'
import { uploadOne } from '../lib/uploadFile'
import { uniqueLogicalName } from '../lib/files'
import { FormSection } from './FormSection'
import { StandardListLibrary } from './StandardListLibrary'
import { createStandardList } from '../lib/lists'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
// #238: only the formats the SSP extractors actually parse. .tsv/.txt/.xls
// used to be accepted here (and server-side), then failed mid-batch at the
// SSP MCP — the server upload allowlist (upload.go) now matches this exactly,
// so the format problem surfaces at upload, not after the batch is live.
const ACCEPTED_EXTS = ['.csv', '.xlsx']

function countDealsForDomainFile(form: DealForm): number {
  // OTT now reaches desktop and web, so it counts toward the domain pool as
  // well as the app-bundle one (see listChannelRouting). CTV stays app-only.
  return form.deals.filter(d => d.channel && d.channel !== 'CTV' && d.channel !== 'Audio' && (d.channel === 'OTT' || d.inventoryType !== 'In-App' || form.defaultInventoryType !== 'In-App')).length
}

function countDealsForAppBundleFile(form: DealForm): number {
  return form.deals.filter(d => {
    const inv = d.inventoryType || form.defaultInventoryType
    return d.channel && (d.channel === 'CTV' || d.channel === 'OTT' || inv === 'In-App' || (isVideoChannel(d.channel) && inv !== 'Web Only'))
  }).length
}

interface Props {
  form: DealForm
  update: <K extends keyof DealForm>(key: K, val: DealForm[K]) => void
  /** Standard-list library — used to compute, per file, which deals it
   *  actually reaches. */
  standardLists?: StandardList[]
  open?: boolean
  onToggle?: (next: boolean) => void
  filled?: number
  total?: number
  issues?: number
  /** Section heading overrides so the component can be reused outside the
   *  workspace (e.g. the Pending review modal) without the workspace number. */
  number?: string
  title?: string
}

interface Pending {
  id: string
  name: string
  size: number
  progress: number
  error?: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DropZone({
  label, files, pending, scopeNoun, deals, dealToggles, onAssignToggle, onFiles, onPaste, onRemove, onTypeChange, onColumnChange, onSaveAsStandard,
}: {
  label: string
  files: UploadedFile[]
  pending: Pending[]
  scopeNoun: string
  /** Deal cards (labels only) — length gates the chips row. */
  deals: { id: string; label: string }[]
  /** Per-file assignment chips: checked = this file ships with that deal —
   *  the SAME wire-exact state the deal cards show. Disabled entries can't
   *  take this file kind (channel routing). */
  dealToggles: (fileId: string) => { id: string; label: string; checked: boolean; disabled: boolean; title?: string }[]
  /** Toggle a deal's assignment: on = assign this file to the deal (explicit
   *  per-deal pick), off = opt the deal out of this list kind. */
  onAssignToggle: (fileId: string, dealId: string, next: boolean) => void
  onFiles: (files: FileList) => void
  onPaste: (name: string, text: string, type: 'Include' | 'Exclude') => void
  onRemove: (id: string) => void
  onTypeChange: (id: string, type: 'Include' | 'Exclude') => void
  onColumnChange: (id: string, column: string) => void
  onSaveAsStandard: (file: UploadedFile) => void

}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteName, setPasteName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pasteType, setPasteType] = useState<'Include' | 'Exclude'>('Include')

  const submitPaste = () => {
    if (!pasteText.trim()) return
    onPaste(pasteName.trim(), pasteText, pasteType)
    setPasteName('')
    setPasteText('')
    setPasteType('Include')
    setPasteOpen(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
  }

  return (
    <div className="field-group">
      <span className="field-label">{label}</span>
      <div
        className={`file-upload-dropzone${dragOver ? ' drag-over' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={`Upload ${label}`}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTS.join(',')}
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) onFiles(e.target.files) }}
        />
        <div className="dropzone-content">
          <svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
          <span className="dropzone-text">
            Drag & drop or <button type="button" className="dropzone-browse-btn" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>browse</button>
          </span>
          <span className="dropzone-hint">Accepts {ACCEPTED_EXTS.join(', ')} — up to 100 MB each</span>
        </div>

        {(pending.length > 0 || files.length > 0) && (
          <div className="file-list" onClick={e => e.stopPropagation()}>
            {pending.map(p => (
              <div key={p.id} className={`file-item${p.error ? ' file-item--error' : ''}`}>
                <span className="file-item-name" title={p.name}>{p.name}</span>
                <span className="file-item-size">{formatSize(p.size)}</span>
                <div className="file-item-progress" aria-label={`Uploading ${p.progress}%`}>
                  {p.error ? (
                    <span className="file-item-error-text">{p.error}</span>
                  ) : (
                    <>
                      <div className="file-item-progress-bar">
                        <div className="file-item-progress-fill" style={{ width: `${p.progress}%` }} />
                      </div>
                      <span className="file-item-progress-text">{p.progress}%</span>
                    </>
                  )}
                </div>
              </div>
            ))}
            {files.map(f => (
              <div key={f.id}>
              <div className="file-item">
                <span className="file-item-name" title={f.name}>{f.name}</span>
                <span className="file-item-size">{formatSize(f.size)}</span>
                {f.headers && f.headers.length > 0 ? (
                  <div className="file-item-type">
                    <select
                      className="field-select"
                      style={{ minHeight: '2rem', fontSize: 'var(--font-size-caption)' }}
                      value={f.detectedColumn || ''}
                      onChange={e => onColumnChange(f.id, e.target.value)}
                      onClick={e => e.stopPropagation()}
                      aria-label={`Column for ${f.name}`}
                      title="Column inside the file holding the URLs or bundle IDs — the headerless option omits the column so every row (including the first) is read as a value"
                    >
                      {/* Explicit no-column state (issue #227): blank keeps the
                          column omitted. For a single-column file that means
                          headerless (row 0 is data, read every row); for a
                          multi-column file none was recognized — pick one, or on
                          CREATE cutlass split_rows silently uses column 0. */}
                      {!(f.detectedColumn || '').trim() && <option value="">{f.headers.length > 1 ? '(no column selected)' : '(no header — read every row)'}</option>}
                      {f.headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ) : (
                  // No headers = detection never ran or failed (e.g. an
                  // an attachment that couldn't be read back). Offer a
                  // free-text column so the trader can always state the
                  // file's value column; blank = column omitted (headerless).
                  <div className="file-item-type">
                    <input
                      type="text"
                      className="field-input"
                      style={{ minHeight: '2rem', fontSize: 'var(--font-size-caption)', maxWidth: '9rem' }}
                      value={f.detectedColumn || ''}
                      onChange={e => onColumnChange(f.id, e.target.value)}
                      onClick={e => e.stopPropagation()}
                      placeholder="Column (blank = headerless)"
                      aria-label={`Column for ${f.name}`}
                      title="Column inside the file holding the URLs or bundle IDs — left blank, the prompt omits the column and the file is read as a headerless list (every row is a value)"
                    />
                  </div>
                )}
                <div className="file-item-type">
                  <select
                    className="field-select"
                    style={{ minHeight: '2rem', fontSize: 'var(--font-size-caption)' }}
                    value={f.inclusionType}
                    onChange={e => onTypeChange(f.id, e.target.value as 'Include' | 'Exclude')}
                    onClick={e => e.stopPropagation()}
                    aria-label={`File type for ${f.name}`}
                  >
                    <option value="">Type…</option>
                    <option value="Include">Include</option>
                    <option value="Exclude">Exclude</option>
                  </select>
                </div>
                {f.path && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title="Save this file as a reusable standard list (shows in the picker above)"
                    onClick={e => { e.stopPropagation(); onSaveAsStandard(f) }}
                  >
                    Save as standard
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Remove ${f.name}`}
                  onClick={e => { e.stopPropagation(); onRemove(f.id) }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Say exactly what the prompt will do when no column is set
                  (the 2026-06-30 mistarget was a silent default landing unseen;
                  the #227 data loss was a fabricated column). Fires for BOTH a
                  headerless/no-header file AND a multi-column file whose header
                  row matched no pattern (FIX 4) — in the latter, cutlass
                  split_rows silently picks column 0 on CREATE unless the trader
                  chooses, so tell them to pick it explicitly. */}
              {!(f.detectedColumn || '').trim() && (
                <p className="file-item-column-warning">
                  {(f.headers?.length || 0) > 1
                    ? 'Multiple columns and none recognized — pick the value column above, otherwise the deal prompt omits the column and the first column is used by default.'
                    : 'No value column detected — the deal prompt will omit the column and read the file as a headerless list (every row is a value, including the first). If this file has a real header row, set its column name above.'}
                </p>
              )}
              {/* Assignment chips — checked = ships with that deal, computed
                  from the SAME resolve() pipeline the prompts run and the deal
                  cards display. Toggling edits the real per-deal assignment
                  (explicit pick on, opt-out off), so this row and the deal
                  cards can never disagree. Replaces the legacy "Applies to"
                  inheritance filter, which explicit per-deal picks (e.g. every
                  parser-mapped deal) silently bypassed. */}
              {deals.length > 0 && (
                <div className="field-group" style={{ marginTop: 'var(--space-2)' }}>
                  <span className="field-label">
                    Ships with <span className="field-label__hint">checked = this list ships with that deal — same state as the deal cards</span>
                  </span>
                  <div className="chip-row" role="group" aria-label={`Deals shipping ${f.name}`}>
                    {dealToggles(f.id).map(d => (
                      <label
                        key={d.id}
                        className={`chip chip--toggle${d.checked ? ' is-checked' : ''}${d.disabled ? ' is-disabled' : ''}`}
                        title={d.title}
                      >
                        <input type="checkbox" checked={d.checked} disabled={d.disabled} onChange={() => onAssignToggle(f.id, d.id, !d.checked)} />
                        <span className="chip__check" aria-hidden="true">✓</span>
                        <span>{d.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual entry — paste a list instead of uploading a file. The pasted
          values become a synthesized one-column CSV that flows through the
          identical upload + column-detection path. */}
      {!pasteOpen ? (
        <button
          type="button"
          className="dropzone-browse-btn"
          style={{ marginTop: 'var(--space-2)' }}
          onClick={() => setPasteOpen(true)}
        >
          or paste a list of {scopeNoun}
        </button>
      ) : (
        <div className="paste-list-entry" style={{ marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <input
            type="text"
            className="field-input"
            value={pasteName}
            onChange={e => setPasteName(e.target.value)}
            placeholder={`List name (e.g. ${scopeNoun === 'domains' ? 'hispanic_news_domains' : 'ctv_app_bundles'})`}
            aria-label="Pasted list name"
          />
          <textarea
            className="field-input"
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            rows={5}
            placeholder={`Paste ${scopeNoun}, one per line (commas, tabs, or spaces also work)`}
            aria-label={`Pasted ${scopeNoun}`}
            style={{ fontFamily: 'var(--font-mono, monospace)', resize: 'vertical' }}
          />
          <div className="field-row" style={{ alignItems: 'center', gap: 'var(--space-2)' }}>
            <select
              className="field-select"
              style={{ minHeight: '2rem', fontSize: 'var(--font-size-caption)', maxWidth: '8rem' }}
              value={pasteType}
              onChange={e => setPasteType(e.target.value as 'Include' | 'Exclude')}
              aria-label="Pasted list type"
            >
              <option value="Include">Include</option>
              <option value="Exclude">Exclude</option>
            </select>
            <button type="button" className="btn btn-secondary btn-sm" onClick={submitPaste} disabled={!pasteText.trim()}>
              Add list
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPasteOpen(false); setPasteText(''); setPasteName('') }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function FileUploads({ form, update, open, onToggle, filled, total, issues, number = '06', title = 'File Uploads', standardLists }: Props) {
  const [pendingDomain, setPendingDomain] = useState<Pending[]>([])
  const [pendingApp, setPendingApp] = useState<Pending[]>([])
  const [listsReload, setListsReload] = useState(0)
  const [saveMsg, setSaveMsg] = useState('')

  // Promote an uploaded ad-hoc file into the reusable Standard Lists picker.
  // kind comes from the file's Include/Exclude type (allow/block); name from
  // the file name. On success the picker re-fetches and the list appears.
  const handleSaveAsStandard = async (scope: 'domain' | 'app_bundle', file: UploadedFile) => {
    if (!file.path) return
    const name = file.name.replace(/\.[^.]+$/, '')
    const kind: 'allow' | 'block' = file.inclusionType === 'Exclude' ? 'block' : 'allow'
    setSaveMsg('')
    try {
      const created = await createStandardList({ name, kind, scope, sourcePath: file.path })
      setListsReload(n => n + 1)
      // Auto-select the new list for this scope so it's applied right away.
      const key = scope === 'domain' ? 'appliedDomainListIds' : 'appliedAppBundleListIds'
      update(key, [...form[key], created.id])
      setSaveMsg(`Saved "${created.name}" to standard ${scope === 'domain' ? 'domain' : 'app bundle'} lists.`)
    } catch (err: unknown) {
      setSaveMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAdd = (key: 'domainLists' | 'appBundleLists', fileList: FileList) =>
    addFiles(key, Array.from(fileList))

  // Manual paste → synthesize a one-column CSV File and run it through the
  // identical upload + detection path so a pasted list is indistinguishable
  // from an uploaded one downstream (same UploadedFile shape, same prompt YAML).
  const handlePaste = (key: 'domainLists' | 'appBundleLists', name: string, text: string, type: 'Include' | 'Exclude') => {
    const scope: 'domain' | 'app_bundle' = key === 'domainLists' ? 'domain' : 'app_bundle'
    const { csv, count } = pastedListToCsv(text, scope)
    if (count === 0) return
    const base = (name || `pasted-${scope === 'domain' ? 'domains' : 'app-bundles'}`).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_|_$/g, '') || 'pasted-list'
    const file = new File([csv], `${base}.csv`, { type: 'text/csv' })
    void addFiles(key, [file], type)
  }

  const addFiles = async (key: 'domainLists' | 'appBundleLists', files: File[], inclusionType?: 'Include' | 'Exclude') => {
    const setPending = key === 'domainLists' ? setPendingDomain : setPendingApp
    const scope: 'domain' | 'app_bundle' = key === 'domainLists' ? 'domain' : 'app_bundle'
    // Dedupe each attachment's LOGICAL name against everything the submission
    // will carry (#282.2): both upload lists ride the same submit, and
    // deal_brief.json is reserved for the structured brief — fleet 400s the
    // whole create on a duplicate logical file name. Deterministic rename
    // (name-2.csv) keeps the prompt/brief/fileNames consistent since they all
    // read the stored name.
    const usedNames = new Set([...form.domainLists, ...form.appBundleLists].map(f => f.name))

    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        const tempId = `err-${Date.now()}-${Math.random()}`
        setPending(p => [...p, { id: tempId, name: file.name, size: file.size, progress: 0, error: `Too large (${formatSize(file.size)} > 100 MB max)` }])
        setTimeout(() => setPending(p => p.filter(x => x.id !== tempId)), 6000)
        continue
      }
      const tempId = `tmp-${Date.now()}-${Math.random()}`
      setPending(p => [...p, { id: tempId, name: file.name, size: file.size, progress: 0 }])
      try {
        // Run upload + header detection in parallel — detection is
        // client-side (SheetJS), so it doesn't block the network write.
        const [uploaded, columns] = await Promise.all([
          uploadOne(file, pct => {
            setPending(p => p.map(x => x.id === tempId ? { ...x, progress: pct } : x))
          }),
          detectFileColumns(file, scope),
        ])
        setPending(p => p.filter(x => x.id !== tempId))
        const logicalName = uniqueLogicalName(uploaded.name, usedNames)
        usedNames.add(logicalName)
        update(key, [...form[key], { ...uploaded, name: logicalName, headers: columns.headers, detectedColumn: columns.detected, inclusionType: inclusionType ?? uploaded.inclusionType }])
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        setPending(p => p.map(x => x.id === tempId ? { ...x, error: message } : x))
        setTimeout(() => setPending(p => p.filter(x => x.id !== tempId)), 6000)
      }
    }
  }

  // Removing a file must also clear every deal's explicit pick of it —
  // otherwise the deal keeps a stale id that the prompt resolver deliberately
  // treats as "no list" (never a surprise fallback), and the batch would
  // create with zero scoping while other uploads still ship (the DEAL07253
  // E2E failure, 2026-07-20; the Go audit's list_ref rule now also fails
  // closed on any stale pick that slips through).
  const removeFile = (key: 'domainLists' | 'appBundleLists', id: string) => {
    update(key, form[key].filter(f => f.id !== id))
    const [listKey, incKey] = key === 'domainLists'
      ? (['domainListId', 'domainListInclusion'] as const)
      : (['appBundleListId', 'appBundleListInclusion'] as const)
    if (form.deals.some(d => d[listKey] === id)) {
      update('deals', form.deals.map(d =>
        d[listKey] === id ? { ...d, [listKey]: undefined, [incKey]: undefined } : d
      ))
    }
  }

  const setType = (key: 'domainLists' | 'appBundleLists', id: string, type: 'Include' | 'Exclude') => {
    update(key, form[key].map(f => f.id === id ? { ...f, inclusionType: type } : f))
  }

  const setColumn = (key: 'domainLists' | 'appBundleLists', id: string, column: string) => {
    update(key, form[key].map(f => f.id === id ? { ...f, detectedColumn: column } : f))
  }

  const dealChips = form.deals.map((d, i) => ({
    id: d.id,
    label: `${d.theme.trim() || `Deal ${i + 1}`}${d.channel ? ` · ${d.channel.replace(' (Online Video)', '')}` : ''}${d.ssp ? ` · ${d.ssp}` : ''}`,
  }))

  const domainDealCount = countDealsForDomainFile(form)
  const appDealCount = countDealsForAppBundleFile(form)

  // Wire-exact assignment state per (deal, dimension) — the same
  // dealListAssignments the deal cards render, computed once per form change.
  const perDeal = useMemo(
    () => form.deals.map(d => dealListAssignments(form, d, standardLists ?? [])),
    [form, standardLists],
  )

  const dealToggles = (scope: 'domain' | 'app_bundle') => (fileId: string) =>
    form.deals.map((d, i) => {
      const dim = scope === 'domain' ? perDeal[i].domain : perDeal[i].app_bundle
      const kindLabel = scope === 'domain' ? 'site lists' : 'app-bundle lists'
      return {
        id: d.id,
        label: dealChips[i].label,
        checked: dim.ships && dim.file?.id === fileId,
        disabled: !dim.ships,
        title: !dim.ships
          ? `${d.channel ? d.channel.replace(' (Online Video)', '') + ' deals' : 'This deal'} can't take ${kindLabel}${d.ssp === 'OpenX' ? '' : ' (channel routing)'}`
          : undefined,
      }
    })

  // Toggle the REAL assignment: on = explicit per-deal pick of this file,
  // off = explicit opt-out ('' — same as the deal card's ✕). Clears the
  // per-deal allow/block override either way so a stale override can't
  // apply to a different list.
  const setAssignment = (scope: 'domain' | 'app_bundle', fileId: string, dealId: string, next: boolean) => {
    update('deals', form.deals.map(d => {
      if (d.id !== dealId) return d
      return scope === 'domain'
        ? { ...d, domainListId: next ? fileId : '', domainListInclusion: undefined }
        : { ...d, appBundleListId: next ? fileId : '', appBundleListInclusion: undefined }
    }))
  }

  return (
    <FormSection number={number} title={title} anchorId="section-files" open={open} onToggle={onToggle} filled={filled} total={total} issues={issues}>
      <p className="field-helper" style={{ margin: 0 }}>
        The batch's list library. Files land here from the assistant chat or a direct upload;
        applying one here reaches every matching deal, and each deal card's <strong>Domains &amp; app bundles</strong> row
        shows (and can override) exactly what ships with that deal.
      </p>
      {saveMsg && <p className="field-helper" style={{ color: 'var(--color-text-secondary)' }}>{saveMsg}</p>}
      <StandardListLibrary
        form={form}
        update={update}
        reloadKey={listsReload}
      />
      <DropZone
        label={`Domain Lists${domainDealCount > 0 ? ` — applies to ${domainDealCount} deal${domainDealCount !== 1 ? 's' : ''}` : ''}`}
        files={form.domainLists}
        pending={pendingDomain}
        scopeNoun="domains"
        deals={dealChips}
        dealToggles={dealToggles('domain')}
        onAssignToggle={(fid, did, next) => setAssignment('domain', fid, did, next)}
        onFiles={fl => void handleAdd('domainLists', fl)}
        onPaste={(name, text, type) => handlePaste('domainLists', name, text, type)}
        onRemove={id => removeFile('domainLists', id)}
        onTypeChange={(id, t) => setType('domainLists', id, t)}
        onColumnChange={(id, c) => setColumn('domainLists', id, c)}
        onSaveAsStandard={f => void handleSaveAsStandard('domain', f)}
      />
      <DropZone
        label={`App Bundle Lists${appDealCount > 0 ? ` — applies to ${appDealCount} deal${appDealCount !== 1 ? 's' : ''}` : ''}`}
        files={form.appBundleLists}
        pending={pendingApp}
        scopeNoun="app bundle IDs"
        deals={dealChips}
        dealToggles={dealToggles('app_bundle')}
        onAssignToggle={(fid, did, next) => setAssignment('app_bundle', fid, did, next)}
        onFiles={fl => void handleAdd('appBundleLists', fl)}
        onPaste={(name, text, type) => handlePaste('appBundleLists', name, text, type)}
        onRemove={id => removeFile('appBundleLists', id)}
        onTypeChange={(id, t) => setType('appBundleLists', id, t)}
        onColumnChange={(id, c) => setColumn('appBundleLists', id, c)}
        onSaveAsStandard={f => void handleSaveAsStandard('app_bundle', f)}
      />
    </FormSection>
  )
}

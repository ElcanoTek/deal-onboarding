import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { FormData } from '../types/deal'
import { mergeParsedIntoForm, spreadsheetToText } from '../lib/dealParser'
import { extractDocxText, isDocx } from '../lib/docx'
import { SAMPLE_BRIEFS } from '../lib/sampleBriefs'
import { ChatModelPicker, useChatModel } from './ChatModelPicker'

interface Props {
  currentForm: FormData
  onClose: () => void
  onApply: (next: FormData, appliedFields: string[]) => void
  onError: (message: string) => void
  /** Default country for geo-less parsed deals (lib/geoPolicy.ts); unset →
   *  the US house default. */
  defaultGeoCountry?: string | null
}

const PLACEHOLDER = `Paste anything — a trader brief, an email, a Slack message, a deal name, or a spreadsheet excerpt. Example:

DataCo_Index_Amazon_Northwind Media_Contoso_NA_Cold and Flu_Display_All_US_DEAL00130_B14

Name of Submitter: Jane Doe
Email of Submitter: jane.doe@example.com
Agency: Northwind Media
Flight Dates: 4/13/2026 - 12/31/2026
Amazon DSP, seat: AMZNPU55BHZCP31W
Preferred SSP: Index
Geo: US
Bid floor: 0.10
Targeting:
  Health > Current > Cough and Cold Symptoms
  Health > Current > Airborne Virus Symptoms`

export function DealParserModal({ currentForm, onClose, onApply, onError, defaultGeoCountry }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const trapRef = useFocusTrap<HTMLDivElement>({ onEscape: () => { if (!busy) onClose() } })
  const [fileName, setFileName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  // The parser keeps its own persisted pick; '' = let the server resolve
  // OPENROUTER_MODEL / its built-in default.
  const [model, setModel] = useChatModel('deal-onboarding-parser-model', '')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the composer textarea like the chat inputs, with parser-sized
  // headroom (briefs are long).
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 380)}px`
  }, [text])

  const ingestFile = async (file: File) => {
    setFileName(file.name)
    try {
      const isSheet = /\.(xlsx|xls|csv)$/i.test(file.name)
      let fileText: string
      if (isDocx(file.name)) {
        fileText = await extractDocxText(file)
      } else if (isSheet) {
        fileText = await spreadsheetToText(file)
      } else {
        fileText = await file.text()
      }
      setText(t => t.trim() ? `${t}\n\n${fileText}` : fileText)
    } catch (err) {
      onError(`Could not read file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await ingestFile(file)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (busy) return
    const file = e.dataTransfer.files?.[0]
    if (file) await ingestFile(file)
  }

  const handleParse = async () => {
    const trimmed = text.trim()
    if (!trimmed) {
      onError('Paste some deal data or attach a spreadsheet first.')
      return
    }
    setBusy(true)
    try {
      const payload: Record<string, string> = { text: trimmed }
      if (model) payload.model = model
      const res = await fetch('/api/parse-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        onError(body?.error || `Parser request failed (${res.status})`)
        return
      }
      const merged = mergeParsedIntoForm(currentForm, body.form || {}, defaultGeoCountry)
      if (merged.appliedFields.length === 0) {
        onError('The parser could not extract any recognizable fields from that text.')
        return
      }
      onApply(merged.form, merged.appliedFields)
    } catch (err) {
      onError(`Parse failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="parser-modal-title"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="modal modal--wide" ref={trapRef}>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm modal-close"
          aria-label="Close parser"
          onClick={onClose}
          disabled={busy}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <h2 className="modal-title" id="parser-modal-title">Parse Deal Data</h2>
        <p className="modal-body" style={{ marginBottom: 'var(--space-3)' }}>
          Paste a trader's brief, an email, a deal name, or drop a spreadsheet — the parser extracts every field it can identify into the form. Fields you've already filled stay unless the parser finds something specific. Calls run through your OpenRouter key.
        </p>

        {SAMPLE_BRIEFS.length > 0 && (
          <div className="parser-samples" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="field-label" style={{ marginRight: 'var(--space-2)' }}>Try a sample brief:</span>
            {SAMPLE_BRIEFS.map(sample => (
              <button
                key={sample.id}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setText(sample.text)}
                disabled={busy}
                title={sample.description}
                style={{ marginRight: 'var(--space-2)' }}
              >
                {sample.label}
              </button>
            ))}
          </div>
        )}

        {/* The chat-composer language everywhere text meets a model: textarea
            on the surface, model picker + paperclip in the toolbar, arrow-up
            send. Files drop anywhere on the composer and append as text. */}
        <div
          className={`chat-composer parser-composer${dragOver ? ' chat-composer--dragover' : ''}`}
          onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { void handleDrop(e) }}
        >
          {dragOver && (
            <div className="chat-composer__overlay" aria-hidden="true">
              <span>Drop to append</span>
            </div>
          )}
          <textarea
            ref={textRef}
            className="chat-composer__input"
            rows={6}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            disabled={busy}
            aria-label="Deal data text"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,.txt,.docx"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            disabled={busy}
          />
          <div className="chat-composer__row">
            <div className="chat-composer__tools">
              <ChatModelPicker value={model} onPick={setModel} disabled={busy} serverDefaultOption />
              <span className="chat-composer__divider" aria-hidden="true" />
              <button
                type="button"
                className="chat-composer__toolbtn"
                aria-label="Attach a spreadsheet, Word doc, or text file — appended to the text"
                title="Attach .csv / .xlsx / .xls / .txt / .docx — appended to the text"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons/core-icons.svg#paperclip" /></svg>
              </button>
              {fileName && <span className="parser-attach-name">Loaded: {fileName}</span>}
            </div>
            <div className="chat-composer__actions">
              <button
                type="button"
                className={`chat-composer__send-circle${text.trim() && !busy ? ' is-ready' : ''}`}
                aria-label="Parse and fill the form"
                title={busy ? 'Reading your text…' : 'Parse & fill form'}
                onClick={handleParse}
                disabled={busy || !text.trim()}
              >
                {busy
                  ? <span className="btn-spinner" aria-hidden="true" />
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons/core-icons.svg#arrow-up" /></svg>}
              </button>
            </div>
          </div>
        </div>
        <p className="chat-composer__hint is-visible" aria-hidden="true">
          {busy ? 'Reading your text…' : 'Drop or attach files to append their text · parse fills the form without clearing what you typed'}
        </p>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

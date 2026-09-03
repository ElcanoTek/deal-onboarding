// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { fileBasename } from '../lib/files'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatUploadedFile, DealChatChange, DealChatMessage, openDealChatStream } from '../lib/dealChatApi'
import { parseSseChunk } from '../lib/sse'
import { detectFileColumns } from '../lib/fileColumns'
import { hydrateForm } from '../hooks/useFormState'
import { seedNewDealsGeo } from '../lib/geoPolicy'
import { AuditResult, FormData as DealFormData } from '../types/deal'
import { AppliedSnapshot, applyProposal, AssistantProposal, buildProposalDiff, undoApplied } from '../lib/assistantProposal'
import { LoadingLogo } from './LoadingLogo'
import { ChatModelPicker, useChatModel } from './ChatModelPicker'

/** A line the parent posts into the conversation (e.g. the re-audit result
 *  after an applied edit). Deduped by id. */
export interface ChatNotice {
  id: string
  text: string
}

interface Props {
  /** The current populated form (the live draft). Sent with every turn so the
   *  assistant edits on top of accumulated changes. */
  form: DealFormData
  /** Called ONLY when the trader clicks Apply on a proposed edit (or Undo) —
   *  the chat never mutates the form without confirmation. */
  onFormChange: (form: DealFormData) => void
  /** The latest audit response for this form, forwarded with every turn so
   *  the assistant sees exactly which checks fail. */
  audit?: AuditResult | null
  /** Seed the composer with this text (a "Fix with assistant" hand-off). A new
   *  nonce re-applies the same text. */
  prefill?: { text: string; nonce: number } | null
  /** Bumping this clears the conversation (submit / reset). */
  resetToken?: number
  /** Lines the parent posts into the conversation (applied-edit results). */
  notices?: ChatNotice[]
  /** Fires after Apply with the number of deals that changed. */
  onApplied?: (dealsChanged: number) => void
  /** Fires whenever a new assistant turn lands — the dock uses it for the
   *  unread indicator while minimized. */
  onActivity?: () => void
  /** Lifts streaming state so the parent can disable actions mid-stream. */
  onStreamingChange?: (streaming: boolean) => void
  disabled?: boolean
  /** Rendered inside the dock: the dock supplies the header, so the chat's
   *  own is hidden and it stretches to fill. */
  embedded?: boolean
}

interface ChatMsg {
  id: number
  role: 'user' | 'assistant' | 'error' | 'notice'
  content: string
  changes?: DealChatChange[]
  streaming?: boolean
  /** A proposed form rewrite awaiting Apply / Discard. */
  proposal?: AssistantProposal
  proposalState?: 'pending' | 'applied' | 'discarded'
}

const CHAT_STORAGE_KEY = 'deal-onboarding-assistant-chat-v1'
const SEND_ON_ENTER_KEY = 'deal-onboarding-chat-send-on-enter'

let msgSeq = 1

/** Restore the persisted conversation (browser session only). Proposals are
 *  not persisted — an unconfirmed edit dies with the page; the trader asks
 *  again against the current form. */
function loadStoredMessages(): ChatMsg[] {
  try {
    const raw = sessionStorage.getItem(CHAT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { role: ChatMsg['role']; content: string; changes?: DealChatChange[] }[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'notice') && typeof m.content === 'string')
      .map(m => ({ id: msgSeq++, role: m.role, content: m.content, changes: m.changes }))
  } catch {
    return []
  }
}

function storeMessages(messages: ChatMsg[]): void {
  try {
    const slim = messages
      .filter(m => !m.streaming && m.role !== 'error' && m.content.trim() !== '')
      .map(m => ({ role: m.role, content: m.content, changes: m.changes }))
    sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(slim))
  } catch { /* session-only */ }
}

/** Streaming, conversational deal-editing chat — the engine behind the Deal
 *  Assistant dock. The assistant streams prose and, when it changes the
 *  deals, emits a form.update that renders as a DIFF PREVIEW; the form only
 *  changes when the trader clicks Apply (one level of Undo is kept). */
export function DealChat({ form, onFormChange, audit, prefill, resetToken, notices, onApplied, onActivity, onStreamingChange, disabled, embedded }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>(loadStoredMessages)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  // Files the trader attached via the paperclip, pending the next send. Each is
  // already uploaded; the message tells the assistant where to apply it.
  const [attached, setAttached] = useState<ChatUploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  // Composer drag-and-drop: a counter ref keeps nested dragenter/dragleave
  // bubbling from flickering the drop state.
  const [dragOver, setDragOver] = useState(false)
  const [model, setModel] = useChatModel()
  // Send-key preference: Enter sends (default) or Ctrl/Cmd+Enter.
  const [sendOnEnter, setSendOnEnter] = useState(() => {
    try { return localStorage.getItem(SEND_ON_ENTER_KEY) !== '0' } catch { return true }
  })
  const [composerFocused, setComposerFocused] = useState(false)
  // One-level undo of the last applied proposal.
  const [lastApplied, setLastApplied] = useState<AppliedSnapshot | null>(null)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const seenNoticeIds = useRef<Set<string>>(new Set())
  // Keep the latest form/audit in refs so an in-flight send always reads the
  // live draft without re-binding the callback.
  const formRef = useRef(form)
  formRef.current = form
  const auditRef = useRef(audit)
  auditRef.current = audit

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight })
    storeMessages(messages)
  }, [messages])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Reset (submit / start fresh): the conversation is per batch.
  const lastResetToken = useRef(resetToken)
  useEffect(() => {
    if (resetToken === lastResetToken.current) return
    lastResetToken.current = resetToken
    abortRef.current?.abort()
    setMessages([])
    setLastApplied(null)
    setInput('')
    try { sessionStorage.removeItem(CHAT_STORAGE_KEY) } catch { /* ignore */ }
  }, [resetToken])

  // "Fix with assistant" hand-off: seed the composer and focus it.
  useEffect(() => {
    if (!prefill || !prefill.text) return
    setInput(prefill.text)
    window.setTimeout(() => inputRef.current?.focus(), 50)
  }, [prefill?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Parent-posted lines (the re-audit result after an applied edit).
  useEffect(() => {
    if (!notices || notices.length === 0) return
    const fresh = notices.filter(n => !seenNoticeIds.current.has(n.id))
    if (fresh.length === 0) return
    for (const n of fresh) seenNoticeIds.current.add(n.id)
    setMessages(ms => [...ms, ...fresh.map(n => ({ id: msgSeq++, role: 'notice' as const, content: n.text }))])
  }, [notices])

  // Auto-grow the textarea with its content, capped at 13rem (208px).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`
  }, [input])

  const patch = (id: number, fn: (m: ChatMsg) => ChatMsg) =>
    setMessages(ms => ms.map(m => (m.id === id ? fn(m) : m)))

  // Upload an attached file + detect its column so the assistant gets a clean
  // {id,name,path,detectedColumn} to fold into the form.
  const attachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        const [resp, cols] = await Promise.all([
          fetch('/api/upload', { method: 'POST', body: fd }),
          detectFileColumns(file, 'domain').catch(() => ({ headers: [] as string[], detected: undefined as string | undefined })),
        ])
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          setMessages(ms => [...ms, { id: msgSeq++, role: 'error', content: `Upload failed for ${file.name}: ${body?.error || resp.status}` }])
          continue
        }
        const b = await resp.json()
        setAttached(a => [...a, { id: b.id, name: b.name, size: b.size, path: b.path, detectedColumn: cols.detected, headers: cols.headers }])
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }
  const removeAttached = (id: string) => setAttached(a => a.filter(f => f.id !== id))

  const toggleSendOnEnter = () => {
    setSendOnEnter(v => {
      try { localStorage.setItem(SEND_ON_ENTER_KEY, v ? '0' : '1') } catch { /* session-only */ }
      return !v
    })
  }

  const applyMessageProposal = (id: number) => {
    const msg = messages.find(m => m.id === id)
    if (!msg?.proposal || msg.proposalState !== 'pending') return
    const snapshot = applyProposal(formRef.current, msg.proposal, onFormChange)
    setLastApplied(snapshot)
    patch(id, m => ({ ...m, proposalState: 'applied' }))
    onApplied?.(snapshot.dealsChanged)
  }
  const discardMessageProposal = (id: number) => {
    patch(id, m => ({ ...m, proposalState: 'discarded' }))
  }
  const undoLastApply = () => {
    if (!lastApplied) return
    undoApplied(lastApplied, onFormChange)
    setLastApplied(null)
    setMessages(ms => [...ms, { id: msgSeq++, role: 'notice', content: 'Undid the last applied edit — the form is back to how it was before Apply.' }])
  }

  const send = async (text: string) => {
    const trimmed = text.trim()
    if ((!trimmed && attached.length === 0) || streaming || disabled) return

    const sending = attached
    // The model gets a clean instruction; if the trader only attached a file
    // without typing, give it a default cue (it's coached to ask if unclear).
    const instruction = trimmed || `Attached ${sending.map(f => fileBasename(f.name)).join(', ')} — add to the deals as instructed.`
    const attachNote = sending.length > 0 ? `  \n📎 ${sending.map(f => fileBasename(f.name)).join(', ')}` : ''
    const userMsg: ChatMsg = { id: msgSeq++, role: 'user', content: (trimmed || instruction) + attachNote }
    const assistantId = msgSeq++
    // Conversation history for the model: prior user/assistant text turns + this one.
    const convo: DealChatMessage[] = [
      ...messages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: instruction },
    ]

    setMessages(ms => [...ms, userMsg, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    setInput('')
    setAttached([])
    setStreaming(true)
    onStreamingChange?.(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const resp = await openDealChatStream(
        { messages: convo, form: formRef.current, audit: auditRef.current ?? undefined, uploadedFiles: sending.length > 0 ? sending : undefined, model },
        ctrl.signal,
      )
      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, remainder } = parseSseChunk(buffer)
        buffer = remainder
        for (const ev of events) {
          let payload: Record<string, unknown> = {}
          try {
            payload = JSON.parse(ev.data)
          } catch {
            continue
          }
          if (ev.event === 'text.delta') {
            const text = String(payload.text ?? '')
            patch(assistantId, m => ({ ...m, content: m.content + text }))
          } else if (ev.event === 'form.update') {
            const nextForm = payload.form as Partial<DealFormData> | undefined
            const changes = (payload.changes as DealChatChange[]) || []
            const summary = String(payload.summary ?? '')
            const validation = Array.isArray(payload.validation) ? (payload.validation as string[]) : []
            // Hydrate the raw LLM form: /api/deal/chat returns it as an
            // unvalidated object, so deals can be missing defaults.
            // hydrateForm fills them; the geo policy then seeds the house
            // default country onto any GENUINELY-NEW geo-less deal the model
            // invented (a trader's deleted geo chip on an existing deal
            // stays deleted). Nothing is applied yet — the trader confirms.
            const proposal: AssistantProposal | undefined = nextForm
              ? { form: seedNewDealsGeo(formRef.current.deals, hydrateForm(nextForm)), summary, changes, validation }
              : undefined
            patch(assistantId, m => ({
              ...m,
              changes,
              content: m.content.trim() ? m.content : summary,
              proposal,
              proposalState: proposal ? 'pending' : undefined,
            }))
          } else if (ev.event === 'error') {
            const message = String(payload.message ?? 'chat error')
            patch(assistantId, m => ({ ...m, role: 'error', content: message, streaming: false }))
          }
        }
      }
    } catch (err: unknown) {
      if (!ctrl.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        patch(assistantId, m => ({ ...m, role: 'error', content: message, streaming: false }))
      }
    } finally {
      setStreaming(false)
      onStreamingChange?.(false)
      patch(assistantId, m => (m.streaming ? { ...m, streaming: false } : m))
      abortRef.current = null
      onActivity?.()
    }
  }

  return (
    <section className={`assistant-chat${embedded ? ' assistant-chat--embedded' : ''}`}>
      {!embedded && (
        <div className="assistant-chat__header">
          <h3 className="assistant-chat__title" style={{ margin: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem', marginRight: 'var(--space-2)', verticalAlign: '-2px' }} aria-hidden="true">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            Deal Assistant
          </h3>
          <span className="assistant-chat__hint">Ask a question, or tell the assistant how to adjust the deals — edits show as a diff you confirm.</span>
        </div>
      )}

      <div className="assistant-chat__history" ref={historyRef} role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="assistant-chat__bubble assistant-chat__bubble--assistant assistant-intro">
            Bulk-edit the deal matrix in plain English (<em>“set CPM to 12 on every CTV deal”</em>, <em>“drop OpenX from all deals”</em>),
            ask what an audit rule means, or use <strong>Fix with assistant</strong> on any failing audit row. Every edit shows a diff
            you <strong>Apply</strong> or <strong>Discard</strong> — nothing changes until you confirm.
          </div>
        )}
        {messages.map(m => {
            if (m.role === 'user') {
              return <div key={m.id} className="assistant-chat__bubble assistant-chat__bubble--user">{m.content}</div>
            }
            if (m.role === 'error') {
              return <div key={m.id} className="assistant-chat__bubble assistant-chat__bubble--error">{m.content}</div>
            }
            if (m.role === 'notice') {
              return <div key={m.id} className="assistant-notice" role="status">{m.content}</div>
            }
            const hasContent = m.content.trim() !== '' || (m.changes?.length ?? 0) > 0 || !!m.proposal
            const diff = m.proposal ? buildProposalDiff(formRef.current, m.proposal) : null
            return (
              <div key={m.id} className="assistant-chat__turn">
                {/* Thinking cue: the orbital logo + shimmer label, crossfading
                    out as the first token streams in. */}
                <ThinkingIndicator active={!!m.streaming && !hasContent} />
                {hasContent && (
                  <div className="assistant-chat__bubble assistant-chat__bubble--assistant">
                    <div className="assistant-chat__markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                    {m.proposal && diff && (
                      <div className={`assistant-proposal assistant-proposal--${m.proposalState ?? 'pending'}`} role="group" aria-label="Proposed edit">
                        <div className="assistant-proposal__head">
                          <span className="assistant-proposal__title">
                            {m.proposalState === 'applied' ? 'Applied' : m.proposalState === 'discarded' ? 'Discarded' : 'Proposed edit'}
                          </span>
                          <span className="assistant-proposal__meta">
                            {diff.dealsBefore === diff.dealsAfter
                              ? `${diff.dealsAfter} deal${diff.dealsAfter === 1 ? '' : 's'}`
                              : `${diff.dealsBefore} → ${diff.dealsAfter} deals`}
                            {' · '}{diff.dealsChanged} changed
                          </span>
                        </div>
                        {diff.rows.length > 0 ? (
                          <ul className="assistant-proposal__rows">
                            {diff.rows.map((r, i) => (
                              <li key={i}><span className="assistant-proposal__scope">{r.scope}</span> {r.description}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="assistant-proposal__empty">The assistant returned a rewritten form without listing changes — review the deals before applying.</p>
                        )}
                        {m.proposal.validation.length > 0 && (
                          <ul className="assistant-proposal__validation" role="alert">
                            {m.proposal.validation.map((v, i) => <li key={i}>{v}</li>)}
                          </ul>
                        )}
                        {m.proposalState === 'pending' && (
                          <div className="assistant-proposal__actions">
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => applyMessageProposal(m.id)} disabled={disabled}>Apply</button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => discardMessageProposal(m.id)}>Discard</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
        })}
      </div>

      {lastApplied && (
        <div className="assistant-undo" role="status">
          <span>Last edit applied ({lastApplied.dealsChanged} deal{lastApplied.dealsChanged === 1 ? '' : 's'} changed).</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={undoLastApply} disabled={streaming}>Undo last apply</button>
        </div>
      )}

      {/* Composer: rounded surface with the textarea on top, attachment chips
          in a tray, and a bottom toolbar (paperclip left, Send right). Files
          drop anywhere on the composer or paste straight into the textarea. */}
      <form
        className={`chat-composer${dragOver ? ' chat-composer--dragover' : ''}`}
        onSubmit={e => { e.preventDefault(); void send(input) }}
        onDragEnter={e => {
          e.preventDefault()
          dragCounterRef.current += 1
          if (dragCounterRef.current === 1) setDragOver(true)
        }}
        onDragOver={e => { e.preventDefault() }}
        onDragLeave={() => {
          dragCounterRef.current -= 1
          if (dragCounterRef.current === 0) setDragOver(false)
        }}
        onDrop={e => {
          e.preventDefault()
          dragCounterRef.current = 0
          setDragOver(false)
          void attachFiles(e.dataTransfer.files)
        }}
      >
        {dragOver && (
          <div className="chat-composer__overlay" aria-hidden="true">
            <span>Drop to attach</span>
          </div>
        )}
        <textarea
          ref={inputRef}
          className="chat-composer__input"
          rows={1}
          aria-label="Message the assistant"
          placeholder="Message the assistant…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          onKeyDown={e => {
            // Send-key contract: Enter sends (Shift+Enter for a new line)
            // unless the ⏎ toggle switched to Ctrl/Cmd+Enter mode.
            // Ctrl/Cmd+Enter always sends in either mode.
            if (e.key !== 'Enter') return
            const modified = e.metaKey || e.ctrlKey
            if (modified || (sendOnEnter && !e.shiftKey)) {
              e.preventDefault()
              void send(input)
            }
          }}
          onPaste={e => {
            const files = e.clipboardData?.files
            if (files && files.length > 0) {
              e.preventDefault()
              void attachFiles(files)
            }
          }}
          disabled={streaming || disabled}
        />

        {attached.length > 0 && (
          <div className="chat-composer__tray">
            {attached.map(f => (
              <span
                key={f.id}
                className="chat-composer__chip"
                title={`${f.name}${f.detectedColumn ? ` · column: ${f.detectedColumn}` : ''}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#paperclip" /></svg>
                <span className="chat-composer__chip-name">{fileBasename(f.name)}</span>
                {typeof f.size === 'number' && f.size > 0 && (
                  <span className="chat-composer__chip-size">{formatBytes(f.size)}</span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeAttached(f.id)}
                  disabled={streaming || uploading}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </span>
            ))}
            <span className="chat-composer__tray-hint">
              Tell the assistant where to apply {attached.length === 1 ? 'it' : 'them'} (e.g. “domain blocklist for the Contextual deals”).
            </span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls"
          multiple
          style={{ display: 'none' }}
          onChange={e => {
            void attachFiles(e.target.files)
            e.target.value = ''
          }}
        />

        <div className="chat-composer__row">
          <div className="chat-composer__tools">
            <ChatModelPicker value={model} onPick={setModel} disabled={streaming || disabled} />
            <span className="chat-composer__divider" aria-hidden="true" />
            <button
              type="button"
              className="chat-composer__toolbtn"
              aria-label="Attach a site/app-bundle list"
              title="Attach a site/app-bundle list"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || disabled || uploading}
            >
              {uploading
                ? <span className="btn-spinner" aria-hidden="true" />
                : <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#paperclip" /></svg>}
            </button>
          </div>
          <div className="chat-composer__actions">
            {streaming && (
              <button type="button" className="chat-composer__stop" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            )}
            <button
              type="button"
              className={`chat-composer__toolbtn${sendOnEnter ? ' is-active' : ''}`}
              aria-label={sendOnEnter ? 'Send on Enter (click to switch to Ctrl+Enter)' : 'Send on Ctrl+Enter (click to switch to Enter)'}
              title={sendOnEnter ? 'Send on Enter' : 'Send on Ctrl+Enter'}
              aria-pressed={sendOnEnter}
              onClick={toggleSendOnEnter}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#return-key" /></svg>
            </button>
            <button
              type="submit"
              className={`chat-composer__send-circle${(input.trim() || attached.length > 0) && !streaming && !uploading ? ' is-ready' : ''}`}
              aria-label="Send message"
              title={uploading ? 'Uploading attachment…' : 'Send message'}
              disabled={streaming || disabled || uploading || (!input.trim() && attached.length === 0)}
            >
              {uploading
                ? <span aria-hidden="true">…</span>
                : <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#arrow-up" /></svg>}
            </button>
          </div>
        </div>
      </form>
      {/* Composer hint: fades in while the textarea is focused; wording adapts
          to the send-key preference. */}
      <p className={`chat-composer__hint${composerFocused ? ' is-visible' : ''}`} aria-hidden="true">
        {sendOnEnter
          ? <><strong>Enter</strong> to send · <strong>Shift+Enter</strong> for a new line</>
          : <><strong>Ctrl+Enter</strong> to send · <strong>Enter</strong> for a new line</>}
      </p>
    </section>
  )
}

/** Thinking cue: the orbital mark + a shimmer-swept "Thinking" label. Stays
 *  mounted for a 220ms opacity crossfade after the first token arrives, then
 *  unmounts. */
function ThinkingIndicator({ active }: { active: boolean }) {
  const [mounted, setMounted] = useState(active)
  useEffect(() => {
    if (active) {
      setMounted(true)
      return
    }
    if (!mounted) return
    const t = setTimeout(() => setMounted(false), 220)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  if (!mounted) return null
  return (
    <div
      className={`assistant-chat__thinking${active ? '' : ' is-fading'}`}
      role="status"
      aria-label="Assistant is thinking"
    >
      <LoadingLogo size={20} color="var(--color-primary)" />
      <span className="thinking-shimmer">Thinking</span>
    </div>
  )
}

/** B / KB / MB / GB, one decimal above 1 KB. */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value.toFixed(1)} ${unit}`
}

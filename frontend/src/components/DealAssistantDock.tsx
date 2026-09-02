import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { AuditResult, FormData } from '../types/deal'
import { ChatNotice, DealChat } from './DealChat'

const DOCK_STORAGE_KEY = 'deal-onboarding-assistant-dock-v1'
const MIN_W = 320
const MIN_H = 360
const DEFAULT_W = 420
const DEFAULT_H = 600

interface DockPrefs {
  open: boolean
  width: number
  height: number
}

function loadPrefs(): DockPrefs {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<DockPrefs>
      return {
        open: !!p.open,
        width: typeof p.width === 'number' && p.width >= MIN_W ? p.width : DEFAULT_W,
        height: typeof p.height === 'number' && p.height >= MIN_H ? p.height : DEFAULT_H,
      }
    }
  } catch { /* defaults */ }
  return { open: false, width: DEFAULT_W, height: DEFAULT_H }
}

function savePrefs(p: DockPrefs): void {
  try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

interface Props {
  form: FormData
  /** The builder's setForm — the ONLY way the dock changes the form, and only
   *  after the trader clicks Apply on a diff preview. */
  onFormChange: (form: FormData) => void
  /** Latest audit response, forwarded to the assistant with every turn. */
  audit: AuditResult | null
  /** "Fix with assistant" hand-off: seeds the composer and opens the dock. */
  prefill?: { text: string; nonce: number } | null
  /** Bumping this clears the conversation (submit / reset). */
  resetToken?: number
  /** Lines the builder posts into the chat (applied-edit re-audit results). */
  notices?: ChatNotice[]
  onApplied?: (dealsChanged: number) => void
  disabled?: boolean
}

/** The Deal Assistant dock — a floating launcher in the bottom-right of the
 *  Deal Builder that opens a non-blocking chat panel. The panel stays open
 *  while the trader scrolls and edits; Minimize collapses it back to the
 *  launcher (with an unread dot when the assistant answered meanwhile).
 *  Open/closed state and panel size persist in localStorage; Esc minimizes;
 *  focus is trapped while open. */
export function DealAssistantDock({ form, onFormChange, audit, prefill, resetToken, notices, onApplied, disabled }: Props) {
  const [prefs, setPrefs] = useState<DockPrefs>(loadPrefs)
  const [unread, setUnread] = useState(false)
  const openRef = useRef(prefs.open)
  openRef.current = prefs.open

  const update = useCallback((patch: Partial<DockPrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  const open = useCallback(() => { setUnread(false); update({ open: true }) }, [update])
  const minimize = useCallback(() => update({ open: false }), [update])

  // A "Fix with assistant" hand-off opens the dock.
  useEffect(() => {
    if (prefill?.text) open()
  }, [prefill?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const trapRef = useFocusTrap<HTMLDivElement>({ active: prefs.open, onEscape: minimize })

  // Corner resize handle (top-left, since the panel is anchored bottom-right).
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const onResizePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    resizeStart.current = { x: e.clientX, y: e.clientY, w: prefs.width, h: prefs.height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onResizePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = resizeStart.current
    if (!s) return
    const width = Math.max(MIN_W, Math.min(window.innerWidth - 32, s.w + (s.x - e.clientX)))
    const height = Math.max(MIN_H, Math.min(window.innerHeight - 32, s.h + (s.y - e.clientY)))
    setPrefs(prev => ({ ...prev, width, height }))
  }
  const onResizePointerUp = () => {
    if (!resizeStart.current) return
    resizeStart.current = null
    setPrefs(prev => { savePrefs(prev); return prev })
  }
  const onResizeKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 40 : 16
    let { width, height } = prefs
    if (e.key === 'ArrowLeft') width += step
    else if (e.key === 'ArrowRight') width -= step
    else if (e.key === 'ArrowUp') height += step
    else if (e.key === 'ArrowDown') height -= step
    else return
    e.preventDefault()
    update({ width: Math.max(MIN_W, width), height: Math.max(MIN_H, height) })
  }

  return (
    <>
      {!prefs.open && (
        <button
          type="button"
          className={`assistant-launcher${unread ? ' has-unread' : ''}`}
          onClick={open}
          aria-label={unread ? 'Open the Deal Assistant (new reply)' : 'Open the Deal Assistant'}
          title="Deal Assistant"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <span className="assistant-launcher__label">Deal Assistant</span>
          {unread && <span className="assistant-launcher__dot" aria-hidden="true" />}
        </button>
      )}

      {/* The chat stays mounted while minimized so the stream/conversation
          survives; only the panel's visibility changes. */}
      <div
        className={`assistant-dock${prefs.open ? ' is-open' : ''}`}
        role="dialog"
        aria-label="Deal Assistant"
        aria-hidden={!prefs.open}
        hidden={!prefs.open}
        ref={trapRef}
        style={{ width: prefs.width, height: prefs.height }}
      >
        <button
          type="button"
          className="assistant-dock__resize"
          aria-label="Resize the assistant panel (arrow keys)"
          title="Drag to resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onKeyDown={onResizeKeyDown}
        />
        <header className="assistant-dock__head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="assistant-dock__head-icon" aria-hidden="true">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          <span className="assistant-dock__title">Deal Assistant</span>
          <span className="assistant-dock__hint">bulk edits · questions · audit fixes</span>
          <button
            type="button"
            className="chat-composer__toolbtn assistant-dock__minimize"
            aria-label="Minimize the assistant (Esc)"
            title="Minimize (Esc)"
            onClick={minimize}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
        </header>
        <div className="assistant-dock__body">
          <DealChat
            form={form}
            onFormChange={onFormChange}
            audit={audit}
            prefill={prefill}
            resetToken={resetToken}
            notices={notices}
            onApplied={onApplied}
            onActivity={() => { if (!openRef.current) setUnread(true) }}
            disabled={disabled}
            embedded
          />
        </div>
      </div>
    </>
  )
}

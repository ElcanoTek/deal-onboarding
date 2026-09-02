import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_MODEL, ADVANCED_MODEL, labelForModel, tierForModel } from '../lib/modelAliases'
import {
  RankedModel,
  composePickerModels,
  isNewlyReleased,
  loadCatalogModels,
  loadRankedModels,
} from '../lib/modelCatalog'

/** useChatModel — a persisted model choice (an OpenRouter slug; '' = let the
 *  server pick its default). One preference per storage key: the chat
 *  composers share 'deal-onboarding-chat-model'; the parser keeps its own key. */
export function useChatModel(
  storageKey = 'deal-onboarding-chat-model',
  initial: string = DEFAULT_MODEL,
): [string, (slug: string) => void] {
  const [slug, setSlug] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      return stored === null ? initial : stored
    } catch {
      return initial
    }
  })
  const pick = (next: string) => {
    setSlug(next)
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // Private mode — selection stays session-only.
    }
  }
  return [slug, pick]
}

const SERVER_DEFAULT_ROW: RankedModel = { slug: '', name: 'Server default' }

// Popover geometry. The popover is position:fixed (viewport-relative) so it
// can never be clipped by a modal's overflow:hidden or run past the screen —
// the composers live inside .modal--bars containers where a plain absolute
// popover gets cut off (post-#362 regression).
const POP_WIDTH = 304 // 19rem
const POP_MARGIN = 8 // breathing room from the viewport edges
const POP_GAP = 9 // 0.55rem between the chip and the popover
const POP_CHROME = 56 // search input + padding + gap above the listbox

type PopPosition = { style: CSSProperties; listMaxHeight: number }

/** Place the popover against the trigger chip: prefer opening upward (fleet's
 *  direction), flip downward when the space above can't fit a useful list,
 *  and clamp both the horizontal position and the list height to the
 *  viewport. */
function computePopPosition(rect: DOMRect): PopPosition {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const spaceAbove = rect.top - POP_GAP - POP_MARGIN
  const spaceBelow = vh - rect.bottom - POP_GAP - POP_MARGIN
  const openUp = spaceAbove >= 280 || spaceAbove >= spaceBelow
  const available = Math.max(150, openUp ? spaceAbove : spaceBelow)
  const width = Math.min(POP_WIDTH, vw - POP_MARGIN * 2)
  const left = Math.min(Math.max(rect.left, POP_MARGIN), Math.max(POP_MARGIN, vw - width - POP_MARGIN))
  const style: CSSProperties = openUp
    ? { position: 'fixed', left, right: 'auto', bottom: vh - rect.top + POP_GAP, top: 'auto', width }
    : { position: 'fixed', left, right: 'auto', top: rect.bottom + POP_GAP, bottom: 'auto', width }
  return { style, listMaxHeight: available - POP_CHROME }
}

/** Fleet-parity composer model picker (fleet@dev Composer.tsx model chip +
 *  COMPOSER_POP_WIDE listbox): the chip-icon trigger opens a searchable
 *  combobox above the toolbar — pinned "recommended" tier rows, then the
 *  newest model per major lab from the live OpenRouter catalog; typing
 *  filters the full catalog and doubles as free slug entry. Exactly one
 *  pill per row: recommended > tested > ✨ new > experimental. */
export function ChatModelPicker({ value, onPick, disabled, serverDefaultOption }: {
  /** The selected OpenRouter slug ('' = server default). */
  value: string
  onPick: (slug: string) => void
  disabled?: boolean
  /** Pin a "Server default" row (empty slug) above the tier rows — the
   *  parser's mode, where the server resolves OPENROUTER_MODEL. */
  serverDefaultOption?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [ranked, setRanked] = useState<RankedModel[]>([])
  const [catalog, setCatalog] = useState<RankedModel[]>([])
  const [loading, setLoading] = useState(false)
  const [popPos, setPopPos] = useState<PopPosition | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const extraPinned = useMemo(
    () => (serverDefaultOption ? [SERVER_DEFAULT_ROW] : []),
    [serverDefaultOption],
  )
  const visible = useMemo(
    () => composePickerModels(query, ranked, catalog, extraPinned),
    [query, ranked, catalog, extraPinned],
  )

  const openPicker = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    setPopPos(rect ? computePopPosition(rect) : null)
    setOpen(true)
    setQuery('')
    setHighlight(0)
  }
  const closePicker = (returnFocus: boolean) => {
    setOpen(false)
    setQuery('')
    if (returnFocus) triggerRef.current?.focus()
  }

  // Lazy-load both lists when the popover opens. The loaders attempt once
  // per session regardless of outcome (see modelCatalog.ts), so a failing
  // endpoint degrades to the pinned rows instead of refetch loops.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void Promise.all([loadRankedModels(), loadCatalogModels()]).then(([r, c]) => {
      if (cancelled) return
      setRanked(r)
      setCatalog(c)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    // The popover is fixed-positioned, so scrolling the page (or the modal
    // body) underneath it would leave it floating detached from the chip —
    // close instead. Scrolling inside the popover's own list is fine.
    const onScroll = (e: Event) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const label = value ? labelForModel(value) : 'Server default'
  const clampedHighlight = Math.min(highlight, Math.max(visible.length - 1, 0))

  return (
    <div
      className="chat-model"
      ref={rootRef}
      onKeyDown={e => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          closePicker(true)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`chat-model__trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        title={`OpenRouter model slug — e.g. ${DEFAULT_MODEL} (recommended) or ${ADVANCED_MODEL} (strongest)`}
        disabled={disabled}
        onClick={() => {
          if (open) closePicker(false)
          else openPicker()
        }}
      >
        <svg className="chat-model__icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons/core-icons.svg#model" /></svg>
        <span className="chat-model__label">{label}</span>
        <svg className="chat-model__caret" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons/core-icons.svg#selector" /></svg>
      </button>
      {open && !disabled && (
        <div className="chat-model__pop" style={popPos?.style}>
          <input
            ref={inputRef}
            type="text"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Search models…"
            aria-label="Model"
            role="combobox"
            aria-expanded="true"
            aria-controls="chat-model-listbox"
            aria-activedescendant={visible.length > 0 ? `chat-model-opt-${clampedHighlight}` : undefined}
            className="chat-model__search"
            value={query}
            onChange={e => {
              // Typing both filters the catalog and keeps free slug entry
              // working: the raw text is the selected model until a row is
              // picked (fleet parity).
              onPick(e.target.value)
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={e => {
              const count = visible.length
              if (e.key === 'ArrowDown' && count > 0) {
                e.preventDefault()
                setHighlight(h => (Math.min(h, count - 1) + 1) % count)
              } else if (e.key === 'ArrowUp' && count > 0) {
                e.preventDefault()
                setHighlight(h => (Math.min(h, count - 1) - 1 + count) % count)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const pick = visible[Math.min(clampedHighlight, count - 1)]
                if (pick) onPick(pick.slug)
                closePicker(true)
              }
            }}
          />
          <div
            id="chat-model-listbox"
            role="listbox"
            aria-label="Model options"
            className="chat-model__list"
            style={popPos ? { maxHeight: popPos.listMaxHeight } : undefined}
          >
            {loading ? (
              <div className="chat-model__empty">Loading...</div>
            ) : visible.length === 0 ? (
              <div className="chat-model__empty">No matches</div>
            ) : (
              visible.map((m, i) => {
                const tier = m.slug ? tierForModel(m.slug) : null
                const isTier = tier === 'default' || tier === 'advanced'
                let pill: ReactNode = null
                if (isTier) {
                  pill = <span className="chat-model__pill chat-model__pill--recommended">recommended</span>
                } else if (tier === 'tested') {
                  pill = <span className="chat-model__pill chat-model__pill--tested">tested</span>
                } else if (isNewlyReleased(m.created)) {
                  pill = (
                    <span
                      className="chat-model__pill chat-model__pill--new"
                      title="Listed on OpenRouter within the last two weeks"
                    >
                      ✨ new
                    </span>
                  )
                } else if (tier === 'experimental') {
                  pill = <span className="chat-model__pill chat-model__pill--experimental">experimental</span>
                }
                const selected = m.slug === value
                const highlighted = i === clampedHighlight
                return (
                  <button
                    key={m.slug || '__default__'}
                    id={`chat-model-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={m.slug ? `${m.name} (${m.slug})` : 'Use the server-configured default model'}
                    className={`chat-model__row${selected ? ' is-selected' : ''}${highlighted && !selected ? ' is-highlighted' : ''}`}
                    onClick={() => {
                      onPick(m.slug)
                      closePicker(true)
                    }}
                  >
                    <span className="chat-model__row-label">{m.name}</span>
                    {pill}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

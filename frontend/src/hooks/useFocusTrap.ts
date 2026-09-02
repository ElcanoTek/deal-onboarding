import { useEffect, useRef } from 'react'

interface FocusTrapOptions {
  /** Set false to suspend the trap without unmounting (default true). */
  active?: boolean
  /** Called on Escape. Wire to the modal's close path (the draft-saving one where it matters). */
  onEscape?: () => void
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Focus management for modal dialogs (flag INTERACTION_ACCESSIBILITY baseline:
 * "modals: trap focus and close on escape").
 *
 * Attach the returned ref to the dialog container (the `.modal` element).
 * On mount: remembers the previously-focused element and moves focus to the
 * first focusable child (or `[data-autofocus]` if present). While active:
 * Tab/Shift+Tab wrap within the container, Escape calls `onEscape`.
 * On unmount: restores focus to the remembered element.
 */
export function useFocusTrap<T extends HTMLElement>({ active = true, onEscape }: FocusTrapOptions = {}) {
  const containerRef = useRef<T | null>(null)
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previous = document.activeElement as HTMLElement | null

    // offsetParent weeds out display:none subtrees; the visibility check weeds
    // out visibility:hidden ones (e.g. a closed chat panel that stays mounted
    // for its open/close animation) — those still have boxes, but focus()
    // silently no-ops on them, which would break the Tab wrap.
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        el =>
          (el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden') ||
          el === document.activeElement,
      )

    const initial = container.querySelector<HTMLElement>('[data-autofocus]') || focusables()[0]
    initial?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        escapeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          e.preventDefault()
          last.focus()
        }
      } else if (current === last || !container.contains(current)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [active])

  return containerRef
}

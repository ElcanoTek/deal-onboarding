// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Global guard against the number-input scroll footgun: browsers treat a
// mouse-wheel event over a FOCUSED <input type="number"> as a spin — silently
// decrementing/incrementing the value the trader just typed. That is exactly
// how the DEAL07254 E2E batch shipped $0.08/$0.07 floors after the trader
// entered $0.10 on each deal card and then scrolled the page (two ticks on one
// card, three on the other). The ix_floor audit rule now catches sub-minimum
// results, but the input should never mutate on scroll in the first place.
//
// The guard blurs a focused number input the moment a wheel event lands on it,
// BEFORE the browser applies the spin (the spin only fires on a focused
// control). The page keeps scrolling normally — no preventDefault — and the
// typed value stays put. Installed once at the app entry point so every
// current and future <input type="number"> is covered without per-field
// wiring.

export function installNumberInputWheelGuard(doc: Document = document): () => void {
  const onWheel = (e: WheelEvent) => {
    const active = doc.activeElement
    // <select> is guarded too: Firefox spins a focused select's value on
    // wheel-over, which is the same trap in a different widget (relevant now
    // that viewability is a dropdown pinned to IX's bucket grid).
    const guarded =
      (active instanceof HTMLInputElement && active.type === 'number') ||
      active instanceof HTMLSelectElement
    if (
      guarded &&
      active instanceof HTMLElement &&
      (e.target === active || (e.target instanceof Node && active.contains(e.target)))
    ) {
      active.blur()
    }
  }
  // Capture phase so the blur happens before any component-level handlers;
  // passive because we never call preventDefault (scrolling must keep working).
  doc.addEventListener('wheel', onWheel, { capture: true, passive: true })
  return () => doc.removeEventListener('wheel', onWheel, { capture: true })
}

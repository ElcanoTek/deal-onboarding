// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

/** Accordion open-state contract.
 *
 *  Every collapsible in the trader shell is an uncontrolled <details> that a
 *  `forceOpen` prop NUDGES open through an imperative effect
 *  (`if (forceOpen && ref.current) ref.current.open = true`). The trader may
 *  collapse it again at will.
 *
 *  Pairing that effect with a controlled `open={forceOpen || undefined}` JSX
 *  prop breaks the contract in both directions: React force-CLOSES the element
 *  when forceOpen goes true -> false, and blocks manual collapse while it is
 *  true.
 *
 *  The close was a live bug. Typing in a field flips formChangedSinceAudit,
 *  which makes auditDealIssues drop that field's own finding until the
 *  debounced re-audit returns — so forceOpen dropped on every keystroke,
 *  collapsing the group mid-edit and blurring the focused input. This asserts
 *  against the source because the defect is a code shape, not a value: the
 *  same idiom in a fourth accordion would reintroduce it silently.
 */
import { describe, it, expect } from 'vitest'

// Vite's raw glob — no node typings needed in the frontend tsconfig, and it
// stays in sync automatically as components are added.
const SOURCES = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function componentSources(): { file: string; src: string }[] {
  return Object.entries(SOURCES).map(([path, src]) => ({ file: path.replace('./', ''), src }))
}

describe('accordion open-state contract', () => {
  it('no <details> couples the forceOpen effect with a controlled open prop', () => {
    const offenders = componentSources()
      .filter(({ src }) => /<details[^>]*\bopen=\{/.test(src))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it('every forceOpen accordion still nudges itself open imperatively', () => {
    // Guards the other direction: dropping the open prop must not be "fixed"
    // by deleting the effect too, which would leave errors unreachable behind
    // a collapsed group.
    const withForceOpen = componentSources().filter(({ src }) => src.includes('forceOpen'))
    expect(withForceOpen.length).toBeGreaterThan(0)
    for (const { file, src } of withForceOpen) {
      expect(src, `${file} must keep the imperative nudge`).toMatch(
        /if \(forceOpen && ref\.current\) ref\.current\.open = true/,
      )
    }
  })
})

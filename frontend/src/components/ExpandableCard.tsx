// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { ReactNode, useId, useState } from 'react'

interface Props {
  /** Sits left of the toggle as its own tap target (e.g. a row checkbox) —
   *  a sibling, never nested inside the toggle button. */
  leading?: ReactNode
  /** Collapsed-row content (client pill, campaign ID, deal name…). */
  summary: ReactNode
  children: ReactNode
}

/** Mobile replacement for a table row: a card whose header toggles an
 *  expanded body (canonical flag accordion `+`/`−` indicator). Tapping
 *  anywhere on the header toggles; expansion pushes later cards down. */
export function ExpandableCard({ leading, summary, children }: Props) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    <article className="record-card">
      <div className="record-card__header">
        {leading}
        <button
          type="button"
          className="record-card__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(o => !o)}
        >
          <span className="record-card__summary">{summary}</span>
          <span className="record-card__icon" aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </div>
      {open && <div id={bodyId} className="record-card__body">{children}</div>}
    </article>
  )
}

/** Label-left / value-right row inside an expanded card. */
export function CardRow({ label, children }: { label: string; children?: ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false
  return (
    <div className="record-card__row">
      <span className="record-card__row-label">{label}</span>
      <span className="record-card__row-value">{empty ? '—' : children}</span>
    </div>
  )
}

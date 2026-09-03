// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import type { ReactNode } from 'react'
import type { PublisherAllowlistEntry } from '../types/deal'
import { PublisherAllowlist } from './PublisherAllowlist'
import type { CatalogSlice } from '../lib/publisherCatalog'

interface Props {
  /** Stable toggle element id (audit "Fix →" jumps + label binding). */
  toggleId: string
  inputId: string
  /** "Max publishers" state — true = all eligible publishers (default). */
  allPublishers: boolean
  onToggle: (on: boolean) => void
  entries: PublisherAllowlistEntry[]
  onEntriesChange: (entries: PublisherAllowlistEntry[]) => void
  /** SSPs whose wire takes IDs only (OpenX). */
  idRequired?: boolean
  /** Audit error for the allowlist field. */
  error?: string
  /** Platform cannot target publisher accounts (Xandr/TripleLift/Media.net):
   *  the toggle renders locked ON and this note explains the alternative. */
  unsupportedNote?: string
  /** Extra field rendered while the toggle is ON (PubMatic's Max Allowed
   *  Publishers). */
  maxOnExtra?: ReactNode
  /** Known-publisher-list slice(s) for advisory entry-time validation. */
  catalogSlices?: CatalogSlice[]
}

/** PublisherScope — the dedicated Publishers section, byte-identical on every
 *  SSP card: a "Max publishers" toggle (all eligible publishers, the default)
 *  vs a specific allowlist entered by file drop or paste. SSPs whose platform
 *  cannot target publisher accounts render the same section with the toggle
 *  locked on and a note naming the alternative, so every card reads the same
 *  and none can silently pretend to scope. */
export function PublisherScope({
  toggleId, inputId, allPublishers, onToggle, entries, onEntriesChange,
  idRequired, error, unsupportedNote, maxOnExtra, catalogSlices,
}: Props) {
  const locked = unsupportedNote !== undefined
  const on = locked || allPublishers
  return (
    <div className="field-group">
      <span className="field-label">Publishers</span>
      <div className="toggle-wrap">
        <label className="toggle" htmlFor={toggleId}>
          <input
            id={toggleId}
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={e => onToggle(e.target.checked)}
          />
          <span className="toggle-track" /><span className="toggle-thumb" />
        </label>
        <span className="toggle-label">Max publishers</span>
      </div>
      <span className="field-helper">
        {locked
          ? unsupportedNote
          : 'On, all eligible publishers are included automatically (the standard setup). Off, the deals run ONLY on a specific publisher list — drop a file or paste it below.'}
      </span>
      {!locked && (on ? maxOnExtra : (
        <PublisherAllowlist
          inputId={inputId}
          entries={entries}
          onChange={onEntriesChange}
          idRequired={idRequired}
          error={error}
          catalogSlices={catalogSlices}
        />
      ))}
    </div>
  )
}

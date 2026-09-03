// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useRef, useState } from 'react'
import { splitEmails } from '../lib/recipients'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Props {
  id: string
  /** Comma-joined wire value (the FormData field stays a plain string, so
   *  drafts persisted before this input existed hydrate unchanged). */
  value: string
  onChange: (next: string) => void
  placeholder?: string
  invalid?: boolean
  /** Rendered under the chips only while at least one chip exists. */
  helper?: string
}

/** Multi-email chip input (runner-style "Email Results To"): committed addresses
 *  render as removable chips; the trailing inline input commits on Enter,
 *  comma/semicolon, blur, or the Add button. The wire value is the chips
 *  comma-joined — a single address behaves exactly like the old text input. */
export function EmailChipsInput({ id, value, onChange, placeholder, invalid, helper }: Props) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const chips = splitEmails(value)

  const commit = (raw: string) => {
    const additions = splitEmails(raw)
    if (additions.length === 0) return
    const next = [...chips]
    for (const a of additions) {
      if (!next.some(c => c.toLowerCase() === a.toLowerCase())) next.push(a)
    }
    onChange(next.join(', '))
    setDraft('')
  }

  const removeChip = (idx: number) => {
    onChange(chips.filter((_, i) => i !== idx).join(', '))
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && draft === '' && chips.length > 0) {
      removeChip(chips.length - 1)
    }
  }

  return (
    <>
      <div
        className={`email-chips${invalid ? ' email-chips--error' : ''}`}
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((chip, i) => (
          <span key={`${chip}-${i}`} className={`email-chips__chip${EMAIL_RE.test(chip) ? '' : ' email-chips__chip--invalid'}`}>
            {chip}
            <button
              type="button"
              className="email-chips__remove"
              aria-label={`Remove ${chip}`}
              onClick={e => { e.stopPropagation(); removeChip(i) }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="email"
          className="email-chips__input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={chips.length === 0 ? placeholder : 'Add another…'}
          // Password managers treat this box as a login field and inject the
          // saved USERNAME (the admin account's is the literal "admin"), which
          // the blur-commit then turns into a chip that can never validate.
          // autoComplete="off" alone is ignored by the extensions, so carry
          // each manager's opt-out attribute too.
          autoComplete="off"
          name="deal-sheet-recipient-add"
          data-1p-ignore=""
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          aria-invalid={invalid || undefined}
        />
        {draft.trim() !== '' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm email-chips__add"
            onMouseDown={e => e.preventDefault() /* don't blur-commit first */}
            onClick={() => commit(draft)}
          >
            Add
          </button>
        )}
      </div>
      {helper && chips.length > 1 && <span className="field-helper">{helper}</span>}
    </>
  )
}

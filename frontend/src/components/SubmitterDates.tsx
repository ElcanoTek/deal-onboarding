// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useEffect } from 'react'
import { FormData } from '../types/deal'
import { computeAutoEndDate } from '../lib/flightDates'
import { businessTodayISO, DEFAULT_DEAL_SHEET_THEME, KNOWN_DEAL_SHEET_THEMES } from '../lib/dealPromptYaml'
import { DatePickerField } from './DatePickerField'
import { EmailChipsInput } from './EmailChipsInput'
import { splitEmails } from '../lib/recipients'
import { FormSection } from './FormSection'

// Display names for the runner's registered deal-sheet themes. Themes missing
// here still render (capitalized slug) so a newly registered theme shows up
// without a UI change.
const THEME_LABEL: Record<string, string> = {
  default: 'Default',
}

const themeLabel = (t: string) => THEME_LABEL[t] ?? (t.charAt(0).toUpperCase() + t.slice(1))

interface Props {
  form: FormData
  update: <K extends keyof FormData>(key: K, val: FormData[K]) => void
  open?: boolean
  onToggle?: (next: boolean) => void
  filled?: number
  total?: number
  issues?: number
  /** Audit failures keyed by fieldPath — red-outlines the offending input. */
  formIssues?: Record<string, string>
}

export function SubmitterDates({ form, update, open, onToggle, filled, total, issues, formIssues }: Props) {
  // Business-timezone calendar date (#235.1): the UTC date rolls over
  // at 19:00/20:00 US-Eastern, which blocked picking "today" in the evening
  // and disagreed with the Go date_logic rule + resolveStartDate.
  const today = businessTodayISO()
  const err = (path: string) => formIssues?.[path]

  // Surface a warning when any deal-sheet recipient matches the submitter
  // email — that's the exact configuration that caused incident 2026-05-21
  // (deal sheet sent to a client because submitterEmail carried the client's
  // address). The warning is non-blocking; some teammates
  // legitimately submit their own briefs and want their own email here.
  const recipients = splitEmails(form.dealSheetRecipient).map(r => r.toLowerCase())
  const submitter = form.submitterEmail.trim().toLowerCase()
  const recipientMatchesSubmitter = !!submitter && recipients.includes(submitter)

  // Deal-sheet theme: "" = the runner's default theme. The select shows the
  // resolved value; picking one pins it for this batch.
  const presetTheme = DEFAULT_DEAL_SHEET_THEME
  const effectiveTheme = form.dealSheetTheme && KNOWN_DEAL_SHEET_THEMES.includes(form.dealSheetTheme)
    ? form.dealSheetTheme
    : presetTheme

  // Flight-end-date policy: whenever flightStartDate changes, recompute
  // flightEndDate to start + 2y. Always overwrites — the policy is "ignore
  // brief-supplied end dates" and we treat the form the same way. If a
  // trader needs a shorter flight they edit the end date AFTER finalizing
  // the start. See lib/flightDates.ts for the rationale.
  useEffect(() => {
    const auto = computeAutoEndDate(form.flightStartDate)
    if (auto && auto !== form.flightEndDate) {
      update('flightEndDate', auto)
    }
    // Only react to start-date changes — editing the end date directly
    // must not trigger a re-overwrite cascade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.flightStartDate])

  return (
    <FormSection number="01" title="Submitter & Dates" anchorId="section-submitter" open={open} onToggle={onToggle} filled={filled} total={total} issues={issues}>
      <div className="field-row">
        <div className="field-group">
          <label className="field-label required" htmlFor="submitterName">Submitter Name</label>
          <input
            id="submitterName"
            type="text"
            className={`field-input${err('submitterName') ? ' field-input--error' : ''}`}
            value={form.submitterName}
            onChange={e => update('submitterName', e.target.value)}
            placeholder="Jane Smith"
            autoComplete="name"
            aria-invalid={err('submitterName') ? true : undefined}
          />
          {err('submitterName') && <span className="field-error">{err('submitterName')}</span>}
        </div>
        <div className="field-group">
          <label className="field-label required" htmlFor="submitterEmail">Submitter Email</label>
          <input
            id="submitterEmail"
            type="email"
            className={`field-input${err('submitterEmail') ? ' field-input--error' : ''}`}
            value={form.submitterEmail}
            onChange={e => update('submitterEmail', e.target.value)}
            placeholder="jane@agency.com"
            autoComplete="email"
            aria-invalid={err('submitterEmail') ? true : undefined}
          />
          {err('submitterEmail') && <span className="field-error">{err('submitterEmail')}</span>}
        </div>
      </div>

      <div className="field-row">
        <div className="field-group">
          <label className="field-label required" htmlFor="dealSheetRecipient">Deal Sheet Recipient (Trader)</label>
          <EmailChipsInput
            id="dealSheetRecipient"
            value={form.dealSheetRecipient}
            onChange={next => update('dealSheetRecipient', next)}
            placeholder="you@example.com"
            invalid={!!err('dealSheetRecipient')}
            helper="First recipient gets the deal-sheet email; the others are cc'd."
          />
          {err('dealSheetRecipient') && <span className="field-error">{err('dealSheetRecipient')}</span>}
          {recipientMatchesSubmitter && (
            <span className="field-helper" style={{ color: 'var(--color-danger)', fontWeight: 'var(--font-weight-bold)' }}>
              ⚠ Recipient matches the Submitter Email. If the brief came from a client, this will send the deal sheet to the client. Change it to your own email before auditing.
            </span>
          )}
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="dealSheetTheme">Deal Sheet Theme</label>
          <select
            id="dealSheetTheme"
            className="field-select"
            value={effectiveTheme}
            onChange={e => update('dealSheetTheme', e.target.value)}
          >
            {KNOWN_DEAL_SHEET_THEMES.map(t => (
              <option key={t} value={t}>{themeLabel(t)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field-row-3">
        <div className="field-group">
          <label className="field-label required" htmlFor="requestedDueDate">Requested Due Date</label>
          <DatePickerField
            id="requestedDueDate"
            value={form.requestedDueDate}
            onChange={value => update('requestedDueDate', value)}
            minDate={today}
            invalid={!!err('requestedDueDate')}
          />
          {err('requestedDueDate') && <span className="field-error">{err('requestedDueDate')}</span>}
        </div>
        <div className="field-group">
          <label className="field-label required" htmlFor="flightStartDate">Flight Start Date</label>
          <DatePickerField
            id="flightStartDate"
            value={form.flightStartDate}
            onChange={value => update('flightStartDate', value)}
            minDate={today}
            invalid={!!err('flightStartDate')}
          />
          {err('flightStartDate') && <span className="field-error">{err('flightStartDate')}</span>}
          {!!form.flightStartDate && form.flightStartDate < today && (
            <span className="field-helper" style={{ color: 'var(--color-danger)', fontWeight: 'var(--font-weight-bold)' }}>
              ⚠ Start date is in the past — bump it forward.
            </span>
          )}
        </div>
        <div className="field-group">
          <label className="field-label required" htmlFor="flightEndDate">Flight End Date</label>
          <DatePickerField
            id="flightEndDate"
            value={form.flightEndDate}
            onChange={value => update('flightEndDate', value)}
            minDate={form.flightStartDate || today}
            invalid={!!err('flightEndDate')}
          />
          {err('flightEndDate') && <span className="field-error">{err('flightEndDate')}</span>}
        </div>
      </div>
    </FormSection>
  )
}

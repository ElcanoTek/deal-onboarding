// Flight-date policy. Single source of truth for "how long does a deal run?"
//
// Policy: a deal's end date should be as far out
// as the SSP allows. SSPs that support truly open-ended deals get no
// end_date at all; SSPs that require one get start_date + 2 years.
// Trader-supplied or brief-extracted end dates are intentionally IGNORED —
// shorter flights leak revenue if buyers extend without us noticing.
//
// This module is the policy boundary. Every entry path that lands a value
// in form.flightEndDate (manual entry, LLM parser merge,
// templates) routes through computeAutoEndDate so the policy holds.


/** How far out an end date is set for SSPs that require one. */
export const END_DATE_HORIZON_YEARS = 2

/** Add N years to an ISO YYYY-MM-DD date. Returns '' for empty input. */
export function computeAutoEndDate(startDate: string, horizonYears: number = END_DATE_HORIZON_YEARS): string {
  const trimmed = (startDate || '').trim()
  if (!trimmed) return ''
  const parts = trimmed.split('-')
  if (parts.length !== 3) return ''
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const d = parseInt(parts[2], 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ''
  // Use UTC to avoid timezone shifts. Feb 29 + 2y → Feb 28 of the target year.
  const date = new Date(Date.UTC(y + horizonYears, m - 1, d))
  if (date.getUTCMonth() !== m - 1) {
    // Day overflowed (e.g. Feb 29 + 2y on a non-leap year); JS rolled to Mar 1.
    // Clamp to the last day of the intended month instead.
    date.setUTCDate(0)
  }
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}


/** The business timezone every human-facing calendar date in the deal
 *  pipeline resolves against — the same America/New_York the deal-naming and
 *  geo policies assume. Resolving 'today' in UTC bumped an evening-ET submit
 *  to tomorrow's date (#235.1): at 20:00-24:00 US-Eastern the UTC
 *  calendar has already rolled over. */
export const BUSINESS_TIMEZONE = 'America/New_York'

/** Today's calendar date (YYYY-MM-DD) in the business timezone — NOT the UTC
 *  calendar date. en-CA formatting yields ISO year-month-day order. The Go
 *  audit's date_logic rule resolves "today" against the same zone
 *  (internal/validation/rules.go) so the two sides can never disagree about
 *  whether a start date is "in the past". Exported for tests + SubmitterDates. */
export function businessTodayISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** SSPs whose deals run always-on: the prompt omits end_date entirely, so the
 *  booked flight has no end. Mirrors SSP_REQUIREMENTS.endDateSupport
 *  ('open-ended') in types/deal.ts — kept as a plain set here so this leaf
 *  module stays import-free. */
const OPEN_ENDED_SSPS: ReadonlySet<string> = new Set(['Xandr'])

/** The flight window a deal is BOOKED with, as the prompt ships it — what the
 *  deal record records per row. Start: the form date, bumped to today when it
 *  is already past (the prompt builder's resolveStartDate rule — a deal can't
 *  start yesterday), today when blank. End: the form's policy end date, or
 *  blank for always-on SSPs. `today` is injectable for tests. */
export function bookedFlightWindow(
  form: { flightStartDate: string; flightEndDate: string },
  ssp: string,
  today: string = businessTodayISO(),
): { startDate: string; endDate: string } {
  const formStart = (form.flightStartDate || '').trim()
  const startDate = !formStart || formStart < today ? today : formStart
  const endDate = OPEN_ENDED_SSPS.has(ssp) ? '' : (form.flightEndDate || '').trim()
  return { startDate, endDate }
}

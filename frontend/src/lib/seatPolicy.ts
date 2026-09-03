import { DealEntry } from '../types/deal'

/** DSPs that bid through a house seat on the exchanges we curate, so there is
 *  no per-client Seat ID for traders to enter — the SSPs accept deals for
 *  these DSPs without one. Keyed by canonical name (lowercase, alphanumerics
 *  only) so "StackAdapt", "Stack Adapt", and "stackadapt" all match.
 *  Mirrored in Go: seatOptionalDSPs (internal/validation/rules.go) — change
 *  both together. */
const SEAT_OPTIONAL_DSPS: ReadonlySet<string> = new Set(['stackadapt'])

export function seatOptionalDsp(dsp: string): boolean {
  return SEAT_OPTIONAL_DSPS.has(dsp.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

/** SSPs whose create path structurally needs a seat even for a seat-optional
 *  DSP: the PubMatic MCP resolves the DSP buyer mapping from seat_id (a
 *  seatless create hard-blocks with missing_dsp_buyer), and the TripleLift
 *  prompt embeds dsp.seat.seatString (a blank seat would emit an unresolved
 *  <FILL> token the /api/runner/create prompt gate rejects). Mirrored in Go:
 *  seatRequiredCreateSSPs (internal/validation/rules.go). */
export const SEAT_REQUIRED_SSPS: readonly string[] = ['PubMatic', 'TripleLift']

/** The batch's CREATE-row SSPs that still demand a Seat ID. Sheet-only rows
 *  create nothing this batch, so they never demand a seat (mirrors Go
 *  containsCreateSSP). */
export function seatRequiredCreateSsps(deals: DealEntry[]): string[] {
  const present = new Set(deals.filter(d => !d.sheetOnly && d.ssp).map(d => d.ssp as string))
  return SEAT_REQUIRED_SSPS.filter(s => present.has(s))
}

/** SSPs whose CREATE path accepts more than one buyer seat on a single deal.
 *  Magnite's ClearLine Demand Management API takes dsps[i].buyers as a list and
 *  resolves every ref independently against the DSP's buyer catalog, so one
 *  deal can be pinned to several DV360 buyers (one live batch ran 14). Every
 *  other SSP carries exactly ONE seat token — IX seat_name, PubMatic seat_id,
 *  OpenX buyer_ids, Xandr buyer, TripleLift dsp.seat.seatString — and would
 *  ship a comma list verbatim as a single unresolvable value. Mirrored in Go:
 *  multiSeatSSPs (internal/validation/rules.go) — change both together. */
export const MULTI_SEAT_SSPS: readonly string[] = ['Magnite']

/** Split a Seat ID field into its individual seat tokens. Traders pin a deal to
 *  several buyer seats by entering them comma-separated
 *  ("1413973141,850299280,134"). The historical `prefix/seat` strip is applied
 *  PER TOKEN so a mixed list can never collapse onto the last slash in the
 *  whole string. Order-preserving, trimmed, deduped. Mirrored in Go:
 *  SplitSeatIDs (internal/validation/rules.go). */
export function splitSeatIds(seatId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of (seatId || '').split(',')) {
    const token = raw.trim().replace(/^.*\//, '').trim()
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

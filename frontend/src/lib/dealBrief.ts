// Structured, file-backed deal brief.
//
// A large batch used to be shipped to the runner as ONE giant inline
// text prompt; deeply-indented per-deal YAML blocks, segment paths containing
// `>`/`:`, and long names got garbled/truncated in transit. This module emits
// the same batch as a STRUCTURED document (one object per deal, each carrying
// its arg body as a single escaped string field) that serializes to JSON
// without any indentation ambiguity — suitable for attaching as a file and
// schema-validating BEFORE handoff, instead of pasting a fragile blob.
//
// It reuses the canonical per-SSP arg builder (generateDealPromptYaml) so the
// deal arguments stay identical to the inline path; only the transport changes.

import type { DealEntry, DspEntry, FormData, StandardList } from '../types/deal'
import { curator } from './dealNameSlots'
import { generateDealName } from '../hooks/useDealMatrix'
import { DEFAULT_DEAL_SHEET_THEME, generateDealPromptYaml, KNOWN_DEAL_SHEET_THEMES, resolveAdDuration, splitBatchPairs } from './dealPromptYaml'
import { splitEmails } from './recipients'

// Mirrors cutlass protocols/deal-brief.schema.yaml `version` (v1.1 introduced
// the per-deal ad_duration object this module emits). CI-tied both ways:
// contractGolden.test.ts asserts this constant AND the emitted doc against
// cutlass-contract.json brief.schemaVersion, and check-cutlass-contract.mjs
// diffs the fixture against the cutlass schema file — bump all together.
export const DEAL_BRIEF_SCHEMA_VERSION = '1.1'

/** A create row: exact tool routing + the per-SSP arg body. The first four
 *  fields (ssp, channel, deal_name, recommended_bid) + floor mirror the Cutlass
 *  deal-brief.schema.yaml per-deal record so this doc's `deals` validate cleanly
 *  against `mcp_deal_sheet_validate_brief` (REQUIRED_DEAL_FIELDS); `tool` and
 *  `prompt_inputs` are Deal Onboarding transport extras the validator ignores. */
export interface BriefDeal {
  ssp: string
  tool: string
  channel: string
  deal_name: string
  /** Sheet-only pitch range (free text), independent of `floor`. REQUIRED by
   *  validate_brief. Canonical by channel (deal-brief.schema.yaml). */
  recommended_bid: string
  /** Numeric SSP floor (CPM). Sent to the execute tool; also carried in
   *  prompt_inputs. Schema-documented per-deal field. */
  floor: number
  /** Optional ad-duration targeting — the brief-schema v1.1 `ad_duration`
   *  object, field names matching protocols/deal-brief.schema.yaml exactly:
   *  EITHER allowed_durations (exact creative lengths, integer SECONDS) OR
   *  min_seconds/max_seconds (contiguous bound) — never both. Only present
   *  on CTV/OLV/OTT deals that carry a duration requirement (resolveAdDuration
   *  gates the channel, so a stray duration on Display/Audio/Native — a brief
   *  validation error — can never reach the wire). */
  ad_duration?: { allowed_durations?: number[]; min_seconds?: number; max_seconds?: number }
  prompt_inputs: string
}

/** A sheet-only row: listed for the deal sheet, never created. Carries NO tool. */
export interface SheetOnlyRow {
  ssp: string
  channel: string
  deal_name: string
  status: 'already_created'
}

export interface DealBriefDoc {
  schema_version: string
  client_name: string
  /** Default data-partner shown in the sheet's Partner column (deal-brief.schema
   *  top-level `partner`). Per-deal overrides are not modelled here. */
  partner: string
  recipient: string
  /** Additional deal-sheet recipients (chip input entries after the first) —
   *  cc'd on the consolidated email. Schema-blessed (deal-brief.schema.yaml
   *  cc_recipients); OMITTED (not []) when the trader listed one address, so
   *  single-recipient briefs stay byte-identical to the pre-chip shape. */
  cc_recipients?: string[]
  theme: string
  campaign_id: string
  /** Reporting email alias (curator.brand.campaignid@reports.example.com) —
   *  where SSP delivery reports for this campaign land. Follows campaign_id
   *  onto the deal sheet + email. OMITTED (not '') when underivable; both
   *  brief validators ignore unknown/absent keys, so older Cutlass ignores it. */
  reporting_email_alias?: string
  notes?: string
  deals: BriefDeal[]
  already_created_for_sheet: SheetOnlyRow[]
}

export interface BriefValidation {
  ok: boolean
  issues: string[]
}

function clientName(form: FormData): string {
  return form.brand || 'Client'
}

// Pull the tool name out of the canonical arg body's first line:
//   "Call mcp_<server>_<tool> with these EXACT arguments:"
function extractTool(promptInputs: string): string {
  const m = /Call\s+(\S+)\s+with/.exec(promptInputs)
  return m ? m[1] : ''
}

// Route through generateDealName so the brief carries EXACTLY the audit's
// names: a full override rides verbatim and a whitespace-only override falls
// back to the generated name.
function dealName(form: FormData, deal: DealEntry, dsp?: DspEntry): string {
  return generateDealName(form, deal, { dsp })
}

// Sheet-only pitch range per channel — the deal-brief.schema.yaml canonical
// ranges. INDEPENDENT of `floor` (the SSP auction minimum); recommended_bid is
// what the trader pitches to the buyer. The SSP never sees it.
const RECOMMENDED_BID_BY_CHANNEL: Record<string, string> = {
  'Display': '$2-$5',
  'OLV (Online Video)': '$8-$12',
  'CTV': '$25-$35',
  'OTT': '$8-$12',
  'Native': '$2-$5',
  'Audio': '$8-$12',
}

function recommendedBid(channel: string): string {
  return RECOMMENDED_BID_BY_CHANNEL[channel] || '$2-$5'
}

// Numeric SSP floor for the brief record. The authoritative per-SSP floor lives
// in prompt_inputs (resolved per SSP); this mirrors the deal's CPM, defaulting
// to the conventional 0.10 minimum (same floor default the IX/OpenX builders
// use) when the deal carries no explicit CPM. Magnite is the exception: its
// floor is the publisher-tab CPM floor from the Magnite config (default 0.10),
// NEVER the deal CPM — see buildMagnitePrompt (Sun Bum incident, 2026-07).
// PubMatic is the other exception: no deal-level floor ships AT ALL — a
// flooreCPM forces Fixed Price on PubMatic and the deal transacts at that
// exact CPM (PM-ZOOR-0075, 2026-08-19) — so the brief records 0 to stay
// honest. See buildPubMaticPrompt.
function dealFloor(form: FormData, deal: DealEntry): number {
  if (deal.ssp === 'PubMatic') return 0
  if (deal.ssp === 'Magnite') {
    // Mirror buildMagnitePrompt's price-type branch: plain Market Rate has NO
    // floor (record 0 so the brief stays honest); Market Rate with Minimum /
    // CPM carry the config floor (default 0.10). CTV
    // routes to SpringServe, where MRwM is unsupported and the prompt
    // downgrades to Market Rate (#228) — the brief floor must match (0).
    const pt = form.magniteConfig.priceType || 'Market Rate with Minimum'
    if (pt === 'Market Rate') return 0
    if (pt === 'Market Rate with Minimum' && deal.channel === 'CTV') return 0
    const mg = parseFloat((form.magniteConfig.floorCpm ?? '').trim())
    return Number.isFinite(mg) && mg > 0 ? mg : 0.1
  }
  const n = parseFloat(deal.cpm || '')
  return Number.isFinite(n) && n > 0 ? n : 0.1
}

/** Build a structured deal brief from the form. Sheet-only rows are separated
 *  from create rows; create rows carry exact tool routing metadata. */
export function buildBatchBrief(
  form: FormData,
  standardLists: StandardList[] = [],
): DealBriefDoc {
  // Shared split + multi-DSP expansion with buildBatchPrompt
  // (dealPromptYaml.ts splitBatchPairs) — brief and prompt must never
  // disagree on which rows create, which only ride the sheet, or how the
  // batch expands across DSPs (the runner.go gate compares brief names to the
  // audit's expanded set 1:1).
  const { createPairs, sheetOnlyPairs } = splitBatchPairs(form)

  const deals: BriefDeal[] = createPairs.map(({ deal, dsp }, i) => {
    const body = generateDealPromptYaml(form, deal, i, createPairs.length, standardLists, dsp)
    // Brief-schema ad_duration: the allowed list wins when present (the two
    // forms are schema alternatives — never both). A max-only requirement
    // has no derivable min, so it carries max_seconds alone.
    const dur = resolveAdDuration(deal)
    const ad_duration = dur
      ? (dur.allowed.length > 0 ? { allowed_durations: dur.allowed } : { max_seconds: dur.maxSecs as number })
      : undefined
    return {
      ssp: deal.ssp,
      tool: extractTool(body),
      channel: deal.channel || '',
      deal_name: dealName(form, deal, dsp),
      recommended_bid: recommendedBid(deal.channel || ''),
      floor: dealFloor(form, deal),
      ...(ad_duration ? { ad_duration } : {}),
      prompt_inputs: body,
    }
  })

  const already_created_for_sheet: SheetOnlyRow[] = sheetOnlyPairs.map(({ deal, dsp }) => ({
    ssp: deal.ssp,
    channel: deal.channel || '',
    deal_name: dealName(form, deal, dsp),
    status: 'already_created',
  }))

  // Same resolution as buildBatchPrompt: explicit form pick → default,
  // clamped to the registered theme set so the brief never carries a value
  // build_deal_sheet would reject.
  const requestedTheme = form.dealSheetTheme || DEFAULT_DEAL_SHEET_THEME

  // First chip-input address is the To (the protocol's single-trader
  // `recipient`); the rest cc the same email (mirrors buildBatchPrompt).
  const allRecipients = splitEmails(form.dealSheetRecipient)
  const ccRecipients = allRecipients.slice(1)

  return {
    schema_version: DEAL_BRIEF_SCHEMA_VERSION,
    client_name: clientName(form),
    partner: form.dataPartner || curator(form),
    recipient: allRecipients[0] || '',
    ...(ccRecipients.length > 0 ? { cc_recipients: ccRecipients } : {}),
    theme: KNOWN_DEAL_SHEET_THEMES.includes(requestedTheme) ? requestedTheme : DEFAULT_DEAL_SHEET_THEME,
    campaign_id: form.campaignId || '',
    deals,
    already_created_for_sheet,
  }
}

/** Serialize to a stable JSON string for a file attachment (no indentation
 *  ambiguity, every newline/`>`/`:` inside a value safely escaped). */
export function serializeBrief(doc: DealBriefDoc): string {
  return JSON.stringify(doc, null, 2)
}

const UNRESOLVED_TOKEN = /<FILL|\$\{|\{\{|<UNSET/

/** The attachment set a submit will actually carry, for validateBrief's
 *  fail-closed reference cross-check (#221):
 *    listNames — upload names of the standard lists in the submit's listIds
 *                (standardListUploadName — the registry name plus the data
 *                file's extension, #198; runner.go uploads each under the same
 *                UploadName, and dealFilePath emits it via standardListAsFile);
 *    fileNames — ORIGINAL client filenames of the ad-hoc uploads in filePaths
 *                (runner.go uploads each under its paired fileNames entry, #157). */
export interface BriefAttachments {
  listNames: string[]
  fileNames: string[]
}

/** Every attachment name a per-deal arg body references. Patterns match the
 *  exact emissions in dealPromptYaml.ts:
 *    - fileArgsBlock:              domain_file_path: "<name>" /
 *                                  app_bundle_file_path: <name>
 *    - Media.net + TripleLift post-create merge blocks:
 *                                  `#     values_file: <name>` (unquoted —
 *                                  names may contain spaces)
 *  Exported so tests can pin the patterns against the real emissions. */
export function referencedFileNames(promptInputs: string): string[] {
  const names: string[] = []
  const push = (raw: string) => {
    const n = unquoteFileRef(raw)
    if (n && !names.includes(n)) names.push(n)
  }
  for (const m of promptInputs.matchAll(/^[ \t]*(?:domain|app_bundle)_file_path:[ \t]*(.+)$/gm)) push(m[1])
  for (const m of promptInputs.matchAll(/^[ \t]*#[ \t]*values_file:[ \t]*(.+)$/gm)) push(m[1])
  return names
}

// Undo quote() for a referenced name: a quoted value is unescaped; an
// unquoted value keeps everything up to a trailing `<ws>#` comment.
function unquoteFileRef(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s)
    if (m) return m[1].replace(/\\(.)/g, '$1')
  }
  return s.replace(/[ \t]+#.*$/, '').trim()
}

/** Validate a structured brief before handoff. Catches the exact transport
 *  hazards from the failed batch: unresolved placeholders, missing tool
 *  routing, sheet-only rows leaking a create tool, blank envelope fields.
 *  When `attachments` is supplied (both submit call sites pass it), ALSO
 *  fail closed on any prompt_inputs list/file reference absent from the
 *  attachment set (#221) — a referenced-but-unattached list means
 *  IX/OpenX/PubMatic fail missing_domain_file and Media.net creates the deal
 *  LIVE without its list. Omitting `attachments` skips only that check
 *  (legacy/preview callers). */
export function validateBrief(doc: DealBriefDoc, attachments?: BriefAttachments): BriefValidation {
  const issues: string[] = []
  if (!doc.client_name) issues.push('client_name is required')
  if (!doc.recipient || UNRESOLVED_TOKEN.test(doc.recipient)) issues.push('recipient is missing or unresolved')
  if (!doc.campaign_id) issues.push('campaign_id is required')
  if (doc.deals.length === 0 && doc.already_created_for_sheet.length === 0) issues.push('brief has no deals')

  const attached = attachments
    ? new Set([...attachments.listNames, ...attachments.fileNames])
    : null

  doc.deals.forEach((d, i) => {
    const label = d.deal_name || `deal[${i}]`
    if (!d.ssp) issues.push(`${label}: ssp is required`)
    if (!d.tool || !d.tool.startsWith('mcp_')) issues.push(`${label}: missing/invalid tool routing (${d.tool || 'none'})`)
    if (!d.deal_name) issues.push(`deal[${i}]: deal_name is required`)
    // recommended_bid + channel are REQUIRED_DEAL_FIELDS in the Cutlass
    // validate_brief — gate them here so a brief that passes locally also
    // passes server-side.
    if (!d.channel) issues.push(`${label}: channel is required`)
    if (!d.recommended_bid) issues.push(`${label}: recommended_bid is required`)
    if (!d.prompt_inputs) issues.push(`${label}: prompt_inputs is empty`)
    if (UNRESOLVED_TOKEN.test(d.prompt_inputs)) issues.push(`${label}: prompt_inputs contains an unresolved token (<FILL/\${}/{{}}/<UNSET)`)
    if (UNRESOLVED_TOKEN.test(d.deal_name)) issues.push(`${label}: deal_name contains an unresolved token`)
    if (attached) {
      for (const ref of referencedFileNames(d.prompt_inputs)) {
        if (!attached.has(ref)) {
          issues.push(`${label}: prompt references list/file "${ref}" but it is not in the attachment set (listIds + filePaths) — the SSP MCP would fail missing_domain_file or skip the post-create merge`)
        }
      }
    }
  })

  doc.already_created_for_sheet.forEach((row, i) => {
    if (!row.deal_name) issues.push(`already_created[${i}]: deal_name is required`)
    // Sheet-only rows must never carry create-tool routing.
    if ('tool' in (row as unknown as Record<string, unknown>)) {
      issues.push(`${row.deal_name}: sheet-only row must not carry a tool`)
    }
  })

  return { ok: issues.length === 0, issues }
}

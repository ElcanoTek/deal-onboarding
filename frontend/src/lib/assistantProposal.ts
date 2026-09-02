import type { DealEntry, FormData } from '../types/deal'
import type { DealChatChange } from './dealChatApi'

/** A form rewrite the assistant proposed but the trader has not confirmed.
 *  The chat NEVER mutates the builder's form directly: a `form.update` event
 *  lands here first, renders as a diff preview, and only Apply hands it to
 *  the parent's setForm. */
export interface AssistantProposal {
  /** The complete mutated form the edit_deal tool returned (hydrated). */
  form: FormData
  summary: string
  changes: DealChatChange[]
  /** Server-side deterministic validation issues on the proposed form. */
  validation: string[]
}

/** One rendered row of the diff preview. */
export interface ProposalDiffRow {
  /** "Deal 3", "Deals", or "Campaign". */
  scope: string
  description: string
}

export interface ProposalDiff {
  rows: ProposalDiffRow[]
  dealsBefore: number
  dealsAfter: number
  /** Number of deals whose serialized shape differs (added, removed, or
   *  edited) — the "N deals changed" figure in the Applied line. */
  dealsChanged: number
}

/** The one-level undo snapshot kept after an Apply. */
export interface AppliedSnapshot {
  previous: FormData
  dealsChanged: number
  appliedAt: number
}

function dealKey(d: DealEntry): string {
  return JSON.stringify(d)
}

/** Count deals whose serialized shape differs between two forms, by deal id.
 *  Added and removed deals count once each; an edited deal counts once. */
export function countChangedDeals(prev: FormData, next: FormData): number {
  const before = new Map(prev.deals.map(d => [d.id, dealKey(d)]))
  const after = new Map(next.deals.map(d => [d.id, dealKey(d)]))
  let changed = 0
  for (const [id, key] of after) {
    if (!before.has(id) || before.get(id) !== key) changed++
  }
  for (const id of before.keys()) {
    if (!after.has(id)) changed++
  }
  return changed
}

/** Render the assistant's changes[] into per-deal rows for the diff preview.
 *  Paths like `deals[3].cpm` group under "Deal 4"; `deals[]` under "Deals";
 *  anything else is a campaign-level field. */
export function buildProposalDiff(prev: FormData, proposal: AssistantProposal): ProposalDiff {
  const rows: ProposalDiffRow[] = proposal.changes.map(c => {
    const path = (c.path || '').trim()
    const m = /^deals\[(\d+)\]/.exec(path)
    let scope = 'Campaign'
    if (m) scope = `Deal ${Number(m[1]) + 1}`
    else if (path.startsWith('deals')) scope = 'Deals'
    const field = m ? path.slice(m[0].length).replace(/^\./, '') : path
    const description = field && scope !== 'Deals' && !field.startsWith('deals') && field !== path
      ? `${field}: ${c.description}`
      : c.description
    return { scope, description }
  })
  return {
    rows,
    dealsBefore: prev.deals.length,
    dealsAfter: proposal.form.deals.length,
    dealsChanged: countChangedDeals(prev, proposal.form),
  }
}

/** Apply a confirmed proposal: hands the proposed form to `commit` (the
 *  builder's setForm) and returns the undo snapshot of the form it replaced. */
export function applyProposal(current: FormData, proposal: AssistantProposal, commit: (next: FormData) => void): AppliedSnapshot {
  const snapshot: AppliedSnapshot = {
    previous: current,
    dealsChanged: countChangedDeals(current, proposal.form),
    appliedAt: Date.now(),
  }
  commit(proposal.form)
  return snapshot
}

/** Undo the last Apply: restores the snapshotted form through `commit`. */
export function undoApplied(snapshot: AppliedSnapshot, commit: (next: FormData) => void): void {
  commit(snapshot.previous)
}

/** The one-line result the dock posts after an applied edit re-audits. */
export function appliedResultLine(dealsChanged: number, audit: { status: string; checks: { passed: boolean }[] } | null): string {
  const changed = `Applied: ${dealsChanged} deal${dealsChanged === 1 ? '' : 's'} changed.`
  if (!audit) return `${changed} Audit: pending.`
  const failures = audit.checks.filter(c => !c.passed).length
  if (audit.status === 'passed' || failures === 0) return `${changed} Audit: passed.`
  return `${changed} Audit: ${failures} failure${failures === 1 ? '' : 's'} remain${failures === 1 ? 's' : ''}.`
}

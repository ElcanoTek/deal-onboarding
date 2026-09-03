// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useState } from 'react'
import { AuditAIInsight, AuditAIResult, AuditResult as AuditResultType, AuditCheck, DealEntry } from '../types/deal'
import { checkToSectionId } from '../lib/sectionStatus'
import { fieldPathToElementId } from '../lib/sectionStatus'
import { requestJumpReveal } from '../lib/reveal'
import { auditInsightKey } from '../lib/qa'
import { QASpecialistReport } from './QASpecialistReport'

// Re-exported for existing imports (DealBuilder) — implementation lives in
// lib/qa.ts so the QA report component can share it without a cycle.
export { auditInsightKey }

interface Props {
  result: AuditResultType
  /** Current form deals — used to resolve per-deal jump targets (DealsList
   *  keys input ids by deal.id, not index). */
  deals?: DealEntry[]
  onJumpToSection?: (sectionId: string) => void
  aiResult?: AuditAIResult | null
  aiLoading?: boolean
  aiError?: string
  /** Keys of AI insights the trader has dismissed (so a critical no longer
   *  blocks creation). Toggled via onDismissInsight. */
  dismissedInsights?: Set<string>
  onDismissInsight?: (insight: AuditAIInsight) => void
  /** Expand the full checklist even on a passing audit — the Deal Summary
   *  review step shows the checks as its audit checklist rather than hiding
   *  them behind "Show details". */
  defaultExpanded?: boolean
  /** True when the form changed since this audit ran — the result is stale and
   *  must be re-run. Dims the panel and shows a re-audit prompt. */
  stale?: boolean
  /** "Fix with assistant": opens the Deal Assistant dock pre-filled with the
   *  failing check (rule + message + deal). Rendered on every failing row and
   *  QA warning when provided. */
  onAskAssistant?: (text: string) => void
}

/** The composer text a "Fix with assistant" hand-off seeds for a check. */
export function assistantFixText(check: Pick<AuditCheck, 'rule' | 'message' | 'dealIndex' | 'fieldPath'>): string {
  const deal = typeof check.dealIndex === 'number' && check.dealIndex >= 0 ? ` (Deal ${check.dealIndex + 1})` : ''
  const field = check.fieldPath ? ` [${check.fieldPath}]` : ''
  return `Fix: ${check.rule}${deal}${field} — ${check.message}`
}


function CheckIcon({ passed }: { passed: boolean }) {
  if (passed) {
    return (
      <svg className="audit-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    )
  }
  return (
    <svg className="audit-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function StatusIcon({ status }: { status: AuditResultType['status'] }) {
  if (status === 'passed') {
    return (
      <svg className="audit-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
      </svg>
    )
  }
  if (status === 'warnings') {
    return (
      <svg className="audit-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    )
  }
  return (
    <svg className="audit-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function statusTitle(result: AuditResultType): string {
  const failCount = result.checks.filter(c => !c.passed).length
  if (result.status === 'passed') return `Audit Passed — Ready to create ${result.total_deals} deal${result.total_deals !== 1 ? 's' : ''}.`
  if (result.status === 'warnings') return `Audit Passed with ${failCount} warning${failCount !== 1 ? 's' : ''}.`
  return `Audit Failed — ${failCount} error${failCount !== 1 ? 's' : ''} found.`
}

function severityBadge(s: AuditAIInsight['severity']): string {
  switch (s) {
    case 'critical': return 'audit-ai-insight--critical'
    case 'warn': return 'audit-ai-insight--warn'
    default: return 'audit-ai-insight--info'
  }
}

function severityLabel(s: AuditAIInsight['severity']): string {
  switch (s) {
    case 'critical': return 'CRITICAL'
    case 'warn': return 'WARN'
    default: return 'INFO'
  }
}

export function AuditResult({ result, deals, onJumpToSection, aiResult, aiLoading, aiError, dismissedInsights, onDismissInsight, defaultExpanded, stale, onAskAssistant }: Props) {
  const [expanded, setExpanded] = useState(result.status !== 'passed' || !!defaultExpanded)
  const dismissed = dismissedInsights ?? new Set<string>()
  const failedChecks = result.checks.filter((c: AuditCheck) => !c.passed)
  const passedChecks = result.checks.filter((c: AuditCheck) => c.passed)
  const insights = aiResult?.insights ?? []
  const aiBlockingCount = insights.filter(i => i.severity === 'critical' && !dismissed.has(auditInsightKey(i))).length

  return (
    <div className={`audit-banner ${result.status}${stale ? ' audit-banner--stale' : ''}`} role="status" aria-live="polite">
      {stale && (
        <div className="audit-stale-notice" role="alert">
          You’ve edited the form since this audit ran — these results are out of date.
          Click <strong>Re-audit Deals</strong> to re-check.
        </div>
      )}
      <div className="audit-banner-header">
        <StatusIcon status={result.status} />
        <span className="audit-banner-title">{statusTitle(result)}</span>
        <button
          type="button"
          className="audit-banner-toggle"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {expanded && result.qa && (
        <div className="audit-checks-list">
          {failedChecks.length > 0 && (
            <div className="audit-blockers" role="alert">
              <span className="audit-blockers__count">{failedChecks.length}</span>
              {failedChecks.length === 1 ? ' blocker' : ' blockers'} must be fixed before these deals can be created — every flag below carries exact fix guidance.
            </div>
          )}
          {aiBlockingCount > 0 && (
            <div className="audit-blockers" role="alert">
              <span className="audit-blockers__count">{aiBlockingCount}</span>
              critical AI {aiBlockingCount === 1 ? 'issue' : 'issues'} {aiBlockingCount === 1 ? 'blocks' : 'block'} creation — resolve the deal or dismiss the {aiBlockingCount === 1 ? 'issue' : 'issues'} below to proceed.
            </div>
          )}
          <QASpecialistReport
            report={result.qa}
            deals={deals ?? []}
            onJumpToSection={onJumpToSection}
            aiInsights={insights}
            aiLoading={aiLoading}
            aiError={aiError}
            dismissedInsights={dismissed}
            onDismissInsight={onDismissInsight}
            onAskAssistant={onAskAssistant}
          />
        </div>
      )}

      {expanded && !result.qa && (
        <div className="audit-checks-list">
          {failedChecks.length > 0 && (
            <div className="audit-blockers" role="alert">
              <span className="audit-blockers__count">{failedChecks.length}</span>
              {failedChecks.length === 1 ? ' blocker' : ' blockers'} must be fixed before these deals can be created — resolve every item below.
            </div>
          )}
          {failedChecks.map((c: AuditCheck, i: number) => {
            const section = checkToSectionId(c)
            const hasDeal = typeof c.dealIndex === 'number' && c.dealIndex >= 0
            const fieldLabel = [hasDeal ? `Deal ${(c.dealIndex as number) + 1}` : '', c.fieldPath || '']
              .filter(Boolean)
              .join(' · ')
            // Prefer scrolling+focusing the exact field over a section anchor
            // jump — the trader lands on the input that needs fixing, not the
            // top of a section they then have to scan. Falls back to the
            // section anchor for rules without a fieldPath.
            const targetElementId = fieldPathToElementId(c)
            const handleFix = () => {
              if (section && onJumpToSection) onJumpToSection(section)
              if (!targetElementId) return
              // A collapsed deal card keeps its fields out of the DOM — ask it
              // to expand before the delayed lookup below runs.
              requestJumpReveal(targetElementId)
              // Section toggle is async (the parent uses setTimeout(60)) — wait
              // a beat so the field is in the DOM before we scroll/focus it.
              window.setTimeout(() => {
                const el = document.getElementById(targetElementId)
                if (!el) return
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
                  el.focus({ preventScroll: true })
                }
              }, 150)
            }
            return (
              <div key={`${c.rule}-${c.dealIndex ?? ''}-${c.fieldPath ?? ''}-${i}`} className="audit-check check-fail">
                <CheckIcon passed={false} />
                <span className="audit-check-message">
                  {c.message}
                  {fieldLabel && <span className="audit-check-field" title="Field to fix">{fieldLabel}</span>}
                </span>
                {section && onJumpToSection && (
                  <button
                    type="button"
                    className="audit-check-fix"
                    onClick={handleFix}
                    aria-label={`Jump to ${section} section to fix this`}
                  >
                    Fix →
                  </button>
                )}
                {onAskAssistant && (
                  <button
                    type="button"
                    className="audit-check-ask"
                    onClick={() => onAskAssistant(assistantFixText(c))}
                    aria-label="Fix this with the Deal Assistant"
                  >
                    Fix with assistant
                  </button>
                )}
              </div>
            )
          })}
          {passedChecks.map((c: AuditCheck, i: number) => (
            <div key={`${c.rule}-pass-${i}`} className="audit-check check-pass">
              <CheckIcon passed={true} />
              <span className="audit-check-message">{c.message}</span>
            </div>
          ))}
          {result.inferred?.iab_categories?.length > 0 && (
            <div className="audit-check" style={{ color: 'var(--color-info)' }}>
              <svg className="audit-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span className="audit-check-message">
                {result.inferred.per_deal?.length
                  ? <>Inferred IAB per deal: {result.inferred.per_deal.map(d => `Deal ${d.deal_index + 1} → ${d.iab_categories.join(', ')}`).join(' · ')} — {result.inferred.note}</>
                  : <>Inferred IAB: {result.inferred.iab_categories.join(', ')} — {result.inferred.note}</>}
              </span>
            </div>
          )}

          <div className="audit-ai-section" aria-live="polite">
            <h3 className="audit-ai-section__heading">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem', marginRight: '0.4rem', verticalAlign: '-2px' }} aria-hidden="true">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
              </svg>
              AI Audit
              {aiLoading && <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--font-size-caption)', fontWeight: 400, opacity: 0.7 }}>analyzing…</span>}
            </h3>
            {aiLoading && !aiResult && (
              <div className="audit-ai-empty">
                <span className="btn-spinner" aria-hidden="true" />
                Reading the brief, comparing to client conventions and SSP norms…
              </div>
            )}
            {aiError && !aiLoading && (
              <div className="audit-ai-empty audit-ai-empty--error">AI audit error: {aiError}</div>
            )}
            {!aiLoading && !aiError && aiResult && insights.length === 0 && (
              <div className="audit-ai-empty">No fuzzy issues found. Rule-based audit covered everything.</div>
            )}
            {aiBlockingCount > 0 && (
              <div className="audit-blockers" role="alert">
                <span className="audit-blockers__count">{aiBlockingCount}</span>
                critical AI {aiBlockingCount === 1 ? 'issue' : 'issues'} {aiBlockingCount === 1 ? 'blocks' : 'block'} creation — resolve the deal or dismiss the {aiBlockingCount === 1 ? 'issue' : 'issues'} below to proceed.
              </div>
            )}
            {insights.map((insight, i) => {
              const key = auditInsightKey(insight)
              const isDismissed = dismissed.has(key)
              const blocks = insight.severity === 'critical' && !isDismissed
              return (
                <div key={i} className={`audit-ai-insight ${severityBadge(insight.severity)}${isDismissed ? ' audit-ai-insight--dismissed' : ''}`}>
                  <span className={`audit-ai-insight__sev ${severityBadge(insight.severity)}__sev`}>{severityLabel(insight.severity)}</span>
                  <span className="audit-ai-insight__msg">
                    {insight.message}
                    {blocks && <span className="audit-ai-insight__blocks" title="Resolve or dismiss to enable creation">blocks creation</span>}
                  </span>
                  <span className="audit-ai-insight__actions">
                    {insight.fieldHint && onJumpToSection && (
                      <button
                        type="button"
                        className="audit-check-fix"
                        onClick={() => onJumpToSection(jumpTargetForFieldHint(insight.fieldHint!))}
                        aria-label={`Jump to ${insight.fieldHint}`}
                      >
                        Jump →
                      </button>
                    )}
                    {onDismissInsight && (
                      <button
                        type="button"
                        className="audit-ai-insight__dismiss"
                        onClick={() => onDismissInsight(insight)}
                        aria-label={isDismissed ? 'Restore this insight' : 'Dismiss this insight'}
                        title={isDismissed ? 'Restore (will count again)' : 'Dismiss — acknowledge and ignore'}
                      >
                        {isDismissed ? 'Undo' : '✕'}
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Map an LLM-supplied fieldHint (e.g. "deals[2].cpm", "submitterEmail") to
 *  one of the existing section anchors so onJumpToSection can scroll. */
function jumpTargetForFieldHint(hint: string): string {
  if (hint.startsWith('deals[')) return 'deals'
  if (hint === 'submitterName' || hint === 'submitterEmail' || hint === 'flightStartDate' || hint === 'flightEndDate' || hint === 'requestedDueDate') return 'submitter'
  if (hint === 'agency' || hint === 'brand' || hint === 'campaignId' || hint === 'campaignName' || hint === 'reportingLabels.salesperson' || hint === 'salesperson'
      || hint === 'curatedDealFee' || hint === 'feeType' || hint === 'dailyPacingGoal' || hint === 'kpiGoal') return 'client'
  if (hint.startsWith('dsps') || hint === 'seatId') return 'dsp'
  if (hint.endsWith('Config') || hint.includes('xandrConfig') || hint.includes('openxConfig') || hint.includes('pubmaticConfig') || hint.includes('medianetConfig') || hint.includes('tripleliftConfig') || hint.includes('ixConfig') || hint.includes('magniteConfig')) return 'ssp'
  return 'deals'
}

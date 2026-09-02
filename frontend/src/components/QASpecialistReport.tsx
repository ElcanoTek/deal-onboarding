import { useEffect, useMemo, useState } from 'react'
import { AuditAIInsight, DealEntry, QAItem, QAReport, QASection } from '../types/deal'
import { auditInsightKey, groupInsightsBySection, QA_OUTCOME_LABEL, qaJumpElementId } from '../lib/qa'
import { checkToSectionId } from '../lib/sectionStatus'
import { requestJumpReveal } from '../lib/reveal'

interface Props {
  report: QAReport
  deals: DealEntry[]
  onJumpToSection?: (sectionId: string) => void
  aiInsights: AuditAIInsight[]
  aiLoading?: boolean
  aiError?: string
  dismissedInsights: Set<string>
  onDismissInsight?: (insight: AuditAIInsight) => void
  /** "Fix with assistant" on flags and warnings — opens the Deal Assistant
   *  pre-filled with the item's rule, label, and fix guidance. */
  onAskAssistant?: (text: string) => void
}

/** The composer text a "Fix with assistant" hand-off seeds for a QA item. */
export function assistantFixTextForItem(item: Pick<QAItem, 'rule' | 'label' | 'detail' | 'fix' | 'dealIndex' | 'fieldPath'>): string {
  const deal = typeof item.dealIndex === 'number' && item.dealIndex >= 0 ? ` (Deal ${item.dealIndex + 1})` : ''
  const field = item.fieldPath ? ` [${item.fieldPath}]` : ''
  const rule = item.rule ? `${item.rule}` : 'qa'
  const body = [item.label, item.detail, item.fix ? `Fix guidance: ${item.fix}` : ''].filter(Boolean).join(' — ')
  return `Fix: ${rule}${deal}${field} — ${body}`
}

/** Map a QA item to the workspace section anchor for the fallback jump when
 *  no concrete input id resolves. Items without a fieldPath still resolve
 *  through their originating rule (RULE_TO_SECTION_ID) — rules like
 *  deals_required carry no field but must keep a
 *  working Fix button, same as the old flat check list. */
function itemSectionAnchor(item: Pick<QAItem, 'fieldPath' | 'rule'>): string | undefined {
  if (!item.fieldPath && !item.rule) return undefined
  return checkToSectionId({ rule: item.rule ?? '', passed: false, message: '', fieldPath: item.fieldPath })
}

function StatusGlyph({ status }: { status: QAItem['status'] }) {
  switch (status) {
    case 'pass':
      return (
        <svg className="qa-item__icon qa-item__icon--pass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )
    case 'flag':
      return (
        <svg className="qa-item__icon qa-item__icon--flag" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      )
    case 'warn':
      return (
        <svg className="qa-item__icon qa-item__icon--warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      )
    case 'na':
      return (
        <svg className="qa-item__icon qa-item__icon--na" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )
    default:
      return null // manual renders a real checkbox instead
  }
}

/** Section health including its AI insights — a collapsed section must never
 *  show a green dot while a blocking critical insight hides inside it. */
function sectionRollup(section: QASection, sectionAI: AuditAIInsight[] = [], dismissed: Set<string> = new Set(), dismissedItems: Set<string> = new Set()): 'flag' | 'warn' | 'pass' {
  const liveAI = sectionAI.filter(i => !dismissed.has(auditInsightKey(i)))
  section = { ...section, items: section.items.filter(i => !dismissedItems.has(i.id)) }
  if (section.items.some(i => i.status === 'flag') || liveAI.some(i => i.severity === 'critical')) return 'flag'
  if (section.items.some(i => i.status === 'warn') || liveAI.some(i => i.severity === 'warn')) return 'warn'
  return 'pass'
}

function severityClass(s: AuditAIInsight['severity']): string {
  switch (s) {
    case 'critical': return 'audit-ai-insight--critical'
    case 'warn': return 'audit-ai-insight--warn'
    default: return 'audit-ai-insight--info'
  }
}

/** The Deal QA Specialist report — the pre-launch QA checklist,
 *  section by section: hard-validation flags with exact fix guidance and
 *  jump-to-field, best-practice advisories, and manual confirmations the
 *  trader ticks off. AI insights tagged with a qaSection render inside
 *  their section so the whole review reads as one checklist. */
export function QASpecialistReport({ report, deals, onJumpToSection, aiInsights, aiLoading, aiError, dismissedInsights, onDismissInsight, onAskAssistant }: Props) {
  // Sections holding flags/warns start open; clean ones start collapsed.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const open: Record<string, boolean> = {}
    for (const s of report.sections) open[s.id] = sectionRollup(s) !== 'pass'
    return open
  })
  // AI insights land asynchronously after mount — force-open any section that
  // gains a non-dismissed CRITICAL insight so a creation blocker is never
  // hidden behind a collapsed header.
  useEffect(() => {
    const mustOpen = aiInsights
      .filter(i => i.severity === 'critical' && !dismissedInsights.has(auditInsightKey(i)) && i.qaSection)
      .map(i => i.qaSection as string)
    if (mustOpen.length === 0) return
    setOpenSections(prev => {
      let changed = false
      const next = { ...prev }
      for (const id of mustOpen) if (!next[id]) { next[id] = true; changed = true }
      return changed ? next : prev
    })
  }, [aiInsights, dismissedInsights])
  // Manual confirmations are per-report working state — a re-audit resets
  // them on purpose: after changes, the trader re-verifies.
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const toggleConfirmed = (id: string) =>
    setConfirmed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // Dismissed checklist items — the trader's "seen it, creating anyway"
  // acknowledgement for flags/advisories. Working state like manual
  // confirmations, keyed by item id: a re-audit that re-raises the same item
  // stays dismissed; a changed item (new id) resurfaces. NOTE: this never
  // unblocks anything the RULE audit failed — those are re-enforced
  // server-side at submit; only the QA/specialist layer is dismissible.
  const [dismissedItems, setDismissedItems] = useState<Set<string>>(new Set())
  const toggleDismissItem = (id: string) =>
    setDismissedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const { bySection: aiBySection, general: aiGeneral } = useMemo(
    () => groupInsightsBySection(aiInsights),
    [aiInsights],
  )

  const manualTotal = report.counts.manual
  const outcomeLabel = QA_OUTCOME_LABEL[report.outcome] ?? report.outcome
  // Header counts use the SAME math as the per-section badges (checklist
  // items minus dismissals, plus live Specialist-review findings) — the old
  // header counted checklist warns only, so sections could show more orange
  // than the total claimed.
  const allItems = report.sections.flatMap(s => s.items)
  const liveFlagCount = allItems.filter(i => i.status === 'flag' && !dismissedItems.has(i.id)).length
  const liveWarnCount = allItems.filter(i => i.status === 'warn' && !dismissedItems.has(i.id)).length
    + aiInsights.filter(i => i.severity !== 'info' && !dismissedInsights.has(auditInsightKey(i))).length
  const dismissedCount = dismissedItems.size + (aiInsights ?? []).filter(i => dismissedInsights.has(auditInsightKey(i))).length

  const jumpTo = (item: Pick<QAItem, 'fieldPath' | 'rule'>, fallbackSection?: string) => {
    const section = itemSectionAnchor(item) ?? fallbackSection
    if (section && onJumpToSection) onJumpToSection(section)
    const elementId = qaJumpElementId(item, deals)
    if (!elementId) return
    // A collapsed deal card keeps its fields out of the DOM — ask it to
    // expand before the delayed lookup below runs.
    requestJumpReveal(elementId)
    // Section toggle is async (the parent uses setTimeout(60)) — wait a beat
    // so the field is in the DOM before we scroll/focus it.
    window.setTimeout(() => {
      const el = document.getElementById(elementId)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        el.focus({ preventScroll: true })
      }
    }, 150)
  }

  const renderInsight = (insight: AuditAIInsight) => {
    const key = auditInsightKey(insight)
    const isDismissed = dismissedInsights.has(key)
    const blocks = insight.severity === 'critical' && !isDismissed
    return (
      <div key={key} className={`audit-ai-insight ${severityClass(insight.severity)}${isDismissed ? ' audit-ai-insight--dismissed' : ''}`}>
        <span className={`audit-ai-insight__sev ${severityClass(insight.severity)}__sev`}>
          {insight.severity === 'critical' ? 'CRITICAL' : insight.severity === 'warn' ? 'WARN' : 'INFO'}
        </span>
        <span className="audit-ai-insight__msg">
          {insight.message}
          {blocks && <span className="audit-ai-insight__blocks" title="Resolve or dismiss to enable creation">blocks creation</span>}
        </span>
        <span className="audit-ai-insight__actions">
          {insight.fieldHint && (
            <button
              type="button"
              className="audit-check-fix"
              onClick={() => jumpTo({ fieldPath: insight.fieldHint }, 'deals')}
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
  }

  return (
    <div className="qa-report">
      <div className="qa-report__header">
        <div className="qa-report__title-row">
          <svg className="qa-report__badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
          </svg>
          <div>
            <h3 className="qa-report__title">Deal QA Specialist</h3>
            <p className="qa-report__subtitle">Pre-launch deal build QA — checked against the QA best-practices checklist.</p>
          </div>
          <span className={`qa-outcome qa-outcome--${report.outcome}`}>{outcomeLabel}</span>
        </div>
        <p className="qa-report__summary">{report.summary}</p>
        <div className="qa-report__counts" aria-label="QA result counts">
          <span className="qa-count qa-count--pass" title="Checks that verified good — nothing to do.">{report.counts.pass} passed</span>
          {liveFlagCount > 0 && <span className="qa-count qa-count--flag" title="Likely mistakes worth fixing before you create. Flags don't block submission — only the rule audit's failures do — and each can be dismissed (✕) if intentional.">{liveFlagCount} flag{liveFlagCount !== 1 ? 's' : ''}</span>}
          {liveWarnCount > 0 && <span className="qa-count qa-count--warn" title="Advisories — worth a look, never blocking. This total matches the per-section 'to review' badges: checklist advisories plus Specialist-review findings, minus anything you've dismissed.">{liveWarnCount} advisor{liveWarnCount !== 1 ? 'ies' : 'y'}</span>}
          {manualTotal > 0 && <span className="qa-count qa-count--manual" title="Manual checks — tick each once you've verified it by hand.">{confirmed.size}/{manualTotal} confirmed</span>}
          {dismissedCount > 0 && (
            <button
              type="button"
              className="qa-count qa-count--dismissed"
              title="Items you dismissed — they stay out of the counts. Click to restore all."
              onClick={() => { setDismissedItems(new Set()); (aiInsights ?? []).forEach(i => { if (dismissedInsights.has(auditInsightKey(i))) onDismissInsight?.(i) }) }}
            >
              {dismissedCount} dismissed · restore
            </button>
          )}
        </div>
      </div>

      {report.sections.map(section => {
        const sectionAI = aiBySection[section.id] ?? []
        const rollup = sectionRollup(section, sectionAI, dismissedInsights, dismissedItems)
        const open = openSections[section.id] ?? false
        const flagCount = section.items.filter(i => i.status === 'flag' && !dismissedItems.has(i.id)).length
        const warnCount = section.items.filter(i => i.status === 'warn' && !dismissedItems.has(i.id)).length
          + sectionAI.filter(i => i.severity !== 'info' && !dismissedInsights.has(auditInsightKey(i))).length
        if (section.items.length === 0 && sectionAI.length === 0) return null
        return (
          <section key={section.id} className={`qa-section qa-section--${rollup}`}>
            <button
              type="button"
              className="qa-section__head"
              aria-expanded={open}
              onClick={() => setOpenSections(prev => ({ ...prev, [section.id]: !open }))}
            >
              <span className={`qa-section__dot qa-section__dot--${rollup}`} aria-hidden="true" />
              <span className="qa-section__title">{section.title}</span>
              {flagCount > 0 && <span className="qa-section__badge qa-section__badge--flag">{flagCount} to fix</span>}
              {flagCount === 0 && warnCount > 0 && <span className="qa-section__badge qa-section__badge--warn">{warnCount} to review</span>}
              <span className="qa-section__chevron" aria-hidden="true">{open ? '−' : '+'}</span>
            </button>
            {open && (
              <div className="qa-section__body">
                {section.items.map(item => {
                  const canJump = Boolean(qaJumpElementId(item, deals) || itemSectionAnchor(item))
                  const isManual = item.status === 'manual'
                  const isConfirmed = confirmed.has(item.id)
                  const isItemDismissed = dismissedItems.has(item.id)
                  const dismissible = item.status === 'flag' || item.status === 'warn'
                  return (
                    <div key={item.id} className={`qa-item qa-item--${item.status}${isConfirmed ? ' qa-item--confirmed' : ''}${isItemDismissed ? ' qa-item--dismissed' : ''}`}>
                      {isManual ? (
                        <input
                          type="checkbox"
                          className="qa-item__confirm"
                          checked={isConfirmed}
                          onChange={() => toggleConfirmed(item.id)}
                          aria-label={`Mark confirmed: ${item.label}`}
                          title="Manual check — tick once you've verified it"
                        />
                      ) : (
                        <StatusGlyph status={item.status} />
                      )}
                      <div className="qa-item__text">
                        <span className="qa-item__label">{item.label}</span>
                        {item.detail && <span className="qa-item__detail">{item.detail}</span>}
                        {item.fix && item.status !== 'pass' && (
                          <span className="qa-item__fix">
                            <strong>{item.status === 'manual' ? 'How to verify:' : 'What to fix:'}</strong> {item.fix}
                          </span>
                        )}
                      </div>
                      {canJump && item.status !== 'pass' && item.status !== 'na' && !isItemDismissed && (
                        <button
                          type="button"
                          className="audit-check-fix"
                          onClick={() => jumpTo(item)}
                          aria-label={`Jump to the field for: ${item.label}`}
                        >
                          Fix →
                        </button>
                      )}
                      {onAskAssistant && dismissible && !isItemDismissed && (
                        <button
                          type="button"
                          className="audit-check-ask"
                          onClick={() => onAskAssistant(assistantFixTextForItem(item))}
                          aria-label={`Fix with the Deal Assistant: ${item.label}`}
                        >
                          Fix with assistant
                        </button>
                      )}
                      {dismissible && (
                        <button
                          type="button"
                          className="qa-item__dismiss"
                          title={isItemDismissed ? 'Restore this item to the counts' : 'Dismiss — I\u2019ve reviewed this and I\u2019m creating anyway'}
                          aria-label={`${isItemDismissed ? 'Restore' : 'Dismiss'}: ${item.label}`}
                          onClick={() => toggleDismissItem(item.id)}
                        >
                          {isItemDismissed ? 'Restore' : '\u2715'}
                        </button>
                      )}
                    </div>
                  )
                })}
                {sectionAI.length > 0 && (
                  <div className="qa-section__ai">
                    <span className="qa-section__ai-label">Specialist review</span>
                    {sectionAI.map(renderInsight)}
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })}

      <div className="audit-ai-section" aria-live="polite">
        <h3 className="audit-ai-section__heading">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem', marginRight: '0.4rem', verticalAlign: '-2px' }} aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
          </svg>
          Specialist review (AI)
          {aiLoading && <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--font-size-caption)', fontWeight: 400, opacity: 0.7 }}>analyzing…</span>}
        </h3>
        {aiLoading && aiInsights.length === 0 && (
          <div className="audit-ai-empty">
            <span className="btn-spinner" aria-hidden="true" />
            Reading the brief against the QA checklist, client conventions and SSP norms…
          </div>
        )}
        {aiError && !aiLoading && (
          <div className="audit-ai-empty audit-ai-empty--error">AI review error: {aiError}</div>
        )}
        {!aiLoading && !aiError && aiInsights.length === 0 && (
          <div className="audit-ai-empty">No fuzzy issues found beyond the checklist above.</div>
        )}
        {!aiLoading && aiInsights.length > 0 && aiGeneral.length === 0 && (
          <div className="audit-ai-empty">All AI findings are filed under their checklist sections above.</div>
        )}
        {aiGeneral.map(renderInsight)}
      </div>
    </div>
  )
}

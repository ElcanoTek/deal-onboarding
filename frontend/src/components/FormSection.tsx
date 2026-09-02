import { createContext, ReactNode, useContext } from 'react'

/** Per-section chrome injected by the guided builder: the step-audit banner
 *  rendered as the first child of the section body, keyed by SectionId (the
 *  anchorId minus its `section-` prefix). Keeps the six section components
 *  free of wizard plumbing. */
export const SectionBannerContext = createContext<Partial<Record<string, ReactNode>>>({})

interface Props {
  number: string
  title: string
  /** Legacy collapse props — sections are always open in the guided builder.
   *  Kept so the section components don't need churn. */
  open?: boolean
  onToggle?: (next: boolean) => void
  /** Number of required fields filled and total — drives the status badge. */
  filled?: number
  total?: number
  /** Issues to show in the header badge. */
  issues?: number
  /** Anchor id for scroll-into-view from the audit result list. */
  anchorId?: string
  /** Extra header content after the title (e.g. the deal-count chip). */
  headerExtra?: ReactNode
  children: ReactNode
}

/** Fleet form-section card: numbered disc + title + status badge header and
 *  an always-open body. The status badge reads Complete / Needs info /
 *  N issues / Optional off the section's live validation counts. */
export function FormSection({
  number,
  title,
  filled,
  total,
  issues,
  anchorId,
  headerExtra,
  children,
}: Props) {
  const banners = useContext(SectionBannerContext)
  const sectionKey = anchorId?.startsWith('section-') ? anchorId.slice('section-'.length) : anchorId
  const banner = sectionKey ? banners[sectionKey] : undefined

  const showProgress = typeof filled === 'number' && typeof total === 'number' && total > 0
  const hasIssues = (issues ?? 0) > 0
  const allComplete = showProgress && filled === total && !hasIssues
  const optional = !showProgress && !hasIssues

  let badge: ReactNode
  if (hasIssues) {
    badge = (
      <span className="status-badge status-badge--warning" style={{ marginLeft: 'auto' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        {issues} {issues === 1 ? 'issue' : 'issues'}
      </span>
    )
  } else if (allComplete) {
    badge = (
      <span className="status-badge status-badge--success" style={{ marginLeft: 'auto' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        Complete
      </span>
    )
  } else if (optional) {
    badge = <span className="status-badge status-badge--muted" style={{ marginLeft: 'auto' }}>Optional</span>
  } else {
    badge = <span className="status-badge status-badge--warning" style={{ marginLeft: 'auto' }}>Needs info</span>
  }

  return (
    <section className="form-section" id={anchorId}>
      <div className="form-section__header">
        <span className="section-num">{number.replace(/^0/, '')}</span>
        <h3 className="form-section__title">{title}</h3>
        {headerExtra}
        {badge}
      </div>
      <div className="form-section__body">
        {banner}
        {children}
      </div>
    </section>
  )
}

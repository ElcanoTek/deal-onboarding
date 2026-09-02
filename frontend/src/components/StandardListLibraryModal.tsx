import { useMemo, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { StandardList } from '../types/deal'
import { formatLineCount, formatUpdated } from '../lib/lists'

interface Props {
  lists: StandardList[]
  /** Ids currently applied to the campaign (union of both scopes). */
  appliedIds: Set<string>
  onToggle: (list: StandardList) => void
  onClose: () => void
}

type ScopeFilter = 'all' | 'domain' | 'app_bundle'
type TypeFilter = 'all' | 'allow' | 'block'

const scopeLabel = (s: 'domain' | 'app_bundle') => (s === 'domain' ? 'Domain' : 'App bundle')

/** Browsable, searchable picker for the curated standard-list registry. Scales
 *  past the old inline chip rows: filter by scope/type, search by name, and the
 */
export function StandardListLibraryModal({ lists, appliedIds, onToggle, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [type, setType] = useState<TypeFilter>('all')
  const trapRef = useFocusTrap<HTMLDivElement>({ onEscape: onClose })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lists.filter(l => {
      if (scope !== 'all' && l.scope !== scope) return false
      if (type !== 'all' && l.kind !== type) return false
      if (q && !`${l.name} ${l.description || ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [lists, query, scope, type])


  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="list-library-title"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="modal modal--wide" ref={trapRef}>
        <button type="button" className="btn btn-ghost btn-icon btn-sm modal-close" aria-label="Close library" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.1rem', height: '1.1rem' }} aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <h2 className="modal-title" id="list-library-title">Standard list library</h2>

        <div className="list-library-modal__filters">
          <input
            className="field-input"
            placeholder="Search lists…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search standard lists"
          />
          <select className="field-select" value={scope} onChange={e => setScope(e.target.value as ScopeFilter)} aria-label="Filter by scope">
            <option value="all">All scopes</option>
            <option value="domain">Domain</option>
            <option value="app_bundle">App bundle</option>
          </select>
          <select className="field-select" value={type} onChange={e => setType(e.target.value as TypeFilter)} aria-label="Filter by type">
            <option value="all">Allow &amp; block</option>
            <option value="allow">Allow</option>
            <option value="block">Block</option>
          </select>
        </div>

        <div className="list-library-modal__body">
          {filtered.length === 0 ? (
            <p className="field-helper">No lists match your filters.</p>
          ) : (
            <>
              <ListTable lists={filtered} appliedIds={appliedIds} onToggle={onToggle} />
            </>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

function ListTable({
  heading, lists, appliedIds, onToggle,
}: {
  heading?: string
  lists: StandardList[]
  appliedIds: Set<string>
  onToggle: (list: StandardList) => void
}) {
  return (
    <div className="list-library-table">
      {heading && <div className="list-library-table__heading">{heading}</div>}
      {lists.map(l => {
        const applied = appliedIds.has(l.id)
        const count = formatLineCount(l.line_count)
        const updated = formatUpdated(l.updated_at)
        return (
          <div key={l.id} className="list-library-row">
            <div className="list-library-row__main">
              <span className="list-library-row__name">{l.name}</span>
              {l.description && <span className="list-library-row__desc">{l.description}</span>}
              {updated && <span className="list-library-row__updated">{updated}</span>}
            </div>
            <span className="list-library-row__scope">{scopeLabel(l.scope)}</span>
            <span className={`seg-tag seg-tag--${l.kind}`}>{l.kind === 'block' ? 'BLOCK' : 'ALLOW'}</span>
            <span className="list-library-row__count">{count || '—'}</span>
            <button
              type="button"
              className={`btn btn-sm ${applied ? 'btn-ghost' : 'btn-secondary'} list-library-row__toggle`}
              onClick={() => onToggle(l)}
              aria-pressed={applied}
            >
              {applied ? '✓ Added' : '+ Add'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

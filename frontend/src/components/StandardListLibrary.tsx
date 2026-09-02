import { useState } from 'react'
import type { FormData as DealForm, StandardList } from '../types/deal'
import { useStandardLists } from '../lib/lists'
import { StandardListLibraryModal } from './StandardListLibraryModal'

interface Props {
  form: DealForm
  update: <K extends keyof DealForm>(key: K, val: DealForm[K]) => void
  /** Bump to re-fetch (e.g. after "Save as standard" creates a new list). */
  reloadKey?: number
}

/** Campaign-level standard-list chooser. Shows the applied lists as removable
 *  chips and opens a browsable library modal — replaces the old per-scope
 *  inline chip rows so it scales as the curated registry grows. Applied ids
 *  live in form.appliedDomainListIds / appliedAppBundleListIds by scope. */
export function StandardListLibrary({ form, update, reloadKey }: Props) {
  const { lists, loading, error } = useStandardLists(reloadKey)
  const [open, setOpen] = useState(false)

  const appliedIds = new Set([...form.appliedDomainListIds, ...form.appliedAppBundleListIds])

  const keyFor = (scope: 'domain' | 'app_bundle') =>
    scope === 'domain' ? 'appliedDomainListIds' as const : 'appliedAppBundleListIds' as const

  const toggle = (list: StandardList) => {
    const key = keyFor(list.scope)
    const cur = form[key]
    update(key, cur.includes(list.id) ? cur.filter(x => x !== list.id) : [...cur, list.id])
  }

  const remove = (list: StandardList) => {
    const key = keyFor(list.scope)
    update(key, form[key].filter(x => x !== list.id))
  }

  // Resolve applied ids against the loaded registry so chips can show name/kind.
  const applied = lists.filter(l => appliedIds.has(l.id))

  // Nothing to show and nothing to browse — stay out of the way.
  if (!loading && !error && lists.length === 0 && applied.length === 0) return null

  return (
    <div className="field-group list-library">
      <span className="field-label">
        Standard lists
        <span className="field-label__hint">reusable allow/block lists — auto-applied to matching deals</span>
      </span>
      <div className="list-library__bar">
        {applied.length === 0 ? (
          <span className="list-library__empty">{loading ? 'Loading…' : 'None applied yet'}</span>
        ) : (
          applied.map(l => (
            <span key={l.id} className="list-library__chip">
              <span className={`seg-tag seg-tag--${l.kind}`}>{l.kind === 'block' ? 'BLOCK' : 'ALLOW'}</span>
              <span className="list-library__chip-name">{l.name}</span>
              <span className="list-library__chip-scope">{l.scope === 'domain' ? 'domain' : 'app'}</span>
              <button
                type="button"
                className="list-library__chip-x"
                aria-label={`Remove ${l.name}`}
                onClick={() => remove(l)}
              >
                ×
              </button>
            </span>
          ))
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(true)}
          disabled={loading || !!error}
        >
          + Browse library
        </button>
      </div>
      {error && (
        <span className="field-helper" style={{ color: 'var(--color-text-muted)' }}>
          Could not load standard lists ({error})
        </span>
      )}
      {open && (
        <StandardListLibraryModal
          lists={lists}
          appliedIds={appliedIds}
          onToggle={toggle}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

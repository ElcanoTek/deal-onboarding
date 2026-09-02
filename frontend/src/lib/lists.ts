import { useEffect, useState } from 'react'
import type { StandardList } from '../types/deal'

/** useStandardLists — one-shot fetch of /api/lists on mount, cached for the
 *  session. The picker calls this on render; an empty registry is the
 *  normal "no curated lists configured yet" state, not an error. */
export function useStandardLists(reloadKey = 0): { lists: StandardList[]; loading: boolean; error: string } {
  const [lists, setLists] = useState<StandardList[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/lists', { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error(`status ${r.status}`)
        return r.json()
      })
      .then(body => {
        if (cancelled) return
        const incoming: StandardList[] = Array.isArray(body?.lists) ? body.lists : []
        setLists(incoming)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setError(String(err))
        setLoading(false)
      })
    return () => { cancelled = true }
    // Re-fetch when reloadKey changes (e.g. after saving a new standard list).
  }, [reloadKey])

  return { lists, loading, error }
}

/** Promote an already-uploaded ad-hoc file into a reusable standard list. The
 *  file must already live under the trader upload dir (UploadedFile.path).
 *  Returns the created list summary; bump the picker's reloadKey to show it. */
export async function createStandardList(input: {
  name: string
  kind: 'allow' | 'block'
  scope: 'domain' | 'app_bundle'
  sourcePath: string
}): Promise<StandardList> {
  const r = await fetch('/api/lists/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error((body && body.error) || `could not save standard list (${r.status})`)
  }
  return r.json() as Promise<StandardList>
}

/** formatLineCount — compact "1.2M domains" rendering for the picker. */
export function formatLineCount(n: number): string {
  if (n <= 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** formatUpdated — a short "updated Jul 9, 2026" staleness signal for the
 *  picker. Returns '' for a missing/invalid timestamp so pre-versioning API
 *  responses render nothing rather than "Invalid Date". */
export function formatUpdated(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `updated ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
}

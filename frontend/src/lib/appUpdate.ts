// Deploy detection — the client half of cache busting.
//
// The server exposes GET /api/version (unauthenticated): a content hash of
// the built index.html, which changes on every frontend build. The app
// remembers the version it booted with; when a later probe returns a
// different hash, a deploy shipped and the UpdateBanner offers a one-click
// reload. Combined with the server's Cache-Control policy (index.html
// no-cache, hashed /assets immutable), that reload is always sufficient —
// no hard refresh ever needed.

export function isNewVersion(baseline: string | null, next: string | null): boolean {
  if (!baseline || !next) return false
  // 'dev' is the server's no-built-frontend sentinel (local dev, API-only
  // deploys) — never treat transitions to/from it as an update.
  if (baseline === 'dev' || next === 'dev') return false
  return baseline !== next
}

export function parseVersionPayload(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const version = (data as { version?: unknown }).version
  return typeof version === 'string' && version !== '' ? version : null
}

export async function fetchAppVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' })
    if (!res.ok) return null
    return parseVersionPayload(await res.json().catch(() => null))
  } catch {
    // Offline / mid-deploy blip — a missed probe is fine, we'll check again.
    return null
  }
}

/** Auto-heal stale lazy chunks. Vite dispatches a cancelable
 *  'vite:preloadError' when a dynamic import's chunk fails to load — after a
 *  deploy replaces the content-hashed files, an open tab hits exactly that on
 *  its next navigation. Reloading picks up the new index.html (served
 *  no-cache) and its new chunk URLs. The sessionStorage timestamp guards
 *  against a reload loop (e.g. the user is genuinely offline): within the
 *  cooldown we let the error propagate to ChunkErrorBoundary's manual card
 *  instead. */
export function installChunkReloadGuard(): void {
  const KEY = 'deal-onboarding-chunk-reload-at'
  const COOLDOWN_MS = 30_000
  window.addEventListener('vite:preloadError', event => {
    let last = 0
    try {
      last = Number(sessionStorage.getItem(KEY) || 0)
    } catch { /* private mode — fall through, still guard via in-memory? reload once is fine */ }
    if (Date.now() - last < COOLDOWN_MS) return
    try {
      sessionStorage.setItem(KEY, String(Date.now()))
    } catch { /* ignore */ }
    event.preventDefault()
    window.location.reload()
  })
}

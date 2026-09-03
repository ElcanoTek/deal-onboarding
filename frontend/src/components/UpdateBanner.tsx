// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useEffect, useRef, useState } from 'react'
import { fetchAppVersion, isNewVersion } from '../lib/appUpdate'

const CHECK_INTERVAL_MS = 5 * 60_000

/** Deploy-aware reload prompt. Probes /api/version on load, on tab refocus,
 *  and every few minutes; when the served version diverges from the one this
 *  tab booted with, offers a one-click reload. Rendered once at the root so
 *  it covers every route (login included). */
export function UpdateBanner() {
  const [updateReady, setUpdateReady] = useState(false)
  const baselineRef = useRef<string | null>(null)

  useEffect(() => {
    let disposed = false
    const check = async () => {
      const version = await fetchAppVersion()
      if (disposed || !version) return
      if (baselineRef.current === null) {
        baselineRef.current = version
        return
      }
      if (isNewVersion(baselineRef.current, version)) setUpdateReady(true)
    }
    void check()
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  if (!updateReady) return null
  return (
    <div className="update-banner" role="status">
      <span className="update-banner__text">A new version of Deal Onboarding is ready.</span>
      <button type="button" className="update-banner__btn" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  )
}

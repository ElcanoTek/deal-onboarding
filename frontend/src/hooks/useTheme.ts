import { useEffect, useState } from 'react'

const PREF_KEY = 'flag-theme-preference'

export type Theme = 'light' | 'dark'
export type ThemePreference = 'system' | Theme

function getStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(PREF_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch { /* ignore */ }
  return 'system'
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Flag theme state shared by the account menu's System/Light/Dark control and
 *  the standalone ThemeToggle (auth pages). Applies `data-theme` to <html>.
 *  Only an explicit light/dark choice persists — "system" clears the stored
 *  key so the pre-hydration script in index.html keeps following the OS. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(getStoredPreference)
  const [osTheme, setOsTheme] = useState<Theme>(systemTheme)

  const theme: Theme = preference === 'system' ? osTheme : preference

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    try {
      if (preference === 'system') localStorage.removeItem(PREF_KEY)
      else localStorage.setItem(PREF_KEY, preference)
    } catch { /* ignore */ }
  }, [preference])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setOsTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return { theme, preference, setPreference, setTheme: setPreference as (t: ThemePreference) => void }
}

// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useTheme } from '../hooks/useTheme'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      data-flag-theme-toggle
      className="icon-action"
      type="button"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      <span className="theme-toggle__icon-wrap" aria-hidden="true">
        <svg className="icon-inline theme-toggle__icon theme-toggle__icon--sun" aria-hidden="true">
          <use href="/design-system/icons/core-icons.svg#sun" />
        </svg>
        <svg className="icon-inline theme-toggle__icon theme-toggle__icon--moon" aria-hidden="true">
          <use href="/design-system/icons/core-icons.svg#moon" />
        </svg>
      </span>
    </button>
  )
}

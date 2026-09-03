import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTheme } from '../hooks/useTheme'
import type { ThemePreference } from '../hooks/useTheme'

/** The Elcano mark — every Elcano product carries the same mark in its app
 *  header (Flag `ds-app-header__mark`); the product name sits beside it. */
const ELCANO_MARK = '/design-system/logos/elcano-mark-primary.svg'

/** Page key used to highlight the active nav item. Mirrors App.tsx Route. */
export type NavRoute = 'workspace'

export interface SideNavProps {
  currentRoute: NavRoute
  sessionEmail: string
  onNavigateWorkspace: () => void
  onHelp: () => void
  onLogout: () => Promise<void> | void
}

const RAIL_COLLAPSED_KEY = 'deal-onboarding-rail-collapsed'

// Fleet nav-tile idiom (fleet@dev NavRail navTileClass): the icon sits in a
// small accent-tinted square that lifts on hover and saturates + glows when
// active — one brand hue for every surface.
const icon = (id: string) => (
  <span className="side-rail__tile" aria-hidden="true">
    <svg className="side-rail__icon" viewBox="0 0 24 24">
      <use href={`/design-system/icons/core-icons.svg#${id}`} />
    </svg>
  </span>
)

/** Rail-footer account control (avatar + email) opening the account menu
 *  (Help · Theme · Sign out) upward. Keyboard contract: Escape closes and
 *  returns focus to the trigger,
 *  Arrow/Home/End move between items, Tab is trapped, and an outside
 *  pointer-down closes. */
function AccountMenu({
  email,
  collapsed,
  onExpandRail,
  onHelp,
  onLogout,
  loggingOut,
}: {
  email: string
  collapsed: boolean
  /** Re-expand the collapsed rail. The popover is wider than the icon rail
   *  (and clipped by its scroll container), so on a collapsed rail the
   *  trigger expands first. */
  onExpandRail: () => void
  onHelp: () => void
  onLogout: () => void
  loggingOut: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { preference, setPreference } = useTheme()

  const close = useCallback(() => setOpen(false), [])
  const closeAndRefocus = useCallback(() => {
    triggerRef.current?.focus()
    setOpen(false)
  }, [])

  // Focus the first item on open.
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    menu?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }, [open])

  // An outside pointer-down (not on the menu or its trigger) closes the menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, close])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    if (!menu) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeAndRefocus()
      return
    }
    const items = Array.from(menu.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(index + 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const dir = e.shiftKey ? -1 : 1
      items[(index + dir + items.length) % items.length]?.focus()
    }
  }

  const initial = (email || '?').charAt(0).toUpperCase()
  const avatar = <span className="account-menu__avatar" aria-hidden="true">{initial}</span>

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        className="account-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => {
          if (collapsed) {
            onExpandRail()
            setOpen(true)
            return
          }
          setOpen(o => !o)
        }}
      >
        {avatar}
        {!collapsed && (
          <>
            <span className="account-menu__email side-rail__email" title={email}>{email}</span>
            <svg
              className="account-menu__selector side-rail__chev"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 9l4-4 4 4" />
              <path d="M16 15l-4 4-4-4" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          className="account-menu__popover"
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
        >
          <div className="account-menu__header">
            {avatar}
            <span className="account-menu__email" title={email}>{email}</span>
          </div>
          <div className="account-menu__separator" role="separator" />
          <button
            type="button"
            className="account-menu__item"
            role="menuitem"
            onClick={() => { close(); onHelp() }}
          >
            <span className="account-menu__item-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#info" /></svg>
            </span>
            <span className="account-menu__item-label">Help</span>
          </button>
          <div className="account-menu__theme">
            <svg className="account-menu__theme-icon" viewBox="0 0 24 24" aria-hidden="true">
              <use href="/design-system/icons/core-icons.svg#moon" />
            </svg>
            <span className="account-menu__theme-label">Theme</span>
            {/* menuitemradio-in-group is the ARIA-sanctioned way to embed a
                mutually-exclusive control inside a role="menu" surface. */}
            <span className="account-menu__theme-group" role="group" aria-label="Theme">
              {(['system', 'light', 'dark'] as ThemePreference[]).map(value => (
                <button
                  key={value}
                  type="button"
                  className="account-menu__theme-btn"
                  role="menuitemradio"
                  aria-checked={preference === value}
                  onClick={() => setPreference(value)}
                >
                  {value}
                </button>
              ))}
            </span>
          </div>
          <div className="account-menu__separator" role="separator" />
          <button
            type="button"
            className="account-menu__item"
            role="menuitem"
            disabled={loggingOut}
            onClick={() => { close(); onLogout() }}
          >
            <span className="account-menu__item-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#logout" /></svg>
            </span>
            <span className="account-menu__item-label">{loggingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** Fleet side rail rendered once at the App level on every authenticated
 *  page. Sticky in the flex shell while the content column scrolls; on
 *  desktop it collapses to an icon rail (persisted), below the desktop
 *  breakpoint it becomes a slide-in panel behind a topbar hamburger. */
export function SideNav({
  currentRoute,
  sessionEmail,
  onNavigateWorkspace,
  onHelp,
  onLogout,
}: SideNavProps) {
  const [loggingOut, setLoggingOut] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1' } catch { return false }
  })
  // Mobile slide-in state. On desktop widths the rail is always visible and
  // this flag is ignored by CSS.
  const [mobileOpen, setMobileOpen] = useState(false)
  const hamburgerRef = useRef<HTMLButtonElement | null>(null)

  const handleLogout = useCallback(async () => {
    setLoggingOut(true)
    try { await onLogout() } finally { setLoggingOut(false) }
  }, [onLogout])

  const toggleCollapsed = () => {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  /** Re-expand the icon rail (persisted) — used by the account menu popover,
   *  whose expanded UI can't fit the 4rem rail. */
  const expandRail = () => {
    setCollapsed(false)
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, '0') } catch { /* ignore */ }
  }

  // Mobile panel: Escape closes, background scroll locks while open, and
  // focus returns to the hamburger on close.
  useEffect(() => {
    if (!mobileOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
      hamburgerRef.current?.focus()
    }
  }, [mobileOpen])

  // Close the mobile panel on the same tap that navigates.
  const withClose = (fn: () => void) => () => { setMobileOpen(false); fn() }

  const navButton = (route: NavRoute, label: string, iconId: string, onClick: () => void) => {
    const isActive = currentRoute === route
    return (
      <button
        type="button"
        className={`side-rail__item${isActive ? ' is-active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        title={label}
        onClick={withClose(onClick)}
      >
        {icon(iconId)}
        <span className="side-rail__label">{label}</span>
      </button>
    )
  }

  return (
    <>
      {/* Slim topbar — only rendered below the desktop breakpoint (CSS). */}
      <header className="mobile-topbar">
        <button type="button" className="mobile-topbar__brand" onClick={onNavigateWorkspace} aria-label="Go to the Deal Builder">
          <img className="mobile-topbar__mark" src={ELCANO_MARK} alt="Elcano" />
          <span>Deal Onboarding</span>
        </button>
        <button
          ref={hamburgerRef}
          type="button"
          className="mobile-topbar__hamburger"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="side-nav"
          onClick={() => setMobileOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href="/design-system/icons/core-icons.svg#menu" />
          </svg>
        </button>
      </header>

      <div
        className={`side-nav-backdrop ${mobileOpen ? 'side-nav-backdrop--open' : ''}`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      <nav
        id="side-nav"
        className={`side-rail${collapsed ? ' side-rail--collapsed' : ''}${mobileOpen ? ' side-rail--open' : ''}`}
        aria-label="Primary"
      >
        <div className="side-rail__header">
          <img className="side-rail__mark" src={ELCANO_MARK} alt="Elcano" />
          <span className="side-rail__text">
            <span className="side-rail__eyebrow">Self-hosted deal desk</span>
            <span className="side-rail__title">Deal Onboarding</span>
          </span>
          <button
            type="button"
            className="side-rail__collapse"
            onClick={toggleCollapsed}
            aria-label="Toggle sidebar"
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9.5" y1="4" x2="9.5" y2="20" />
            </svg>
          </button>
        </div>

        <div className="side-rail__nav">
          {navButton('workspace', 'Deal Builder', 'folder', onNavigateWorkspace)}
        </div>

        <div className="side-rail__spacer" />

        <div className="side-rail__footer">
          <AccountMenu
            email={sessionEmail}
            collapsed={collapsed}
            onExpandRail={expandRail}
            onHelp={withClose(onHelp)}
            onLogout={() => void handleLogout()}
            loggingOut={loggingOut}
          />
        </div>
      </nav>
    </>
  )
}

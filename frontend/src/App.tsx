import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ThemeToggle } from './components/ThemeToggle'
import { SideNav } from './components/SideNav'

// The builder loads on demand so the login and help pages stay light.
const DealBuilder = lazy(() => import('./components/DealBuilder').then(m => ({ default: m.DealBuilder })))

const PRODUCT_NAME = 'Deal Onboarding'
/** The Elcano mark (Flag design system) — shared by every Elcano product. */
const ELCANO_MARK = '/design-system/logos/elcano-mark-primary.svg'

type Session = { email: string }
type Route = '/' | '/login' | '/help'

function currentRoute(): Route {
  const path = window.location.pathname
  if (path === '/login' || path === '/help') return path
  return '/'
}

function navigate(path: Route, replace = false) {
  const fn = replace ? window.history.replaceState : window.history.pushState
  fn.call(window.history, {}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function LoadingScreen({ title = 'Checking your session...', copy = 'One quick moment while we open the deal desk.' }: { title?: string; copy?: string }) {
  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--compact">
        <p className="auth-eyebrow">{PRODUCT_NAME}</p>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-copy">{copy}</p>
      </section>
    </main>
  )
}

/** The builder loads as a lazy chunk with a content-hashed name; a deploy
 *  replaces it, so a tab held open across one gets a 404 on its first
 *  navigation to a not-yet-loaded page — React.lazy then throws during
 *  render, and without a boundary React unmounts the whole tree into a
 *  permanent white screen. Catch it and offer a reload (which picks up the
 *  new index.html and chunk names). */
class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="auth-shell">
        <section className="auth-card auth-card--compact">
          <p className="auth-eyebrow">{PRODUCT_NAME}</p>
          <h1 className="auth-title">This page failed to load</h1>
          <p className="auth-copy">Usually a new version of {PRODUCT_NAME} was just deployed. Reloading picks it up — unsaved form state is kept locally.</p>
          <button type="button" className="btn btn-primary auth-submit" onClick={() => window.location.reload()}>
            Reload {PRODUCT_NAME}
          </button>
        </section>
      </main>
    )
  }
}

type LoginPageProps = {
  error: string | null
  pending: boolean
  onLogin: (email: string, password: string) => Promise<void>
  onHelp: () => void
}

function LoginPage({ error, pending, onLogin, onHelp }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await onLogin(email, password)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-card__header">
          <div className="auth-brand">
            <img className="auth-brand__mark" src={ELCANO_MARK} alt="Elcano" />
            <div>
              <p className="auth-eyebrow">Self-hosted deal desk</p>
              <h1 className="auth-title">Welcome to {PRODUCT_NAME}</h1>
            </div>
          </div>
          <ThemeToggle />
        </div>

        <p className="auth-copy">
          Sign in to intake a brief, audit the package, and book live deals across every exchange. New here? Start with the help page before you log in.
        </p>

        {error && <p className="auth-alert">{error}</p>}

        <form className="auth-form" onSubmit={submit}>
          <label className="auth-field">
            <span>Username / Email</span>
            <input value={email} onChange={e => setEmail(e.target.value)} type="text" autoComplete="username" required />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
          </label>
          <button className="btn btn-primary auth-submit" type="submit" disabled={pending}>
            {pending ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="auth-footnote">
          <span>Need access or want to know what this tool does?</span>
          <button type="button" className="auth-link-button" onClick={onHelp}>Open the help page</button>
        </div>
      </section>
    </main>
  )
}

type HelpPageProps = {
  signedIn: boolean
  onBack: () => void
}

function HelpPage({ signedIn, onBack }: HelpPageProps) {
  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--guide">
        <div className="auth-card__header">
          <div>
            <p className="auth-eyebrow">Quick Guide</p>
            <h1 className="auth-title">How to use {PRODUCT_NAME}</h1>
          </div>
          <ThemeToggle />
        </div>

        <div className="guide-panel">
          <h2>1. Ask for an account</h2>
          <p>An operator can create one with <code>deal-onboarding-admin user add your.name@example.com</code> and will hand you a one-time password.</p>
        </div>

        <div className="guide-panel">
          <h2>2. Sign in from the login page</h2>
          <p>Use your email address and the password you were given. If the password gets lost, ask an operator to rotate it with <code>deal-onboarding-admin user passwd your.name@example.com</code>.</p>
        </div>

        <div className="guide-panel">
          <h2>3. Build the batch</h2>
          <p>Paste or drop a brief into <strong>Parse Deal Data</strong> to fill the form, or work through the steps by hand: submitter and dates, campaign, DSP, deals, per-SSP configuration, and file uploads. The audit re-checks every step as you go.</p>
        </div>

        <div className="guide-panel">
          <h2>4. Ask the Deal Assistant</h2>
          <p>The chat dock in the bottom-right corner bulk-edits the deal matrix from plain English (“set CPM to 12 on every CTV deal”), explains what an audit rule means, and opens pre-filled from any failing audit row via <strong>Fix with assistant</strong>. Every edit shows a diff you confirm before the form changes.</p>
        </div>

        <div className="guide-panel">
          <h2>5. Review and submit</h2>
          <p>The Deal Summary runs the full rules audit plus the AI critique. When both pass, submit the batch to your configured runner — or copy the generated prompt from the debug panel if no runner is configured.</p>
        </div>

        <button type="button" className="btn btn-secondary auth-submit" onClick={onBack}>
          {signedIn ? `Back to ${PRODUCT_NAME}` : 'Back to Login'}
        </button>
      </section>
    </main>
  )
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshSession = async () => {
    const response = await fetch('/api/session', { cache: 'no-store' })
    if (!response.ok) {
      setSession(null)
      return
    }
    setSession(await response.json() as Session)
  }

  useEffect(() => {
    const handlePopState = () => setRoute(currentRoute())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Reset scroll on route change. Skip the first render so refreshes don't
  // jump past whatever anchor the trader was on.
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [route])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/session', { cache: 'no-store' })
        if (!response.ok) {
          if (!cancelled) setSession(null)
          return
        }
        const data = await response.json() as Session
        if (!cancelled) setSession(data)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const handleLogin = async (email: string, password: string) => {
    setPending(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (response.status === 400) {
        setError('Please enter both email and password.')
        return
      }
      if (response.status === 401) {
        setError('Invalid email or password.')
        return
      }
      if (!response.ok) {
        setError('Sign in is unavailable right now. Try again in a moment.')
        return
      }
      await refreshSession()
      navigate('/', true)
      setRoute('/')
    } finally {
      setPending(false)
    }
  }

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setSession(null)
    setError(null)
    navigate('/login', true)
    setRoute('/login')
  }

  if (loading) return <LoadingScreen />
  if (route === '/help') return <HelpPage signedIn={Boolean(session)} onBack={() => navigate(session ? '/' : '/login', true)} />
  if (!session) return <LoginPage error={error} pending={pending} onLogin={handleLogin} onHelp={() => navigate('/help')} />

  return (
    <div className="app-shell">
      <SideNav
        currentRoute="workspace"
        sessionEmail={session.email}
        onNavigateWorkspace={() => navigate('/')}
        onHelp={() => navigate('/help')}
        onLogout={handleLogout}
      />
      <div className="app-shell__content">
        {/* Neutral copy — the session is already established here; this
            fallback covers the page chunk download, not the auth check. */}
        <ChunkErrorBoundary>
          <Suspense fallback={<LoadingScreen title="Loading..." copy="One quick moment while this page loads." />}>
            <DealBuilder onLogout={handleLogout} />
          </Suspense>
        </ChunkErrorBoundary>
      </div>
    </div>
  )
}

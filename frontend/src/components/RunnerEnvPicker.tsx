import { useState } from 'react'
import { checkRunner, RunnerEnv, RunnerEnvironmentInfo, RunnerCheckResult } from '../lib/runnerApi'

/** Radio picker for which runner instance receives a submit. Renders nothing
 *  unless the server reports the dev environment enabled (GET
 *  /api/runner/environments), so prod-only deployments see no UI change and
 *  every submit defaults to prod. Dev selects which orchestrator/agent runs
 *  the task — the deals a credentialed dev runner books are still LIVE, hence
 *  the warning when it's picked. */
export function RunnerEnvPicker({
  environments,
  value,
  onChange,
  disabled = false,
  name,
}: {
  environments: RunnerEnvironmentInfo[]
  value: RunnerEnv
  onChange: (env: RunnerEnv) => void
  disabled?: boolean
  /** Radio-group name — unique per usage site so two pickers on one page
   *  (workspace modal vs debug panel) never capture each other's keyboard
   *  navigation. */
  name: string
}) {
  const dev = environments.find(e => e.id === 'dev')
  const prod = environments.find(e => e.id === 'prod')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<RunnerCheckResult | null>(null)
  const [checkError, setCheckError] = useState('')

  if (!dev?.enabled) return null

  const host = (url?: string) => {
    if (!url) return ''
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }


  const runCheck = async () => {
    setChecking(true)
    setCheck(null)
    setCheckError('')
    try {
      setCheck(await checkRunner(value))
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  // Reachable and keyAccepted are reported separately on purpose: "host is
  // down" and "host is up but rejected the key" need different fixes.
  const checkSummary = (r: RunnerCheckResult): { ok: boolean; text: string } => {
    if (!r.reachable) return { ok: false, text: r.error || 'unreachable' }
    const version = r.serverVersion ? ` (${r.serverVersion})` : ''
    if (!r.keyAccepted) return { ok: false, text: `reachable${version} — API key rejected: ${r.keyError || 'unknown reason'}` }
    return { ok: true, text: `reachable${version}, API key accepted` }
  }

  return (
    <fieldset className="runner-env-picker">
      <legend>Agent runner</legend>
      <label className="runner-env-picker__radio">
        {/* A dev-only deployment (prod vars unset) still lists Production, but
            un-pickable — selecting it would 503 every submit. */}
        <input type="radio" name={name} checked={value === 'prod'} onChange={() => onChange('prod')} disabled={disabled || !prod?.enabled} />
        <span>
          Production{' '}
          <span className="runner-env-picker__hint">
            {prod?.enabled ? host(prod.baseUrl) : 'not configured'}
          </span>
        </span>
      </label>
      <label className="runner-env-picker__radio">
        <input type="radio" name={name} checked={value === 'dev'} onChange={() => onChange('dev')} disabled={disabled} />
        <span>
          Dev (testing){' '}
          <span className="runner-env-picker__hint">
            {host(dev.baseUrl)}
          </span>
        </span>
      </label>
      <div className="runner-env-picker__check">
        <button type="button" className="btn btn-ghost btn-sm" onClick={runCheck} disabled={checking || disabled}>
          {checking ? 'Testing…' : 'Test connection'}
        </button>
        {checkError && <span className="runner-env-picker__check-result runner-env-picker__check-result--bad">{checkError}</span>}
        {check && (
          <span
            className={`runner-env-picker__check-result runner-env-picker__check-result--${checkSummary(check).ok ? 'ok' : 'bad'}`}
            role="status"
          >
            {checkSummary(check).ok ? '✓' : '✕'} {checkSummary(check).text}
          </span>
        )}
      </div>
      {value === 'dev' && (
        <p className="runner-env-picker__warning" role="alert">
          Runs on the dev runner — the deals its agent books at the SSPs are still live.
        </p>
      )}
    </fieldset>
  )
}

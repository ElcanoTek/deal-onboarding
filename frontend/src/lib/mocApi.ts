import { useEffect, useMemo, useState } from 'react'

/** Which configured runner instance a submit targets. 'prod' is the default;
 *  'dev' is the server's RUNNER_DEV_* instance — during the Fleet port that is
 *  a second (dev) runner deployment. Offer it
 *  only when fetchMocEnvironments reports it enabled. The id names the SLOT,
 *  not the backend; `backend` on MocEnvironmentInfo says which wire it speaks.
 *  NOTE: dev selects which orchestrator runs the task, not whether deals are
 *  real — a dev runner with live SSP credentials books live deals. */
export type MocEnv = 'prod' | 'dev'

export interface MocEnvironmentInfo {
  id: MocEnv
  backend?: 'moc' | 'fleet'
  baseUrl?: string
  targetNode?: string
  enabled: boolean
}

/** Which MOC instances the server has configured (prod first, then dev).
 *  Fails soft to [] so the environment picker simply hides on transient
 *  errors — submits then default to prod server-side. */
export async function fetchMocEnvironments(): Promise<MocEnvironmentInfo[]> {
  try {
    const r = await fetch('/api/runner/environments')
    if (!r.ok) return []
    const body = (await r.json()) as { environments?: MocEnvironmentInfo[] }
    return body.environments ?? []
  } catch {
    return []
  }
}

/** Human label for where a submit ran. Backend-aware when the caller has the
 *  environment list: the dev slot runs Fleet during the port, so "dev MOC" is
 *  actively misleading there. Falls back to the slot name when the backend
 *  isn't known (post-submit toasts only carry the echoed id). */
export function mocEnvLabel(env?: string, backend?: string): string {
  const runner = backend === 'fleet' ? 'Fleet' : backend === 'moc' ? 'MOC' : ''
  if (env === 'dev') return runner ? `${runner} dev` : 'dev runner'
  return runner || 'MOC'
}

/** Result of GET /api/runner/check — a read-only reachability + key probe.
 *  `reachable` and `keyAccepted` are independent: a fleet deployment answers
 *  version discovery without auth, so "up but key rejected" is a distinct and
 *  common state that must not read as "host is down". */
export interface RunnerCheckResult {
  backend?: string
  baseUrl?: string
  reachable: boolean
  apiVersion?: string
  serverVersion?: string
  keyAccepted: boolean
  keyError?: string
  error?: string
}

/** Probes one configured runner instance. Creates nothing. */
export async function checkRunner(env: MocEnv): Promise<RunnerCheckResult> {
  const r = await fetch(`/api/runner/check?env=${encodeURIComponent(env)}`)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body?.message || body?.error || `Connection check failed (${r.status})`)
  return body.check as RunnerCheckResult
}

/** Submit-environment state for a page: fetches the configured instances once
 *  and owns the selection. `defaultEnv` is the safe reset target per submit
 *  intent — prod when it's configured, else the only enabled instance (on a
 *  dev-only deployment "Production" isn't submittable, so preselecting it
 *  would 503 every submit). Selection auto-corrects to defaultEnv once the
 *  fetch resolves. */
export function useMocEnvironments(): {
  environments: MocEnvironmentInfo[]
  mocEnv: MocEnv
  setMocEnv: (env: MocEnv) => void
  defaultEnv: MocEnv
} {
  const [environments, setEnvironments] = useState<MocEnvironmentInfo[]>([])
  const [mocEnv, setMocEnv] = useState<MocEnv>('prod')
  const defaultEnv: MocEnv = useMemo(() => {
    const prodEnabled = environments.some(e => e.id === 'prod' && e.enabled)
    const devEnabled = environments.some(e => e.id === 'dev' && e.enabled)
    return !prodEnabled && devEnabled ? 'dev' : 'prod'
  }, [environments])
  useEffect(() => {
    let cancelled = false
    fetchMocEnvironments().then(envs => {
      if (cancelled) return
      setEnvironments(envs)
      const prodEnabled = envs.some(e => e.id === 'prod' && e.enabled)
      if (!prodEnabled && envs.some(e => e.id === 'dev' && e.enabled)) setMocEnv('dev')
    })
    return () => { cancelled = true }
  }, [])
  return { environments, mocEnv, setMocEnv, defaultEnv }
}

export interface MocCreateResult {
  taskId: string
  taskUrl?: string
  files: number
  /** The environment the task ran on ('prod' | 'dev'), echoed by the server. */
  mocEnv?: string
  /** True when the server replayed a prior submission (matched by idempotency
   *  key) instead of creating a new task. The caller skips post-submit
   *  bookkeeping so a retry never double-records. */
  duplicate?: boolean
  uploaded?: string[]
  /** Non-fatal submit-time conditions the trader must see (e.g. result
   *  writeback not configured server-side → library rows will stay pending).
   *  The workspace surfaces these in the sticky post-submit toast. */
  warnings?: string[]
}

interface MocCreateBase {
  prompt: string
  listIds: string[]
  filePaths: string[]
  /** Original client filename for each `filePaths` entry, paired by index.
   *  An ad-hoc upload lives on disk under a hash-suffixed name, but the prompt
   *  references it by its ORIGINAL filename — so the server uploads each file
   *  to MOC under this name (still reading bytes from the validated path) so
   *  the agent's fuzzy match against the prompt resolves (#157). Omit only for
   *  submissions with no ad-hoc file attachments; when present it MUST be the
   *  same length as `filePaths` (the server rejects a mismatch). */
  fileNames?: string[]
  /** Target runner instance. Omitted/blank means 'prod'; unknown values are
   *  rejected server-side (moc_env_invalid) so a typo never mis-routes a live
   *  batch. The idempotency ledger is namespaced per environment. */
  mocEnv?: MocEnv
  /** Ask the server to append a result_callback block so MOC reports per-deal
   *  outcomes back and the library auto-updates from pending. */
  resultCallback?: boolean
  /** Stable key minted per submit intent (held across retries) so the server
   *  can dedup a reload/remount/retry and never create a second live batch. */
  idempotencyKey?: string
}

/** Create vs update is a compile-time contract mirroring the server-side gate
 *  in HandleMOCCreate (#152): a create MUST carry the audited form AND the
 *  structured brief (the server binds the brief's and the prompt's deal names
 *  to the re-audited form); an update MUST declare itself (it is exempt from
 *  the audited-form gate — the prompt-only update flow has no audit concept —
 *  but still floor-gated on the unresolved-token + brief-schema checks, and
 *  its prompt must not follow the multi-deal-creation protocol). */
export type MocCreateInput =
  | (MocCreateBase & {
      /** Create is the default operation server-side. */
      operation?: 'create'
      /** The audited FormData snapshot — the exact JSON a passing /api/audit
       *  run approved. The server re-runs the same deterministic audit pipeline
       *  against it and rejects the submit (audit_form_required, brief_required,
       *  audit_failed, audit_brief_mismatch, audit_prompt_mismatch,
       *  client_unresolved, campaign_id_required) unless it still passes. */
      form: unknown
      /** Serialized structured deal brief (JSON from serializeBrief). REQUIRED
       *  for creates: the server schema-validates it, cross-checks its deal
       *  names against the re-audited form, and attaches it as
       *  `deal_brief.json` so the batch travels as a structured file. */
      brief: string
    })
  | (MocCreateBase & {
      /** Updates and clones are both prompt-only operations, exempt from the
       *  audited-form gate but floor-gated server-side (updates: relabel +
       *  seat routing; clones additionally gateCloneShape — protocol marker +
       *  non-empty unique new deal names, #329). */
      operation: 'update' | 'clone'
      form?: undefined
      /** Prompt-only flows; a brief, if ever supplied, is still
       *  schema-validated server-side. */
      brief?: string
    })

/** Creates a MOC task from a generated batch prompt, attaching any standard
 *  lists (by id) + ad-hoc uploads (by server path). Throws with the server's
 *  message — notably a 503 when MOC isn't configured (MOC_BASE_URL/MOC_API_KEY
 *  unset), which the caller surfaces as a friendly "not configured" note. */
export async function createMocTask(input: MocCreateInput): Promise<MocCreateResult> {
  const r = await fetch('/api/runner/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    // Gate rejections carry a machine code in `error` plus an actionable human
    // `message` — surface the message; legacy responses only carry `error`.
    throw new Error((err && (err.message || err.error)) || `MOC submission failed (${r.status})`)
  }
  return r.json() as Promise<MocCreateResult>
}

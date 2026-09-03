// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useEffect, useMemo, useState } from 'react'

/** Which configured runner instance a submit targets. 'prod' is the default;
 *  'dev' is the server's RUNNER_DEV_* instance, offered only when
 *  fetchRunnerEnvironments reports it enabled. The id names the SLOT.
 *  NOTE: dev selects which fleet deployment runs the task, not whether deals
 *  are real — a dev runner with live SSP credentials books live deals. */
export type RunnerEnv = 'prod' | 'dev'

export interface RunnerEnvironmentInfo {
  id: RunnerEnv
  baseUrl?: string
  enabled: boolean
}

/** Which runner instances the server has configured (prod first, then dev).
 *  Fails soft to [] so the environment picker simply hides on transient
 *  errors — submits then default to prod server-side. */
export async function fetchRunnerEnvironments(): Promise<RunnerEnvironmentInfo[]> {
  try {
    const r = await fetch('/api/runner/environments')
    if (!r.ok) return []
    const body = (await r.json()) as { environments?: RunnerEnvironmentInfo[] }
    return body.environments ?? []
  } catch {
    return []
  }
}

/** Human label for where a submit ran. */
export function runnerEnvLabel(env?: string): string {
  return env === 'dev' ? 'the dev runner' : 'the runner'
}

/** Result of GET /api/runner/check — a read-only reachability + key probe.
 *  `reachable` and `keyAccepted` are independent: a fleet deployment answers
 *  version discovery without auth, so "up but key rejected" is a distinct and
 *  common state that must not read as "host is down". */
export interface RunnerCheckResult {
  baseUrl?: string
  reachable: boolean
  apiVersion?: string
  serverVersion?: string
  keyAccepted: boolean
  keyError?: string
  error?: string
}

/** Probes one configured runner instance. Creates nothing. */
export async function checkRunner(env: RunnerEnv): Promise<RunnerCheckResult> {
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
export function useRunnerEnvironments(): {
  environments: RunnerEnvironmentInfo[]
  runnerEnv: RunnerEnv
  setRunnerEnv: (env: RunnerEnv) => void
  defaultEnv: RunnerEnv
} {
  const [environments, setEnvironments] = useState<RunnerEnvironmentInfo[]>([])
  const [runnerEnv, setRunnerEnv] = useState<RunnerEnv>('prod')
  const defaultEnv: RunnerEnv = useMemo(() => {
    const prodEnabled = environments.some(e => e.id === 'prod' && e.enabled)
    const devEnabled = environments.some(e => e.id === 'dev' && e.enabled)
    return !prodEnabled && devEnabled ? 'dev' : 'prod'
  }, [environments])
  useEffect(() => {
    let cancelled = false
    fetchRunnerEnvironments().then(envs => {
      if (cancelled) return
      setEnvironments(envs)
      const prodEnabled = envs.some(e => e.id === 'prod' && e.enabled)
      if (!prodEnabled && envs.some(e => e.id === 'dev' && e.enabled)) setRunnerEnv('dev')
    })
    return () => { cancelled = true }
  }, [])
  return { environments, runnerEnv, setRunnerEnv, defaultEnv }
}

export interface RunnerCreateResult {
  taskId: string
  taskUrl?: string
  files: number
  /** The environment the task ran on ('prod' | 'dev'), echoed by the server. */
  runnerEnv?: string
  /** True when the server replayed a prior submission (matched by idempotency
   *  key) instead of creating a new task. The caller skips post-submit
   *  bookkeeping so a retry never double-records. */
  duplicate?: boolean
  uploaded?: string[]
  /** Non-fatal submit-time conditions the trader must see. The builder
   *  surfaces these in the sticky post-submit toast. */
  warnings?: string[]
}

/** The create request. It mirrors the server-side gate in HandleRunnerCreate:
 *  a create MUST carry the audited form AND the structured brief (the server
 *  binds the brief's and the prompt's deal names to the re-audited form). */
export interface RunnerCreateInput {
  prompt: string
  listIds: string[]
  filePaths: string[]
  /** Original client filename for each `filePaths` entry, paired by index.
   *  An ad-hoc upload lives on disk under a hash-suffixed name, but the prompt
   *  references it by its ORIGINAL filename — so the server uploads each file
   *  to the runner under this name (still reading bytes from the validated
   *  path) so the agent's match against the prompt resolves. Omit only for
   *  submissions with no ad-hoc file attachments; when present it MUST be the
   *  same length as `filePaths` (the server rejects a mismatch). */
  fileNames?: string[]
  /** Target runner instance. Omitted/blank means 'prod'; unknown values are
   *  rejected server-side (runner_env_invalid) so a typo never mis-routes a
   *  live batch. The idempotency ledger is namespaced per environment. */
  runnerEnv?: RunnerEnv
  /** Stable key minted per submit intent (held across retries) so the server
   *  can dedup a reload/remount/retry and never create a second live batch. */
  idempotencyKey?: string
  /** Create is the only operation; the server rejects anything else. */
  operation?: 'create'
  /** The audited FormData snapshot — the exact JSON a passing /api/audit run
   *  approved. The server re-runs the same deterministic audit pipeline
   *  against it and rejects the submit (audit_form_required, brief_required,
   *  audit_failed, audit_brief_mismatch, audit_prompt_mismatch,
   *  campaign_id_required) unless it still passes. */
  form: unknown
  /** Serialized structured deal brief (JSON from serializeBrief). REQUIRED:
   *  the server schema-validates it, cross-checks its deal names against the
   *  re-audited form, and attaches it as `deal_brief.json`. */
  brief: string
}

/** Creates a runner task from a generated batch prompt, attaching any standard
 *  lists (by id) + ad-hoc uploads (by server path). Throws with the server's
 *  message — notably a 503 when no runner is configured (RUNNER_BASE_URL /
 *  RUNNER_API_KEY unset), which the caller surfaces as a "not configured" note. */
export async function createRunnerTask(input: RunnerCreateInput): Promise<RunnerCreateResult> {
  const r = await fetch('/api/runner/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    // Gate rejections carry a machine code in `error` plus an actionable human
    // `message` — surface the message; older responses only carry `error`.
    throw new Error((err && (err.message || err.error)) || `Runner submission failed (${r.status})`)
  }
  return r.json() as Promise<RunnerCreateResult>
}

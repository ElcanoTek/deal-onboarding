import { useEffect, useState } from 'react'

/** Operator identity for this installation — one installation = one
 *  organization. Mirrors internal/config.Operator on the server, which is the
 *  source of truth (GET /api/config). The name generator reads the module-level
 *  value so pure helpers (dealNameSlots, dealBrief, dealPromptYaml) need no
 *  React context; `useOperatorConfig` loads it once per page and re-renders
 *  subscribers when it lands. Tests run on the defaults. */
export interface OperatorConfig {
  /** Deal-name Curator slot (slot 1) when no data partner is set. */
  orgName: string
  /** Campaign ids are `${campaignIdPrefix}` + five digits. */
  campaignIdPrefix: string
  /** Slot 12 when the form leaves the attribution code blank. */
  defaultAttributionCode: string
}

export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  orgName: 'Curator',
  campaignIdPrefix: 'DEAL',
  defaultAttributionCode: 'A1',
}

let current: OperatorConfig = { ...DEFAULT_OPERATOR_CONFIG }
const listeners = new Set<() => void>()

export function getOperatorConfig(): OperatorConfig {
  return current
}

/** Install a new operator config (called once from the boot fetch; tests may
 *  call it directly). Blank fields keep their defaults. */
export function setOperatorConfig(next: Partial<OperatorConfig>): void {
  current = {
    orgName: (next.orgName || '').trim() || DEFAULT_OPERATOR_CONFIG.orgName,
    campaignIdPrefix: ((next.campaignIdPrefix || '').trim() || DEFAULT_OPERATOR_CONFIG.campaignIdPrefix).toUpperCase(),
    defaultAttributionCode: ((next.defaultAttributionCode || '').trim() || DEFAULT_OPERATOR_CONFIG.defaultAttributionCode).toUpperCase(),
  }
  for (const l of listeners) l()
}

/** The campaign-id pattern the audit enforces (prefix + 5 digits). */
export function campaignIdPattern(cfg: OperatorConfig = current): RegExp {
  return new RegExp(`^${cfg.campaignIdPrefix}\\d{5}$`)
}

/** Placeholder shown for an unset campaign id, e.g. "DEAL#####". */
export function campaignIdPlaceholder(cfg: OperatorConfig = current): string {
  return `${cfg.campaignIdPrefix}#####`
}

let fetched = false

/** Load the operator config from the server once and subscribe to it. */
export function useOperatorConfig(): OperatorConfig {
  const [cfg, setCfg] = useState<OperatorConfig>(current)
  useEffect(() => {
    const onChange = () => setCfg(getOperatorConfig())
    listeners.add(onChange)
    if (!fetched) {
      fetched = true
      fetch('/api/config', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(body => { if (body && typeof body === 'object') setOperatorConfig(body as Partial<OperatorConfig>) })
        .catch(() => { /* defaults stay in place */ })
    }
    return () => { listeners.delete(onChange) }
  }, [])
  return cfg
}

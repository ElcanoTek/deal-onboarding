import { AuditAIInsight, DealEntry, QAItem } from '../types/deal'
import { fieldPathToElementId } from './sectionStatus'

/** Known QA section ids, in checklist order — mirrors internal/validation/qa.go. */
export const QA_SECTION_IDS = [
  'campaign_information',
  'deal_structure',
  'naming_convention',
  'targeting',
  'inventory_controls',
  'ssp_configuration',
  'campaign_settings',
  'documentation_readiness',
] as const

/** Per-deal field → the id prefix DealsList renders (deal-<prefix>-<deal.id>).
 *  Fields with no dedicated input fall back to the deal-name anchor so the
 *  jump still lands on the right card. */
const DEAL_FIELD_ID_PREFIX: Record<string, string> = {
  nameOverride: 'deal-name',
  theme: 'deal-theme',
  channel: 'deal-channel',
  ssp: 'deal-ssp',
  cpm: 'deal-cpm',
  inventoryType: 'deal-inv',
  vcr: 'deal-vcr',
  language: 'deal-language',
  viewabilityTarget: 'deal-viewability',
  iabCategories: 'deal-iabCategories',
  externalReferenceId: 'deal-extref',
  magniteSizes: 'deal-magniteSizes',
  geoExclude: 'deal-geoExclude',
}

/** Resolve a QA item's jump target to a concrete DOM element id.
 *
 *  Per-deal paths ("deals[N].field") resolve through the deals array because
 *  DealsList keys its input ids by deal.id, not index — this is what makes
 *  "Fix →" land on the exact input of the exact card. Top-level paths reuse
 *  the audit ELEMENT_ID table. Returns undefined when there is no resolvable
 *  input (callers fall back to the section jump). */
export function qaJumpElementId(item: Pick<QAItem, 'fieldPath' | 'rule'>, deals: DealEntry[]): string | undefined {
  const fp = item.fieldPath
  if (!fp) return undefined
  const m = fp.match(/^deals\[(\d+)\]\.(.+)$/)
  if (m) {
    const deal = deals[parseInt(m[1], 10)]
    if (!deal) return undefined
    const prefix = DEAL_FIELD_ID_PREFIX[m[2]] ?? 'deal-name'
    return `${prefix}-${deal.id}`
  }
  return fieldPathToElementId({ rule: item.rule ?? '', passed: false, message: '', fieldPath: fp })
}

/** Split AI insights into per-section buckets (known qaSection) and the
 *  leftover general list. Order within each bucket is preserved. */
export function groupInsightsBySection(insights: AuditAIInsight[]): {
  bySection: Record<string, AuditAIInsight[]>
  general: AuditAIInsight[]
} {
  const known = new Set<string>(QA_SECTION_IDS)
  const bySection: Record<string, AuditAIInsight[]> = {}
  const general: AuditAIInsight[] = []
  for (const ins of insights) {
    const sec = ins.qaSection ?? ''
    if (known.has(sec)) {
      ;(bySection[sec] ??= []).push(ins)
    } else {
      general.push(ins)
    }
  }
  return { bySection, general }
}

export const QA_OUTCOME_LABEL: Record<string, string> = {
  approved: 'Approved',
  approved_minor: 'Approved with Minor Changes',
  rework: 'Returned for Rework',
}

/** Stable identity for an AI insight, shared by the workspace creation gate
 *  and the report renderers so dismiss state always matches. */
export function auditInsightKey(i: AuditAIInsight): string {
  return `${i.severity}|${i.dealIndex ?? ''}|${i.message}`
}

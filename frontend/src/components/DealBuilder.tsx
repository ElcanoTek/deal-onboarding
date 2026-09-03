// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useFormState } from '../hooks/useFormState'
import { requestJumpReveal } from '../lib/reveal'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useDealMatrix } from '../hooks/useDealMatrix'
import { AuditAIInsight, AuditAIResult, AuditResult as AuditResultType, effectivePubMaticPublisherEntries, sspsInUse } from '../types/deal'
import { formOverwriteLabel, formWorthSaving } from '../lib/formDirty'
import { isSubmittedBatch, markBatchSubmitted } from '../lib/submittedBatch'
import { buildBatchPrompt, collectSubmitListIds, generateAllDealPrompts, standardListUploadName } from '../lib/dealPromptYaml'
import { buildBatchBrief, serializeBrief, validateBrief } from '../lib/dealBrief'
import { createRunnerTask, runnerEnvLabel, useRunnerEnvironments } from '../lib/runnerApi'
import { useOperatorConfig } from '../lib/operatorConfig'
import { auditChecksToDealIssues, auditChecksToFormIssues, auditIssuesBySection, checkToSectionId, EMAIL_RE, fieldPathToElementId, getAllStatuses, getDealsStatus, getLiveFormIssues, readyToAudit, SectionId, totalIssueCount } from '../lib/sectionStatus'
import { splitEmails } from '../lib/recipients'
import { mintSubmitKey } from '../lib/submitKey'
import { useStandardLists } from '../lib/lists'

import { SectionBannerContext } from './FormSection'
import { SubmitterDates } from './SubmitterDates'
import { Campaign } from './Campaign'
import { DspConfig } from './DspConfig'
import { DealsList } from './DealsList'
import { SspSelection } from './SspSelection'
import { FileUploads } from './FileUploads'
import { DealMatrixPreview } from './DealMatrixPreview'
import { AuditResult, auditInsightKey } from './AuditResult'
import { DealParserModal } from './DealParserModal'
import { DealPromptOutput } from './DealPromptOutput'
import { RunnerEnvPicker } from './RunnerEnvPicker'
import { DealAssistantDock } from './DealAssistantDock'
import type { ChatNotice } from './DealChat'
import { appliedResultLine } from '../lib/assistantProposal'

type ModalState = 'none' | 'confirm' | 'reset' | 'parser'
type ToastState = { id: number; message: string; tone: 'success' | 'info' | 'error' } | null

/** Guided-builder steps, in the order a trader works. The last entry is the
 *  read-only Deal Summary review; each of the first six maps to a section. */
const WIZARD_STEPS: { id: SectionId | 'summary'; label: string; title: string }[] = [
  { id: 'submitter', label: 'Submitter', title: 'Submitter & Dates' },
  { id: 'client', label: 'Campaign', title: 'Campaign' },
  { id: 'dsp', label: 'DSP', title: 'DSP Configuration' },
  { id: 'deals', label: 'Deals', title: 'Deals' },
  { id: 'ssp', label: 'SSP', title: 'SSP Configuration' },
  { id: 'files', label: 'Files', title: 'File Uploads' },
  { id: 'summary', label: 'Deal Summary', title: 'Deal Summary' },
]
const SUMMARY_STEP = WIZARD_STEPS.length - 1
const stepIndexOf = (id: SectionId): number => WIZARD_STEPS.findIndex(s => s.id === id)

/** Post-submit confirmation screen state ("Batch sent"). */
type DoneState = {
  count: number
  taskId?: string
  duplicate: boolean
  envLabel: string
  recipient: string
  sspCounts: [string, number][]
} | null

type DealBuilderProps = {
  /** Logout callback. Used internally for session-expiry handling on the
   *  audit-AI 401 path. The nav logout is handled by SideNav in App.tsx. */
  onLogout: () => Promise<void>
}

export function DealBuilder({ onLogout }: DealBuilderProps) {
  const { form, update, setForm, reset } = useFormState()
  // Restored-draft transparency: when the builder mounts already holding a
  // meaningfully-filled form, that form was restored from localStorage
  // persistence — say so, name the build, and offer a reset, instead of
  // silently presenting old work as the current task. 'submitted' is the
  // sharper variant: this exact form is a batch that already went to the
  // runner (last-submit key match at mount), so the primary action flips to
  // starting fresh.
  const [restoredNotice, setRestoredNotice] = useState<'draft' | 'submitted' | null>(() => {
    if (!formWorthSaving(form)) return null
    return isSubmittedBatch(form) ? 'submitted' : 'draft'
  })
  const matrix = useDealMatrix(form)
  // The operator config (campaign-id prefix) arrives asynchronously; the live
  // section statuses read it, so they must recompute when it lands or a
  // non-default prefix shows a false "Campaign ID format" warning.
  const operator = useOperatorConfig()
  const statuses = useMemo(() => getAllStatuses(form), [form, operator])
  const statusById = useMemo(() => {
    const map: Record<SectionId, typeof statuses[number]> = {} as Record<SectionId, typeof statuses[number]>
    for (const s of statuses) map[s.id] = s
    return map
  }, [statuses])
  const dealsStatus = useMemo(() => getDealsStatus(form), [form, operator])
  // Merge audit-driven failures with live validation issues so deal cards
  // surface backend rule failures (e.g. always-exclude missing) on the right field.
  const totalIssues = useMemo(() => totalIssueCount(form), [form, operator])
  const isReady = useMemo(() => readyToAudit(form), [form, operator])

  // Guided-builder position. maxStep tracks the furthest step visited so the
  // stepper only warns about steps the trader has actually seen; `reviewed`
  // marks the Deal Summary as visited; `done` swaps in the batch-sent screen.
  const [step, setStep] = useState(0)
  const [maxStep, setMaxStep] = useState(0)
  const [reviewed, setReviewed] = useState(false)
  const [done, setDone] = useState<DoneState>(null)

  // Default dealSheetRecipient to the logged-in trader's session email on
  // mount. Never overwrites a value the trader has already set/edited.
  // This is the load-bearing line against emailing a deal sheet to a client
  // (dealPromptYaml.ts must never pull form.submitterEmail for it).
  //
  // The session identity is only used when it IS an email address: the admin
  // account's identity is the literal string "admin" (users.json login, not
  // an address), and prefilling it created a chip that can never pass the
  // recipient validation. Non-address identities leave the field blank.
  // The trader's session email, kept past the mount prefill so startFresh can
  // re-prefill dealSheetRecipient on a blank form without re-fetching (the
  // prefill effect below is mount-only, and a post-submit reset happens long
  // after mount).
  const [sessionEmail, setSessionEmail] = useState('')
  useEffect(() => {
    // Prefill only when the field is empty (or held nothing but invalid
    // chips) — a value the trader set/edited is never overwritten.
    let shouldPrefill = true
    if (form.dealSheetRecipient) {
      // Heal persisted forms the old prefill already stamped with a
      // non-address identity ("admin"): drop chips that can never validate.
      const valid = splitEmails(form.dealSheetRecipient).filter(a => EMAIL_RE.test(a))
      const joined = valid.join(', ')
      if (joined !== form.dealSheetRecipient) update('dealSheetRecipient', joined)
      if (valid.length > 0) shouldPrefill = false
    }
    let cancelled = false
    fetch('/api/session')
      .then(r => r.ok ? r.json() : null)
      .then(body => {
        if (cancelled) return
        const email: string = typeof body?.email === 'string' ? body.email.trim() : ''
        if (!EMAIL_RE.test(email)) return
        setSessionEmail(email)
        if (shouldPrefill) update('dealSheetRecipient', email)
      })
      .catch(() => { /* unauthenticated or transient — leave blank, YAML will placeholder */ })
    return () => { cancelled = true }
    // Intentionally only on mount — re-runs would clobber trader edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [auditResult, setAuditResult] = useState<AuditResultType | null>(null)
  const [auditAIResult, setAuditAIResult] = useState<AuditAIResult | null>(null)
  const [auditAILoading, setAuditAILoading] = useState(false)
  const [auditAIError, setAuditAIError] = useState<string>('')
  const [auditing, setAuditing] = useState(false)
  // Flips true the first time the trader clicks Audit while the form is
  // incomplete. From then on, live (pre-backend-audit) validation red-outlines
  // the exact offending fields — the same "validate on submit, then live" UX as
  // standard forms. It auto-resolves: liveFormIssues is recomputed from `form`,
  // so each field's outline drops the instant it's filled.
  const [auditAttempted, setAuditAttempted] = useState(false)
  const [creating, setCreating] = useState(false)
  // Idempotency key for the current create intent — DERIVED from the audited
  // snapshot (mintSubmitKey, #225), never random. See handleCreate.
  const [submitKey, setSubmitKey] = useState<string>('')
  // Which runner instance receives submits. The picker (confirm modal + debug
  // panel) only renders when the server reports a dev instance configured, so
  // on prod-only deployments this state is inert. handleCreate resets the
  // selection to defaultEnv per create intent — a dev choice made for one
  // test batch must never silently ride into the next real create.
  const { environments: runnerEnvironments, runnerEnv, setRunnerEnv, defaultEnv: defaultRunnerEnv } = useRunnerEnvironments()
  const [modal, setModal] = useState<ModalState>('none')
  const [toast, setToast] = useState<ToastState>(null)
  // Deal Assistant dock plumbing. prefill seeds the composer from a "Fix with
  // assistant" click; resetToken clears the conversation on submit / reset;
  // notices carry the one-line re-audit result after an applied edit.
  const [assistantPrefill, setAssistantPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [assistantResetToken, setAssistantResetToken] = useState(0)
  const [assistantNotices, setAssistantNotices] = useState<ChatNotice[]>([])
  const pendingAssistantReport = useRef<{ dealsChanged: number; id: number } | null>(null)
  const askAssistant = (text: string) => setAssistantPrefill({ text, nonce: Date.now() })
  const handleAssistantApplied = (dealsChanged: number) => {
    pendingAssistantReport.current = { dealsChanged, id: Date.now() }
  }
  // Runner prompt YAML visibility — a dev/debug surface, hidden for traders by
  // default; the preference persists so developers only flip it once.
  const [showRunnerPrompts, setShowRunnerPrompts] = useState<boolean>(() => {
    try { return localStorage.getItem('deal-onboarding-show-runner-prompts') === '1' } catch { return false }
  })
  const toggleRunnerPrompts = () => setShowRunnerPrompts(v => {
    const next = !v
    try { localStorage.setItem('deal-onboarding-show-runner-prompts', next ? '1' : '0') } catch { /* ignore */ }
    return next
  })
  // One trap per inline modal; `active` keys off which modal is open, and the
  // ref only attaches to the conditionally-rendered dialog it belongs to.
  const resetTrapRef = useFocusTrap<HTMLDivElement>({ active: modal === 'reset', onEscape: () => setModal('none') })
  const confirmTrapRef = useFocusTrap<HTMLDivElement>({ active: modal === 'confirm', onEscape: () => setModal('none') })

  const auditPassed = auditResult?.status === 'passed'
  const sspsUsed = sspsInUse(form.deals)

  // AI-audit gate: a critical AI insight blocks creation until the trader
  // resolves it (re-audit) or explicitly dismisses it. The rule audit passing
  // is necessary but not sufficient — previously the AI criticals were ignored.
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set())
  const aiBlockers = useMemo(
    () => (auditAIResult?.insights ?? []).filter(i => i.severity === 'critical' && !dismissedInsights.has(auditInsightKey(i))),
    [auditAIResult, dismissedInsights],
  )
  const toggleInsightDismissed = (insight: AuditAIInsight) => {
    const key = auditInsightKey(insight)
    setDismissedInsights(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Tag the form snapshot at the moment audit passed; if the form changes,
  // the trader is forced to re-audit before generating prompts.
  const [auditedSnapshot, setAuditedSnapshot] = useState<string>('')
  // Snapshot the AI audit last fired for. The as-you-go rules audits never
  // run the AI critique, so the Deal Summary must fire it even when the
  // rules result is fresh — otherwise a silently-passing rules audit would
  // unlock submit with zero AI review.
  const [aiAuditedSnapshot, setAiAuditedSnapshot] = useState<string>('')
  const formSnapshot = useMemo(() => JSON.stringify(form), [form])
  const auditStale = auditPassed && auditedSnapshot !== formSnapshot && auditedSnapshot !== ''
  const generateUnlocked = auditPassed && !auditStale && aiBlockers.length === 0
  // Captured on EVERY completed audit (pass or fail) — narrower in purpose than
  // auditStale: it gates whether the rendered audit result still describes the
  // current form. Used to optimistically clear field-level red outlines the
  // instant the trader edits any field, even when the audit had failed.
  const [lastAuditSnapshot, setLastAuditSnapshot] = useState<string>('')
  const formChangedSinceAudit = lastAuditSnapshot !== '' && lastAuditSnapshot !== formSnapshot
  // Form-level audit failures keyed by fieldPath. Threaded to section
  // components so they can red-outline the offending input. Cleared the
  // instant the form changes after the audit (optimistic clear on edit);
  // the re-audit re-derives the map.
  // Live field-level issues (red outlines) shown once the trader has attempted
  // an audit. Recomputed from the form, so outlines clear optimistically as
  // fields are filled. Backend audit failures (spread last) take precedence on
  // any shared field path so the more authoritative message wins.
  const liveFormIssues = useMemo(
    () => (auditAttempted ? getLiveFormIssues(form) : {}),
    [auditAttempted, form],
  )
  const formIssues = useMemo(() => {
    const backend = formChangedSinceAudit ? {} : auditChecksToFormIssues(auditResult)
    // As-you-go audits run silently on every step change, so backend failures
    // exist for steps the trader hasn't finished yet. Red-outline a field only
    // once its step has been LEFT (index < maxStep), after the summary has
    // been reached, or after an explicit audit attempt — a pristine field on
    // the step you just landed on gets the banner chip, not a scolding
    // outline. Header badges and step banners stay ungated.
    const gated: Record<string, string> = {}
    for (const [path, msg] of Object.entries(backend)) {
      const sec = checkToSectionId({ rule: '', passed: false, message: '', fieldPath: path }) ?? 'submitter'
      const idx = stepIndexOf(sec)
      if (auditAttempted || reviewed || (idx >= 0 && idx < maxStep)) gated[path] = msg
    }
    return { ...liveFormIssues, ...gated }
  }, [liveFormIssues, auditResult, formChangedSinceAudit, auditAttempted, reviewed, maxStep])

  // Per-section audit-failure counts so a section header goes red when the
  // audit failed there even if its live field-validation is green (the
  // "validation says fine but audit says wrong" complaint). Cleared optimistically
  // on edit, like formIssues. A section's indicator = audit issues there, falling
  // back to the validation-missing count on a failed audit.
  const auditSectionIssues = useMemo(
    () => (formChangedSinceAudit ? null : auditIssuesBySection(auditResult)),
    [auditResult, formChangedSinceAudit],
  )
  const sectionIssues = (id: SectionId): number | undefined => {
    const a = auditSectionIssues?.[id] ?? 0
    if (a > 0) return a
    if (!formChangedSinceAudit && auditResult?.status === 'failed') {
      const v = statusById[id].missing.length
      if (v > 0) return v
    }
    return undefined
  }
  // The form as it looked when the last audit ran — the identity source for
  // re-locating per-deal findings after deals are added/removed/reordered,
  // and the baseline for the per-FIELD optimistic clear below.
  const auditedFormParsed = useMemo(() => {
    if (!lastAuditSnapshot) return null
    try { return JSON.parse(lastAuditSnapshot) as typeof form } catch { return null }
  }, [lastAuditSnapshot])

  // Per-deal audit failures → deal-card outlines. Editing used to clear EVERY
  // card's findings at once (fix one deal and all the others reset until the
  // next audit) — now only the finding whose own inputs changed clears, per
  // deal, per field; the debounced re-audit re-derives the rest.
  const auditDealIssues = useMemo(() => {
    const raw = auditChecksToDealIssues(form, auditResult, auditedFormParsed)
    if (!formChangedSinceAudit || !auditedFormParsed) return formChangedSinceAudit ? [] : raw
    return raw.filter(issue => {
      const cur = form.deals[issue.dealIndex]
      const aud = auditedFormParsed.deals.find(d => d.id === issue.dealId)
      if (!cur || !aud) return false
      const fieldChanged =
        JSON.stringify((cur as unknown as Record<string, unknown>)[issue.field]) !==
        JSON.stringify((aud as unknown as Record<string, unknown>)[issue.field])
      // cpm/vcr read campaign-level fallbacks — an edit there invalidates the
      // finding just like the per-deal field would.
      const sharedChanged =
        issue.field === 'cpm'
          ? form.defaultDisplayCpm !== auditedFormParsed.defaultDisplayCpm ||
            form.defaultVideoCpm !== auditedFormParsed.defaultVideoCpm ||
            form.openxConfig.dealPrice !== auditedFormParsed.openxConfig.dealPrice
          : issue.field === 'vcr'
            ? form.defaultVcr !== auditedFormParsed.defaultVcr
            : false
      return !fieldChanged && !sharedChanged
    })
  }, [form, auditResult, formChangedSinceAudit, auditedFormParsed])

  const { lists: standardLists } = useStandardLists()

  // Keep the active tab visible in the (mobile-scrollable) stepper strip.
  useEffect(() => {
    document.querySelector('.wizard-tab.is-current')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [step])

  /** Move the guided builder to a step. Entering the Deal Summary marks it
   *  reviewed and auto-runs the full backend audit against the current form
   *  (the per-step banners are live validation; this is the enforcement run). */
  const gotoStep = (i: number) => {
    const next = Math.max(0, Math.min(SUMMARY_STEP, i))
    setStep(next)
    setMaxStep(m => Math.max(m, next))
    if (next === SUMMARY_STEP) setReviewed(true)
    window.scrollTo({ top: 0 })
  }

  const showToast = (message: string, tone: 'success' | 'info' | 'error' = 'success') => {
    const id = Date.now()
    setToast({ id, message, tone })
    // Errors stay sticky until the user dismisses (or a new toast replaces them);
    // success/info auto-dismiss after 4s.
    if (tone !== 'error') {
      setTimeout(() => setToast(t => t?.id === id ? null : t), 4000)
    }
  }
  const dismissToast = () => setToast(null)

  /** Audit "fix →" links and summary Edit buttons jump to the step that owns
   *  the section. Every section stays mounted (hidden) so field reveals work
   *  right after the step switch. */
  const scrollToSection = (id: SectionId) => {
    const idx = stepIndexOf(id)
    if (idx >= 0) gotoStep(idx)
  }

  const handleAudit = async () => {
    if (!isReady) {
      // Turn on live field-level errors: the exact inputs red-outline with
      // inline messages, instead of only a generic count toast.
      setAuditAttempted(true)
      const live = getLiveFormIssues(form)
      const fieldCount = Object.keys(live).length
      showToast(
        fieldCount > 0
          ? `${fieldCount} field${fieldCount !== 1 ? 's' : ''} need attention — highlighted in red below.`
          : `Fix ${totalIssues} issue${totalIssues !== 1 ? 's' : ''} before auditing.`,
        'error',
      )
      // Jump to the first incomplete step, then scroll to (and focus) the
      // first offending field with a resolvable input id.
      const firstIncomplete = statuses.find(s => !s.complete)
      if (firstIncomplete) scrollToSection(firstIncomplete.id)
      const firstResolvable = Object.keys(live)
        .map(p => fieldPathToElementId({ rule: '', passed: false, message: '', fieldPath: p }))
        .find(Boolean)
      if (firstResolvable) {
        requestJumpReveal(firstResolvable)
        setTimeout(() => {
          const el = document.getElementById(firstResolvable)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            if (typeof el.focus === 'function') el.focus({ preventScroll: true })
          }
        }, 120)
      }
      return
    }
    setAuditing(true)
    setAuditResult(null)
    setAuditAIResult(null)
    setAuditAIError('')
    setDismissedInsights(new Set())
    setAuditAILoading(true)

    // Build the AI audit payload — same form plus the generated deal names so
    // the model has context.
    const generatedNames = generateAllDealPrompts(form).map(p => p.name)
    const aiBody = { form, generatedNames }

    // Fire both audits in parallel; render whichever returns first.
    const rulesPromise = fetch('/api/audit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    const aiPromise = fetch('/api/audit-ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aiBody),
    })
    setAiAuditedSnapshot(formSnapshot)

    try {
      const res = await rulesPromise
      if (res.status === 401) {
        showToast('Session expired. Sign in again.', 'error')
        setTimeout(() => { void onLogout() }, 400)
        setAuditAILoading(false)
        return
      }
      if (!res.ok) throw new Error(`Audit failed: ${res.status}`)
      const data: AuditResultType = await res.json()
      setAuditResult(data)
      // lastAuditSnapshot tracks any completed audit (pass or fail) so the
      // form-level error map can clear optimistically when the trader edits a
      // failing field. auditedSnapshot stays gated on pass for the
      // generate-prompts gate.
      setLastAuditSnapshot(formSnapshot)
      if (data.status === 'passed') {
        setAuditedSnapshot(formSnapshot)
      }
      setTimeout(() => {
        const el = document.getElementById('audit-result-anchor')
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 80)
    } catch (err) {
      setAuditResult({
        status: 'failed', total_deals: 0, deal_names: [],
        checks: [{ rule: 'network', passed: false, message: String(err) }],
        inferred: { iab_categories: [], note: '' },
      })
    } finally { setAuditing(false) }

    // Resolve the AI critique independently — don't block the rules-result UX on it.
    aiPromise
      .then(async aiRes => {
        if (!aiRes.ok) {
          const body = await aiRes.json().catch(() => ({}))
          throw new Error(body?.error || `AI audit failed (${aiRes.status})`)
        }
        const data: AuditAIResult = await aiRes.json()
        setAuditAIResult(data)
      })
      .catch(err => {
        setAuditAIError(String(err.message || err))
      })
      .finally(() => {
        setAuditAILoading(false)
      })
  }

  // Audit-as-you-go: every step change fires a silent rules-only audit of the
  // current draft, so each step's banner, header badge, and stepper tab carry
  // the backend verdict for what's been entered so far — issues surface on
  // the step that owns them instead of piling up at the summary. Silent:
  // no spinner, no scroll, no AI (the model critique runs once, at the
  // summary). A sequence counter drops stale responses when the trader
  // clicks through tabs faster than the audits return.
  const silentAuditSeq = useRef(0)
  const runSilentAudit = async () => {
    const seq = ++silentAuditSeq.current
    const snapshot = formSnapshot
    try {
      const res = await fetch('/api/audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      })
      if (!res.ok) return
      const data: AuditResultType = await res.json()
      if (seq !== silentAuditSeq.current) return
      setAuditResult(data)
      setLastAuditSnapshot(snapshot)
      if (data.status === 'passed') setAuditedSnapshot(snapshot)
    } catch { /* silent — the summary's full run surfaces transport errors */ }
  }
  useEffect(() => {
    if (done || step === SUMMARY_STEP || auditing) return
    if (formSnapshot !== lastAuditSnapshot) void runSilentAudit()
    // Step-triggered: entering a step re-audits immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // After an applied assistant edit, post the re-audit result into the chat
  // once the (debounced) audit has caught up with the applied form.
  useEffect(() => {
    const pending = pendingAssistantReport.current
    if (!pending || !auditResult || lastAuditSnapshot !== formSnapshot) return
    pendingAssistantReport.current = null
    setAssistantNotices(n => [...n, { id: `applied-${pending.id}`, text: appliedResultLine(pending.dealsChanged, auditResult) }])
  }, [auditResult, lastAuditSnapshot, formSnapshot])

  // …and a debounced re-audit while EDITING, so per-deal findings refresh in
  // place (fix deal 2's VCR → only that finding drops, the audit confirms the
  // rest ~700ms later) instead of waiting for the next step change.
  useEffect(() => {
    if (done || step === SUMMARY_STEP || auditing) return
    if (formSnapshot === lastAuditSnapshot) return
    const t = setTimeout(() => { void runSilentAudit() }, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSnapshot])

  // Entering the Deal Summary runs the FULL audit (rules + AI critique)
  // whenever either half hasn't seen the current form — the as-you-go audits
  // above cover only the rules half.
  useEffect(() => {
    if (step !== SUMMARY_STEP || done) return
    if (auditing) return
    if (isReady && (!auditResult || formChangedSinceAudit || aiAuditedSnapshot !== formSnapshot)) void handleAudit()
    // Intentionally step-triggered only — the audit callback owns the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const handleCreate = () => {
    // Derive the idempotency key from the AUDITED form snapshot (#225) —
    // sha256 over canonicalized JSON — instead of minting a fresh random key
    // per click. Every retry of the SAME audited batch (re-click after an
    // error toast, a lost/timed-out response, even a reload followed by
    // re-auditing the unchanged form) replays the SAME key, so the server
    // dedups it and can never book a second live batch. Editing the form
    // invalidates the audit, and the re-audited snapshot derives a different
    // key — a genuinely different batch is a distinct submission. The Create
    // button is gated on generateUnlocked, so auditedSnapshot === formSnapshot
    // here; the fallback is belt-and-suspenders for that invariant breaking.
    const snap = auditedSnapshot || formSnapshot
    setSubmitKey(mintSubmitKey(snap))
    // Fresh intent, fresh environment: reset to the safe default so a dev
    // selection left over from an earlier test can't preselect itself for a
    // real batch. Picking dev is a deliberate per-intent act in the modal.
    setRunnerEnv(defaultRunnerEnv)
    setModal('confirm')
  }
  const handleConfirmCreate = async () => {
    setModal('none')
    setCreating(true)
    try {
      const prompt = buildBatchPrompt(form, standardLists)
      const brief = buildBatchBrief(form, standardLists)
      // Attachment set FIRST (#221): batch-applied standard lists UNIONed with
      // every per-deal standard-list pick (collectSubmitListIds — the same
      // resolution the prompt builders use), so every list the prompt
      // references by name is actually uploaded to the runner.
      const listIds = collectSubmitListIds(form, standardLists)
      // Pair filePaths with fileNames by index: filter the FILE objects first
      // so an empty-path file can't misalign the two arrays. The server uploads
      // each attachment to the runner under fileNames[i] so the agent can match the
      // prompt's original-filename reference (#157).
      const attachFiles = [...form.domainLists, ...form.appBundleLists].filter(f => f.path)
      const filePaths = attachFiles.map(f => f.path)
      const fileNames = attachFiles.map(f => f.name)
      // Fail closed BEFORE any network call when the brief references a
      // list/file that is not in the attachment set — advisory here,
      // enforced again server-side (runner.go prompt_reference_unattached).
      // listNames use standardListUploadName (#198): the extension-suffixed
      // name the server uploads each list under AND the name the prompt
      // references — comparing against the bare registry name would
      // false-block every extensionless-named list.
      const briefVal = validateBrief(brief, {
        listNames: standardLists.filter(l => listIds.includes(l.id)).map(standardListUploadName),
        fileNames,
      })
      if (!briefVal.ok) {
        throw new Error(`Brief validation failed: ${briefVal.issues.join('; ')}`)
      }
      const res = await createRunnerTask({
        prompt,
        brief: serializeBrief(brief),
        listIds,
        filePaths,
        fileNames,
        runnerEnv,
        idempotencyKey: submitKey,
        operation: 'create',
        // The audited snapshot — the exact FormData JSON the passing /api/audit
        // run approved. The server re-runs the same audit pipeline against it
        // and rejects the submit if it no longer passes. The Create
        // button is gated on generateUnlocked, so this equals `form` here; an
        // empty snapshot (never audited) fails closed server-side with
        // audit_form_required.
        form: auditedSnapshot ? (JSON.parse(auditedSnapshot) as unknown) : undefined,
      })
      // 2xx ONLY past here: the batch is live, so remember its submit key
      // FIRST — any surviving copy of this exact form is then recognized as
      // already-submitted (the restored-draft notice keys off it).
      markBatchSubmitted(submitKey)
      // Server-side submit warnings (e.g. the recipient-typo tripwire) ride a
      // sticky toast: the batch IS live, but something the trader relies on
      // may not happen — never bury that under a plain success toast.
      const submitWarnings: string[] = res.warnings?.length ? [...res.warnings] : []
      const sentMsg = res.duplicate
        ? 'Already submitted — showing the existing runner task.'
        : `Sent ${matrix.totalDeals} deal${matrix.totalDeals !== 1 ? 's' : ''} to ${runnerEnvLabel(res.runnerEnv)}${res.taskId ? ` · task ${res.taskId}` : ''}.`
      if (submitWarnings.length > 0) {
        showToast(`${sentMsg} BUT ${submitWarnings.join('; ')}.`, 'error')
      } else {
        showToast(sentMsg)
      }
      // Swap the builder for the batch-sent confirmation screen.
      setDone({
        count: matrix.totalDeals,
        taskId: res.taskId,
        duplicate: !!res.duplicate,
        envLabel: runnerEnvLabel(res.runnerEnv),
        recipient: form.dealSheetRecipient,
        sspCounts: matrix.sspCounts,
      })
      // A submitted batch is no longer work in progress: clear the form (store
      // + localStorage) so returning to the builder starts blank instead of
      // presenting the sent batch as editable work. The `done` screen above
      // owns its own snapshot.
      startFresh()
      window.scrollTo({ top: 0 })
    } catch (err) {
      // Submit failed: surface the error so the trader can fix and retry
      // (same key).
      showToast(err instanceof Error ? err.message : 'Runner submission failed', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleResetClick = () => setModal('reset')

  /** Clear the builder back to a truly blank form: shared store + its
   *  localStorage persistence, every piece of audit/wizard state, and the
   *  restored-draft notice. The trader's session email re-prefills the
   *  deal-sheet recipient (the mount effect won't re-run). Deliberately does
   *  NOT touch `done` — the batch-sent screen owns its own snapshot, so the
   *  submit success path can reset underneath it while it stays up. */
  const startFresh = () => {
    reset()
    if (sessionEmail) update('dealSheetRecipient', sessionEmail)
    setAuditResult(null)
    setAuditAIResult(null)
    setAuditAIError('')
    setAuditAILoading(false)
    setAuditAttempted(false)
    setDismissedInsights(new Set())
    setAuditedSnapshot('')
    setAiAuditedSnapshot('')
    setLastAuditSnapshot('')
    setSubmitKey('')
    setRestoredNotice(null)
    // The assistant conversation is per batch — clear it with the form.
    setAssistantResetToken(t => t + 1)
    setAssistantNotices([])
    pendingAssistantReport.current = null
    setStep(0)
    setMaxStep(0)
    setReviewed(false)
  }
  const confirmReset = () => {
    startFresh()
    setDone(null)
    setModal('none')
    showToast('Form reset.', 'info')
  }

  // ---------------- Guided wizard derived state ----------------
  const requiredComplete =
    statusById.submitter.complete &&
    statusById.client.complete &&
    statusById.dsp.complete &&
    form.deals.length > 0 && statusById.deals.complete &&
    statusById.ssp.complete
  const sectionComplete = (id: SectionId): boolean =>
    id === 'deals' ? form.deals.length > 0 && statusById.deals.complete : statusById[id].complete
  const completeCount = (['submitter', 'client', 'dsp', 'deals', 'ssp'] as SectionId[])
    .filter(sectionComplete).length + (statusById.files.complete ? 1 : 0)
  const attentionCount = 6 - completeCount

  /** Backend audit checks failing in a section, minus the ones the live
   *  validation already covers as missing-field chips (same fieldPath) — the
   *  as-you-go audit's contribution to that step's banner. */
  const sectionAuditFindings = (id: SectionId): { message: string; fieldPath?: string }[] => {
    if (!auditResult || formChangedSinceAudit) return []
    const livePaths = new Set([
      ...(statusById[id].fieldIssues ?? []).map(f => f.path),
      ...(id === 'deals' ? dealsStatus.dealIssues.map(di => `deals[${di.dealIndex}].${di.field}`) : []),
    ])
    return auditResult.checks
      .filter(c => !c.passed && c.rule !== 'network' && (checkToSectionId(c) ?? 'submitter') === id)
      .filter(c => !c.fieldPath || !livePaths.has(c.fieldPath))
      .map(c => ({ message: c.message, fieldPath: c.fieldPath }))
  }

  /** Per-step audit banner — the live validation verdict for one stage plus
   *  the backend audit's findings for it (the as-you-go audits keep those
   *  fresh on every step change), rendered as the first child of that
   *  section's body. */
  const stepBannerFor = (id: SectionId): ReactNode => {
    const st = statusById[id]
    const findings = sectionAuditFindings(id)
    const complete = sectionComplete(id) && findings.length === 0
    if (id === 'files' && st.complete && findings.length === 0) {
      return (
        <div className="step-audit step-audit--optional">
          <span className="step-audit__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </span>
          <div className="step-audit__body">
            <span className="step-audit__title">Optional step</span>
            <span className="step-audit__note">Attach domain / app-bundle lists and reusable standard lists only if this campaign needs them.</span>
          </div>
        </div>
      )
    }
    if (complete) {
      const audited = !!auditResult && !formChangedSinceAudit
      return (
        <div className="step-audit step-audit--ok" role="status">
          <span className="step-audit__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          </span>
          <div className="step-audit__body">
            <span className="step-audit__title">{audited ? 'This step passes the audit' : 'This step looks complete'}</span>
            <span className="step-audit__note">{audited ? 'Every required field is filled in and no audit rule flags this step.' : 'Every required field here is filled in.'}</span>
          </div>
        </div>
      )
    }
    const missing = id === 'deals' && form.deals.length === 0 ? ['At least one deal'] : st.missing
    const count = missing.length + findings.length
    return (
      <div className="step-audit step-audit--warn" role="status">
        <span className="step-audit__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
        </span>
        <div className="step-audit__body">
          <span className="step-audit__title">{count} {count === 1 ? 'thing' : 'things'} to address on this step</span>
          <span className="step-audit__note">
            Fix {count === 1 ? 'it' : 'them'} here before moving on — the audit re-checks as you go.
          </span>
          {missing.length > 0 && (
            <div className="step-audit__chips">
              {missing.map(m => <span key={m} className="step-audit__chip">{m}</span>)}
            </div>
          )}
          {findings.length > 0 && (
            <ul className="step-audit__findings">
              {findings.map((f, i) => <li key={`${f.fieldPath ?? ''}-${i}`}>{f.message}</li>)}
            </ul>
          )}
        </div>
      </div>
    )
  }

  const sectionBanners: Partial<Record<string, ReactNode>> = {
    submitter: stepBannerFor('submitter'),
    client: stepBannerFor('client'),
    dsp: stepBannerFor('dsp'),
    deals: stepBannerFor('deals'),
    ssp: stepBannerFor('ssp'),
    files: stepBannerFor('files'),
  }

  // ---------------- Deal Summary (step 7) derived rows ----------------
  const fmtDate = (iso: string): string => {
    if (!iso) return ''
    const [y, m, d] = iso.split('-').map(n => parseInt(n, 10))
    if (!y || !m || !d) return iso
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${mo[m - 1] ?? ''} ${d}, ${y}`
  }
  type SummaryRow = { label: string; value: string; filled: boolean; required?: boolean; mono?: boolean }
  const sumRow = (label: string, raw: string, opts?: { required?: boolean; mono?: boolean; display?: string }): SummaryRow => {
    const filled = !!(raw && raw.trim())
    return { label, value: opts?.display ?? (filled ? raw : ''), filled, required: opts?.required !== false, mono: opts?.mono }
  }
  const submitterRows: SummaryRow[] = [
    sumRow('Submitter name', form.submitterName),
    sumRow('Submitter email', form.submitterEmail),
    sumRow('Deal sheet recipient', form.dealSheetRecipient),
    sumRow('Requested due date', form.requestedDueDate, { display: fmtDate(form.requestedDueDate) || undefined }),
    sumRow('Flight start', form.flightStartDate, { display: fmtDate(form.flightStartDate) || undefined }),
    sumRow('Flight end', form.flightEndDate, { display: fmtDate(form.flightEndDate) || undefined }),
  ]
  const clientRows: SummaryRow[] = [
    sumRow('Agency', form.agency),
    sumRow('Brand / Advertiser', form.brand),
    sumRow('Campaign name', form.campaignName, { required: false }),
    sumRow('Campaign ID', form.campaignId, { mono: true }),
    sumRow('Data partner', form.dataPartner, { required: false, display: form.dataPartner || 'None' }),
    sumRow('Funnel', form.funnel, { required: false, display: form.funnel || 'None' }),
    sumRow('Attribution code', form.attributionCode, { required: false, mono: true }),
    sumRow('Curated deal fee', form.curatedDealFee, { display: form.curatedDealFee ? `${form.curatedDealFee}${form.feeType === 'Percentage of Media' ? '%' : ''}` : undefined }),
    sumRow('Fee type', form.feeType),
    sumRow('Daily pacing goal', form.dailyPacingGoal, { required: false }),
    sumRow('Campaign KPI goal', form.kpiGoal, { required: false }),
  ]
  const activeDspList = form.multipleDsps ? form.dsps : form.dsps.slice(0, 1)
  const dspRows: SummaryRow[] = [
    ...activeDspList.map((d, i) => sumRow(activeDspList.length > 1 ? `DSP ${i + 1}` : 'DSP', d.dsp && d.seatId ? `${d.dsp} · seat ${d.seatId}` : d.dsp || '')),
    sumRow('Multiple DSPs', form.multipleDsps ? 'Yes' : 'No', { required: false }),
  ]
  const sspConfigSummary = (ssp: string): string => {
    switch (ssp) {
      case 'Index Exchange':
        return form.ixConfig.accountId ? `Account ${form.ixConfig.accountId} · ${form.ixConfig.auctionType}` : ''
      case 'OpenX':
        return form.openxConfig.dealPrice ? `Deal price $${form.openxConfig.dealPrice} · ${form.openxConfig.pmpDealType || 'PREFERRED_DEAL'}` : ''
      case 'PubMatic':
        // Effective scope (entries else legacy names) — counting publisherNames
        // alone showed "0 publisher name(s)" for PublisherAllowlist chips.
        return form.pubmaticConfig.maxReach ? 'Max publishers' : `${effectivePubMaticPublisherEntries(form.pubmaticConfig).length} publisher(s)`
      case 'Magnite':
        return form.magniteConfig.marketplace ? `${form.magniteConfig.marketplace}${form.magniteConfig.priceType ? ` · ${form.magniteConfig.priceType}` : ''}` : ''
      default:
        return 'Configured in step 5'
    }
  }
  const sspRows: SummaryRow[] = sspsUsed.map(ssp => sumRow(ssp, sspConfigSummary(ssp), { display: sspConfigSummary(ssp) || undefined }))
  const filesRows: SummaryRow[] = [
    sumRow('Domain lists', form.domainLists.map(f => f.name).join(', '), { required: false, display: form.domainLists.length ? form.domainLists.map(f => f.name).join(', ') : 'None attached' }),
    sumRow('App-bundle lists', form.appBundleLists.map(f => f.name).join(', '), { required: false, display: form.appBundleLists.length ? form.appBundleLists.map(f => f.name).join(', ') : 'None attached' }),
    (() => {
      const ids = collectSubmitListIds(form, standardLists)
      const names = standardLists.filter(l => ids.includes(l.id)).map(l => l.name)
      return sumRow('Standard lists', names.join(', '), { required: false, display: names.length ? names.join(', ') : 'None applied' })
    })(),
  ]
  const dealIssueIds = new Set(dealsStatus.dealIssues.map(i => i.dealId))
  const summaryBadge = (complete: boolean) => complete
    ? (
      <span className="status-badge status-badge--success">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
        Complete
      </span>
    )
    : <span className="status-badge status-badge--warning">Needs info</span>
  const renderSummaryRows = (rows: SummaryRow[], cols?: boolean) => (
    <dl className={`summary-dl${cols ? ' summary-dl--cols' : ''}`}>
      {rows.map(r => (
        <div key={r.label} className="summary-dl__row">
          <dt className="summary-dl__label">{r.label}</dt>
          <dd className={`summary-dl__value${r.mono && r.filled ? ' field-mono' : ''}${r.filled ? '' : r.required ? ' summary-dl__value--req' : ' summary-dl__value--muted'}`}>
            {r.filled || r.value ? r.value : r.required ? 'Required — not set' : 'Not set'}
          </dd>
        </div>
      ))}
    </dl>
  )

  const summaryStatusText = auditing
    ? 'Running final audit…'
    : !requiredComplete
      ? `${attentionCount} section${attentionCount === 1 ? ' still needs' : 's still need'} attention`
      : auditStale
        ? 'Form changed since the audit — re-run it before submitting'
        : auditResult?.status === 'failed'
          ? 'Audit found issues — fix them, then re-audit'
          : aiBlockers.length > 0
            ? `${aiBlockers.length} critical AI issue${aiBlockers.length === 1 ? '' : 's'} — resolve or dismiss in the audit panel`
            : generateUnlocked
              ? 'All checks passed — ready to submit'
              : 'Finishing audit…'

  return (
    <>
      {done && (
        <div className="container container--wide">
          <div className="builder-done">
            <p className="builder-done__headline">
              ✓ {done.duplicate ? `Batch already submitted — ${done.count} deal${done.count === 1 ? '' : 's'} with ${done.envLabel}` : `Sent ${done.count} deal${done.count === 1 ? '' : 's'} to ${done.envLabel}`}
            </p>
            <ul className="update-send-results">
              {done.sspCounts.map(([ssp, n]) => (
                <li key={ssp}>
                  <span className="update-send-results__label">{ssp}</span>
                  <span className="update-send-results__count">{n} deal{n === 1 ? '' : 's'}</span>
                  {done.taskId && <span className="pending-meta">{done.taskId}</span>}
                </li>
              ))}
            </ul>
            <p className="field-helper" style={{ margin: 0 }}>
              The runner parses the batch, runs a one-deal canary, creates the rest, verifies every write, and emails{' '}
              <strong>{done.recipient || 'the deal-sheet recipient'}</strong> a deal sheet + QA report. Per-deal outcomes and deal IDs are reported in the runner's own UI{done.taskId ? ` (task ${done.taskId})` : ''}.
            </p>
            <div className="builder-done__actions">
              {/* startFresh, not just setDone(null): the sent batch must never
                  reload into the builder as editable work. */}
              <button type="button" className="btn btn-primary" onClick={() => { startFresh(); setDone(null); window.scrollTo({ top: 0 }) }}>Build another batch</button>
            </div>
          </div>
        </div>
      )}

      {!done && (
      <div className="container container--wide" style={{ paddingBottom: 0 }}>
        <div className="page-topbar">
          <div className="page-topbar__inner">
            <h1 className="page-header__title">Deal Builder</h1>
            <p className="page-header__intro">Build, audit, and submit multi-SSP programmatic deals.</p>
          </div>
        </div>

      {restoredNotice && (
        <div className="workspace-handoff" role="status">
          <span className="workspace-handoff__label">
            {restoredNotice === 'submitted' ? (
              <><strong>This batch was already submitted.</strong> {formOverwriteLabel(form)} went to the runner — start fresh unless you're deliberately rebuilding it.</>
            ) : (
              <><strong>Restored your in-progress build:</strong> {formOverwriteLabel(form)}. It lives only in this browser — keep working, or reset to start fresh.</>
            )}
          </span>
          <div className="workspace-handoff__actions">
            {restoredNotice === 'submitted' ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { startFresh(); showToast('Cleared the submitted batch — the builder is blank.', 'info') }}>Start fresh</button>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleResetClick}>Reset form</button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRestoredNotice(null)}>Keep working</button>
          </div>
        </div>
      )}

      <main>
        <div className="form-toolbar" aria-label="Form controls" style={{ marginTop: '1rem' }}>
          <div className="form-toolbar__status">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem', color: 'var(--color-accent)', flex: '0 0 auto' }} aria-hidden="true">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <span>Have a trader brief? <strong style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>Parse Deal Data</strong> auto-fills every step.</span>
          </div>
          <div className="form-toolbar__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleResetClick}>Reset form</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal('parser')}>
              Parse Deal Data
            </button>
          </div>
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <div className="wizard-head">
            <span className="wizard-head__label">Step {step + 1} of {WIZARD_STEPS.length} — {WIZARD_STEPS[step].title}</span>
            <span className="wizard-head__meta" aria-live="polite">{completeCount} of 6 sections complete</span>
          </div>
          <div className="wizard-tabs" role="tablist" aria-label="Deal builder steps">
            {WIZARD_STEPS.map((s, i) => {
              const isCurrent = step === i
              // A tab is "done" only when its live validation AND the
              // as-you-go audit agree — a section can be filled in yet still
              // flagged by an audit rule.
              const auditClean = s.id === 'summary' || sectionAuditFindings(s.id as SectionId).length === 0
              const complete = s.id === 'summary'
                ? requiredComplete && reviewed
                : (s.id === 'files'
                    ? statusById.files.complete && maxStep >= i
                    : sectionComplete(s.id as SectionId)) && auditClean
              const optional = s.id === 'files'
              const attention = !complete && !optional && s.id !== 'summary' && (maxStep >= i || !auditClean) && !isCurrent
              const cls = `wizard-tab${isCurrent ? ' is-current' : complete ? ' is-complete' : attention ? ' is-attention' : ''}`
              return (
                <button key={s.id} type="button" role="tab" aria-selected={isCurrent} aria-current={isCurrent ? 'step' : undefined} className={cls} onClick={() => gotoStep(i)}>
                  {!isCurrent && complete && (
                    <svg className="wizard-tab__done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
                  )}
                  {attention && (
                    <svg className="wizard-tab__warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
                  )}
                  <span className="wizard-tab__label">{s.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className={`layout-grid${step === SUMMARY_STEP ? ' layout-grid--single' : ''}`}>
          <div className="form-column form-column-gap">
            {/* Every section stays mounted (uploads keep streaming, audit
                field-reveals resolve) — the wizard hides all but the current
                step. Step order: who/when, campaign, DSP, the deals themselves,
                per-SSP configuration, then files. */}
            <SectionBannerContext.Provider value={sectionBanners}>
              <div hidden={step !== 0}>
                <SubmitterDates form={form} update={update} filled={statusById.submitter.filled} total={statusById.submitter.total} issues={sectionIssues('submitter')} formIssues={formIssues} />
              </div>
              <div hidden={step !== 1}>
                <Campaign form={form} update={update} filled={statusById.client.filled} total={statusById.client.total} issues={sectionIssues('client')} formIssues={formIssues} />
              </div>
              <div hidden={step !== 2}>
                <DspConfig form={form} update={update} filled={statusById.dsp.filled} total={statusById.dsp.total} issues={sectionIssues('dsp')} formIssues={formIssues} />
              </div>
              <div hidden={step !== 3}>
                <DealsList form={form} update={update} filled={statusById.deals.filled} total={statusById.deals.total} issues={form.deals.length === 0 ? undefined : ((dealsStatus.dealIssues.length + auditDealIssues.length) || undefined)} dealIssues={[...dealsStatus.dealIssues, ...auditDealIssues]} standardLists={standardLists} />
              </div>
              <div hidden={step !== 4}>
                <SspSelection form={form} update={update} filled={statusById.ssp.filled} total={statusById.ssp.total} issues={sectionIssues('ssp')} formIssues={formIssues} />
              </div>
              <div hidden={step !== 5}>
                <FileUploads form={form} update={update} number="06" filled={statusById.files.filled} total={statusById.files.total} issues={sectionIssues('files')} standardLists={standardLists} />
              </div>
            </SectionBannerContext.Provider>

            {step === SUMMARY_STEP && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="summary-head">
                  <p className="subsection-label">Step 7</p>
                  <h2 className="summary-head__title">Deal summary</h2>
                  <p className="summary-head__sub">
                    Everything you entered, locked for a final read. Fields aren't editable here — use <strong>Edit</strong> on any card (or a step above) to change something, then come back to submit.
                  </p>
                </div>

                <div className={`summary-banner ${requiredComplete ? (generateUnlocked ? 'summary-banner--ok' : 'summary-banner--pending') : 'summary-banner--warn'}`} role="status">
                  <span className="summary-banner__mark" aria-hidden="true">
                    {requiredComplete ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
                    )}
                  </span>
                  <div className="summary-banner__body">
                    <span className="summary-banner__title">
                      {requiredComplete ? (generateUnlocked ? 'Ready to submit' : 'Almost there') : `${attentionCount} section${attentionCount === 1 ? ' needs' : 's need'} attention`}
                    </span>
                    <span className="summary-banner__note">
                      {requiredComplete
                        ? generateUnlocked
                          ? 'Every required field across the six steps is filled in and the audit passed. Give it one last read, then submit to the runner.'
                          : summaryStatusText
                        : 'Some required fields are still blank. Open the flagged steps to finish them before submitting.'}
                    </span>
                  </div>
                </div>

                <div className="summary-grid">
                  <div className="summary-card">
                    <div className="summary-card__head">
                      <span className="section-num">1</span>
                      <h3 className="summary-card__title">Submitter &amp; Dates</h3>
                      <span style={{ marginLeft: 'auto' }}>{summaryBadge(statusById.submitter.complete)}</span>
                      <button type="button" className="summary-card__edit" onClick={() => gotoStep(0)}>Edit</button>
                    </div>
                    {renderSummaryRows(submitterRows)}
                  </div>

                  <div className="summary-card">
                    <div className="summary-card__head">
                      <span className="section-num">2</span>
                      <h3 className="summary-card__title">Campaign</h3>
                      <span style={{ marginLeft: 'auto' }}>{summaryBadge(statusById.client.complete)}</span>
                      <button type="button" className="summary-card__edit" onClick={() => gotoStep(1)}>Edit</button>
                    </div>
                    {renderSummaryRows(clientRows)}
                  </div>

                  <div className="summary-card summary-card--wide">
                    <div className="summary-card__head">
                      <span className="section-num">3</span>
                      <h3 className="summary-card__title">DSP Configuration</h3>
                      <span style={{ marginLeft: 'auto' }}>{summaryBadge(statusById.dsp.complete)}</span>
                      <button type="button" className="summary-card__edit" onClick={() => gotoStep(2)}>Edit</button>
                    </div>
                    {renderSummaryRows(dspRows, true)}
                  </div>

                  <div className="summary-card summary-card--wide">
                    <div className="summary-card__head">
                      <span className="section-num">4</span>
                      <h3 className="summary-card__title">Deals</h3>
                      <span className="chip">{matrix.totalDeals}</span>
                      <span style={{ marginLeft: 'auto' }}>{summaryBadge(form.deals.length > 0 && statusById.deals.complete)}</span>
                      <button type="button" className="summary-card__edit" onClick={() => gotoStep(3)}>Edit</button>
                    </div>
                    <div className="summary-deals">
                      {matrix.items.map((it, i) => {
                        const ready = !dealIssueIds.has(it.id.split('~')[0])
                        return (
                          <div key={it.id} className="summary-deal">
                            <div className="summary-deal__top">
                              <span className="summary-deal__idx">Deal {i + 1}</span>
                              <span className="summary-deal__theme">{it.theme || '—'}</span>
                              <span
                                className={`deal-status-dot ${ready ? 'deal-status-dot--ok' : 'deal-status-dot--warn'}`}
                                style={{ marginLeft: 'auto' }}
                                title={ready ? 'Ready' : 'Needs attention'}
                                aria-label={ready ? 'Ready' : 'Needs attention'}
                              />
                            </div>
                            <div className="summary-deal__name">{it.name}</div>
                            <div className="summary-deal__meta">{[it.ssp, it.channel, it.geo].filter(Boolean).join(' · ')}{it.sheetOnly ? ' · sheet only' : ''}</div>
                          </div>
                        )
                      })}
                      {matrix.items.length === 0 && <p className="field-helper" style={{ margin: 0 }}>No deals yet — add at least one in step 4.</p>}
                    </div>
                  </div>

                  <div className="summary-card summary-card--wide">
                    <div className="summary-card__head">
                      <span className="section-num">5</span>
                      <h3 className="summary-card__title">SSP Configuration</h3>
                      <span style={{ marginLeft: 'auto' }}>{summaryBadge(statusById.ssp.complete)}</span>
                      <button type="button" className="summary-card__edit" onClick={() => gotoStep(4)}>Edit</button>
                    </div>
                    {sspRows.length > 0
                      ? renderSummaryRows(sspRows, true)
                      : <p className="field-helper" style={{ margin: 0 }}>No SSPs in use yet — pick an SSP on each deal in step 4.</p>}
                  </div>

                  <div className="summary-card summary-card--wide">
                    <div className="summary-card__head">
                      <span className="section-num">6</span>
                      <h3 className="summary-card__title">File Uploads</h3>
                      <span style={{ marginLeft: 'auto' }}>
                        {statusById.files.complete
                          ? <span className="status-badge status-badge--muted">Optional</span>
                          : summaryBadge(false)}
                      </span>
                      <button type="button" className="summary-card__edit" onClick={() => gotoStep(5)}>Edit</button>
                    </div>
                    {renderSummaryRows(filesRows)}
                  </div>
                </div>

                <span id="audit-result-anchor" aria-hidden="true" />
                {auditing && !auditResult && (
                  <div className="section-card" style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }} role="status">
                    <span className="btn-spinner" aria-hidden="true" />
                    <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Auditing {matrix.totalDeals} deal{matrix.totalDeals !== 1 ? 's' : ''} against SSP policy…</span>
                  </div>
                )}
                {auditResult && (
                  <AuditResult
                    result={auditResult}
                    deals={form.deals}
                    onJumpToSection={id => scrollToSection(id as SectionId)}
                    aiResult={auditAIResult}
                    aiLoading={auditAILoading}
                    aiError={auditAIError}
                    dismissedInsights={dismissedInsights}
                    onDismissInsight={toggleInsightDismissed}
                    defaultExpanded
                    stale={formChangedSinceAudit}
                    onAskAssistant={askAssistant}
                  />
                )}

                {auditStale && (
                  <div className="audit-stale-banner" role="status" aria-live="polite">
                    <svg className="audit-stale-banner__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span>Form changed since last audit — re-run Audit before submitting.</span>
                  </div>
                )}

                {/* Runner prompt YAML — a developer/debugging surface. Hidden behind a
                    disclosure so traders aren't confronted with raw prompts; devs
                    flip it open and the choice sticks via localStorage. */}
                {form.deals.length > 0 && (
                  <div className="runner-debug">
                    <button
                      type="button"
                      className="runner-debug__toggle"
                      aria-expanded={showRunnerPrompts}
                      aria-controls="runner-debug-panel"
                      onClick={toggleRunnerPrompts}
                    >
                      <span>
                        Runner deal prompts
                        <span className="runner-debug__hint">debug — for developers</span>
                      </span>
                      <span className="prompt-panel__disclosure" aria-hidden="true">{showRunnerPrompts ? '−' : '+'}</span>
                    </button>
                    {showRunnerPrompts && (
                      <div id="runner-debug-panel">
                        {/* Read-only — Submit on this step is the only create path. */}
                        <DealPromptOutput
                          form={form}
                          auditPassed={generateUnlocked}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {step < SUMMARY_STEP && (
              <div className="wizard-nav">
                <button type="button" className="btn btn-secondary" onClick={() => gotoStep(step - 1)} disabled={step === 0}>Previous Step</button>
                <button type="button" className="btn btn-primary" onClick={() => gotoStep(step + 1)}>Next Step</button>
              </div>
            )}
          </div>

          {step !== SUMMARY_STEP && <DealMatrixPreview matrix={matrix} />}
        </div>

        {step === SUMMARY_STEP && (
          <div className="summary-submit">
            <div className="summary-submit__inner">
              <button type="button" className="btn btn-secondary" onClick={() => gotoStep(SUMMARY_STEP - 1)}>← Back to edit</button>
              {auditResult && (formChangedSinceAudit || auditResult.status === 'failed') && (
                <button type="button" className="btn btn-secondary" onClick={handleAudit} disabled={auditing} aria-busy={auditing}>
                  {auditing && <span className="btn-spinner" aria-hidden="true" />}
                  {auditing ? 'Auditing…' : 'Re-audit Deals'}
                </button>
              )}
              <span className="summary-submit__status" aria-live="polite">{summaryStatusText}</span>
              <button
                type="button"
                className="btn btn-primary summary-submit__go"
                onClick={handleCreate}
                disabled={!generateUnlocked || creating}
                aria-disabled={!generateUnlocked}
                title={auditStale ? 'Re-run audit before submitting' : !auditPassed ? 'The audit must pass first' : aiBlockers.length > 0 ? `${aiBlockers.length} critical AI issue${aiBlockers.length !== 1 ? 's' : ''} — resolve or dismiss in the audit panel` : undefined}
              >
                {creating && <span className="btn-spinner" aria-hidden="true" />}
                {creating ? 'Submitting…' : `Submit ${matrix.totalDeals} deal${matrix.totalDeals !== 1 ? 's' : ''} to the runner`}
              </button>
            </div>
          </div>
        )}
      </main>
      </div>
      )}

      {!done && (
        <DealAssistantDock
          form={form}
          onFormChange={setForm}
          audit={formChangedSinceAudit ? null : auditResult}
          prefill={assistantPrefill}
          resetToken={assistantResetToken}
          notices={assistantNotices}
          onApplied={handleAssistantApplied}
          disabled={creating}
        />
      )}

      {modal === 'parser' && (
        <DealParserModal
          currentForm={form}
          onClose={() => setModal('none')}
          onApply={(next, applied) => {
            // A parsed brief that carries its own deals REPLACES the deal list
            // (mergeParsedIntoForm) — for scalar fields the parser only fills,
            // but started deals are real work and must not vanish on a click.
            // Compare deal identity (theme+channel), not array reference: the
            // exclusion-fold path also reports 'deals' while keeping the same
            // deals, and re-parsing the same brief shouldn't nag either.
            const startedDeals = form.deals.filter(d => d.theme.trim() || d.channel)
            if (applied.includes('deals') && startedDeals.length > 0) {
              const identity = (deals: typeof form.deals) => JSON.stringify(deals.map(d => [d.theme.trim(), d.channel]))
              if (identity(form.deals) !== identity(next.deals) &&
                !window.confirm(`Applying this parse replaces the ${startedDeals.length} deal${startedDeals.length !== 1 ? 's' : ''} already in the builder with the ${next.deals.length} parsed one${next.deals.length !== 1 ? 's' : ''}. Replace them? (Cancel keeps your current deals.)`)) {
                return
              }
            }
            setForm(next)
            setAuditResult(null)
            setModal('none')
            showToast(`Parsed ${applied.length} field${applied.length !== 1 ? 's' : ''} — ${next.deals.length} deal${next.deals.length !== 1 ? 's' : ''} ready for review.`, 'success')
          }}
          onError={msg => showToast(msg, 'error')}
        />
      )}

      {modal === 'reset' && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-modal-title" onClick={e => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="modal" ref={resetTrapRef}>
            <h2 className="modal-title" id="reset-modal-title">Reset form?</h2>
            <p className="modal-body">All form data will be cleared. This cannot be undone.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setModal('none')}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={confirmReset}>Reset</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'confirm' && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="modal modal--bars" style={{ maxWidth: 480 }} ref={confirmTrapRef}>
            <div className="modal-header">
              <h3 id="modal-title">Confirm Deal Creation</h3>
              <button type="button" className="modal-close icon-action" aria-label="Close modal" onClick={() => setModal('none')} style={{ position: 'static' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <p className="auth-copy" style={{ margin: 0 }}>
                This will create <strong>{matrix.totalDeals} deal{matrix.totalDeals !== 1 ? 's' : ''}</strong> across <strong>{sspsUsed.join(', ')}</strong>. Proceed?
              </p>
              <RunnerEnvPicker environments={runnerEnvironments} value={runnerEnv} onChange={setRunnerEnv} disabled={creating} name="workspace-runner-env" />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setModal('none')}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleConfirmCreate} disabled={creating}>
                {creating && <span className="btn-spinner" aria-hidden="true" />}
                Create &amp; send to the runner
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-container" aria-live="polite">
          <div className={`toast ${toast.tone}`}>
            {toast.tone === 'success' && <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>}
            {toast.tone === 'error' && <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>}
            {toast.tone === 'info' && <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>}
            <span>{toast.message}</span>
            <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={dismissToast}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.85rem', height: '0.85rem' }} aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      )}
    </>
  )
}

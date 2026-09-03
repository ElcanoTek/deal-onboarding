import { useMemo, useState } from 'react'
import { FormData } from '../types/deal'
import { useStandardLists } from '../lib/lists'
import { buildBatchPrompt, generateAllDealPrompts, isBatchSupportedDeal, splitBatchPairs } from '../lib/dealPromptYaml'

// This panel is READ-ONLY — view/copy the generated prompts. The ONLY submit
// path is the builder's Submit flow, which carries the idempotency key and the
// server-side audit gate.
interface Props {
  form: FormData
  auditPassed: boolean
}

type OutputMode = 'per-deal' | 'batch'

function CopyButton({ text, label = 'Copy', size = 'sm', disabled = false, disabledTitle }: { text: string; label?: string; size?: 'sm' | 'md'; disabled?: boolean; disabledTitle?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (disabled) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } finally { document.body.removeChild(ta) }
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }

  return (
    <button
      type="button"
      className={`btn ${copied ? 'btn-success' : 'btn-secondary'} btn-${size}`}
      onClick={handleCopy}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledTitle : undefined}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.95rem', height: '0.95rem', marginRight: '0.4rem', verticalAlign: '-2px' }} aria-hidden="true">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.95rem', height: '0.95rem', marginRight: '0.4rem', verticalAlign: '-2px' }} aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {label}
        </>
      )}
    </button>
  )
}

export function DealPromptOutput({ form, auditPassed }: Props) {
  const [mode, setMode] = useState<OutputMode>('per-deal')

  const { lists: standardLists } = useStandardLists()
  const prompts = useMemo(() => generateAllDealPrompts(form, standardLists), [form, standardLists])
  const allYaml = useMemo(() => prompts.map(p => p.yaml).join('\n---\n'), [prompts])
  const batchYaml = useMemo(() => buildBatchPrompt(form, standardLists), [form, standardLists])

  if (form.deals.length === 0) return null

  const hasBatch = form.deals.some(isBatchSupportedDeal)
  // Expanded (deal x DSP) count — matches the audit's total_deals and the
  // number of create+sheet rows the batch prompt/brief actually emit.
  const batchPairs = splitBatchPairs(form)
  const batchCount = batchPairs.createPairs.length + batchPairs.sheetOnlyPairs.length

  // Guard against exporting a prompt with unresolved <FILL …> placeholders —
  // these are the required fields (Magnite marketplace/sizes, PubMatic
  // publishers, etc.) that, if run as-is, fail at the SSP
  // API. Copy is blocked until they're filled. Keep the token in sync with the
  // placeholders emitted in dealPromptYaml.ts.
  const allHasFill = allYaml.includes('<FILL')
  const batchHasFill = batchYaml.includes('<FILL')
  const activeHasFill = mode === 'batch' ? batchHasFill : allHasFill
  const FILL_BLOCK_TITLE = 'Resolve the <FILL …> placeholders first — required SSP fields (e.g. Magnite marketplace/sizes, PubMatic publishers) are still missing.'

  // Reset mode if the active tab is no longer applicable to the current deals.
  if (mode === 'batch' && !hasBatch) {
    setMode('per-deal')
  }

  return (
    <section className="runner-prompts" aria-labelledby="runner-prompts-heading">
      <header className="runner-prompts__header">
        <div>
          <h2 className="runner-prompts__title" id="runner-prompts-heading">Runner Deal Prompts</h2>
          <p className="runner-prompts__subtitle">
            {auditPassed
              ? 'Audit passed. Pick an output mode and copy the prompt for your runner.'
              : 'Run an audit first to verify these prompts are complete. Prompts with unresolved required fields can’t be copied until they’re filled in.'}
          </p>
        </div>
      </header>

      {activeHasFill && (
        <div className="banner-warning" role="alert">
          This prompt still has <code>&lt;FILL …&gt;</code> placeholders — required SSP fields are missing
          (e.g. Magnite marketplace / ad sizes, or PubMatic publishers). Copy is disabled until
          they're resolved. Run the audit to see exactly which fields to fix.
        </div>
      )}

      <div className="deal-output-tabs" role="tablist" aria-label="Prompt output mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'per-deal'}
          className={`deal-output-tab${mode === 'per-deal' ? ' is-active' : ''}`}
          onClick={() => setMode('per-deal')}
        >
          Per-deal ({prompts.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'batch'}
          className={`deal-output-tab${mode === 'batch' ? ' is-active' : ''}`}
          onClick={() => setMode('batch')}
          disabled={!hasBatch}
          title={!hasBatch ? 'No batch-supported deals — pick an SSP on each deal card' : 'One combined runner prompt for all deals'}
        >
          Batch (MCP) {hasBatch ? `· ${batchCount}` : ''}
        </button>
      </div>

      {mode === 'per-deal' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-3)' }}>
            <CopyButton text={allYaml} label={`Copy all ${prompts.length}`} size="md" disabled={allHasFill} disabledTitle={FILL_BLOCK_TITLE} />
          </div>
          <div className="runner-prompts__list">
            {prompts.map((p, i) => (
              <article key={p.deal.id} className="runner-prompt-card">
                <header className="runner-prompt-card__header">
                  <div className="runner-prompt-card__title">
                    <span className="runner-prompt-card__index">Deal {i + 1}</span>
                    <code className="runner-prompt-card__name" title={p.name}>{p.name}</code>
                  </div>
                  <CopyButton text={p.yaml} label="Copy" disabled={p.yaml.includes('<FILL')} disabledTitle={FILL_BLOCK_TITLE} />
                </header>
                <pre className="runner-prompt-card__yaml" tabIndex={0} aria-label={`YAML prompt for deal ${i + 1}`}>
                  <code>{p.yaml}</code>
                </pre>
              </article>
            ))}
          </div>
        </>
      )}

      {mode === 'batch' && hasBatch && (
        <article className="runner-prompt-card">
          <header className="runner-prompt-card__header">
            <div className="runner-prompt-card__title">
              <span className="runner-prompt-card__index">Batch · {batchCount} deal{batchCount !== 1 ? 's' : ''}</span>
              <code className="runner-prompt-card__name">Multi-deal MCP creation</code>
            </div>
            <div className="runner-prompt-card__actions">
              <CopyButton text={batchYaml} label="Copy batch prompt" size="md" disabled={batchHasFill} disabledTitle={FILL_BLOCK_TITLE} />
            </div>
          </header>
          <pre className="runner-prompt-card__yaml" tabIndex={0} aria-label="Combined batch YAML prompt">
            <code>{batchYaml}</code>
          </pre>
        </article>
      )}
    </section>
  )
}

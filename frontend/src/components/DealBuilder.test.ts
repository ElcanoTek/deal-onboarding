import { describe, expect, it } from 'vitest'
// Source-level guard (no jsdom/RTL in this suite). The key-derivation behavior
// itself is covered by submitKey.test.ts; this pins the CALL SITE so the
// builder can't drift back to a per-click random key.
import src from './DealBuilder.tsx?raw'

// Idempotency key lifecycle. A per-click random key meant a retry after a
// lost/timed-out response carried a NEW key and the server booked a SECOND
// live batch. The key must instead be derived from the audited snapshot
// (mintSubmitKey), so every retry of the same audited batch replays the same
// key.
describe('DealBuilder — submit key derived from the audited snapshot', () => {
  it('handleCreate derives the key from the audited snapshot via mintSubmitKey', () => {
    expect(src).toContain("import { mintSubmitKey } from '../lib/submitKey'")
    expect(src).toMatch(/const snap = auditedSnapshot \|\| formSnapshot/)
    expect(src).toMatch(/mintSubmitKey\(snap\)/)
  })

  it('never mints a per-click random key', () => {
    expect(src).not.toContain('randomUUID')
    expect(src).not.toMatch(/setSubmitKey\([^)]*Math\.random/)
  })
})

// Create-submit wiring regression guard: a stubbed handleConfirmCreate passes
// tsc and every suite while no batch ever reaches the runner. These guards pin
// the load-bearing wiring so a re-stub (or a dropped field) fails CI.
describe('DealBuilder — Create submit wiring', () => {
  it('handleConfirmCreate actually submits to the runner', () => {
    expect(src).toMatch(/const res = await createRunnerTask\(\{/)
  })

  it('sends the audited form snapshot, prompt, brief, attachments, and the idempotency key', () => {
    const body = src.slice(src.indexOf('await createRunnerTask({'), src.indexOf('})', src.indexOf('await createRunnerTask({')))
    for (const field of ['prompt,', 'brief: serializeBrief(brief)', 'listIds,', 'filePaths,', 'fileNames,', 'idempotencyKey: submitKey', "operation: 'create'", 'form: auditedSnapshot']) {
      expect(body).toContain(field)
    }
  })

  it('the confirm modal is wired to handleConfirmCreate', () => {
    expect(src).toContain('onClick={handleConfirmCreate}')
  })

  it('never sends a result callback — the runner reports outcomes in its own UI', () => {
    expect(src).not.toContain('resultCallback')
  })
})

// Post-submit form reset: the submit success path must not leave the whole
// submitted batch in the shared form store + localStorage, where coming back
// to the builder would show it as editable work.
describe('DealBuilder — submitted batches leave the builder', () => {
  it('marks the submit key the moment the submit is confirmed live (2xx)', () => {
    expect(src).toContain("import { isSubmittedBatch, markBatchSubmitted } from '../lib/submittedBatch'")
    const submitIdx = src.indexOf('await createRunnerTask({')
    const markIdx = src.indexOf('markBatchSubmitted(submitKey)', submitIdx)
    expect(markIdx).toBeGreaterThan(submitIdx)
  })

  it('resets the form on the success path', () => {
    const successIdx = src.indexOf('markBatchSubmitted(submitKey)')
    const resetIdx = src.indexOf('startFresh()', successIdx)
    const catchIdx = src.indexOf('} catch (err) {', successIdx)
    expect(resetIdx).toBeGreaterThan(successIdx)
    expect(resetIdx).toBeLessThan(catchIdx)
  })

  it('"Build another batch" starts fresh instead of reloading the sent batch', () => {
    expect(src).toMatch(/onClick=\{\(\) => \{ startFresh\(\); setDone\(null\)/)
  })

  it('startFresh clears the store AND the audit/wizard state', () => {
    const body = src.slice(src.indexOf('const startFresh = ()'), src.indexOf('const confirmReset'))
    for (const call of ['reset()', "setAuditedSnapshot('')", "setAiAuditedSnapshot('')", "setLastAuditSnapshot('')", "setSubmitKey('')", 'setRestoredNotice(null)', 'setMaxStep(0)']) {
      expect(body).toContain(call)
    }
    // The reset modal path rides the same helper.
    expect(src).toMatch(/const confirmReset = \(\) => \{\s*\n\s*startFresh\(\)/)
  })

  it('recognizes a restored, already-submitted copy of the form on mount', () => {
    expect(src).toMatch(/return isSubmittedBatch\(form\) \? 'submitted' : 'draft'/)
  })
})

// The builder is single-tenant: no client preset, intake, pending-queue, or
// deal-library plumbing may creep back in.
describe('DealBuilder — no removed subsystems', () => {
  it('carries no client-preset, intake, or library references', () => {
    for (const needle of ['clientPreset', 'useClients', 'activeIntake', 'promoteIntake', 'recordDeals', 'resubmitCtx', 'onNavigateLibrary', 'onNavigatePending']) {
      expect(src).not.toContain(needle)
    }
  })
})

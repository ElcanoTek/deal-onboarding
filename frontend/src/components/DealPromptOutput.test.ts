import { describe, expect, it } from 'vitest'
// Source-level guard (no jsdom/RTL in this suite — same pattern as
// DealBuilder.test.ts).
import src from './DealPromptOutput.tsx?raw'
import workspaceSrc from './DealBuilder.tsx?raw'

// #210 — the debug panel's 'Send to MOC' button submitted live audited
// batches while skipping idempotencyKey, resultCallback, recordCreatedDeals,
// and post-submit bookkeeping — violating the invariant that a 2xx create
// is the only thing that counts as a submit. The button
// was REMOVED; the panel is read-only (view/copy prompts).
describe('DealPromptOutput — debug Send-to-MOC removed (#210)', () => {
  it('never imports or calls createMocTask', () => {
    expect(src).not.toContain('createMocTask')
    expect(src).not.toContain("from '../lib/mocApi'")
  })

  it('has no send button or send state machine', () => {
    expect(src).not.toContain('SendToMocButton')
    expect(src).not.toContain('handleSend')
    expect(src).not.toContain("'Sending…'")
  })

  it('keeps the read-only copy affordances', () => {
    expect(src).toContain('Copy batch prompt')
  })
})

// The only submit paths are the two guarded flows — both carry an
// idempotencyKey and their operation label. A third createMocTask caller
// appearing anywhere else should be added HERE only after wiring the same
// guarded side-effect set.
describe('createMocTask call sites — only the guarded flows submit', () => {
  it('workspace create flow carries key + operation', () => {
    expect(workspaceSrc).toContain('idempotencyKey: submitKey')
    expect(workspaceSrc).toContain("operation: 'create'")
  })

})

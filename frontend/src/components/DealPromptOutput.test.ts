// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it } from 'vitest'
// Source-level guard (no jsdom/RTL in this suite — same pattern as
// DealBuilder.test.ts).
import src from './DealPromptOutput.tsx?raw'
import workspaceSrc from './DealBuilder.tsx?raw'

// The debug panel's former 'Send to runner' button submitted live audited
// batches while skipping idempotencyKey, resultCallback, recordCreatedDeals,
// and post-submit bookkeeping — violating the invariant that a 2xx create
// is the only thing that counts as a submit. The button
// was REMOVED; the panel is read-only (view/copy prompts).
describe('DealPromptOutput — debug send button removed', () => {
  it('never imports or calls createRunnerTask', () => {
    expect(src).not.toContain('createRunnerTask')
    expect(src).not.toContain("from '../lib/runnerApi'")
  })

  it('has no send button or send state machine', () => {
    expect(src).not.toContain('SendToRunnerButton')
    expect(src).not.toContain('handleSend')
    expect(src).not.toContain("'Sending…'")
  })

  it('keeps the read-only copy affordances', () => {
    expect(src).toContain('Copy batch prompt')
  })
})

// The only submit paths are the two guarded flows — both carry an
// idempotencyKey and their operation label. A third createRunnerTask caller
// appearing anywhere else should be added HERE only after wiring the same
// guarded side-effect set.
describe('createRunnerTask call sites — only the guarded flows submit', () => {
  it('workspace create flow carries key + operation', () => {
    expect(workspaceSrc).toContain('idempotencyKey: submitKey')
    expect(workspaceSrc).toContain("operation: 'create'")
  })

})

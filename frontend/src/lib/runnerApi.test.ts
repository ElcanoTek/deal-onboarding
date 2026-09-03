import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunnerTask } from './runnerApi'

// Wire-contract tests for the /api/runner/create submit. The caller contract
// itself is compile-time enforced by RunnerCreateInput (a create requires
// `form` and `brief`) — these tests pin the serialized request body and the
// error surfacing.

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

function sentBody(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createRunnerTask', () => {
  it('posts to /api/runner/create with the audited form, brief, and runnerEnv', async () => {
    const fn = stubFetch(200, { taskId: 't1', files: 0 })
    const auditedForm = { campaignId: 'DEAL12345', deals: [{ id: 'd1' }] }
    await createRunnerTask({
      prompt: 'go',
      listIds: [],
      filePaths: [],
      brief: '{"campaign_id":"DEAL12345"}',
      operation: 'create',
      runnerEnv: 'dev',
      form: auditedForm,
    })
    const [url] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/runner/create')
    const body = sentBody(fn)
    expect(body.form).toEqual(auditedForm)
    expect(body.operation).toBe('create')
    expect(body.runnerEnv).toBe('dev')
    expect(body.brief).toBe('{"campaign_id":"DEAL12345"}')
  })

  it('surfaces the actionable gate message over the machine error code', async () => {
    stubFetch(422, {
      error: 'audit_failed',
      message: 'server-side audit re-run failed 2 check(s) — fix the flagged fields, re-run the audit, and submit again.',
      checks: [],
    })
    await expect(
      createRunnerTask({ prompt: 'go', listIds: [], filePaths: [], operation: 'create', form: {}, brief: '{}' }),
    ).rejects.toThrow(/re-run the audit/)
  })

  it('falls back to the error field, then to a status message', async () => {
    stubFetch(400, { error: 'prompt is required' })
    await expect(
      createRunnerTask({ prompt: '', listIds: [], filePaths: [], operation: 'create', form: {}, brief: '{}' }),
    ).rejects.toThrow('prompt is required')

    stubFetch(503, {})
    await expect(
      createRunnerTask({ prompt: 'go', listIds: [], filePaths: [], operation: 'create', form: {}, brief: '{}' }),
    ).rejects.toThrow('Runner submission failed (503)')
  })
})

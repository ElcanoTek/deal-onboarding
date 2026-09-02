import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSubmittedBatch, markBatchSubmitted } from './submittedBatch'
import { mintSubmitKey } from './submitKey'
import { DEFAULT_FORM, FormData } from '../types/deal'

// The vitest environment is node — no real localStorage. The module guards
// every access in try/catch, so it must behave sanely both with a stub and
// with no storage at all.
const store = new Map<string, string>()
const stub = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

beforeEach(() => {
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = stub
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
})

const someForm = (): FormData => ({
  ...DEFAULT_FORM,
  campaignId: 'DEAL00137',
  brand: 'The Cooperators',
  agency: 'Ideon',
})

describe('submittedBatch — last-submitted-batch recognition (2026-08-25)', () => {
  it('recognizes nothing before any submit is marked', () => {
    expect(isSubmittedBatch(someForm())).toBe(false)
  })

  it('recognizes the exact submitted form after marking its submit key', () => {
    const form = someForm()
    markBatchSubmitted(mintSubmitKey(JSON.stringify(form)))
    expect(isSubmittedBatch(form)).toBe(true)
  })

  it('is key-order insensitive — a re-materialized copy of the same data still matches', () => {
    const form = someForm()
    markBatchSubmitted(mintSubmitKey(JSON.stringify(form)))
    // Same data, different key insertion order (a reload / JSON round-trip).
    const entries = Object.entries(form).reverse()
    const reordered = Object.fromEntries(entries) as unknown as FormData
    expect(isSubmittedBatch(reordered)).toBe(true)
  })

  it('any edit makes the form new work again (no false positives)', () => {
    const form = someForm()
    markBatchSubmitted(mintSubmitKey(JSON.stringify(form)))
    expect(isSubmittedBatch({ ...form, brand: 'Sun Bum' })).toBe(false)
  })

  it('a later submit replaces the marker — only the LAST batch is recognized', () => {
    const first = someForm()
    const second = { ...someForm(), campaignId: 'DEAL00138' }
    markBatchSubmitted(mintSubmitKey(JSON.stringify(first)))
    markBatchSubmitted(mintSubmitKey(JSON.stringify(second)))
    expect(isSubmittedBatch(first)).toBe(false)
    expect(isSubmittedBatch(second)).toBe(true)
  })

  it('an empty key never marks (a never-audited submit path must not poison recognition)', () => {
    markBatchSubmitted('')
    expect(store.size).toBe(0)
  })

  it('survives a missing localStorage without throwing', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(() => markBatchSubmitted('abc')).not.toThrow()
    expect(isSubmittedBatch(someForm())).toBe(false)
  })
})


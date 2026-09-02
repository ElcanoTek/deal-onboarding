import { describe, expect, it } from 'vitest'
import { canonicalJson, mintSubmitKey, sha256Hex } from './submitKey'

// =============================================================================
// #225 — the MOC-create idempotency key must be a pure function of the audited
// snapshot: stable across re-clicks/retries of the SAME audited batch, and
// different the moment the batch changes. (The old behavior — a fresh
// crypto.randomUUID() per Create click — fails the stability property: every
// retry after a lost response minted a new key and booked a second live
// batch. DealBuilder.test.ts pins the call site.)
// =============================================================================

describe('sha256Hex — FIPS 180-4 test vectors', () => {
  it('empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('"abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('two-block message (448-bit vector)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })
  it('exactly one block of padding boundary (56 bytes)', () => {
    // 56 bytes forces the length words into a second padded block.
    expect(sha256Hex('a'.repeat(56)))
      .toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a')
  })
  it('hashes UTF-8 bytes (non-ASCII input)', () => {
    // sha256 of "café" in UTF-8 (63 61 66 c3 a9).
    expect(sha256Hex('café')).toBe('850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e')
  })
})

describe('canonicalJson — deterministic serialization', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
  it('preserves array order (order is meaningful for deals/audiences)', () => {
    expect(canonicalJson({ deals: [2, 1] })).toBe('{"deals":[2,1]}')
  })
  it('drops undefined members and nulls undefined array slots', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}')
  })
})

describe('mintSubmitKey — stable per audited batch (#225)', () => {
  const snapshot = JSON.stringify({ campaignId: 'DEAL00001', deals: [{ ssp: 'PubMatic', cpm: '2.50' }] })

  it('re-clicking the same audited snapshot replays the SAME key', () => {
    expect(mintSubmitKey(snapshot)).toBe(mintSubmitKey(snapshot))
  })

  it('is a deterministic 64-hex sha256 (no per-click randomness)', () => {
    expect(mintSubmitKey(snapshot)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a changed snapshot (different batch) derives a DIFFERENT key', () => {
    const edited = JSON.stringify({ campaignId: 'DEAL00002', deals: [{ ssp: 'PubMatic', cpm: '2.50' }] })
    expect(mintSubmitKey(edited)).not.toBe(mintSubmitKey(snapshot))
  })

  it('survives JSON key-order differences (reload re-serialization)', () => {
    expect(mintSubmitKey('{"a":1,"b":{"y":2,"x":3}}')).toBe(mintSubmitKey('{"b":{"x":3,"y":2},"a":1}'))
  })

  it('a non-JSON snapshot still derives deterministically', () => {
    expect(mintSubmitKey('not json')).toBe(mintSubmitKey('not json'))
    expect(mintSubmitKey('not json')).toBe(sha256Hex('not json'))
  })
})

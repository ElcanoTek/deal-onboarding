// All rights reserved. This is a private repository.

// =============================================================================
// SUBMIT-KEY DERIVATION (#225)
//
// The runner-create idempotency key is derived from the AUDITED form snapshot —
// sha256 over canonicalized JSON — instead of being minted fresh per Create
// click. That makes the key stable per batch INTENT: every retry of the same
// audited batch (re-click after an error toast, a lost/timed-out response,
// even a reload followed by re-auditing the unchanged form) replays the SAME
// key, so the server-side reservation can dedup it and a second live batch can
// never be booked. Editing the form invalidates the audit; the re-audited
// snapshot then derives a DIFFERENT key, so a genuinely different batch is a
// distinct submission. Because the key is a pure function of the persisted
// form, it needs no storage of its own — the form's localStorage persistence
// (useFormState) is its persistence.
//
// The JSON is canonicalized (deep-sorted object keys) before hashing so the
// key survives serialization-order differences (e.g. a reload re-materializes
// the form with different key insertion order).
//
// SHA-256 is implemented here synchronously (FIPS 180-4) rather than via
// crypto.subtle: subtle is async and only exists in secure contexts, and a
// silent fallback to a weaker/random key would quietly reintroduce the #225
// duplicate-batch bug (or, worse for a weak hash, wrongly dedup a DIFFERENT
// batch). The implementation is pinned to the official FIPS test vectors in
// submitKey.test.ts.
// =============================================================================

/** Deterministic JSON: identical data → identical string, regardless of object
 *  key insertion order. Arrays keep their order (order is meaningful for
 *  deals/audiences); `undefined` object members are dropped (matching
 *  JSON.stringify) and `undefined` array slots serialize as null. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue
    parts.push(JSON.stringify(key) + ':' + canonicalJson(obj[key]))
  }
  return '{' + parts.join(',') + '}'
}

// SHA-256 round constants (first 32 bits of the fractional parts of the cube
// roots of the first 64 primes) — FIPS 180-4 §4.2.2.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** Synchronous SHA-256 (FIPS 180-4) of the UTF-8 bytes of `text`, hex-encoded.
 *  Verified against the official test vectors in submitKey.test.ts. */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text)
  // Pad: 0x80, zeros, then the 64-bit big-endian bit length.
  const bitLenHi = Math.floor((data.length * 8) / 0x1_0000_0000)
  const bitLenLo = (data.length * 8) >>> 0
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLenHi)
  view.setUint32(padded.length - 4, bitLenLo)

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64)
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = b; b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('')
}

/** The idempotency key for one audited batch: sha256 of the canonicalized
 *  audited-form snapshot. Same audited batch → same key on every retry;
 *  any form edit (which forces a re-audit) → different key. A snapshot that
 *  isn't valid JSON is hashed verbatim (still deterministic). */
export function mintSubmitKey(auditedSnapshot: string): string {
  let canonical = auditedSnapshot
  try {
    canonical = canonicalJson(JSON.parse(auditedSnapshot))
  } catch {
    /* not JSON — hash the raw string; determinism is what matters */
  }
  return sha256Hex(canonical)
}

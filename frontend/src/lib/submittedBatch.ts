// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// All rights reserved. This is a private repository.

// =============================================================================
// LAST-SUBMITTED-BATCH MARKER
//
// The builder form persists in localStorage so unsaved manual work survives a
// reload — but a SUBMITTED batch is no longer work in progress. The submit
// success path resets the form, yet copies of the exact submitted form can
// still resurface (a pre-reset tab, a restore from an old snapshot, the
// bookkeeping-failure path that deliberately keeps the form for the
// idempotent retry). Left unrecognized, one accidental re-submit
// could book a live batch twice — the report this module exists to close.
//
// The marker is the batch's submit key: mintSubmitKey canonicalizes the form
// JSON before hashing, so recognition is exact — identical form data → match,
// ANY edit → miss. No false positives on genuinely new work, by construction.
// =============================================================================

import { mintSubmitKey } from './submitKey'
import { FormData } from '../types/deal'

const KEY = 'deal-onboarding-last-submitted-key-v1'

/** Record the idempotency key of a batch the runner just accepted (2xx). Called the
 *  moment the submit is confirmed live — before any post-submit bookkeeping
 *  that might fail and keep the form around. */
export function markBatchSubmitted(submitKey: string): void {
  if (!submitKey) return
  try { localStorage.setItem(KEY, submitKey) } catch { /* ignore */ }
}

/** Is this form byte-for-byte (canonically) the batch of the last successful
 *  submit from this browser? Used to steer the restored-draft notice toward Reset. */
export function isSubmittedBatch(form: FormData): boolean {
  try {
    const last = localStorage.getItem(KEY)
    if (!last) return false
    return mintSubmitKey(JSON.stringify(form)) === last
  } catch {
    return false
  }
}

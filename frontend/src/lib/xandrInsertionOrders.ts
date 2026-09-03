// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Xandr Curate insertion-order catalog for the deal form.
//
// Single source of truth: ../../../reference/xandr_insertion_orders.json (the
// internal Deal Onboarding reference data relocated out of the Cutlass MCP in the SSP
// external-release decoupling). Imported at build time so the IO dropdown and
// the deal-prompt generator share one list and stay in sync.
//
// A Xandr Curate deal is a line item that needs BOTH an insertion_order_id and
// an advertiser_id, and the advertiser varies per IO. Resolving name -> {id,
// advertiserId} here lets dealPromptYaml emit them explicitly so the MCP uses
// its verified happy-path instead of an unverified live GET /insertion-order.
import catalog from '../../../reference/xandr_insertion_orders.json'

export interface XandrInsertionOrder {
  id: number
  name: string
  advertiser_id: number
  state: string
}

const ALL: XandrInsertionOrder[] = (catalog.insertion_orders ?? []) as XandrInsertionOrder[]

/** Active IO names, for the Xandr insertion-order dropdown. */
export const xandrInsertionOrderNames: string[] = ALL.filter((io) => io.state === 'active').map((io) => io.name)

// Normalize for matching — case-insensitive, en-dash/em-dash treated as hyphen,
// whitespace collapsed. Mirrors the Cutlass MCP's _normalize_xandr_io_name so a
// name with a hyphen still resolves to the en-dash catalog entry (and vice versa).
const normalize = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')

const BY_NORM = new Map<string, XandrInsertionOrder>(ALL.map((io) => [normalize(io.name), io]))

/** Resolve an IO name to its numeric id + advertiser id. Returns undefined for
 *  an unknown name so the caller can fall back to passing the name (the MCP
 *  then resolves it via a live lookup). */
export function resolveXandrInsertionOrder(
  name: string | undefined | null,
): { id: number; advertiserId: number } | undefined {
  if (!name) return undefined
  const hit = BY_NORM.get(normalize(name))
  return hit ? { id: hit.id, advertiserId: hit.advertiser_id } : undefined
}

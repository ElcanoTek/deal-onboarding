#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.
// =============================================================================
// check-cutlass-contract.mjs — Deal Onboarding <-> Cutlass contract drift checker.
//
// Diffs every fact in frontend/src/lib/cutlass-contract.json (the machine-
// readable contract the frontend suites assert Deal Onboarding's prompt emission
// against) against the ground truth in a real Cutlass checkout:
//
//   mcp/*_mcp.py + mcp/deal_sheet_server.py + mcp/sendgrid_server.py
//       @mcp.tool-decorated function names, enum/constant literals,
//       fail-closed blocker codes, tool signatures.
//   protocols/deal-brief.schema.yaml
//       the per-deal required fields + SSP key enum.
//
// The engine checkout is a path you supply — this repository ships no engine
// source, and the fixture must be re-verified against YOUR engine revision.
//
// Usage:
//   node scripts/check-cutlass-contract.mjs <path-to-cutlass-checkout>
//   CUTLASS_DIR=<path> node scripts/check-cutlass-contract.mjs
//
// Exit codes: 0 = every extractable fact matches; 1 = drift found;
//             2 = usage / IO error.
//
// Honesty rule: a fixture fact the script cannot mechanically extract is
// reported as "asserted-not-extracted" (a documented residual), never
// silently skipped. Prefer adding an extraction over an assertion whenever a
// stable source pattern exists.
//
// Plain Node >= 18, zero npm dependencies.
// =============================================================================

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const fixturePath = join(repoRoot, 'frontend', 'src', 'lib', 'cutlass-contract.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

const cutlassDir = process.argv[2] || process.env.CUTLASS_DIR
if (!cutlassDir) {
  console.error('usage: node scripts/check-cutlass-contract.mjs <path-to-cutlass-checkout>')
  console.error('   or: CUTLASS_DIR=<path> node scripts/check-cutlass-contract.mjs')
  process.exit(2)
}
const cutlassRoot = resolve(cutlassDir)
if (!existsSync(cutlassRoot) || !statSync(cutlassRoot).isDirectory()) {
  console.error(`error: cutlass checkout not found at ${cutlassRoot}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Result collection + file cache
// ---------------------------------------------------------------------------
const drifts = []   // { fact, fixtureValue, cutlassValue, file }
const matches = []  // { fact, file }
const asserted = [] // { fact, value, why }

const fileCache = new Map()
function read(root, rel) {
  const p = join(root, rel)
  if (!fileCache.has(p)) {
    if (!existsSync(p)) return null
    fileCache.set(p, readFileSync(p, 'utf8'))
  }
  return fileCache.get(p)
}
const readCutlass = (rel) => read(cutlassRoot, rel)
const readLocal = (rel) => read(repoRoot, rel)

function show(v) {
  return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)
}
// Order-insensitive comparison for set-valued facts, ordered for scalars/maps.
function check(fact, file, fixtureValue, cutlassValue, { asSet = false } = {}) {
  let a = fixtureValue
  let b = cutlassValue
  if (asSet && Array.isArray(a) && Array.isArray(b)) {
    a = [...a].sort()
    b = [...b].sort()
  }
  if (JSON.stringify(a) === JSON.stringify(b)) {
    matches.push({ fact, file })
  } else {
    drifts.push({ fact, fixtureValue, cutlassValue, file })
  }
}
function assertOnly(fact, value, why) {
  asserted.push({ fact, value, why })
}
// A fact whose ground truth is "this literal exists in that source file".
function checkPresence(fact, file, src, literal, what = 'literal') {
  if (src === null) {
    drifts.push({ fact, fixtureValue: literal, cutlassValue: `(file ${file} not found)`, file })
    return
  }
  if (src.includes(literal)) {
    matches.push({ fact, file })
  } else {
    drifts.push({ fact, fixtureValue: literal, cutlassValue: `(${what} ${show(literal)} not found)`, file })
  }
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

// All @mcp.tool()-decorated function names in an MCP source file. Cutlass uses
// the uniform bare `@mcp.tool()` decorator with the (async) def on the next
// line (verified: 174/174 tools across all servers at d2987ce).
function mcpToolNames(src) {
  return [...src.matchAll(/@mcp\.tool\(\)\s*\n(?:async\s+)?def\s+([A-Za-z_]\w*)/g)].map((m) => m[1])
}

// The parameter names of one (async) def, scanning its signature block until
// the closing `) ->` / `):` line. Good enough for keyword-arg presence checks.
function defParams(src, name) {
  const m = src.match(new RegExp(`(?:async\\s+)?def\\s+${name}\\s*\\(([\\s\\S]*?)\\)\\s*(?:->|:)`))
  if (!m) return null
  return [...m[1].matchAll(/(?:^|,)\s*\*?\*?([A-Za-z_]\w*)\s*[:=,]?/g)].map((x) => x[1])
}

function checkToolMembership(fact, file, src, tool) {
  if (src === null) {
    drifts.push({ fact, fixtureValue: tool, cutlassValue: `(file ${file} not found)`, file })
    return
  }
  const names = mcpToolNames(src)
  if (names.includes(tool)) {
    matches.push({ fact, file })
  } else {
    drifts.push({ fact, fixtureValue: tool, cutlassValue: `(no @mcp.tool named ${show(tool)}; found ${names.length} tools)`, file })
  }
}

// The source block of one (async) def — from its `def` line to the next
// @mcp.tool decorator (or EOF). Used to scope docstring-marker greps to a
// single tool so an incidental mention elsewhere in the file can't satisfy
// (or break) a per-tool pin.
function defBlock(src, name) {
  const m = src.match(new RegExp(`(?:async\\s+)?def\\s+${name}\\s*\\(`))
  if (!m) return null
  const rest = src.slice(m.index)
  const next = rest.slice(1).search(/@mcp\.tool\(\)/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

// ---------------------------------------------------------------------------
// 1. Per-SSP tool names + fail-closed blocker codes
// ---------------------------------------------------------------------------
for (const [ssp, c] of Object.entries(fixture.ssps)) {
  const src = readCutlass(c.sourceFile)
  checkToolMembership(`ssps["${ssp}"].createTool`, c.sourceFile, src, c.createTool)
  for (const t of c.listTools || []) {
    checkToolMembership(`ssps["${ssp}"].listTools[${show(t)}]`, c.sourceFile, src, t)
  }
  if (c.domainsMergeTool) checkToolMembership(`ssps["${ssp}"].domainsMergeTool`, c.sourceFile, src, c.domainsMergeTool)
  if (c.advertiserWhitelistTool) checkToolMembership(`ssps["${ssp}"].advertiserWhitelistTool`, c.sourceFile, src, c.advertiserWhitelistTool)
  if (c.publishersMergeTool) checkToolMembership(`ssps["${ssp}"].publishersMergeTool`, c.sourceFile, src, c.publishersMergeTool)

  // Domain-merge tool PARAMETER set (2026-07, #224). Tool-name
  // membership alone let the Deal Onboarding prompt emit phantom args (target:/
  // is_excluded:) that FastMCP silently dropped while the tool wrote a
  // different field — so every arg the prompt instructs is pinned against
  // the tool's real signature, exactly like the adDuration/geo create args.
  const dm = c.domainsMerge
  if (dm) {
    checkToolMembership(`ssps["${ssp}"].domainsMerge.tool`, c.sourceFile, src, dm.tool)
    for (const arg of dm.args || []) {
      const params = src === null ? null : defParams(src, dm.tool)
      check(
        `ssps["${ssp}"].domainsMerge arg ${show(arg)} (param of ${dm.tool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${dm.tool} not found)`,
      )
    }
  }
  for (const code of c.failClosedCodes || []) {
    // Blocker/error codes are string literals raised by the MCP; their
    // disappearance means the fail-closed rule moved or was renamed.
    checkPresence(`ssps["${ssp}"].failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
  }

  // Ad-duration create/update surface (2026-07). Every arg Deal Onboarding's prompt
  // builders emit is pinned against the create tool's real signature;
  // merge/update tools against the @mcp.tool catalog; fail-closed codes and
  // semantics markers against source literals. `supported: false` is proven
  // by the ABSENCE of any duration mention in the MCP source — if a vendor
  // grows a duration API, this drifts and forces a contract review instead
  // of leaving a stale "unsupported" label. A mention that the review deems
  // NOT a targeting surface (e.g. a reporting column like TripleLift's
  // CREATIVE_DURATION) is pinned verbatim in knownNonTargetingMentions; the
  // absence test runs on the source with those exact tokens removed, so any
  // NEW duration mention still drifts and forces the next review.
  const ad = c.adDuration
  if (ad) {
    if (ad.supported === false) {
      if (src === null) {
        drifts.push({ fact: `ssps["${ssp}"].adDuration.supported=false`, fixtureValue: false, cutlassValue: `(file ${c.sourceFile} not found)`, file: c.sourceFile })
      } else {
        const reviewed = ad.knownNonTargetingMentions || []
        let scrubbed = src
        for (const token of reviewed) scrubbed = scrubbed.split(token).join('')
        if (/duration/i.test(scrubbed)) {
          drifts.push({ fact: `ssps["${ssp}"].adDuration.supported=false`, fixtureValue: false, cutlassValue: '(source now mentions "duration" beyond knownNonTargetingMentions — re-verify the SSP capability and update the contract + prompt builders)', file: c.sourceFile })
        } else {
          const scrubNote = reviewed.length ? `; ${reviewed.length} reviewed non-targeting mention(s) scrubbed` : ''
          matches.push({ fact: `ssps["${ssp}"].adDuration.supported=false (no duration surface in source${scrubNote})`, file: c.sourceFile })
        }
      }
    }
    const createArgs = ad.createArgs || (ad.createArg ? [ad.createArg] : [])
    for (const arg of createArgs) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].adDuration create arg ${show(arg)} (param of ${c.createTool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    if (ad.mergeTool) checkToolMembership(`ssps["${ssp}"].adDuration.mergeTool`, c.sourceFile, src, ad.mergeTool)
    for (const code of ad.failClosedCodes || []) {
      checkPresence(`ssps["${ssp}"].adDuration.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
    }
    for (const flag of ad.qualityFlags || []) {
      checkPresence(`ssps["${ssp}"].adDuration.qualityFlags[${show(flag)}]`, c.sourceFile, src, `"${flag}"`, 'quality flag')
    }
    if (ad.semanticsMarker) {
      // A stable docstring phrase carrying the field's semantics (e.g. Xandr's
      // "ONE-SIDED MINIMUM-ALLOWED", Media.net's "semantics UNVERIFIED") — if
      // it disappears, the documented meaning changed and the Deal Onboarding
      // comments/mappings need re-review.
      checkPresence(`ssps["${ssp}"].adDuration.semanticsMarker`, c.sourceFile, src, ad.semanticsMarker, 'semantics doc marker')
    }
    if (ad.maxRequiresMin) {
      checkPresence(`ssps["${ssp}"].adDuration.maxRequiresMin`, c.sourceFile, src, 'ad_duration_max requires ad_duration_min', 'fail-closed doc')
    }
  }

  // IAB-exclude create surface (2026-07 create-time IAB/content-genre
  // exclusions, cutlass feat/create-time-iab-excludes). Same rigor as the
  // adDuration create args: the exclude arg Deal Onboarding's prompt builders emit
  // is pinned against the create tool's real signature. Only IX + PubMatic
  // carry an iabExclude block — every other SSP has no exclude API and
  // Deal Onboarding surfaces its exclusions as trader-UI follow-up comments
  // (Deal Onboarding-side, asserted by contractGolden.test.ts, nothing to extract).
  const iabEx = c.iabExclude
  if (iabEx) {
    const iabExArgs = iabEx.createArgs || (iabEx.createArg ? [iabEx.createArg] : [])
    for (const arg of iabExArgs) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].iabExclude create arg ${show(arg)} (param of ${c.createTool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
  }

  // IAB-include create surface + resolution policy (cutlass#714). The include
  // arg is pinned like the exclude arg above, and the exact-match resolution
  // policy — IX contentGenre resolves exact-only, never fuzzy contains — is
  // pinned via a source marker: if Cutlass ever re-enables fuzzy matching for
  // this key (deleting the marker comment), the contract drifts and Deal Onboarding's
  // curated IAB→genre map must be re-reviewed before anything ships.
  const iabCat = c.iabCategories
  if (iabCat) {
    if (iabCat.createArg) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].iabCategories create arg ${show(iabCat.createArg)} (param of ${c.createTool})`,
        c.sourceFile,
        iabCat.createArg,
        params ? (params.includes(iabCat.createArg) ? iabCat.createArg : `(no ${show(iabCat.createArg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    if (iabCat.exactMatchMarker) {
      checkPresence(`ssps["${ssp}"].iabCategories.exactMatchMarker`, c.sourceFile, src, iabCat.exactMatchMarker, 'exact-match policy marker')
    }
  }

  // Buyer routing surface (#231 / cutlass#734): the create arg is
  // pinned against the tool signature, the numeric escape hatch (what makes
  // Deal Onboarding's curated numeric-id emission skip name resolution) via its
  // docstring marker, and the fail-loud resolution codes as source literals.
  // The house buyer member ids themselves are live-probed facts — asserted,
  // not extractable from Cutlass source.
  const buyer = c.buyer
  if (buyer) {
    if (buyer.createArg) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].buyer create arg ${show(buyer.createArg)} (param of ${c.createTool})`,
        c.sourceFile,
        buyer.createArg,
        params ? (params.includes(buyer.createArg) ? buyer.createArg : `(no ${show(buyer.createArg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    if (buyer.numericEscapeHatchMarker) {
      checkPresence(`ssps["${ssp}"].buyer.numericEscapeHatchMarker`, c.sourceFile, src, buyer.numericEscapeHatchMarker, 'numeric escape-hatch doc marker')
    }
    // List-valued buyer args (Magnite dsps[i].buyers): pin the per-ref
    // resolution loop and the "at least one" guard. A silent narrowing to a
    // scalar would book only the first of a trader's multi-seat buyer list
    // instead of failing — the exact class of drift this gate exists for.
    if (buyer.listMarker) {
      checkPresence(`ssps["${ssp}"].buyer.listMarker`, c.sourceFile, src, buyer.listMarker, 'per-ref buyer resolution loop (buyers is a LIST)')
    }
    if (buyer.requiredMarker) {
      checkPresence(`ssps["${ssp}"].buyer.requiredMarker`, c.sourceFile, src, buyer.requiredMarker, 'at-least-one-buyer guard')
    }
    for (const code of buyer.failClosedCodes || []) {
      checkPresence(`ssps["${ssp}"].buyer.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
    }
    if (buyer.houseBuyerMembers) {
      assertOnly(
        `ssps["${ssp}"].buyer.houseBuyerMembers`,
        buyer.houseBuyerMembers,
        'live-probed facts (GET /platform-member primary_type=buyer, 2026-07-09 audit): not extractable from Cutlass source; pinned against Deal Onboarding XANDR_BUYER_CANONICAL by contractGolden.test.ts',
      )
    }
  }

  // Geo create/update surface (2026-07 US-default policy). Same rigor as
  // adDuration: every geo arg Deal Onboarding's prompt builders emit is pinned
  // against the create tool's real signature, merge tools against the
  // @mcp.tool catalog, and non-flat surfaces (OpenX targeting.geographic,
  // TripleLift payload.country_ids) against a source marker literal. The
  // US default itself is Deal Onboarding-side (geoPolicy.ts) — asserted, not
  // extracted; the MCPs stay pass-through.
  // Environment / Inventory Type surface. Same rigor as geo: every arg the
  // Deal Onboarding prompt builders emit for it is pinned against the create tool's
  // real signature, and the wire values against a source marker. Only Xandr
  // carries one today; the others emit a NOT-SUPPORTED marker instead, which
  // is a Deal Onboarding-side decision and so is asserted, not extracted.
  const environment = c.environment
  if (environment) {
    const params = src === null ? null : defParams(src, c.createTool)
    for (const arg of environment.createArgs || []) {
      check(
        `ssps["${ssp}"].environment create arg ${show(arg)} (param of ${c.createTool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    for (const value of environment.supplyTypes || []) {
      checkPresence(
        `ssps["${ssp}"].environment supply type ${show(value)}`,
        c.sourceFile,
        src,
        `"${value}"`,
        'environment wire value',
      )
    }
    if (environment.sourceMarker) {
      checkPresence(
        `ssps["${ssp}"].environment.sourceMarker`,
        c.sourceFile,
        src,
        environment.sourceMarker,
        'environment surface marker',
      )
    }
  }

  const geo = c.geo
  if (geo) {
    for (const arg of geo.createArgs || []) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].geo create arg ${show(arg)} (param of ${c.createTool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    if (geo.mergeTool) checkToolMembership(`ssps["${ssp}"].geo.mergeTool`, c.sourceFile, src, geo.mergeTool)
    if (geo.sourceMarker) {
      checkPresence(`ssps["${ssp}"].geo.sourceMarker`, c.sourceFile, src, geo.sourceMarker, 'geo surface marker')
    }
    // Fail-closed geo blocker codes (mirrors the adDuration loop above) — the
    // literals Deal Onboarding documents to traders must exist verbatim in the MCP
    // source (cutlass#724: unresolved_country / ambiguous_geo_token /
    // subnational_geo_requires_country / country_roster_unavailable). A rename
    // or removal in Cutlass fails this check instead of silently drifting.
    for (const code of geo.failClosedCodes || []) {
      checkPresence(`ssps["${ssp}"].geo.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
    }
  }

  // Site/app-bundle LIST delivery surface (#220/#221). TripleLift's
  // post-create merge tool is pinned exactly like the Media.net domainsMerge
  // block (tool membership + every arg the prompt instructs against the real
  // signature), PLUS a dimension pin: the tl_merge_deal_supply_domains
  // docstring must name EB_SUPPLY_DOMAIN_ID — the SUPPLY-domain (site/
  // inventory) targetingExpression leaf (cutlass#731) — and the separate
  // advertiser-domain control tl_merge_deal_domains is pinned via
  // advertiserDomainMergeTool + advertiserDimensionMarker so the two
  // dimensions can never silently swap again. Xandr's lists.supported:false
  // is a verified-by-absence verdict (no @mcp.tool ingests a values_file into
  // domain targeting) — asserted, with the deal-list merge tool + the
  // platform-prohibited literal extracted.
  const lists = c.lists
  if (lists) {
    if (lists.postCreateMergeTool) {
      checkToolMembership(`ssps["${ssp}"].lists.postCreateMergeTool`, c.sourceFile, src, lists.postCreateMergeTool)
      for (const arg of lists.mergeArgs || []) {
        const params = src === null ? null : defParams(src, lists.postCreateMergeTool)
        check(
          `ssps["${ssp}"].lists merge arg ${show(arg)} (param of ${lists.postCreateMergeTool})`,
          c.sourceFile,
          arg,
          params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${lists.postCreateMergeTool} not found)`,
        )
      }
      if (lists.dimensionMarker) {
        checkPresence(
          `ssps["${ssp}"].lists.dimensionMarker (in the ${lists.postCreateMergeTool} def block)`,
          c.sourceFile,
          src === null ? null : defBlock(src, lists.postCreateMergeTool),
          lists.dimensionMarker,
          'dimension doc marker',
        )
      }
    }
    if (lists.advertiserDomainMergeTool) {
      checkToolMembership(`ssps["${ssp}"].lists.advertiserDomainMergeTool`, c.sourceFile, src, lists.advertiserDomainMergeTool)
      if (lists.advertiserDimensionMarker) {
        checkPresence(
          `ssps["${ssp}"].lists.advertiserDimensionMarker (in the ${lists.advertiserDomainMergeTool} def block)`,
          c.sourceFile,
          src === null ? null : defBlock(src, lists.advertiserDomainMergeTool),
          lists.advertiserDimensionMarker,
          'advertiser-dimension doc marker',
        )
      }
    }
    if (lists.dealListMergeTool) {
      checkToolMembership(`ssps["${ssp}"].lists.dealListMergeTool`, c.sourceFile, src, lists.dealListMergeTool)
    }
    if (lists.prohibitedMarker) {
      checkPresence(`ssps["${ssp}"].lists.prohibitedMarker`, c.sourceFile, src, lists.prohibitedMarker, 'platform-prohibition doc marker')
    }
    if (lists.supported === false) {
      assertOnly(
        `ssps["${ssp}"].lists.supported`,
        false,
        'verified by absence — no @mcp.tool in the SSP source ingests a list FILE into domain/app-bundle targeting (deal-list targeting takes pre-existing Curate deal lists; the dealListMergeTool + prohibitedMarker extractions above pin the surface that DOES exist)',
      )
    }
    if (lists.supplyDomainsSupported === false) {
      assertOnly(
        `ssps["${ssp}"].lists.supplyDomainsSupported`,
        false,
        'vendor capability verdict (cutlass#731 open: the EB_SUPPLY_DOMAIN_ID write path is vendor-unconfirmed, read-side discovery only; no supply-domain merge tool exists) — not mechanically provable from Cutlass source',
      )
    }
    if (lists.supplyDomainsSupported === true) {
      assertOnly(
        `ssps["${ssp}"].lists.supplyDomainsSupported`,
        true,
        'vendor capability verdict with one open residual (cutlass#731): the EB_SUPPLY_DOMAIN_ID encoding is live-READ-proven and the merge tool ships (pinned above), but WRITE acceptance of the binding awaits the one live canary PATCH on a paused deal — not mechanically provable from Cutlass source',
      )
    }
  }

  // TripleLift subnational geo (cutlass#732): the region catalog tool and the
  // region_ids/postal_codes create-payload keys + bindings are pinned as
  // source literals (payload keys are folded inside tl_create_deal, not def
  // params, so defParams cannot see them). The statesEmitted/zipsEmitted/
  // dmasEmitted verdicts are Deal Onboarding-side emission facts — asserted here,
  // pinned by contractGolden.test.ts.
  const sub = c.subnationalGeo
  if (sub) {
    if (sub.regionListTool) checkToolMembership(`ssps["${ssp}"].subnationalGeo.regionListTool`, c.sourceFile, src, sub.regionListTool)
    for (const key of sub.createPayloadKeys || []) {
      checkPresence(`ssps["${ssp}"].subnationalGeo.createPayloadKeys[${show(key)}]`, c.sourceFile, src, `"${key}"`, 'convenience payload key')
    }
    for (const binding of sub.bindings || []) {
      checkPresence(`ssps["${ssp}"].subnationalGeo.bindings[${show(binding)}]`, c.sourceFile, src, `"${binding}"`, 'targeting binding')
    }
    for (const fact of ['statesEmitted', 'zipsEmitted', 'dmasEmitted']) {
      if (fact in sub) {
        assertOnly(
          `ssps["${ssp}"].subnationalGeo.${fact}`,
          sub[fact],
          'Deal Onboarding-side emission fact (buildTripleLiftPrompt): pinned by contractGolden.test.ts, not extractable from Cutlass — see subnationalGeo.note for the canary gate',
        )
      }
    }
  }

  // Geo-EXCLUDE capability (#219). Deal Onboarding ships fail-closed:
  // `emitted` is false for every SSP (the empty geoExcludeEmittingSSPs
  // allowlist in internal/validation/rules.go + zero geoExclude references in
  // dealPromptYaml.ts) — a Deal Onboarding-side fact, asserted not extracted. The
  // WIRE half is pinned against Cutlass source so the longer-term per-SSP
  // emission work starts from verified capability facts: createArg against
  // the create tool's real signature, sourceMarkers/failClosedCodes as source
  // literals, and Xandr's createHardcodesInclude against the literal
  // include-hardcoding line. wireSupport false/"unverified" verdicts are
  // asserted (absence/vendor behavior is not mechanically provable).
  const gx = c.geoExclude
  if (gx) {
    assertOnly(
      `ssps["${ssp}"].geoExclude.emitted`,
      gx.emitted,
      'Deal Onboarding-side fail-closed fact (empty geoExcludeEmittingSSPs allowlist in internal/validation/rules.go; geo_exclude_unsupported audit rule); pinned by contractGolden.test.ts, not extractable from Cutlass',
    )
    const gxArgs = gx.createArgs || (gx.createArg ? [gx.createArg] : [])
    for (const arg of gxArgs) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].geoExclude create arg ${show(arg)} (param of ${c.createTool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    for (const marker of gx.sourceMarkers || []) {
      checkPresence(`ssps["${ssp}"].geoExclude.sourceMarkers[${show(marker)}]`, c.sourceFile, src, marker, 'geo-exclude surface marker')
    }
    for (const code of gx.failClosedCodes || []) {
      checkPresence(`ssps["${ssp}"].geoExclude.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
    }
    if (gx.createHardcodesInclude) {
      checkPresence(`ssps["${ssp}"].geoExclude.createHardcodesInclude`, c.sourceFile, src, 'profile["country_action"] = "include"', 'include-hardcoding line')
    }
    if (gx.wireSupport === false || gx.wireSupport === 'unverified') {
      assertOnly(
        `ssps["${ssp}"].geoExclude.wireSupport`,
        gx.wireSupport,
        'vendor capability verdict (absence of a wire surface / unverified vendor acceptance is not mechanically provable from Cutlass source)',
      )
    }
  }

  // Silent-drop capability facts (#226): segment EXCLUDES,
  // viewability, and language per SSP. Same rigor as the adDuration/
  // geoExclude blocks — every arg Deal Onboarding's prompt builders emit is pinned
  // against the create tool's real signature, wire fields / loud-flag codes
  // as source literals, and `supported:false` verdicts are asserted (an
  // absent wire surface is not mechanically provable). If a vendor grows a
  // wire (or Cutlass drops one), the corresponding pin drifts and forces a
  // coordinated contract + prompt-builder + QA review.
  for (const factName of ['segmentsExclude', 'viewability', 'language']) {
    const cap = c[factName]
    if (!cap) continue
    const capArgs = cap.createArgs || (cap.createArg ? [cap.createArg] : [])
    for (const arg of capArgs) {
      const params = src === null ? null : defParams(src, c.createTool)
      check(
        `ssps["${ssp}"].${factName} create arg ${show(arg)} (param of ${c.createTool})`,
        c.sourceFile,
        arg,
        params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${c.createTool} not found)`,
      )
    }
    for (const marker of cap.sourceMarkers || []) {
      checkPresence(`ssps["${ssp}"].${factName}.sourceMarkers[${show(marker)}]`, c.sourceFile, src, marker, 'capability surface marker')
    }
    for (const code of cap.failClosedCodes || []) {
      checkPresence(`ssps["${ssp}"].${factName}.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
    }
    if (cap.blockerCode) {
      checkPresence(`ssps["${ssp}"].${factName}.blockerCode`, c.sourceFile, src, `"${cap.blockerCode}"`, 'fail-closed blocker code')
    }
    if (cap.supported === false) {
      assertOnly(
        `ssps["${ssp}"].${factName}.supported`,
        false,
        'capability-absence verdict (no wire surface in the MCP source / vendor-unconfirmed) — asserted, not mechanically provable; the prompt builder emits a NOT-SUPPORTED marker and the SSP-aware QA item warns',
      )
    }
  }

  // IAB-include capability-absence verdicts (#226 item C): TripleLift
  // (vendor-gated, cutlass#757) and Magnite (no ClearLine content-category
  // surface) pin supported:false so qa_contextual can never report their IAB
  // as configured. The positive-side iabCategories.createArg pins live in the
  // block above.
  if (c.iabCategories && c.iabCategories.supported === false) {
    assertOnly(
      `ssps["${ssp}"].iabCategories.supported`,
      false,
      'capability-absence verdict (no IAB create path in the MCP source; TL discovery endpoint vendor-gated per cutlass#757) — asserted, not mechanically provable',
    )
  }
}

// ---------------------------------------------------------------------------
// 2. Media.net — ad_format integer enum + channel fallback map
// ---------------------------------------------------------------------------
{
  const c = fixture.ssps['Media.net']
  const src = readCutlass(c.sourceFile)
  if (src) {
    const constant = (n) => {
      const m = src.match(new RegExp(`^MN_AD_FORMAT_${n}:\\s*int\\s*=\\s*(\\d+)`, 'm'))
      return m ? Number(m[1]) : `(MN_AD_FORMAT_${n} not found)`
    }
    // Key order mirrors the vendor enum (0=Banner, 1=Native, 2=Video —
    // Select API Guide v9.4 p.23); the comparison is JSON.stringify-ordered.
    check('ssps["Media.net"].adFormat', c.sourceFile, c.adFormat, {
      Banner: constant('BANNER'),
      Native: constant('NATIVE'),
      Video: constant('VIDEO'),
    })
    // Channel -> format map: `"olv": MN_AD_FORMAT_VIDEO,` etc.
    const channelMap = {}
    for (const m of src.matchAll(/"(display|olv|ctv|ott)":\s*MN_AD_FORMAT_([A-Z]+)/g)) {
      channelMap[m[1]] = m[2][0] + m[2].slice(1).toLowerCase() // BANNER -> Banner
    }
    check('ssps["Media.net"].channelAdFormat', c.sourceFile, c.channelAdFormat, channelMap)
    // whitelisted_seats shape contract (#234.4): the documented
    // {demand_partner, seat_ids[]} groups, the fail-closed shape gate, and
    // the loud rejection of the phantom `seat_id` key.
    if (c.whitelistedSeats) {
      checkPresence('ssps["Media.net"].whitelistedSeats (shape gate)', c.sourceFile, src, 'def _validate_whitelisted_seats', 'whitelisted_seats shape validator')
      checkPresence('ssps["Media.net"].whitelistedSeats.rejectedKey (loud rejection)', c.sourceFile, src, "'seat_id' is not a Media.net field", 'phantom seat_id rejection message')
      checkPresence('ssps["Media.net"].whitelistedSeats (create blocker)', c.sourceFile, src, '"mn_whitelisted_seats_invalid"', 'create-path blocker code')
      check(
        'ssps["Media.net"].whitelistedSeats (retired seat_id identity gone)',
        c.sourceFile,
        false,
        src.includes('sid = seat.get("seat_id")'),
      )
    }
  } else {
    drifts.push({ fact: 'ssps["Media.net"].adFormat', fixtureValue: c.adFormat, cutlassValue: '(file not found)', file: c.sourceFile })
  }
}

// ---------------------------------------------------------------------------
// 2b. PubMatic — ad-format enum + channel fallback map (cutlass#727)
// ---------------------------------------------------------------------------
{
  const c = fixture.ssps['PubMatic']
  const src = readCutlass(c.sourceFile)
  if (src) {
    // Canonical enum constants:
    //   PM_AD_FORMATS_DISPLAY: tuple[int, ...] = (3,)   # Banner
    //   PM_AD_FORMATS_VIDEO: tuple[int, ...] = (13,)    # Video (live-verified)
    const tupleConstant = (n) => {
      const m = src.match(new RegExp(`^PM_AD_FORMATS_${n}:\\s*tuple\\[int, \\.\\.\\.\\]\\s*=\\s*\\((\\d+),\\)`, 'm'))
      return m ? Number(m[1]) : `(PM_AD_FORMATS_${n} not found)`
    }
    check('ssps["PubMatic"].adFormat.Banner/Video/Native', c.sourceFile, { Banner: c.adFormat.Banner, Video: c.adFormat.Video, Native: c.adFormat.Native }, {
      Banner: tupleConstant('DISPLAY'),
      Video: tupleConstant('VIDEO'),
      Native: tupleConstant('NATIVE'),
    })
    // The Native id per PubMatic's adType catalog (cutlass PR #862):
    //   PM_NATIVE_AD_FORMAT_ID = 12
    const nativeId = src.match(/^PM_NATIVE_AD_FORMAT_ID\s*=\s*(\d+)/m)
    check(
      'ssps["PubMatic"].adFormat.Native (PM_NATIVE_AD_FORMAT_ID)',
      c.sourceFile,
      c.adFormat.Native,
      nativeId ? Number(nativeId[1]) : '(PM_NATIVE_AD_FORMAT_ID not found)',
    )
    // The fail-closed allowed set — only catalog-verified ids may reach the
    // wire (GET /v1/common/adType, 2026-08-03):
    //   PUBMATIC_ALLOWED_AD_FORMAT_IDS = {3, 12, 13}
    const allowed = src.match(/^PUBMATIC_ALLOWED_AD_FORMAT_IDS\s*=\s*\{([\d,\s]+)\}/m)
    check(
      'ssps["PubMatic"].adFormat.allowedIds',
      c.sourceFile,
      c.adFormat.allowedIds,
      allowed ? allowed[1].split(',').map((s) => Number(s.trim())) : '(PUBMATIC_ALLOWED_AD_FORMAT_IDS not found)',
      { asSet: true },
    )
    for (const code of c.adFormat.failClosedCodes || []) {
      checkPresence(`ssps["PubMatic"].adFormat.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
    }
    for (const flag of c.adFormat.qualityFlags || []) {
      checkPresence(`ssps["PubMatic"].adFormat.qualityFlags[${show(flag)}]`, c.sourceFile, src, `"${flag}"`, 'quality flag')
    }
    // Channel -> format map: `"olv": PM_AD_FORMATS_VIDEO,` etc.
    const channelMap = {}
    for (const m of src.matchAll(/"(display|olv|ctv|ott|native)":\s*PM_AD_FORMATS_([A-Z]+)/g)) {
      channelMap[m[1]] = m[2][0] + m[2].slice(1).toLowerCase() // VIDEO -> Video
    }
    check('ssps["PubMatic"].channelAdFormat', c.sourceFile, c.channelAdFormat, channelMap)
  } else {
    drifts.push({ fact: 'ssps["PubMatic"].adFormat', fixtureValue: c.adFormat, cutlassValue: '(file not found)', file: c.sourceFile })
  }
}

// ---------------------------------------------------------------------------
// 3. OpenX — fee partner keys + revenue_method enum
// ---------------------------------------------------------------------------
{
  const c = fixture.ssps['OpenX']
  const src = readCutlass(c.sourceFile)
  if (src) {
    // The alias-normalization line is the authoritative statement of which fee
    // partner keys the MCP accepts:
    //   if "partner" in resolved_fee and "partner_name_or_id" not in resolved_fee and "partner_id" not in resolved_fee:
    const alias = src.match(/if "(\w+)" in resolved_fee and "(\w+)" not in resolved_fee and "(\w+)" not in resolved_fee/)
    if (alias) {
      const acceptedKeys = [alias[1], alias[2], alias[3]]
      check('ssps["OpenX"].fee.acceptedPartnerKeys', c.sourceFile, c.fee.acceptedPartnerKeys, acceptedKeys, { asSet: true })
      // The canonical key is what the alias normalizes INTO (the first "not in" key).
      check('ssps["OpenX"].fee.canonicalPartnerKey', c.sourceFile, c.fee.canonicalPartnerKey, alias[2])
      // The rejected key must NOT be among the accepted set.
      check(
        'ssps["OpenX"].fee.rejectedPartnerKey (not accepted)',
        c.sourceFile,
        false,
        acceptedKeys.includes(c.fee.rejectedPartnerKey),
      )
    } else {
      drifts.push({ fact: 'ssps["OpenX"].fee.acceptedPartnerKeys', fixtureValue: c.fee.acceptedPartnerKeys, cutlassValue: '(fee alias-normalization line not found)', file: c.sourceFile })
    }
    // revenue_method enum, from the create-args documentation:
    //   "revenue_method": "PoM",  # Required: "CPM" or "PoM" (Percent of Media)
    const enumLine = src.split('\n').find((l) => l.includes('revenue_method') && /"[A-Za-z]+" or "[A-Za-z]+"/.test(l))
    const em = enumLine && enumLine.match(/"([A-Za-z]+)" or "([A-Za-z]+)"/)
    if (em) {
      check('ssps["OpenX"].fee.revenueMethodEnum', c.sourceFile, c.fee.revenueMethodEnum, [em[1], em[2]], { asSet: true })
    } else {
      drifts.push({ fact: 'ssps["OpenX"].fee.revenueMethodEnum', fixtureValue: c.fee.revenueMethodEnum, cutlassValue: '(revenue_method enum doc line not found)', file: c.sourceFile })
    }
    // noDefaultFee is proven by the ox_fee_required blocker checked in step 1.
    assertOnly('ssps["OpenX"].fee.noDefaultFee', c.fee.noDefaultFee, 'implied by the ox_fee_required blocker (checked above); the "no default" prose itself is not mechanically extractable')

    // gross_share UNIT CONTRACT (cutlass#743.7 / #234.3): the single
    // percent->fraction conversion point, the explicit-unit key Deal Onboarding
    // emits, the sub-1-legacy ambiguity guard, and the prepare-path blocker.
    const gsu = c.fee.grossShareUnit
    if (gsu) {
      checkPresence('ssps["OpenX"].fee.grossShareUnit (converter)', c.sourceFile, src, 'def _serialize_gross_share_percent', 'gross-share percent serializer')
      checkPresence('ssps["OpenX"].fee.grossShareUnit.explicitUnitKey', c.sourceFile, src, `"${gsu.explicitUnitKey}"`, 'explicit-unit fee key')
      checkPresence('ssps["OpenX"].fee.grossShareUnit.subOneLegacyFailsClosed', c.sourceFile, src, 'unit-ambiguous', 'sub-1 legacy gross_share ambiguity guard')
      for (const code of gsu.failClosedCodes || []) {
        checkPresence(`ssps["OpenX"].fee.grossShareUnit.failClosedCodes[${code}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
      }
    }

    // The ad-duration video-channel gate: adunit_max_duration_* args are only
    // honored when targeting.channel is a member of _OX_AD_DURATION_CHANNELS
    // (the gate never infers from rendering_context/device_type). Deal Onboarding's
    // OpenX builder emits targeting.channel from this pinned list — if the
    // enum drifts, the prompt emission must be re-reviewed, not just the pin.
    //   _OX_AD_DURATION_CHANNELS = ("CTV", "OLV", "OTT")
    const chan = src.match(/_OX_AD_DURATION_CHANNELS\s*=\s*\(([^)]*)\)/)
    check(
      'ssps["OpenX"].adDuration.requiresTargetingChannel',
      c.sourceFile,
      c.adDuration.requiresTargetingChannel,
      chan ? [...chan[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : '(_OX_AD_DURATION_CHANNELS tuple not found)',
      { asSet: true },
    )

    // targetingChannel (cutlass#726 / #229): Deal Onboarding emits
    // targeting.channel on ALL OpenX deals. The wire enum is the
    // DEFAULT_RENDERING_CONTEXTS key set (the map the MCP builds each
    // channel's rendering_context from), and the cutlass fail-closed
    // backstop codes must exist verbatim in the MCP source.
    const tc = c.targetingChannel
    if (tc) {
      const rcBlock = src.match(/DEFAULT_RENDERING_CONTEXTS:\s*dict\[str,\s*dict\[str,\s*Any\]\]\s*=\s*\{([\s\S]*?)\n\}/)
      check(
        'ssps["OpenX"].targetingChannel.channelMap (values = DEFAULT_RENDERING_CONTEXTS keys)',
        c.sourceFile,
        Object.values(tc.channelMap),
        rcBlock ? [...rcBlock[1].matchAll(/\n {4}"([A-Z]+)": \{/g)].map((m) => m[1]) : '(DEFAULT_RENDERING_CONTEXTS dict not found)',
        { asSet: true },
      )
      for (const code of tc.failClosedCodes || []) {
        checkPresence(`ssps["OpenX"].targetingChannel.failClosedCodes[${show(code)}]`, c.sourceFile, src, `"${code}"`, 'blocker code')
      }
      assertOnly(
        'ssps["OpenX"].targetingChannel.alwaysEmitted',
        tc.alwaysEmitted,
        'Deal Onboarding-side emission policy (dealPromptYaml.ts buildOpenXPrompt) — pinned by contractGolden.test.ts, not extractable from Cutlass',
      )
    }

    // pmpDealType (cutlass#766): PRIVATE_AUCTION ("2") is API-uncreatable —
    // OpenX's backend requires open_auction_access, absent from the create
    // schema. The ox_private_auction_unsupported blocker code is extracted via
    // failClosedCodes above; here we pin the guard constant in the MCP source
    // and that the create protocol no longer offers Private Auction as an
    // allowed pmp_deal_type value.
    if (c.pmpDealType) {
      checkPresence(
        'ssps["OpenX"].pmpDealType guard constant (cutlass#766)',
        c.sourceFile,
        src,
        'PRIVATE_AUCTION_PMP_DEAL_TYPE = "2"',
        'guard constant',
      )
      const protoFile = 'protocols/deal-creation-openx.yaml'
      const proto = readCutlass(protoFile)
      const allowed = proto && proto.match(/pmp_deal_type_allowed:\n((?: +- .*\n)+)/)
      const allowedValues = allowed ? [...allowed[1].matchAll(/- "?([A-Z0-9_]+)"?/g)].map((m) => m[1]) : null
      check(
        'ssps["OpenX"].pmpDealType (protocol pmp_deal_type_allowed excludes PRIVATE_AUCTION/"2")',
        protoFile,
        false,
        allowedValues
          ? allowedValues.includes('PRIVATE_AUCTION') || allowedValues.includes('2')
          : '(pmp_deal_type_allowed list not found)',
      )
      assertOnly(
        'ssps["OpenX"].pmpDealType.note (Deal Onboarding-side halves)',
        c.pmpDealType.note,
        'UI removal + ox_pmp_type audit hard-block + # BLOCKED prompt emission are Deal Onboarding-side facts pinned by dealPromptYaml.test.ts and rules_test.go; the Cutlass halves (blocker code, guard constant, protocol allowed-list) are extracted above',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 4. TripleLift — required_fields + curation fee model type
// ---------------------------------------------------------------------------
{
  const c = fixture.ssps['TripleLift']
  const src = readCutlass(c.sourceFile)
  if (src) {
    const block = src.match(/required_fields\s*=\s*\[([\s\S]*?)\]/)
    if (block) {
      const fields = [...block[1].matchAll(/"(\w+)"/g)].map((m) => m[1])
      check('ssps["TripleLift"].requiredFields', c.sourceFile, c.requiredFields, fields, { asSet: true })
    } else {
      drifts.push({ fact: 'ssps["TripleLift"].requiredFields', fixtureValue: c.requiredFields, cutlassValue: '(required_fields list not found)', file: c.sourceFile })
    }
    checkPresence('ssps["TripleLift"].curationFeePercentType', c.sourceFile, src, `"${c.curationFeePercentType}"`, 'fee model type')
  }
}

// ---------------------------------------------------------------------------
// 5. Xandr / Magnite — margin & rev-share argument names in the execute tools
// ---------------------------------------------------------------------------
{
  const xn = fixture.ssps['Xandr']
  const src = readCutlass(xn.sourceFile)
  if (src) {
    const params = defParams(src, xn.createTool)
    check(
      `ssps["Xandr"].marginArg (param of ${xn.createTool})`,
      xn.sourceFile,
      xn.marginArg,
      params ? (params.includes(xn.marginArg) ? xn.marginArg : `(no ${show(xn.marginArg)} param; has: ${params.join(', ')})`) : `(def ${xn.createTool} not found)`,
    )
    // Date semantics (cutlass#744.8): the Deal Service interprets naive
    // datetimes as UTC — the corrected docstring marker must be present AND
    // the retired "local time per the Deal Service" claim must be gone
    // (Deal Onboarding's businessMidnightUtc emission depends on the UTC contract).
    if (xn.dates) {
      checkPresence('ssps["Xandr"].dates.timezone (UTC docstring marker)', xn.sourceFile, src, xn.dates.sourceMarker, 'UTC date-semantics marker')
      check(
        'ssps["Xandr"].dates ("local time per the Deal Service" claim removed)',
        xn.sourceFile,
        false,
        src.includes('local time per the Deal Service'),
      )
    }
  }
}
{
  const mg = fixture.ssps['Magnite']
  const src = readCutlass(mg.sourceFile)
  if (src) {
    const params = defParams(src, mg.createTool)
    check(
      `ssps["Magnite"].revShareArg (param of ${mg.createTool})`,
      mg.sourceFile,
      mg.revShareArg,
      params ? (params.includes(mg.revShareArg) ? mg.revShareArg : `(no ${show(mg.revShareArg)} param)`) : `(def ${mg.createTool} not found)`,
    )
    // MAGNITE_PRICE_TYPES = {"Market Rate", "CPM", "Market Rate with Minimum"}
    const pt = src.match(/MAGNITE_PRICE_TYPES\s*=\s*\{([^}]*)\}/)
    if (pt) {
      const types = [...pt[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      check('ssps["Magnite"].priceTypes', mg.sourceFile, mg.priceTypes, types, { asSet: true })
    } else {
      drifts.push({ fact: 'ssps["Magnite"].priceTypes', fixtureValue: mg.priceTypes, cutlassValue: '(MAGNITE_PRICE_TYPES set not found)', file: mg.sourceFile })
    }
    // ALL_PUBLISHERS_SENTINEL = "ALL"
    const sentinel = src.match(/ALL_PUBLISHERS_SENTINEL\s*=\s*"([^"]+)"/)
    check('ssps["Magnite"].allPublishersSentinel', mg.sourceFile, mg.allPublishersSentinel, sentinel ? sentinel[1] : '(ALL_PUBLISHERS_SENTINEL not found)')
    // Rev-share scale, documented twice in the source ("the Percent scale is a
    // FRACTION" header comment + the magnite_margin_required blocker message);
    // case-insensitive since one is shouted.
    const scale = src.match(/Percent scale is (?:a )?(\w+)/i)
    check('ssps["Magnite"].revShareScale', mg.sourceFile, mg.revShareScale, scale ? scale[1].toLowerCase() : '(scale doc not found)')
    // 'Market Rate with Minimum' contract (#228 / cutlass#718):
    // SpringServe rejects MRwM — Deal Onboarding downgrades CTV deals to Market Rate
    // on the strength of this prepare blocker; on DV+ the MRwM floor ships as
    // the TOP-LEVEL curatorPricing.minimumCpm and a floor-less MRwM blocks,
    // which is why Deal Onboarding always pairs the MRwM price_type with a floor.
    checkPresence('ssps["Magnite"].mrwm.springServeBlockerCode', mg.sourceFile, src, `"${mg.mrwm.springServeBlockerCode}"`, 'prepare blocker code')
    checkPresence('ssps["Magnite"].mrwm.minimumWireField', mg.sourceFile, src, `curator_pricing["${mg.mrwm.minimumWireField}"]`, 'MRwM wire-field assignment')
    checkPresence('ssps["Magnite"].mrwm.minimumMissingBlockerCode', mg.sourceFile, src, `"${mg.mrwm.minimumMissingBlockerCode}"`, 'prepare blocker code')
  }
}

// ---------------------------------------------------------------------------
// 6. PubMatic — owner env resolution + role ids + omitted-owner sentinel
// ---------------------------------------------------------------------------
{
  const c = fixture.ssps['PubMatic']
  const src = readCutlass(c.sourceFile)
  if (src) {
    const def = src.match(/^DEFAULT_OWNER_TYPE_ID\s*=\s*(\d+)/m)
    check('ssps["PubMatic"].owner.defaultOwnerTypeId', c.sourceFile, c.owner.defaultOwnerTypeId, def ? Number(def[1]) : '(DEFAULT_OWNER_TYPE_ID not found)')
    const allowed = src.match(/^ALLOWED_OWNER_TYPE_IDS\s*=\s*\{([^}]*)\}/m)
    check(
      'ssps["PubMatic"].owner.allowedOwnerTypeIds',
      c.sourceFile,
      c.owner.allowedOwnerTypeIds,
      allowed ? allowed[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : '(ALLOWED_OWNER_TYPE_IDS not found)',
      { asSet: true },
    )
    checkPresence('ssps["PubMatic"].owner.envVar', c.sourceFile, src, `"${c.owner.envVar}"`, 'env var')
    // The falsy-owner sentinel: `resolved_id = owner_id or _require_owner_id()`
    // means ANY falsy owner_id (Deal Onboarding emits 0) resolves to the variant env
    // owner. If this line disappears, the sentinel contract needs re-review.
    if (/resolved_id\s*=\s*owner_id\s+or\s+_require_owner_id\(\)/.test(src)) {
      matches.push({ fact: 'ssps["PubMatic"].owner.omittedOwnerSentinel (falsy-resolves-to-env pattern)', file: c.sourceFile })
    } else {
      drifts.push({ fact: 'ssps["PubMatic"].owner.omittedOwnerSentinel', fixtureValue: c.owner.omittedOwnerSentinel, cutlassValue: '(falsy owner_id resolution pattern `owner_id or _require_owner_id()` not found)', file: c.sourceFile })
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Shared tools — deal sheet / sendgrid
// ---------------------------------------------------------------------------
{
  const { dealSheet, sendgrid } = fixture.sharedTools
  const dsSrc = readCutlass(dealSheet.sourceFile)
  checkToolMembership('sharedTools.dealSheet.buildTool', dealSheet.sourceFile, dsSrc, dealSheet.buildTool)
  checkToolMembership('sharedTools.dealSheet.validateBriefTool', dealSheet.sourceFile, dsSrc, dealSheet.validateBriefTool)
  const sgSrc = readCutlass(sendgrid.sourceFile)
  checkToolMembership('sharedTools.sendgrid.sendTool', sendgrid.sourceFile, sgSrc, sendgrid.sendTool)
}

// ---------------------------------------------------------------------------
// 7b. CREATE protocol — final_step / followup_step surface (#236.1)
//
// The update surface below has been pinned since #163, but the CREATE
// protocol's batch finalizer was contract-blind: buildBatchPrompt's
// final_step block emitted phantom args (partner:/campaign_id:) that
// build_deal_sheet never accepted, and no CI check could see it. This
// section pins BOTH halves:
//   - the protocol's canonical finalizer tool names (primary_sheet_tool /
//     primary_email_tool lines in multi-deal-creation.yaml), and
//   - every arg Deal Onboarding's final_step / followup_step blocks instruct,
//     against the real build_deal_sheet / send_email signatures — exactly
//     like the domainsMerge/adDuration arg pins above.
// contractGolden.test.ts asserts Deal Onboarding's emission against the same
// fixture facts, closing the loop.
// ---------------------------------------------------------------------------
{
  const cp = fixture.createProtocol
  const { dealSheet, sendgrid } = fixture.sharedTools
  const proto = readCutlass(cp.protocolFile)
  if (proto === null) {
    drifts.push({ fact: 'createProtocol.protocolFile', fixtureValue: cp.protocolFile, cutlassValue: '(file not found)', file: cp.protocolFile })
  } else {
    const sheetLine = proto.match(/^\s*primary_sheet_tool:\s*(\S+)/m)
    check(
      'createProtocol.primarySheetTool',
      cp.protocolFile,
      cp.primarySheetTool,
      sheetLine ? sheetLine[1] : '(primary_sheet_tool line not found)',
    )
    const emailLine = proto.match(/^\s*primary_email_tool:\s*(\S+)/m)
    check(
      'createProtocol.primaryEmailTool',
      cp.protocolFile,
      cp.primaryEmailTool,
      emailLine ? emailLine[1] : '(primary_email_tool line not found)',
    )
  }

  // Self-consistency: the bare finalizer tools composed with the harness
  // naming (mcp_<server>_<tool>) must equal the protocol's canonical names,
  // so the fixture cannot pin two contradictory finalizers.
  check(
    'createProtocol.primarySheetTool composes sharedTools.dealSheet (mcp_<server>_<tool>)',
    cp.protocolFile,
    cp.primarySheetTool,
    `mcp_${dealSheet.server}_${cp.finalStep.tool}`,
  )
  check(
    'createProtocol.finalStep.tool is sharedTools.dealSheet.buildTool',
    dealSheet.sourceFile,
    cp.finalStep.tool,
    dealSheet.buildTool,
  )
  check(
    'createProtocol.primaryEmailTool composes sharedTools.sendgrid (mcp_<server>_<tool>)',
    cp.protocolFile,
    cp.primaryEmailTool,
    `mcp_${sendgrid.server}_${cp.followupStep.tool}`,
  )

  // Arg pins: every instructed arg must be a real parameter of the tool.
  const dsSrc = readCutlass(dealSheet.sourceFile)
  for (const arg of cp.finalStep.args || []) {
    const params = dsSrc === null ? null : defParams(dsSrc, cp.finalStep.tool)
    check(
      `createProtocol.finalStep arg ${show(arg)} (param of ${cp.finalStep.tool})`,
      dealSheet.sourceFile,
      arg,
      params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${cp.finalStep.tool} not found)`,
    )
  }
  const sgSrc = readCutlass(sendgrid.sourceFile)
  for (const arg of cp.followupStep.args || []) {
    const params = sgSrc === null ? null : defParams(sgSrc, cp.followupStep.tool)
    check(
      `createProtocol.followupStep arg ${show(arg)} (param of ${cp.followupStep.tool})`,
      sendgrid.sourceFile,
      arg,
      params ? (params.includes(arg) ? arg : `(no ${show(arg)} param; has: ${params.join(', ')})`) : `(def ${cp.followupStep.tool} not found)`,
    )
  }
}

// ---------------------------------------------------------------------------
// 10. Structured brief — validate_brief required fields + schema
// ---------------------------------------------------------------------------
{
  const br = fixture.brief
  const validator = readCutlass(br.validatorSourceFile)
  if (validator) {
    const tuple = validator.match(/(?<!UPDATE_)REQUIRED_DEAL_FIELDS\s*=\s*\(([^)]*)\)/)
    if (tuple) {
      const fields = [...tuple[1].matchAll(/"(\w+)"/g)].map((m) => m[1])
      check('brief.validateBriefRequiredFields', br.validatorSourceFile, br.validateBriefRequiredFields, fields, { asSet: true })
    } else {
      drifts.push({ fact: 'brief.validateBriefRequiredFields', fixtureValue: br.validateBriefRequiredFields, cutlassValue: '(REQUIRED_DEAL_FIELDS not found)', file: br.validatorSourceFile })
    }
  }
  const schema = readCutlass(br.schemaFile)
  if (schema === null) {
    drifts.push({ fact: 'brief.schemaFile', fixtureValue: br.schemaFile, cutlassValue: '(file not found)', file: br.schemaFile })
  } else {
    // The per-deal `required:` block — the one whose items include deal_name.
    let schemaRequired = null
    for (const block of schema.matchAll(/required:\s*\n((?:\s+-\s+\w+\n)+)/g)) {
      const items = [...block[1].matchAll(/-\s+(\w+)/g)].map((m) => m[1])
      if (items.includes('deal_name')) schemaRequired = items
    }
    check('brief.schemaRequiredDealFields', br.schemaFile, br.schemaRequiredDealFields, schemaRequired ?? '(per-deal required block not found)', { asSet: true })
    // The SSP key enum on the schema's ssp property.
    const sspEnum = schema.match(/ssp:\s*\n\s*type:\s*string\s*\n\s*enum:\s*\[([^\]]+)\]/)
    check(
      'brief.sspKeys',
      br.schemaFile,
      br.sspKeys,
      sspEnum ? sspEnum[1].split(',').map((s) => s.trim()) : '(ssp enum not found)',
      { asSet: true },
    )
    // Schema document version (v1.1 introduced ad_duration).
    const ver = schema.match(/^version:\s*"([^"]+)"/m)
    check('brief.schemaVersion', br.schemaFile, br.schemaVersion, ver ? ver[1] : '(version line not found)')
    // The per-deal ad_duration object's property names — Deal Onboarding's BriefDeal
    // emits these keys verbatim (dealBrief.ts), so a schema rename must fail
    // here. `[ \t]` (not \s) keeps the line-matcher from running past the
    // blank line that ends the properties block.
    const adBlock = schema.match(new RegExp(`${br.adDurationField}:[ \\t]*\\n(?:[ \\t]+.*\\n)*?[ \\t]+properties:[ \\t]*\\n((?:[ \\t]+\\w+:.*\\n)+)`))
    check(
      'brief.adDurationProps',
      br.schemaFile,
      br.adDurationProps,
      adBlock ? [...adBlock[1].matchAll(/^[ \t]+(\w+):/gm)].map((m) => m[1]) : `(${br.adDurationField} properties block not found)`,
      { asSet: true },
    )
  }
}

// ---------------------------------------------------------------------------
// 11. Documented residuals — fixture facts with no mechanical ground truth
// ---------------------------------------------------------------------------
assertOnly('toolNaming.barePattern', fixture.toolNaming.barePattern, 'agent-harness naming (mcp_<server>_<tool>); the server files and tool names it composes ARE extracted above')

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('Cutlass contract check')
console.log(`  fixture : frontend/src/lib/cutlass-contract.json (${fixture.meta.verifiedAgainst}, verified ${fixture.meta.verifiedOn})`)
console.log(`  cutlass : ${cutlassRoot}`)
console.log('')
console.log(`OK      ${matches.length} facts match cutlass sources`)

if (asserted.length > 0) {
  console.log(`NOTE    ${asserted.length} asserted-not-extracted facts (documented residuals, NOT verified against cutlass):`)
  for (const a of asserted) {
    console.log(`        - ${a.fact} = ${show(a.value)}`)
    console.log(`            ${a.why}`)
  }
}

if (drifts.length > 0) {
  console.log('')
  console.log(`DRIFT   ${drifts.length} fact(s) diverged between the fixture and cutlass:`)
  for (const d of drifts) {
    console.log(`        - ${d.fact}`)
    console.log(`            fixture: ${show(d.fixtureValue)}`)
    console.log(`            cutlass: ${show(d.cutlassValue)}`)
    console.log(`            file   : ${d.file}`)
  }
  console.log('')
  console.log('The Deal Onboarding<->Cutlass contract drifted. Either the engine changed a tool')
  console.log('shape (update the fixture AND the matching prompt builder in Deal Onboarding), or')
  console.log('the fixture was edited without re-verifying. See frontend/src/lib/cutlass-contract.json.')
  process.exit(1)
}

console.log('')
console.log('Contract intact: no drift between the fixture and the cutlass checkout.')
process.exit(0)

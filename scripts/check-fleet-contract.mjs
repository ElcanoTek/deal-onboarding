#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.
// =============================================================================
// check-fleet-contract.mjs — Deal Onboarding <-> fleet task-API contract drift checker
// (#281, the fleet twin of check-cutlass-contract.mjs).
//
// Diffs every fact in frontend/src/lib/fleet-contract.json (the machine-
// readable contract Deal Onboarding's fleet runner adapter depends on) against the
// ground truth in a real fleet checkout:
//
//   internal/apiversion/apiversion.go       /v1 prefix + api_version
//   cmd/fleet/main.go                       POST /tasks + /upload routes
//   internal/sched/handlers/batch.go        X-API-Key auth, scoped-key create
//   internal/sched/handlers/upload.go       upload auth (fleet#719) + response
//   internal/sched/handlers/handlers.go     readJSON tolerance, file_names rules
//   internal/sched/models/models.go         TaskCreate/MCPChoice wire fields
//   internal/agentcore/credential_allowlist.go  Gate-3 semantics + denial marker
//   internal/runner/notify.go               trader-facing task URL shape
//
// Deliberately pinned against the REAL handlers, not fleet's openapi.yaml,
// which currently omits several TaskCreate fields (fleet#720).
//
// It ALSO verifies the Deal Onboarding-side half of the contract (internal/runner/runner.go
// wire structs + paths, internal/handlers/runner.go SSP server map, the frontend
// SSP_SERVER emitter), and — when given an bundle checkout — the bundle
// MCP catalog + persona the deployment relies on.
//
// Usage:
//   node scripts/check-fleet-contract.mjs <path-to-fleet-checkout> [path-to-runner-bundle]
//   FLEET_DIR=<path> [RUNNER_BUNDLE_DIR=<path>] node scripts/check-fleet-contract.mjs
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
const fixturePath = join(repoRoot, 'frontend', 'src', 'lib', 'fleet-contract.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

const fleetDir = process.argv[2] || process.env.FLEET_DIR
if (!fleetDir) {
  console.error('usage: node scripts/check-fleet-contract.mjs <path-to-fleet-checkout> [path-to-runner-bundle]')
  console.error('   or: FLEET_DIR=<path> [RUNNER_BUNDLE_DIR=<path>] node scripts/check-fleet-contract.mjs')
  process.exit(2)
}
const fleetRoot = resolve(fleetDir)
if (!existsSync(fleetRoot) || !statSync(fleetRoot).isDirectory()) {
  console.error(`error: fleet checkout not found at ${fleetRoot}`)
  process.exit(2)
}
const bundleDir = process.argv[3] || process.env.RUNNER_BUNDLE_DIR
const bundleRoot = bundleDir ? resolve(bundleDir) : null
if (bundleRoot && (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory())) {
  console.error(`error: bundle checkout not found at ${bundleRoot}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Result collection + file cache
// ---------------------------------------------------------------------------
const drifts = []   // { fact, fixtureValue, fleetValue, file }
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
const readFleet = (rel) => read(fleetRoot, rel)
const readLocal = (rel) => read(repoRoot, rel)
const readBundle = (rel) => (bundleRoot ? read(bundleRoot, rel) : null)

const show = (v) => JSON.stringify(v)

function check(fact, file, fixtureValue, fleetValue, { asSet = false } = {}) {
  let a = fixtureValue
  let b = fleetValue
  if (asSet && Array.isArray(a) && Array.isArray(b)) {
    a = [...a].sort()
    b = [...b].sort()
  }
  if (JSON.stringify(a) === JSON.stringify(b)) {
    matches.push({ fact, file })
  } else {
    drifts.push({ fact, fixtureValue, fleetValue, file })
  }
}
function assertOnly(fact, value, why) {
  asserted.push({ fact, value, why })
}
// A fact whose ground truth is "this literal exists in that source file".
function checkPresence(fact, file, src, literal, what = 'literal') {
  if (src === null) {
    drifts.push({ fact, fixtureValue: literal, fleetValue: `(file ${file} not found)`, file })
    return
  }
  if (src.includes(literal)) {
    matches.push({ fact, file })
  } else {
    drifts.push({ fact, fixtureValue: literal, fleetValue: `(${what} ${show(literal)} not found)`, file })
  }
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

// The json tag names of a Go struct's fields, from `type <name> struct {` to
// its closing brace at column 0 indent (fleet/models and internal/runner both
// declare wire structs at top level with tab-indented fields).
function goStructJSONTags(src, structName) {
  const m = src.match(new RegExp(`type ${structName} struct \\{([\\s\\S]*?)\\n\\}`))
  if (!m) return null
  return [...m[1].matchAll(/json:"([^",]+)/g)].map((x) => x[1])
}

// One Go function's body (brace-counted from `func <sig> {`).
function goFuncBody(src, namePattern) {
  const m = src.match(new RegExp(`func ${namePattern}[^\\n]*\\{`))
  if (!m) return null
  let depth = 0
  for (let i = m.index; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1)
  }
  return null
}

// The values of a Go map[string]string literal, e.g. updateSSPServer.
function goStringMapValues(src, varName) {
  const m = src.match(new RegExp(`${varName} = map\\[string\\]string\\{([\\s\\S]*?)\\n\\}`))
  if (!m) return null
  return [...m[1].matchAll(/:\s*"([^"]+)"/g)].map((x) => x[1])
}

// ---------------------------------------------------------------------------
// 1. API surface: version, paths, auth
// ---------------------------------------------------------------------------
{
  const api = fixture.api
  const av = readFleet('internal/apiversion/apiversion.go')
  const verMatch = av ? av.match(/const Version = "([^"]+)"/) : null
  check('api.apiVersion', 'internal/apiversion/apiversion.go', api.apiVersion, verMatch ? verMatch[1] : '(const Version not found)')
  const prefixMatch = av ? av.match(/const prefix = "([^"]+)"/) : null
  check('api.versionPrefix', 'internal/apiversion/apiversion.go', api.versionPrefix, prefixMatch ? prefixMatch[1] : '(const prefix not found)')

  const main = readFleet('cmd/fleet/main.go')
  checkPresence('api.apiInfoPath (route)', 'cmd/fleet/main.go', main, `r.Get("${api.apiInfoPath}"`, 'route registration')
  // The versioned paths are prefix + the bare route the apiversion.Router
  // strips — extract both halves.
  const bareCreate = api.createTaskPath.replace(api.versionPrefix, '')
  const bareUpload = api.uploadPath.replace(api.versionPrefix, '')
  checkPresence(`api.createTaskPath (${api.versionPrefix} + POST ${bareCreate})`, 'cmd/fleet/main.go', main, `Post("${bareCreate}", h.CreateTask)`, 'route registration')
  checkPresence(`api.uploadPath (${api.versionPrefix} + POST ${bareUpload})`, 'cmd/fleet/main.go', main, `Post("${bareUpload}", h.HandleUpload)`, 'route registration')
  // The connection probe (runner.Client.Check). estimate must stay routed AND
  // stay gated by authorizeTaskCreate — if fleet ever loosens that gate the
  // probe stops proving anything about the key.
  const bareEstimate = api.estimateTaskPath.replace(api.versionPrefix, '')
  checkPresence(`api.estimateTaskPath (${api.versionPrefix} + POST ${bareEstimate})`, 'cmd/fleet/main.go', main, `Post("${bareEstimate}", h.EstimateTask)`, 'route registration')
  const estimate = readFleet('internal/sched/handlers/estimate.go')
  checkPresence('api.estimateTaskGate (same gate as create)', 'internal/sched/handlers/estimate.go', estimate, api.estimateTaskGate, 'authorization gate')
  // /api-info must remain unauthenticated for the probe to tell "down" from
  // "key rejected". apiversion.unversionedForever is the extraction signal.
  const avRouter = readFleet('internal/apiversion/apiversion.go')
  if (api.apiInfoUnauthenticated) {
    checkPresence('api.apiInfoUnauthenticated', 'internal/apiversion/apiversion.go', avRouter, `case "/healthz", "/health", "/readyz", "${api.apiInfoPath}":`, 'unversioned/unauthenticated list')
  }

  const batch = readFleet('internal/sched/handlers/batch.go')
  checkPresence('api.authHeader', 'internal/sched/handlers/batch.go', batch, `r.Header.Get("${api.authHeader}")`, 'auth header read')
  // Scoped create_task keys on POST /tasks: authorizeTaskCreator validates
  // the key against PermissionCreateTask.
  const authFn = batch ? goFuncBody(batch, '\\(h \\*Handlers\\) authorizeTaskCreator') : null
  check('api.createAcceptsScopedCreateKey', 'internal/sched/handlers/batch.go', api.createAcceptsScopedCreateKey, authFn ? authFn.includes('PermissionCreateTask') : '(authorizeTaskCreator not found)')

  // fleet#719 tracking pin: /v1/upload accepts a scoped create_task key only
  // once HandleUpload validates keys against PermissionCreateTask. Today it
  // does not — when this drifts, fleet#719 landed: flip the fixture fact.
  const upload = readFleet('internal/sched/handlers/upload.go')
  const uploadFn = upload ? goFuncBody(upload, '\\(h \\*Handlers\\) HandleUpload') : null
  check('api.uploadAcceptsScopedCreateKey (fleet#719 tracking pin)', 'internal/sched/handlers/upload.go', api.uploadAcceptsScopedCreateKey, uploadFn ? uploadFn.includes('PermissionCreateTask') : '(HandleUpload not found)')

  // Unknown-field tolerance: readJSON is a plain decoder. If fleet ever adds
  // DisallowUnknownFields, additive-first evolution breaks — loud drift.
  const handlers = readFleet('internal/sched/handlers/handlers.go')
  const readJSONFn = handlers ? goFuncBody(handlers, 'readJSON') : null
  check('api.unknownFieldsIgnored', 'internal/sched/handlers/handlers.go', api.unknownFieldsIgnored, readJSONFn ? !readJSONFn.includes('DisallowUnknownFields') : '(readJSON not found)')
}

// ---------------------------------------------------------------------------
// 2. TaskCreate wire fields (fleet side + Deal Onboarding side)
// ---------------------------------------------------------------------------
{
  const tc = fixture.taskCreate
  const models = readFleet('internal/sched/models/models.go')
  const fleetTags = models ? goStructJSONTags(models, 'TaskCreate') : null
  for (const field of tc.fleetAcceptedFields) {
    check(`taskCreate.fleetAcceptedFields[${show(field)}]`, 'internal/sched/models/models.go', field, fleetTags ? (fleetTags.includes(field) ? field : `(no json:"${field}" tag on TaskCreate; ${fleetTags.length} tags found)`) : '(TaskCreate struct not found)')
  }
  // fleet#709 tracking pin: serialization_key appearing on fleet's TaskCreate
  // means the mutual-exclusion feature shipped — flip serializationKeyHonored.
  check('taskCreate.serializationKeyHonored (fleet#709 tracking pin)', 'internal/sched/models/models.go', tc.serializationKeyHonored, fleetTags ? fleetTags.includes('serialization_key') : '(TaskCreate struct not found)')

  const choiceTags = models ? goStructJSONTags(models, 'MCPChoice') : null
  check('taskCreate.mcpChoiceFields (fleet MCPChoice)', 'internal/sched/models/models.go', tc.mcpChoiceFields, choiceTags ?? '(MCPChoice struct not found)', { asSet: true })
  const allowTags = models ? goStructJSONTags(models, 'CredentialAllowlistEntry') : null
  check('taskCreate.mcpChoiceFields (fleet CredentialAllowlistEntry)', 'internal/sched/models/models.go', tc.mcpChoiceFields, allowTags ?? '(CredentialAllowlistEntry struct not found)', { asSet: true })

  const handlers = readFleet('internal/sched/handlers/handlers.go')
  checkPresence('taskCreate.fileNamesPairRule', 'internal/sched/handlers/handlers.go', handlers, tc.fileNamesPairRule, 'validation error')
  checkPresence('taskCreate.duplicateFileNameError', 'internal/sched/handlers/handlers.go', handlers, tc.duplicateFileNameError, 'validation error')

  // Deal Onboarding half: the fleet wire struct sends exactly the pinned field set.
  const runnerGo = readLocal('internal/runner/runner.go')
  const sentTags = runnerGo ? goStructJSONTags(runnerGo, 'fleetTaskCreateWire') : null
  check('taskCreate.clientSentFields (internal/runner fleetTaskCreateWire)', 'internal/runner/runner.go', tc.clientSentFields, sentTags ?? '(fleetTaskCreateWire struct not found)', { asSet: true })
  const manifestChoiceTags = runnerGo ? goStructJSONTags(runnerGo, 'fleetMCPChoice') : null
  check('taskCreate.mcpChoiceFields (client fleetMCPChoice)', 'internal/runner/runner.go', tc.mcpChoiceFields, manifestChoiceTags ?? '(fleetMCPChoice struct not found)', { asSet: true })
  // Every field Deal Onboarding sends beyond fleet's accepted set must be a known,
  // deliberately-early additive field (silently discarded per
  // unknownFieldsIgnored) — anything else is an unnoticed wire mistake.
  const extras = tc.clientSentFields.filter((f) => !tc.fleetAcceptedFields.includes(f))
  check('taskCreate: client-only fields are exactly the tracked additive set', fixturePath, extras, ['serialization_key'], { asSet: true })

  // Deal Onboarding hits the pinned versioned paths with the pinned auth header.
  checkPresence('api.createTaskPath (client)', 'internal/runner/runner.go', runnerGo, `"${fixture.api.createTaskPath}"`, 'client path')
  checkPresence('api.uploadPath (client)', 'internal/runner/runner.go', runnerGo, `"${fixture.api.uploadPath}"`, 'client path')
  checkPresence('api.estimateTaskPath (client)', 'internal/runner/runner.go', runnerGo, `"${fixture.api.estimateTaskPath}"`, 'client path')
  checkPresence('api.apiInfoPath (client)', 'internal/runner/runner.go', runnerGo, `"${fixture.api.apiInfoPath}"`, 'client path')
  checkPresence('api.authHeader (client)', 'internal/runner/runner.go', runnerGo, `req.Header.Set("${fixture.api.authHeader}"`, 'auth header write')
}

// ---------------------------------------------------------------------------
// 3. Gate-3 credential allowlist semantics
// ---------------------------------------------------------------------------
{
  const ca = fixture.credentialAllowlist
  const file = 'internal/agentcore/credential_allowlist.go'
  const src = readFleet(file)
  checkPresence('credentialAllowlist.denialMarker', file, src, ca.denialMarker, 'denial marker')
  // nil → inherit: Permits() returns true for a nil allowlist.
  const permits = src ? goFuncBody(src, '\\(al CredentialAllowlist\\) Permits') : null
  check('credentialAllowlist.nilInheritsGlobal', file, ca.nilInheritsGlobal, permits ? /if al == nil \{\s*\n\s*return true/.test(permits) : '(Permits not found)')
  // empty-denies-all + populated-permits-only are pinned to fleet's own
  // documented semantics lines — a wording change here means the semantics
  // moved and the fixture (and the client's selection derivation) must be
  // re-reviewed.
  checkPresence('credentialAllowlist.emptyDeniesAll', file, src, 'non-nil empty → deny ALL MCP calls', 'semantics doc line')
  checkPresence('credentialAllowlist.populatedPermitsOnlyListed', file, src, 'only the listed pairs are permitted', 'semantics doc line')
}

// ---------------------------------------------------------------------------
// 4. Upload request/response shape
// ---------------------------------------------------------------------------
{
  const up = fixture.upload
  const file = 'internal/sched/handlers/upload.go'
  const src = readFleet(file)
  checkPresence('upload.multipartField', file, src, `r.FormFile("${up.multipartField}")`, 'multipart field')
  checkPresence('upload.responseFilenameField', file, src, `"${up.responseFilenameField}":`, 'response field')
  // Deal Onboarding half: the client reads that same field.
  const runnerGo = readLocal('internal/runner/runner.go')
  checkPresence('upload.responseFilenameField (client UploadResult)', 'internal/runner/runner.go', runnerGo, `json:"${up.responseFilenameField}"`, 'response decode tag')
}

// ---------------------------------------------------------------------------
// 5. Trader-facing task URL
// ---------------------------------------------------------------------------
{
  const prefix = fixture.taskUrl.webUiPathPrefix
  checkPresence('taskUrl.webUiPathPrefix (fleet notifications)', 'internal/runner/notify.go', readFleet('internal/runner/notify.go'), `"${prefix}"`, 'URL prefix')
  checkPresence('taskUrl.webUiPathPrefix (client TaskURL)', 'internal/runner/runner.go', readLocal('internal/runner/runner.go'), `"${prefix}"`, 'URL prefix')
}

// ---------------------------------------------------------------------------
// 6. MCP server names: bundle catalog + every Deal Onboarding-side emitter
// ---------------------------------------------------------------------------
{
  const sspServers = Object.values(fixture.mcpServers.sspServers)
  const services = fixture.mcpServers.serviceServers
  const allNeeded = [...sspServers, ...services]

  // Bundle catalog (ground truth fleet loads via FLEET_CLIENT_CONFIG_DIR) —
  // verified only when a checkout is supplied.
  if (bundleRoot) {
    const catalog = readBundle('manifest.yaml')
    const names = catalog ? [...catalog.matchAll(/^ {2}- name: (\S+)/gm)].map((m) => m[1]) : null
    for (const server of allNeeded) {
      check(`mcpServers bundle catalog has ${show(server)}`, 'bundle/manifest.yaml', server, names ? (names.includes(server) ? server : `(not in catalog: ${names.join(', ')})`) : '(manifest.yaml not found)')
    }
    if (fixture.persona.name) {
      const persona = readBundle(`personas/${fixture.persona.name}.yaml`)
      check(`persona ${show(fixture.persona.name)} exists in bundle`, `bundle/personas/${fixture.persona.name}.yaml`, true, persona !== null)
    }
  } else {
    assertOnly('mcpServers (bundle catalog)', allNeeded, 'no bundle checkout supplied (pass it as argv[3] or RUNNER_BUNDLE_DIR) — bundle catalog membership not verified this run')
    if (fixture.persona.name) assertOnly('persona.name', fixture.persona.name, 'no bundle checkout supplied — persona existence not verified this run; the deployment pins RUNNER_PERSONA')
  }

  // Deal Onboarding emitters, all pinned to the same table:
  //   frontend SSP_SERVER (prompt variant-load lines)
  const dpy = readLocal('frontend/src/lib/dealPromptYaml.ts')
  const sspBlock = dpy ? dpy.match(/const SSP_SERVER: Record<string, string> = \{([\s\S]*?)\n\}/) : null
  const feMap = sspBlock ? Object.fromEntries([...sspBlock[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]])) : null
  check('mcpServers.sspServers (frontend SSP_SERVER)', 'frontend/src/lib/dealPromptYaml.ts', fixture.mcpServers.sspServers, feMap ?? '(SSP_SERVER map not found)')
  //   Go sspServerByKey (handler form derivation)
  const handlersGo = readLocal('internal/handlers/runner.go')
  const goServers = handlersGo ? goStringMapValues(handlersGo, 'var sspServerByKey') : null
  check('mcpServers.sspServers (Go sspServerByKey values)', 'internal/handlers/runner.go', sspServers, goServers ?? '(sspServerByKey map not found)', { asSet: true })
  //   Go defaultFleetMCPServers (the empty-selection fallback roster)
  const runnerGo = readLocal('internal/runner/runner.go')
  const rosterBlock = runnerGo ? runnerGo.match(/var defaultFleetMCPServers = \[\]string\{([\s\S]*?)\n\}/) : null
  const roster = rosterBlock ? [...rosterBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null
  check('mcpServers (Go defaultFleetMCPServers fallback roster)', 'internal/runner/runner.go', allNeeded, roster ?? '(defaultFleetMCPServers not found)', { asSet: true })
  //   Go handler always-appended service pair
  for (const service of services) {
    checkPresence(`mcpServers.serviceServers[${show(service)}] appended by resolveMCPSelection`, 'internal/handlers/runner.go', handlersGo, `moc.MCPChoice{Server: "${service}"}`, 'service append')
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('Fleet contract check')
console.log(`  fixture : frontend/src/lib/fleet-contract.json (${fixture.meta.verifiedAgainst}, verified ${fixture.meta.verifiedOn})`)
console.log(`  fleet   : ${fleetRoot}`)
console.log(`  bundle  : ${bundleRoot ?? '(not supplied — bundle facts asserted only)'}`)
console.log('')
console.log(`OK      ${matches.length} facts match`)

if (asserted.length > 0) {
  console.log(`NOTE    ${asserted.length} asserted-not-extracted facts (documented residuals, NOT verified this run):`)
  for (const a of asserted) {
    console.log(`        - ${a.fact} = ${show(a.value)}`)
    console.log(`            ${a.why}`)
  }
}

if (drifts.length > 0) {
  console.log('')
  console.log(`DRIFT   ${drifts.length} fact(s) diverged between the fixture and the checkouts:`)
  for (const d of drifts) {
    console.log(`        - ${d.fact}`)
    console.log(`            fixture: ${show(d.fixtureValue)}`)
    console.log(`            actual : ${show(d.fleetValue)}`)
    console.log(`            file   : ${d.file}`)
  }
  console.log('')
  console.log('The Deal Onboarding<->fleet contract drifted. Either fleet@dev changed the wire')
  console.log('(update the fixture AND the matching adapter code in internal/runner / the')
  console.log('handlers), or a tracking pin flipped (fleet#709 serialization_key,')
  console.log('fleet#719 scoped upload keys — flip the fixture fact and unlock the')
  console.log('dependent client behavior), or the fixture was edited without')
  console.log('re-verifying. See frontend/src/lib/fleet-contract.json.')
  process.exit(1)
}

console.log('')
console.log('Contract intact: no drift between the fixture and the fleet checkout.')
process.exit(0)

# Deal Onboarding — Architecture & the Runner Seam

> **This is the canonical spec for how Deal Onboarding hands work to a
> deal-booking runner.** Read it before changing anything that crosses the
> boundary: the submit request shape, a prompt field, an engine tool name, the
> structured brief, or the audit gate. It is written to be agent-readable: a
> coding agent that follows the rules here can extend the app without breaking
> the booking workflow.
>
> Companion docs: [`AGENTS.md`](../AGENTS.md) (build/dev guide),
> [`DEAL_NAMING.md`](./DEAL_NAMING.md), [`PUBLISHER_ALLOWLISTS.md`](./PUBLISHER_ALLOWLISTS.md),
> [`ENVIRONMENT_TARGETING.md`](./ENVIRONMENT_TARGETING.md), [`RETENTION.md`](./RETENTION.md).

---

## 0. How to use this document

- **A change inside the app only** (a UI tweak, a new audit rule that doesn't
  change what is emitted): you need §1 and §6.
- **A change that touches the seam** (the runner request, a prompt field, a
  tool name, the brief, the audit gate): read §3 and §5 in full and follow §6.
- **§5 is MUST / MUST NOT.** The invariants encode money-safety guarantees. If
  a change seems to need one broken, stop and escalate.
- When this document and the code disagree, **the code is the source of
  truth**; fix the stale doc and note it.

---

## 1. The picture

```
┌──────────────────────────────┐    POST /api/runner/create     ┌──────────────────────────┐
│  Deal Onboarding (this repo) │ ─────────────────────────────▶ │  Runner (fleet)          │
│  React + Go, single tenant   │   prompt + brief + list files  │  one agent per batch     │
│  build → audit → prompt      │                                │  loads the engine's      │
│  server-side re-audit gate   │ ◀───── 2xx {taskId, taskUrl}   │  MCP tools per SSP       │
└──────────────────────────────┘                                └────────────┬─────────────┘
                                                                             │ creates deals,
                                                                             │ emails the deal sheet
                                                                             ▼
                                                              IX · OpenX · PubMatic · Magnite
                                                              Xandr · Media.net · TripleLift
```

Deal Onboarding is the **human-facing, deterministic front door**. It builds a
validated prompt and a structured brief, and submits them once. The runner and
its engine (a Cutlass-compatible MCP tool surface) do the actual SSP work.
There is no inbound webhook, no shared database, and no shared code.

**Optional backends.** With no runner configured (`RUNNER_BASE_URL` /
`RUNNER_API_KEY` blank) the app still builds, audits, and generates the prompt;
the Create button explains that submission is off. With no `OPENROUTER_API_KEY`
the LLM features (parse, AI audit, assistant) return 503 and everything else
works.

## 2. Glossary

| Term | Meaning |
|---|---|
| **Batch** | One form submission: N deals = audiences × channels × SSPs × DSPs |
| **Prompt** | The YAML-ish instruction document `frontend/src/lib/dealPromptYaml.ts` builds — the executable artifact the runner's agent follows |
| **Brief** | The structured JSON (`dealBrief.ts`) attached as `deal_brief.json`; drives the deal sheet and is schema-validated |
| **Audit** | `POST /api/audit` — the deterministic rule set in `internal/validation`; also re-run server-side at submit |
| **Runner** | A fleet deployment: a task API (`/v1/tasks`) that spawns one agent per task |
| **Engine** | The MCP servers the agent calls — one per SSP plus `deal_sheet` and `sendgrid` |
| **Operator config** | `ORG_NAME`, `CAMPAIGN_ID_PREFIX`, `DEFAULT_ATTRIBUTION_CODE`, `RUNNER_PERSONA` |

## 3. The seam — `POST /api/runner/create`

Handler: `internal/handlers/runner.go` (`HandleRunnerCreate` /
`HandleRunnerCreateWithOverrideAudit`). Client: `frontend/src/lib/runnerApi.ts`.

```jsonc
{
  "prompt":         "…generated batch prompt…",   // REQUIRED — what the agent runs
  "brief":          "…serialized deal_brief JSON…", // REQUIRED for creates; schema-validated
  "form":           { …audited FormData… },        // REQUIRED — the exact payload the passing audit approved
  "listIds":        ["std-list-id", …],            // standard lists → trusted file paths server-side
  "filePaths":      ["/abs/path/under/uploads", …],// ad-hoc uploads; validated under the allowed dirs
  "fileNames":      ["original-name.csv", …],      // paired 1:1 with filePaths — the name the prompt references
  "idempotencyKey": "…",                           // minted per submit intent by the UI
  "operation":      "create",                      // the only accepted value
  "runnerEnv":      "prod"                         // "prod" (default) | "dev"
}
```

Response: `{ taskId, taskUrl?, files, runnerEnv?, uploaded?, warnings? }`.

**Gates, all enforced before any network call, in order:**

1. `operation` must be `create` (400 `operation_invalid`).
2. **Unresolved-token guard** on the prompt: `<FILL…>`, `<UNSET…>`, `${…}`,
   `{{…}}` reject the submit. A leftover placeholder means a required field
   was never filled.
3. **Brief schema validation.**
4. **Audit re-run + batch binding**: the server re-runs `form` through the
   exact `/api/audit` pipeline (`evaluateAudit`), requires it to pass,
   cross-checks the brief's deal set against the regenerated deal names, and
   requires every audited deal name to appear in the prompt. Rejections:
   `audit_form_required`, `brief_required`, `campaign_id_required`,
   `audit_failed` (with the failed checks), `audit_brief_mismatch`,
   `audit_prompt_mismatch`.
5. **Attachment containment**: every `filePaths` entry must resolve
   (symlink-resolved) under an allowed upload dir; `listIds` resolve to
   repo/runtime list files.
6. **Exclusion overrides**: a deal may carry `exclusionOverride` only for
   trader-entered audience/geo exclusions the SSP cannot enforce. The server
   recomputes the marker, derives the actor from the session, and fsyncs an
   `authorized` event to `DATA_DIR/audit/exclusion-overrides.jsonl` before
   dispatch; a `dispatched` event links the task id. If the audit store is
   unavailable the batch stays blocked.
7. **Idempotency**: one key maps to at most one live task, across
   environments. Same-env retry replays the original task; the other env is a
   409 (`idempotency_env_conflict`). Dev-run deals are just as live as prod's.
8. `503` when the targeted runner slot is not configured — never touches the
   network.

**Environments.** The prod slot reads `RUNNER_*`; the optional dev slot reads
`RUNNER_DEV_*`. `runnerEnv` selects between them; an unknown id is 400
(`runner_env_invalid`), an unconfigured dev pick is 503. `GET
/api/runner/environments` reports `{id, baseUrl, enabled}` per slot — never
API keys. `GET /api/runner/check?env=` probes reachability (`/api-info`) and
whether the key clears the create gate (`/v1/tasks/estimate`) without creating
anything.

**Serialization.** Each task carries `serialization_key = campaign:<id>` so two
batches for the same campaign never run concurrently on the runner.

> **Rule:** the prompt is the executable artifact. If you add a required deal
> field, it MUST appear in the prompt (not only the brief), or the batch runs
> without it.

## 4. The prompt contract

- **Producer:** `frontend/src/lib/dealPromptYaml.ts` — `build<SSP>Prompt` per
  SSP plus `buildBatchPrompt` (batch header, `final_step` deal sheet,
  `followup_step` email, typed `critical_actions`). Structured brief:
  `dealBrief.ts`.
- **Consumer:** the engine's multi-deal-creation protocol and per-SSP MCP tools.
- **Drift guards:** `frontend/src/lib/contractGolden.test.ts` asserts each
  SSP's emitted args against `cutlass-contract.json`; `scripts/check-cutlass-contract.mjs`
  diffs that fixture against an engine checkout you supply. **The fixture is
  the contract.** When an engine tool's wire shape changes, update the fixture
  and the builder in the same change.

The prompt names tools explicitly as `mcp_<server>_<tool>` (`SSP_SERVER` in
`dealPromptYaml.ts`, `sspServerByKey` in `internal/handlers/runner.go`, and the
`defaultFleetMCPServers` roster in `internal/runner/runner.go` are pinned to the same
table by `check-fleet-contract.mjs`). Referenced tool names MUST exist in the
target engine.

**Policy defaults baked into the prompt (app-side, never engine-side):**

- *Flight end date* — `flightDates.ts`: SSPs that require an end date get
  start + 2 years.
- *Geo* — `geoPolicy.ts`: a deal with no geo at all is seeded `country=US` at
  write time so every create prompt carries the SSP's geo arg; any specified
  geo passes through. Subnational geo is classified US-state vs CA-province at
  resolve time; OpenX gets the structured `geographic` dict, never a bare
  2-letter token.
- *IAB excludes* — explicit-only, create-time on Index Exchange and PubMatic;
  every other SSP gets a loud `# NOT supported` marker plus a follow-up line.
  Nothing is silently dropped.
- *Environment* — see `ENVIRONMENT_TARGETING.md`; a selection that no wire
  can carry becomes a loud marker, never silence.

**Identity never rides in code.** Seat ids, marketplaces, owner ids, and
insertion orders come from the trader's form (or the engine's own env); the
prompt omits an id it doesn't have and the engine fails closed. The PubMatic
`logged_in_owner_id: 0` sentinel (engine resolves from its env) is the model to
copy for any new identity field.

### Attachments and lists

- Uploads land in `DATA_DIR/uploads` (extension + content sniff + size). The
  prompt references files by **original filename** while the runner stores
  them under a hashed name; `fileNames` carries the original so the runner
  can pair them.
- Standard lists load from the repo `lists/` dir (strict) merged with
  `DATA_DIR/lists` (runtime, lenient; repo id wins). A list uploads under
  `lists.List.UploadName()` — the human name plus the data file's extension —
  and the prompt references the SAME name (`standardListUploadName`); twin
  tests pin the two derivations byte-identical.
- The `list_ref` and `list_applied` audit rules run in `evaluateAudit`, so a
  stale list pick or an orphaned upload blocks the submit server-side too.

## 5. Invariants — MUST / MUST NOT

1. The submit MUST call `/api/runner/create` and treat only a 2xx as success.
   Never fake success; never advance UI state before the response.
2. The server MUST re-run the audit on `form` and bind the brief and prompt
   to it. The UI audit is advisory.
3. The prompt MUST NOT contain unresolved tokens; the gate is the floor.
4. The app MUST NOT default identity (seats, accounts, owners, marketplaces).
   Omit and let the engine fail closed.
5. A trader-entered exclusion MUST either ship on a verified wire or block the
   create (or carry an authenticated, logged override). Dropped exclusions
   serve the excluded audience.
6. Every emitted tool name MUST exist in the engine; the contract fixture and
   golden suite MUST change together with the builder.
7. Proprietary list data MUST NOT be committed; it is provisioned into
   `DATA_DIR/lists` (see `lists/README.md`).
8. New wire fields MUST be additive and optional — never plan a lockstep
   two-repo deploy.

## 6. Change playbooks

**Add or change a per-SSP deal field.** Add it to `types/deal.ts` → the deal
card → the SSP builder in `dealPromptYaml.ts` → the brief if the sheet needs
it → an audit rule in `rules.go` if it can be wrong → `cutlass-contract.json`
+ `contractGolden.test.ts` for the arg name → run the contract checker against
your engine.

**Add a new SSP.** Slot code in `dealNameSlots.ts` + `rules.go` (golden
fixture), `SSP_SERVER` + `sspServerByKey` + `defaultFleetMCPServers`, a
`build<SSP>Prompt`, an SSP card component, the fixture block, and the docs
tables here and in `ENVIRONMENT_TARGETING.md` / `PUBLISHER_ALLOWLISTS.md`.

**Change the runner transport.** Only `internal/runner` knows the wire; keep the
handler's gates above it. Pin new paths/fields in `fleet-contract.json`.

**Change operator config.** Add the env var to `internal/config`, thread it
through `validation.Configure`, expose it on `/api/config`, read it in
`lib/operatorConfig.ts`, document it in `.env.example`.

## 7. Repository map

| Area | Path |
|---|---|
| Routes | `cmd/server/main.go` |
| Submit seam | `internal/handlers/runner.go`, `internal/runner/` |
| Audit + names | `internal/validation/rules.go`, `qa.go`, `testdata/deal_naming_golden.json` |
| Assistant | `internal/handlers/deal_chat.go`, `deal_chat_domain.go`; `frontend/src/components/DealAssistantDock.tsx`, `DealChat.tsx`, `lib/assistantProposal.ts` |
| Prompt + brief | `frontend/src/lib/dealPromptYaml.ts`, `dealBrief.ts` |
| Contracts | `frontend/src/lib/cutlass-contract.json`, `fleet-contract.json`, `scripts/check-*-contract.mjs` |
| Operator config | `internal/config`, `frontend/src/lib/operatorConfig.ts` |

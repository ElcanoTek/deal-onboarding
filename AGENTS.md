# Deal Onboarding — Agent Guide

Deal Onboarding is a self-hosted deal desk for programmatic curation teams:
intake a brief, audit the package, book live deals across every exchange. A
trader builds a batch in the Deal Builder, a deterministic audit (plus an
optional AI QA pass) validates every deal parameter, and one click submits the
audited batch to a deal-booking runner through a single outbound seam.

> **Cross-system behaviour lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> — read it before changing anything that crosses the app ↔ runner boundary**
> (the request shape, a prompt field, an engine tool name, or the audit gate).
> This file is the local build/dev/validation guide.

## Project structure

```
deal-onboarding/
├── cmd/server/main.go                 Go API server entry point (chi router) — the route table is the API surface of record
├── cmd/deal-onboarding-admin/         Operator CLI: user add/del/list/passwd, gc
├── internal/
│   ├── auth/            HMAC session cookie (deal_onboarding_session)
│   ├── config/          Operator identity (ORG_NAME, CAMPAIGN_ID_PREFIX, DEFAULT_ATTRIBUTION_CODE)
│   ├── handlers/        HTTP handlers: audit, audit-ai, upload, parse-deal, extract-text,
│   │                    lists, deal chat (assistant), runner submit (runner.go), config
│   ├── validation/      All audit rules + deal-name generation (rules.go) + QA report (qa.go)
│   ├── lists/           Standard-list registry (repo lists + runtime lists)
│   ├── pubcatalog/      Advisory known-publisher snapshot
│   ├── runner/          Runner client (fleet task API)
│   ├── idempotency/, overrideaudit/, users/, docx/, envfile/, fsutil/, gc/
├── frontend/src/
│   ├── App.tsx                        Routes: / (Deal Builder), /login, /help
│   ├── components/DealBuilder.tsx     The workspace: sections, audit, prompt, submit, assistant dock
│   ├── components/DealAssistantDock.tsx + DealChat.tsx   Floating assistant
│   ├── components/                    One file per form section + shared components
│   ├── hooks/useFormState.ts          Form state with localStorage persistence
│   ├── lib/dealNameSlots.ts           Deal-name generator (TS twin of rules.go)
│   ├── lib/dealPromptYaml.ts          Per-SSP prompt builders + batch prompt
│   ├── lib/dealBrief.ts               Structured brief
│   ├── lib/assistantProposal.ts       Assistant diff preview / apply / undo
│   ├── lib/operatorConfig.ts          /api/config → curator slot, campaign-id pattern
│   ├── lib/cutlass-contract.json, fleet-contract.json   Pinned engine/runner contracts
│   ├── styles/app.css                 All styles — design tokens only (product tokens block at the top)
│   ├── styles/design-tokens.css       Flag token sheet, vendored byte-for-byte — never edit here
│   ├── styles/fonts/                  Nebula Sans + Hack faces, licences, fonts.css (vendored from Flag)
│   └── types/deal.ts                  Form data types
├── frontend/public/design-system/     Flag icon sprite + Elcano mark and product favicons (served unhashed)
├── catalogs/publisher-catalog.json    Synthetic placeholder — regenerate from your export
├── lists/                             Repo-shipped example standard lists
├── scripts/                           bootstrap, update, private-list provisioning, contract checkers, bsl-change-date
├── deploy/                            systemd unit, operator CLI, sample Caddyfile
└── docs/                              ARCHITECTURE, DEAL_NAMING, PUBLISHER_ALLOWLISTS, ENVIRONMENT_TARGETING, RETENTION, LICENSING
```

Repository policy files: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`CODE_OF_CONDUCT.md`, `LICENSE` (BSL 1.1), `NOTICE` (third-party and brand
attribution). `CLAUDE.md` is a symlink to this file.

## Design system and branding

The UI uses the **Elcano Flag design system** (ElcanoTek/flag, vendored), the
same one Explorer, Pages and Lens ship. Rules:

- **Two typefaces: Nebula Sans** (SIL OFL 1.1 — UI, body, headings) and
  **Hack** (MIT — code, logs, tabular output). No other font ships and there
  is **no CDN font loading**. Both faces live under
  `frontend/src/styles/fonts/` with their licence files; `app.css` imports
  `./fonts/fonts.css` then `./design-tokens.css`, never the other way round.
- Nebula Sans ships real 400/500/600/700 faces — ask for only those weights
  (`--font-weight-regular/medium/semibold/bold`).
- **`design-tokens.css` and `fonts/fonts.css` are byte-for-byte copies of
  Flag's.** Do not edit them; re-sync from Flag. Tokens this product needs
  beyond the sheet (`--rail-hover`, `--rail-active`, `--composer-*`) live in
  the "PRODUCT TOKENS" block at the top of `app.css`, derived from Flag
  tokens.
- Every visual property uses a semantic token (`var(--color-primary)`,
  `var(--radius-md)`, `var(--font-body)` …). **Never hardcode** colors, radii,
  spacing, or font families.
- Theme switching: `html[data-theme="light|dark"]`, persisted under the
  `flag-theme-preference` localStorage key (`useTheme.ts`, `ThemeToggle.tsx`,
  and the pre-hydration script in `index.html`).
- **Branding.** The app header (side rail, mobile topbar, login card) carries
  the **Elcano mark** (`/design-system/logos/elcano-mark-primary.svg`,
  `alt="Elcano"`) beside the product name, exactly as the other Elcano
  products do. The browser tab uses the product favicon
  (`deal-onboarding-favicon.svg`, drawn in Flag's favicon idiom: dark rounded
  square, white glyph, primary-purple accent; a `-light` variant exists). The
  icon sprite is `/design-system/icons/core-icons.svg` — Flag's set plus a
  few product symbols appended at the end. These are ElcanoTek trademarks
  (see `NOTICE`); a fork must replace them.

## Source headers

Every first-party `.go`, `.ts`, `.tsx`, `.mjs`, `.sh` and `.css` file starts
with the SPDX header (after the shebang, if any):

```go
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.
```

Vendored Flag assets (`design-tokens.css`, `fonts/`, `public/design-system/`)
do not get one. `scripts/bsl-change-date.sh` prints the licence Change Date
for any ref — two years after the commit's author date; never write a date
into `LICENSE`, `NOTICE`, the README or the docs.

## Development

Prerequisites: Go 1.24+, Node 18+ / npm.

```bash
make dev       # Go API (port 8080) + Vite dev server (port 5173)
make server    # Go API only
make frontend  # Vite only
make build     # Go binaries → ./bin/, Vite bundle → ./frontend/dist/
make fmt vet test
```

Frontend checks from `frontend/`: `npx tsc --noEmit`, `npm test` (vitest),
`npm run build`. Contract checkers (need an engine checkout you supply):
`node scripts/check-cutlass-contract.mjs <engine-dir>` and
`node scripts/check-fleet-contract.mjs <fleet-dir> [bundle-dir]`.

## Configuration

All configuration is environment-driven; `.env.example` is the annotated
catalog. `cmd/server/main.go` prefers `DEAL_ONBOARDING_*` names and still
honours the legacy `MANIFEST_*` aliases for the login/list settings.

**Operator identity** (`internal/config`, applied through
`validation.Configure`, served to the UI by `GET /api/config`):

| Variable | Default | Effect |
|---|---|---|
| `ORG_NAME` | `Curator` | Deal-name slot 1 when no data partner is set |
| `CAMPAIGN_ID_PREFIX` | `DEAL` | Campaign ids must match `<PREFIX>#####`; parse prompt, audit, and UI placeholders all derive from it |
| `DEFAULT_ATTRIBUTION_CODE` | `A1` | Slot 12 default |
| `RUNNER_PERSONA` | *(blank)* | Persona the runner should load; nothing ships by default |

## Authentication

Email/password only. `POST /api/auth/login` checks the JSON user store
(`internal/users`, path from `DEAL_ONBOARDING_USER_STORE`, default
`$DATA_DIR/users.json`) and mints the HMAC-signed `deal_onboarding_session`
cookie (`internal/auth/session.go`, secret from
`DEAL_ONBOARDING_SESSION_SECRET`). `POST /api/auth/logout` clears it.
Mutating cookie-auth'd routes are CSRF-protected by a stateless same-origin
check (`internal/handlers/csrf.go`) comparing `Origin` against
`X-Forwarded-Host`/`Host` — which is why the Vite dev proxy keeps
`changeOrigin: false`. Users are provisioned with `deal-onboarding-admin user add`.

## API

Public: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/session`,
`GET /api/config`, `GET /api/version`, `GET /health`.

Session-gated:

| Route | Purpose |
|---|---|
| `POST /api/audit` | Runs every validation rule against the form; returns `{status, total_deals, deal_names, checks[], qa}` |
| `POST /api/audit-ai` | Optional LLM QA pass over the form + generated names |
| `POST /api/upload`, `GET /api/upload/file` | Upload (extension allow-list, content sniff, 100 MB cap) → `{id, name, size, path}`; download |
| `POST /api/parse-deal` | LLM free-text → partial form (`{"text": "..."}`); campaign-id prefix comes from operator config |
| `POST /api/extract-text` | `.docx` → text, in memory |
| `GET /api/models/*` | OpenRouter model catalog for the pickers |
| `GET /api/publisher-catalog` | The advisory known-publisher snapshot |
| `GET /api/lists`, `POST /api/lists/create` | Standard-list library |
| `POST /api/deal/chat` | Deal Assistant SSE stream (`text.delta`, `form.update`, `error`, `done`) |
| `GET /api/runner/environments`, `GET /api/runner/check` | Configured runner slots (never keys); connectivity probe |
| `POST /api/runner/create` | The one outbound seam — see `docs/ARCHITECTURE.md` |

LLM routes require `OPENROUTER_API_KEY` and return 503 without it.

## Deal Assistant

`DealAssistantDock.tsx` is a floating launcher/panel (bottom-right, ~420×600 on
desktop, full-screen on mobile) wrapping `DealChat.tsx`. Open/size persist in
localStorage; the transcript lives in sessionStorage and is cleared on submit
or reset. The chat is bound to the live form: every request carries the form,
the last matching audit (checks + QA report), the standard lists, and uploaded
files (`HandleDealChat`, `buildDealChatMessages`). Bulk edits arrive as a
`form.update` event and render as a **diff preview** the trader must **Apply**
or **Discard** (`lib/assistantProposal.ts`); an **Undo last apply** bar
restores the prior form, and after the automatic re-audit the chat posts
"Applied: N deals changed. Audit: …". Failing `AuditResult` rows and QA
flags carry a **Fix with assistant** shortcut that prefills the composer.
The system prompt (`dealChatSystemPrompt`) never invents seat, account, or
marketplace ids.

## Deal naming

Canonical spec: [`docs/DEAL_NAMING.md`](docs/DEAL_NAMING.md). Twelve slots:

```
{Curator}_{SSP}_{DSP}_{Agency}_{Brand}_{NA}_{Segment}_{Channel}_{Inventory}_{Geo}_{CampaignID}_{Attribution}
```

Curator = data-partner code if set, else `ORG_NAME`. Campaign id =
`<CAMPAIGN_ID_PREFIX>#####`. The Go (`rules.go`) and TS (`dealNameSlots.ts`)
generators are pinned byte-for-byte by the shared golden fixture
`internal/validation/testdata/deal_naming_golden.json` — change them together.
Total deals = Audiences × Channels × SSPs × DSPs.

## Validation rules (summary)

The full set lives in `internal/validation/rules.go`; each check has a stable
`rule` id the UI and the assistant reference.

1. **completeness** — submitter, dates, agency, brand, DSP, channel, inventory type, fee type, funnel
2. **date_logic** — start today-or-future (business timezone), end ≥ start
3. **video_kpi / display_kpi** — OLV/CTV need VCR > 0; Display needs a display CPM > 0
4. **deal_fee** — curated deal fee > 0; **fee_type_wire** — only percent-of-media has a verified wire
5. **ssp_required / audience_required / ix_segments**
6. **ox_package**, **ox_deal_price** (optional but must parse > 0 when set), **ox_fee**, **ox_pmp_type**
7. **Publishers** — `ix_publishers` / `ox_publishers` / `pm_publishers` / `mg_publishers` fail a toggle-off-but-empty allowlist; `ox_publisher_ids`, `ox_publisher_conflict`; advisory `allowlist_coverage` and `publisher_known_list` (see `docs/PUBLISHER_ALLOWLISTS.md`)
8. **Magnite** — `mg_marketplace`, `mg_sizes` (DV+ needs ≥1 size), `mg_dvplus_audience`, `mg_floor` (Market Rate / Market Rate with Minimum at 0.10 / CPM; the floor is never the deal CPM)
9. **domain_file_type**, **list_ref** (a per-deal list pick must resolve), **list_applied** (an uploaded list must reach ≥1 create deal)
10. **seat_id** — every DSP has a seat (StackAdapt may omit unless PubMatic/TripleLift rows exist); **seat_multi** — comma-separated seats only on Magnite-only batches
11. **campaign_id** — required, `<PREFIX>#####`
12. **inventory_code** — `All` / `In-app` / `Web`; **channel_code**
13. **ix_floor** — IX deals need CPM ≥ 0.10
14. **viewability_code** — whole deciles 10–90
15. **geo_classification**, **geo_exclude_unsupported**, **segment_exclude_unsupported** — per-SSP wire truth, fail closed
16. **attribution_slot** — a full-name override's last slot must match the form's attribution code
17. **deal_name_length**, **deal_name_charset**, **email_format**, **iab_campaign_retired**

The QA report (`qa.go`) adds advisory items (`qa_*`) rendered by
`QASpecialistReport.tsx`.

## Runner integration

The audited batch is submitted through `POST /api/runner/create
{ prompt, brief, form, listIds, filePaths, fileNames, idempotencyKey, operation:"create", runnerEnv }`
(`internal/handlers/runner.go`). Before any network call the handler fail-closed
gates the prompt (unresolved-token check), the brief (schema), and re-runs the
full audit server-side against `form`, binding the brief's and prompt's deal
names to that re-audit — the UI audit is advisory, this is the enforcement
point. `filePaths` are validated under the allowed upload dirs; `fileNames`
carries each attachment's original filename so the runner stores it under the
name the prompt references. The submit counts as done **only after a 2xx** —
never fake success. Details and invariants: `docs/ARCHITECTURE.md`.

## Coupling & boundaries

Deal Onboarding is a **front door**: it produces work for an agent stack
through one narrow seam and knows nothing about how the runner executes it.

1. **One seam out.** `POST /api/runner/create`. Never reach into runner state
   (no shared DB, no shared code).
2. **This repo owns the contract check — one-directional.** The wire surface
   it depends on is pinned as data in `frontend/src/lib/cutlass-contract.json`
   and `fleet-contract.json`, verified by `scripts/check-*-contract.mjs`
   against an engine checkout you supply.
3. **Additive-first wire evolution.** New prompt/brief fields are optional;
   the producer lands first tolerating old consumers.
4. Nothing here may assume which engine runs the deal beyond the seam.

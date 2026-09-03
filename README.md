# Deal Onboarding

Deal Onboarding is a self-hosted deal desk for programmatic curation teams —
intake a brief, audit the package, book live deals across every exchange. A
trader pastes or uploads a brief, the Deal Builder turns it into a structured,
SSP-aware batch, a deterministic audit (plus an optional AI QA pass) checks
every deal parameter, and one click hands the audited batch to your
[fleet](https://github.com/ElcanoTek/fleet) task runner, whose agent creates
the deals on Index Exchange, OpenX, PubMatic, Magnite, Xandr, Media.net and
TripleLift and emails the deal sheet.

![The Deal Builder on the Deals step: a three-deal Northwind Outdoors batch with the first deal card open, its auto-generated deal name, and the Deal Assistant dock open on the right. All names and ids are synthetic.](docs/images/deal-builder.png)

> **This tool books live deals with real money behind them.** The UI audit is
> advisory; the server re-runs the full audit on every submit and refuses
> anything it cannot prove safe. Run it behind a TLS-terminating proxy, hand
> it a **scoped `create_task` runner key** — never an admin key — and treat a
> "dev" runner with live SSP credentials as production. See
> [Security posture](#security-posture).

## Features

- **Deal Builder.** A seven-step guided form — submitter and dates, campaign,
  DSP seats, per-deal cards (audience, channel, geo, floors, IAB categories,
  viewability, publisher allowlists, domain and app-bundle lists), per-SSP
  configuration and file uploads — with live deal-name previews and an
  as-you-go audit on every step.
- **A deterministic audit.** 25+ validation rules that mirror what each SSP
  will actually accept, each with a stable rule id, plus a QA specialist
  report of advisory items. Rules fail closed: a targeting rule the app cannot
  express on the wire blocks the batch rather than being dropped.
- **Server-side enforcement.** Every submit is re-audited on the server and the
  prompt's deal names are bound to that result. The UI audit exists to help
  the trader; the handler is the gate.
- **Deal Assistant.** A floating chat dock bound to the live form. Ask what an
  audit rule means, or ask for bulk edits and review them as a diff you
  **Apply** or **Discard**; failing audit rows carry a *Fix with assistant*
  shortcut. It never invents seat, account or marketplace ids.
- **Parse Deal Data.** Paste or drop a brief (including `.docx`) and an LLM
  fills the form; campaign ids follow your configured prefix.
- **Twelve-slot deal names**, generated identically in Go and TypeScript and
  pinned by a shared golden fixture. See [`docs/DEAL_NAMING.md`](docs/DEAL_NAMING.md).
- **One outbound seam.** `POST /api/runner/create` sends a prompt, a
  structured brief and the list files to your fleet task runner. Nothing else
  leaves the box, and pinned engine contracts fail CI when a tool upstream is
  renamed.
- **Single host, no cloud dependency.** A Go API and a Vite bundle behind
  Caddy, under systemd; a JSON user store; uploads and lists on local disk.

<details>
<summary>The Deal Summary with the audit passed and the QA specialist report</summary>

![The Deal Summary: SSP configuration for Index Exchange, OpenX and Magnite, the file-upload summary, and a green "Audit Passed — Ready to create 3 deals" banner above the Deal QA Specialist report showing 23 passed checks and 4 advisories.](docs/images/deal-summary.png)

</details>

## How it works

```
brief ──▶ Deal Builder ──▶ rules audit + QA report ──▶ prompt + brief + lists
              ▲                    │                            │
              └── Deal Assistant ──┘        POST /api/runner/create (re-audited)
                                                                │
                                                                ▼
                                                    fleet task runner → SSP MCP tools
                                                    → deals created, deal sheet emailed
```

The form lives in the browser (and in `localStorage`) until submit. Every step
change fires a silent rules-only audit so each step's banner shows what is
still wrong there; entering the Deal Summary runs the full audit and, with an
OpenRouter key, the AI QA pass. Submit builds the batch prompt from per-SSP
builders, a structured brief, and the resolved list files, and posts them to
the runner. The handler gates the prompt (no unresolved tokens), the brief
(schema) and the form (full re-audit) before any network call, and the submit
counts as done **only after a 2xx**. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
is the canonical spec for that seam and the invariants around it.

## Quick start

Requires Go 1.24+ and Node 18+.

```bash
git clone https://github.com/ElcanoTek/deal-onboarding.git
cd deal-onboarding
cd frontend && npm install && cd ..
go mod tidy
cp .env.example .env            # set DEAL_ONBOARDING_SESSION_SECRET, ORG_NAME, CAMPAIGN_ID_PREFIX
go build -o bin/deal-onboarding-admin ./cmd/deal-onboarding-admin
DEAL_ONBOARDING_USER_STORE=./data/users.json ./bin/deal-onboarding-admin user add you@example.com
make dev                        # Go API on :8080, Vite on :5173
```

Open <http://localhost:5173/login>, sign in with the one-time password the
admin CLI printed, and start with `/help`.

Without an OpenRouter key the app still builds, audits and submits deals; the
LLM features (Parse Deal Data, AI audit, Deal Assistant) return a clear
"not configured" note. Without a runner configured, the Create button explains
that submission is off and the prompt can still be copied.

Run the checks with `make fmt vet test` and, from `frontend/`,
`npx tsc --noEmit && npm test && npm run build`. Neither suite needs a runner,
an OpenRouter key or the network.

## Configuration

Everything is environment-driven; [`.env.example`](.env.example) is the
annotated catalog. The operator identity settings decide how deal names and
campaign ids look:

| Variable | Default | Purpose |
|---|---|---|
| `ORG_NAME` | `Curator` | Slot 1 of every generated deal name when no data partner is set |
| `CAMPAIGN_ID_PREFIX` | `DEAL` | Campaign ids must match `<PREFIX>#####` |
| `DEFAULT_ATTRIBUTION_CODE` | `A1` | Slot 12 default |
| `RUNNER_PERSONA` | *(blank)* | Persona name your runner bundle defines, if any |
| `DEAL_ONBOARDING_SESSION_SECRET` | *(required)* | HMAC key for the session cookie; 32+ random characters |
| `RUNNER_BASE_URL` / `RUNNER_API_KEY` | *(blank = submission off)* | The fleet task API and a scoped `create_task` key |
| `OPENROUTER_API_KEY` | *(blank = LLM features off)* | Parse Deal Data, AI audit, Deal Assistant |

See [`docs/DEAL_NAMING.md`](docs/DEAL_NAMING.md) for the naming convention and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the runner seam.

## Connecting a runner

Deal Onboarding talks to exactly one thing: a fleet deployment's task API.

1. In fleet, create a **scoped `create_task` key** for this app (it also
   authorizes uploads). Never hand the app an admin key.
2. Make sure the fleet bundle catalogs the MCP servers the prompts route to
   (`indexexchange_mcp`, `openx_mcp`, `pubmatic_mcp`, `magnite_mcp`,
   `xandr_mcp`, `medianet_mcp`, `triplelift_mcp`, `deal_sheet`, `sendgrid`) and,
   if you use one, the persona named in `RUNNER_PERSONA`.
3. Set `RUNNER_BASE_URL` (bare origin, no path) and `RUNNER_API_KEY`, restart,
   and press **Test connection** in the submit dialog: it checks `/api-info`
   reachability and whether the key clears the create gate, without creating
   a task.
4. Optionally configure `RUNNER_DEV_*` for a second deployment; the submit
   dialog then shows an environment picker. A dev runner with live SSP
   credentials books live deals.

Pin your engine and fleet revisions with the contract checkers so a tool
rename upstream fails CI here instead of failing a live batch:

```bash
node scripts/check-cutlass-contract.mjs /path/to/engine
node scripts/check-fleet-contract.mjs /path/to/fleet [/path/to/bundle]
```

## Deployment

Single host, Fedora/RHEL-family:

```bash
sudo dnf install -y git
sudo git clone https://github.com/ElcanoTek/deal-onboarding.git /opt/deal-onboarding-src
sudo bash /opt/deal-onboarding-src/scripts/bootstrap.sh
```

The bootstrap installs dependencies, builds the Go server and the Vite bundle,
installs a `deal-onboarding` operator CLI and systemd unit, provisions initial
users, and optionally fronts the app with Caddy (Let's Encrypt or
`tls internal`). Afterwards:

```bash
deal-onboarding user add alice@example.com
deal-onboarding env edit        # set RUNNER_BASE_URL / RUNNER_API_KEY, OPENROUTER_API_KEY
deal-onboarding env check
deal-onboarding restart
deal-onboarding logs
deal-onboarding update          # git pull + rebuild + restart
```

Back up `DATA_DIR` (users, uploads, standard lists, audit log) on your own
schedule; see [`docs/RETENTION.md`](docs/RETENTION.md).

## Security posture

- **The server is the gate.** `POST /api/runner/create` re-runs the full audit
  against the submitted form and refuses a prompt with unresolved tokens or a
  brief that fails its schema, before any network call.
- **Fail closed.** A geo or segment exclusion the target SSP cannot express on
  the wire blocks the batch; it is never silently dropped.
- **Loopback plus a proxy.** Bind `127.0.0.1` and terminate TLS in front. The
  same-origin CSRF check compares `Origin` against `X-Forwarded-Host`, so the
  proxy must be one you trust.
- **Least-privilege runner key.** A scoped `create_task` key creates tasks and
  uploads attachments and can do nothing else.
- **Uploads are confined.** Extension allow-list, content sniffing, a 100 MB
  cap, and every path validated under the upload directories. Briefs contain
  client data; `deal-onboarding-admin gc` sweeps orphans on a schedule.
- **Append-only compliance log.** `DATA_DIR/audit/exclusion-overrides.jsonl`
  records every acknowledged exclusion override; back it up, never truncate.
- **No identity in the repository.** Fixtures, tests, screenshots and the
  publisher catalog are synthetic (`Northwind`, `DataCo`, `DEAL00xxx`).
- **Never commit a dotenv file.** All `.env*` variants except `.env.example`
  are gitignored. Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Documentation

| Document | What it covers |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Developer guide: layout, build, validation rules, design system, source headers |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The outbound runner contract and the invariants around it |
| [`docs/DEAL_NAMING.md`](docs/DEAL_NAMING.md) | The 12-slot deal-name spec |
| [`docs/PUBLISHER_ALLOWLISTS.md`](docs/PUBLISHER_ALLOWLISTS.md) | Publisher allowlists and the advisory known-publisher catalog |
| [`docs/ENVIRONMENT_TARGETING.md`](docs/ENVIRONMENT_TARGETING.md) | Inventory / environment targeting per SSP |
| [`docs/RETENTION.md`](docs/RETENTION.md) | What lives in `DATA_DIR`, and for how long |
| [`docs/LICENSING.md`](docs/LICENSING.md) | The licence in plain English: what you may and may not do |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, tests, branch and PR conventions, and the invariants |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability; scope; secure operation |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1 |
| [`NOTICE`](NOTICE) | Third-party and brand-asset attribution |

## Repository practices

- **CI** (`.github/workflows/ci.yml`) runs on every push and PR: gofmt,
  `go vet`, `go test -race`, the frontend typecheck/tests/build, shell and
  checker syntax, and fixture parsing. Keep it green; never skip a test to get
  there.
- **Contract checks** (`.github/workflows/contract.yml`) run on demand against
  the engine and fleet repositories you name as inputs, with an optional
  `ENGINE_READ_TOKEN` secret for private repos. Run them before upgrading the
  runner and after any prompt-builder change.
- **CodeQL** (`.github/workflows/codeql.yml`) scans Go and TypeScript on push,
  PR and weekly. **Dependabot** opens grouped weekly PRs for Go modules, npm
  packages and GitHub Actions.
- **Branch protection** we recommend on `main`: require the CI and CodeQL
  checks, require one review, disallow force pushes, squash-merge.
- **Releases**: tag `vX.Y.Z` on `main`, and note prompt/contract changes in the
  tag message so operators know to re-run the contract checkers before
  upgrading. `deal-onboarding update` fast-forwards a host to the tracked
  branch.

## Contributing

Bug reports and patches are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for setup, tests, the PR convention and the invariants, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Contributions are accepted under the
same BSL 1.1 terms as the project; there is no separate CLA.

## License

Deal Onboarding is **source-available**, not open source, under the
[Business Source License 1.1](LICENSE).

- **Non-production use only.** The Additional Use Grant is **None**: you may
  read, modify, build on and redistribute Deal Onboarding, and run it for
  development, testing and evaluation — but not to book real deals.
- **Each version becomes MIT two years after it is published.** The clock is
  per version, so the copy in your hands converts two years after the author
  date of the commit that produced it. Every new commit starts a fresh clock
  for the version it produces; a copy already published keeps the Change Date
  it was published with. To see the effective date for your checkout:

  ```bash
  ./scripts/bsl-change-date.sh
  ```

- **Plain-English explanation:** [docs/LICENSING.md](docs/LICENSING.md).
- **Production or commercial use:** email
  [licensing@elcanotek.com](mailto:licensing@elcanotek.com).

Copyright (c) 2026 ElcanoTek, Inc. Third-party components and ElcanoTek brand
assets bundled in this repository are listed in [NOTICE](NOTICE).

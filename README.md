# Deal Onboarding

**A self-hosted deal desk you run yourself — intake a brief, audit the package,
book live deals across every exchange.**

Deal Onboarding is a single-tenant web app for programmatic curation teams. A
trader pastes or uploads a brief, the Deal Builder turns it into a structured,
SSP-aware batch, a deterministic audit (plus an optional AI QA pass) checks
every deal parameter, and one click hands the audited batch to your
deal-booking runner, which creates the deals on Index Exchange, OpenX,
PubMatic, Magnite, Xandr, Media.net, and TripleLift and emails the deal sheet.

- **Deal Builder** — campaign, DSP seats, SSP configuration, per-deal cards
  (audience, channel, geo, floors, IAB categories, viewability, publisher
  allowlists, domain/app-bundle lists), all with live deal-name previews.
- **Audit** — 25+ validation rules that mirror what each SSP will actually
  accept, a QA specialist report, and a server-side re-audit that gates every
  submit.
- **Deal Assistant** — a floating chat dock bound to the live form. Ask
  questions, or ask for bulk edits and review them as a diff before applying.
  Failing audit rows carry a "Fix with assistant" shortcut.
- **One outbound seam** — `POST /api/runner/create` sends a prompt, a
  structured brief, and the list files to your runner (fleet task API or a
  MOC-style task API). Nothing else leaves the box.

## Quick start

Prerequisites: Go 1.24+, Node 18+.

```bash
cd frontend && npm install && cd ..
go mod tidy
cp .env.example .env            # set DEAL_ONBOARDING_SESSION_SECRET, ORG_NAME, CAMPAIGN_ID_PREFIX
go build -o bin/deal-onboarding-admin ./cmd/deal-onboarding-admin
DEAL_ONBOARDING_USER_STORE=./data/users.json ./bin/deal-onboarding-admin user add you@example.com
make dev                        # Go API on :8080, Vite on :5173
```

Open `http://localhost:5173/login`, sign in with the one-time password the
admin CLI printed, and start with `/help`.

Without an OpenRouter key the app still builds, audits, and submits deals; the
LLM features (Parse Deal Data, AI audit, Deal Assistant) return a clear
"not configured" note. Without a runner configured, the Create button explains
that submission is off and the prompt can still be copied.

## Configuration

Everything is environment-driven; `.env.example` is the annotated catalog.
The operator identity settings decide how deal names and campaign ids look:

| Variable | Default | Purpose |
|---|---|---|
| `ORG_NAME` | `Curator` | Slot 1 of every generated deal name when no data partner is set |
| `CAMPAIGN_ID_PREFIX` | `DEAL` | Campaign ids must match `<PREFIX>#####` |
| `DEFAULT_ATTRIBUTION_CODE` | `A1` | Slot 12 default |
| `RUNNER_PERSONA` | *(blank)* | Persona name your runner bundle defines, if any |

See [`docs/DEAL_NAMING.md`](docs/DEAL_NAMING.md) for the naming convention and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the runner seam.

## Documentation

- [`AGENTS.md`](AGENTS.md) — developer guide: layout, build, validation rules,
  design system.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the outbound runner
  contract and the invariants around it.
- [`docs/DEAL_NAMING.md`](docs/DEAL_NAMING.md) — the 12-slot deal-name spec.
- [`docs/PUBLISHER_ALLOWLISTS.md`](docs/PUBLISHER_ALLOWLISTS.md),
  [`docs/ENVIRONMENT_TARGETING.md`](docs/ENVIRONMENT_TARGETING.md),
  [`docs/RETENTION.md`](docs/RETENTION.md).
- [`docs/LICENSING.md`](docs/LICENSING.md) — what the licence lets you do.

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

## License

Deal Onboarding is licensed under the **Business Source License 1.1**. You may
read, modify, and use it in non-production settings today; production use
requires a commercial licence until the Change Date (**2028-09-02**), after
which this version becomes available under the MIT License. Details in
[`LICENSE`](LICENSE) and [`docs/LICENSING.md`](docs/LICENSING.md); enquiries to
licensing@elcanotek.com.

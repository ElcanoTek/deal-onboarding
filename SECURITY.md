# Security Policy

## Reporting a vulnerability

Email **security@elcanotek.com**. Please do not open a public issue, pull
request or discussion for a security problem.

Deal Onboarding books live deals with real money behind them, so treat any
issue that could mis-route, mis-price, or silently drop a targeting rule as a
security issue and report it the same way.

Helpful to include:

- What the issue is and where in the code it lives — a file path, a route, an
  audit rule id, or a prompt field.
- How to reproduce it: a minimal request, form state, or uploaded-file shape.
  Build it with synthetic data (`Northwind`, `DataCo`, `DEAL00042`); never
  send a real brief, seat id, account id or client name.
- What an attacker — or a careless trader — gets out of it.
- The commit sha or `GET /api/version` output you tested.
- Whether you intend to disclose publicly, and on what timeline.

If you would rather encrypt, say so in a first message with no details and we
will arrange a key.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that a human has read it | 3 business days |
| Initial assessment and severity | 10 business days |
| Fix or documented mitigation for a confirmed high-severity issue | 30 days |

Lower-severity issues are fixed on the normal release cadence. We will keep you
updated, tell you when a fix ships, and tell you plainly if we decide not to
act and why. Please give us 90 days before public disclosure, or less if we
ship sooner. Credit in the release notes is offered unless you prefer
otherwise. We do not operate a paid bug-bounty programme.

## Scope

**In scope** — this repository:

- The Go server (`cmd/`, `internal/`): session cookie minting and
  verification, the same-origin CSRF check, the upload path (extension
  allow-list, content sniffing, size cap, path confinement), the runner
  submit handler and its fail-closed gates, the idempotency store, and the
  append-only override audit log.
- The audit itself (`internal/validation`): a rule that can be made to pass a
  deal it should block, or that silently drops a geo or segment exclusion, is
  in scope even though it is "just validation" — it is the enforcement point.
- The frontend (`frontend/src`): anything that lets a prompt, brief or deal
  name reach the runner without matching the server-side re-audit, XSS through
  markdown rendering in the Deal Assistant, or leakage of another user's form
  state.
- The pinned engine contracts in `frontend/src/lib/*-contract.json` and the
  checkers under `scripts/` — a checker that passes when the contract has
  drifted is in scope.
- The operator CLI and deployment assets (`deploy/`, `scripts/`): privilege
  escalation, unsafe defaults, secrets exposure, unsafe file permissions.
- Accidentally committed credentials, seat ids, account ids or customer data.

**Out of scope:**

- The runner and engine you connect Deal Onboarding to. Report those to their
  maintainers; report to us only if *our* prompt or brief is what creates the
  vulnerability.
- OpenRouter and the models behind it. Treat model output as untrusted input
  — the app already does, and a report that a model can be talked into a bad
  suggestion is not a vulnerability unless the suggestion bypasses the audit.
- Findings that require an already-compromised host, root on the box, the
  session secret, or a valid runner key.
- Anything that follows from a documented configuration choice made against
  our advice — for example exposing port 8080 directly instead of behind the
  reverse proxy, or handing the app a fleet admin key instead of a scoped
  `create_task` key.
- Third-party dependency CVEs with no demonstrated path through Deal
  Onboarding; those are handled by Dependabot.
- Reports from automated scanners with no demonstrated impact.

## Supported versions

Fixes land on `main`. There are no long-lived maintenance branches, so the
supported version is the current `main`. Deployments update with
`deal-onboarding update` (see the README).

## Operating Deal Onboarding securely

Worth knowing whether or not you are reporting anything:

- **Keep the app on loopback behind Caddy** or another TLS-terminating proxy.
  The CSRF defence compares `Origin` against `X-Forwarded-Host`/`Host`, so it
  assumes that header is set by a proxy you trust.
- `DEAL_ONBOARDING_SESSION_SECRET` must be at least 32 random characters.
  Rotate it if it leaks; that invalidates every session, which is the point.
- The runner API key must be a **scoped `create_task` key**, never an admin
  key. The app needs to create tasks and upload attachments and nothing else.
- **A dev runner with live SSP credentials books live deals.** The environment
  picker is a convenience, not a safety boundary.
- `DATA_DIR/audit/exclusion-overrides.jsonl` is an append-only compliance log;
  back it up and never truncate it.
- `.env` holds the session secret and the runner and OpenRouter keys. Keep it
  `0600`, owned by the service user; `.gitignore` refuses every `.env*`
  variant except `.env.example`.
- Run `deal-onboarding-admin gc` on a schedule to sweep orphaned uploads;
  briefs contain client data and nothing prunes them otherwise.
- The UI audit is advisory. The server re-runs the full audit on every submit
  and binds the prompt's deal names to that result; a change that weakens that
  gate is a security change, whatever the commit message says.

## A note on this repository's history

Deal Onboarding was developed privately before it was published; this public
repository begins at its first public commit and does not carry the private
development history. No credentials are committed here, and any credential
used during private development is treated as compromised and rotated out of
service. If you have reason to believe a credential connected to this project
is still *live*, that is an incident: put "live credential" in the subject
line and we will treat it as one.

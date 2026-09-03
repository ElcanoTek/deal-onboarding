# Security policy

Deal Onboarding books live deals with real money behind them, so treat any
issue that could mis-route, mis-price, or silently drop a targeting rule as a
security issue.

## Reporting

Please **do not** open a public issue for a vulnerability. Use GitHub's
private advisory form:

https://github.com/ElcanoTek/deal-onboarding/security/advisories/new

Include the version (`GET /api/version` or commit), steps to reproduce, and
the impact you observed. You will get an acknowledgement within five business
days.

## Scope

In scope: the Go server, the frontend, the operator CLI, the deploy scripts,
and the pinned engine contracts in `frontend/src/lib/*-contract.json`.

Out of scope: the runner and engine you connect it to (report those to their
maintainers), and misconfiguration of a self-hosted instance that the
documentation warns against (for example exposing port 8080 directly instead
of behind the reverse proxy — see `deploy/Caddyfile`).

## Hardening notes for operators

- Keep the app on loopback behind Caddy or another TLS-terminating proxy; the
  CSRF defence assumes `X-Forwarded-Host` is trustworthy.
- `DEAL_ONBOARDING_SESSION_SECRET` must be at least 32 random characters and
  should be rotated if leaked (this invalidates every session).
- The runner API key should be a **scoped create_task key**, never an admin key.
- `DATA_DIR/audit/exclusion-overrides.jsonl` is an append-only compliance log;
  back it up and never truncate it.
- Run `deal-onboarding-admin gc` on a schedule to sweep orphaned uploads.

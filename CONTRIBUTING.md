# Contributing to Deal Onboarding

Thanks for helping make Deal Onboarding better. This page is the short
version; [`AGENTS.md`](AGENTS.md) is the full developer guide and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains the one place where a
careless change can book a wrong live deal.

Before anything substantial, open an issue. The app has a small number of
load-bearing invariants (below) and a patch that crosses one will be hard to
accept however well written it is. A short conversation first is cheaper for
both of us.

## Licensing of contributions

Deal Onboarding is source-available under the [Business Source License
1.1](LICENSE) — **not** an open-source licence. By opening a pull request you
agree that your contribution is licensed under the same BSL 1.1 terms as the
rest of the project, and that ElcanoTek, Inc. may relicense it under the
Change License (MIT) when the Change Date for that version arrives, or under
a commercial licence. There is no separate CLA to sign.

If that does not work for you, please open an issue instead of a PR and we
will find another way to get the fix in. See
[`docs/LICENSING.md`](docs/LICENSING.md) for what BSL does and does not allow.

## Source headers

Every first-party source file carries an SPDX header in its own comment
syntax, after the shebang if there is one:

```go
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.
```

New `.go`, `.ts`, `.tsx`, `.mjs`, `.sh` and `.css` files need it too. Do not
add one to the vendored Flag assets (`frontend/src/styles/design-tokens.css`,
`frontend/src/styles/fonts/`, `frontend/public/design-system/`) — those are
re-synced from the design system, not edited here.

## Setup

Go 1.24+ and Node 18+ (CI runs Node 22).

```bash
git clone https://github.com/ElcanoTek/deal-onboarding.git
cd deal-onboarding
cd frontend && npm install && cd ..
go mod tidy
cp .env.example .env            # never commit a dotenv file
make dev                        # Go API on :8080, Vite on :5173
```

## Tests and checks

CI runs exactly these, and a pull request needs all of them green:

```bash
make fmt vet test                                   # gofmt, go vet, go test, vitest
cd frontend && npx tsc --noEmit && npm test && npm run build
bash -n scripts/*.sh deploy/deal-onboarding-cli     # shell syntax
```

The Go suite runs with `-race` in CI. Neither suite needs a runner, an
OpenRouter key or the network: the runner client is exercised against
`httptest` servers, and LLM handlers return 503 without a key. Keep it that
way — a test that needs credentials is a test nobody runs.

A behaviour change needs a test. Several suites exist because a subtle
invariant broke silently once already; the comments say which.

## Branches, commits and pull requests

- Branch off `main`; `main` is protected and takes changes only via PR.
- Name branches by type: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `ci/…`.
- Write commit subjects as a sentence about the change, in the imperative,
  from the reader's point of view: "Fail closed when a geo exclusion has no
  wire mapping", not "fix geo".
- One topic per PR. Fill in the pull request template and say which suites
  you ran.
- Squash-merge is the default. Dependency bumps arrive via Dependabot
  (`.github/dependabot.yml`); please don't hand-roll them.

## Invariants: do not break these

1. **The runner seam is a contract.** A prompt field, engine tool name, or
   brief field is wire surface. Change the builder,
   `frontend/src/lib/cutlass-contract.json` or `fleet-contract.json`, and
   `contractGolden.test.ts` in the same PR, and run
   `node scripts/check-cutlass-contract.mjs <engine-checkout>`.
2. **Deal naming is pinned byte-for-byte** across Go and TypeScript by
   `internal/validation/testdata/deal_naming_golden.json`. Add a fixture case
   before changing either generator.
3. **Fail closed.** An audit rule that cannot prove a value is safe blocks; it
   does not warn. Silently dropping a targeting rule serves the audience it
   was meant to exclude.
4. **The server-side re-audit is the gate.** The UI audit is advisory. Nothing
   may reach the runner that the handler in `internal/handlers/runner.go` has
   not re-audited, and a submit counts as done only after a 2xx.
5. **No identity in code.** Seat ids, account ids, marketplace names, owner
   ids and customer names never land in the repository — not in fixtures, not
   in tests, not in comments, not in screenshots. Use `Example`, `Northwind`,
   `DataCo`, `DEAL00xxx`.
6. **Design tokens only.** No hardcoded colours, radii, spacing or font
   families in product CSS; see the design-system section of `AGENTS.md`.
   Only Nebula Sans and Hack ship, and nothing loads from a CDN.

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

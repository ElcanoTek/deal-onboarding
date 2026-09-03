# Contributing

Thanks for helping make Deal Onboarding better. This page is the short
version; [`AGENTS.md`](AGENTS.md) is the full developer guide and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains the one place where a
careless change can book a wrong live deal.

## Workflow

1. **Open an issue first** for anything beyond a typo or a small fix, so the
   approach can be agreed before the code exists.
2. Branch from `main`. Keep pull requests focused: one behaviour change per PR.
3. Run the gates locally before pushing:

   ```bash
   make fmt vet test
   cd frontend && npx tsc --noEmit && npm test && npm run build
   ```

4. Fill in the pull request template. CI runs Go fmt/vet/test (with the race
   detector), the frontend typecheck/tests/build, shell and checker syntax, and
   CodeQL.
5. A maintainer reviews; squash-merge is the default.

## What to watch for

- **The runner seam.** A prompt field, engine tool name, or brief field is a
  contract. Change the builder, `cutlass-contract.json`, and
  `contractGolden.test.ts` in the same PR, and run
  `node scripts/check-cutlass-contract.mjs <engine-checkout>`.
- **Deal naming** is pinned byte-for-byte across Go and TypeScript by
  `internal/validation/testdata/deal_naming_golden.json`. Add a fixture case
  before changing either generator.
- **Fail closed.** An audit rule that cannot prove a value is safe should
  block, not warn. Silently dropping a targeting rule serves the audience it
  was meant to exclude.
- **No identity in code.** Seat ids, account ids, marketplace names, owner ids
  and customer names never land in the repository — not in fixtures, not in
  tests, not in comments. Use `Example`, `Northwind`, `DataCo`, `DEAL00xxx`.
- **Design tokens only.** No hardcoded colours, radii, spacing or font
  families; see the design-system section of `AGENTS.md`.

## Dependencies

Dependabot opens grouped weekly PRs for Go modules, npm packages, and GitHub
Actions. Review the changelog of anything that touches the upload path, the
session cookie, or the runner client before merging.

## Licence

By contributing you agree that your contribution is licensed under the
repository's Business Source License 1.1 (see `LICENSE`), converting to MIT on
the Change Date.

## What

<!-- One or two sentences: what changes and why. -->

## Checklist

- [ ] `go build ./... && go vet ./... && go test ./...` pass
- [ ] `cd frontend && npx tsc --noEmit && npm test && npm run build` pass
- [ ] If the change touches a prompt field, tool name, or the brief: `cutlass-contract.json` / `fleet-contract.json` and `contractGolden.test.ts` updated together, and the checker run against an engine checkout
- [ ] If the change touches deal naming: `deal_naming_golden.json` updated and both Go and TS golden suites pass
- [ ] Docs updated (`AGENTS.md`, `docs/`) where behaviour changed
- [ ] No secrets, account ids, customer names, or internal hostnames in the diff

## Screenshots

<!-- For UI changes. -->

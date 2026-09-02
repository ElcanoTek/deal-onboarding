# Publisher Allowlists — "specific publishers only" per SSP

Traders sometimes need a deal to run ONLY on an approved publisher list —
sensitive categories (hunting/firearms, politics) are the driving case. This
doc is the authority on what each SSP supports, how Deal Onboarding expresses
it, and where the safety rails are. Deal Onboarding keeps no publisher
database — the shipped snapshot is advisory only.

## The one surface

Every SSP card has an identical, dedicated **Publishers** section:

- **"Max publishers" toggle, ON by default** — all eligible publishers run
  automatically (the standard setup; byte-identical to the pre-feature wire).
- **Toggle OFF** — the deals run ONLY on a specific list, entered right there:
  drop a file (.xlsx/.csv/.txt of IDs and/or names) or paste the list. Entries
  render as removable chips. Turning the toggle off with an empty list fails
  the audit (`ix_publishers` / `ox_publishers` / `pm_publishers` /
  `mg_publishers`), so a narrowed-but-empty card can never book open.

There is **no publisher database in Deal Onboarding**: every entry is verified
fail-closed against the SSP's live catalog when the deals book — an unknown or
misspelled publisher **blocks the create** with candidates listed, never books
without it. IDs ship verbatim; names resolve server-side where the SSP
supports names.

SSPs whose platform cannot target publisher accounts (Xandr, TripleLift,
Media.net) render the same section with the toggle locked ON and a note naming
the alternative — so every card reads the same and none can pretend to scope.

## Per-SSP wire

| SSP | Toggle OFF ships | Notes |
|---|---|---|
| PubMatic | `publisher_ids` (ints) + `publisher_names` (server-resolved, unioned) | Toggle is the platform's real Max Reach flag (`has_max_reach`); ON may carry `max_allowed_publishers` |
| OpenX | `publisher_ids` (account-id strings, INTERSECTS `targeting.content.account`) | **IDs only** — `ox_publisher_ids` fails name-only entries; mutually exclusive with Excluded Publisher IDs (`ox_publisher_conflict`) |
| Index Exchange | `publisher_ids` (legacyAccountIDs) + `publisher_names` | Names resolve server-side against the live IX catalog |
| Magnite | explicit `publishers:` list (ids bare, names quoted), resolved fail-closed against the live marketplace catalog | Toggle ON = the locked `publishers: "ALL"` opt-in; never mixed (`all_publishers_ambiguous`). CTV Seller IDs ≠ DV+ Account IDs (verified 2026-08-21: both ID spaces ARE the ClearLine DMG publisher ids) |
| Xandr | — (locked ON) | Publisher targets platform-prohibited on Curate; scope via a pre-built Curate deal list (`Advanced → Deal List Names`) |
| TripleLift | — (locked ON) | Scope web inventory with an Include site list (post-create `tl_merge_deal_supply_domains`); app bundles unsupported |
| Media.net | — (locked ON) | Scope web inventory with an Include site list (post-create `medianet_merge_deal_publisher_domains`) |

Domain-level scoping (TL/MN, or Include lists anywhere) is not identical to
publisher-account scoping — one publisher can span many domains.

## The known publisher list (advisory validation)

`catalogs/publisher-catalog.json` is a repo-shipped snapshot of each SSP's
available publishers. **The shipped file is a tiny synthetic placeholder** —
generate your own from an SSP publisher export (one sheet per SSP):

```
node scripts/gen-publisher-catalog.mjs "/path/to/Platform Publisher List.xlsx"
```

Commit the regenerated JSON to refresh it (a code push — there is no runtime
upload). The server loads it at boot (`internal/pubcatalog`,
`DEAL_ONBOARDING_PUBLISHER_CATALOG`, default `./catalogs/publisher-catalog.json`) and
serves it to the form via `GET /api/publisher-catalog`. A missing file turns
the feature off cleanly.

What it powers — all **advisory**, never blocking (the snapshot can lag
reality; booking-time live-catalog verification stays the enforcement):

- **ID auto-fill:** a pasted name matching the list gains its exact id — which
  also makes name-pastes work on OpenX (IDs-only wire).
- **Unknown-entry flags:** chips not on the list show amber "unlisted" with
  the snapshot date; near-miss names get a "did you mean …?" suggestion
  (edit distance ≤ 2).
- **Wrong-SSP-card detection:** when a card's unknown IDs belong to ANOTHER
  SSP's list (the pasted-the-PubMatic-column-into-OpenX failure), a loud
  hint names the list they match. Magnite validates channel-aware: CTV/audio
  deals against the CTV catalog, DV+ channels against DV+.
- **Audit receipt:** the advisory `publisher_known_list` check (appended in
  `evaluateAudit`, so `/api/audit` and the MOC gate agree) reads e.g.
  "OpenX: 22/24 on the known list — not on it: X, Y" with the snapshot date
  and any wrong-card hint.

A flagged entry that books successfully means the snapshot is stale — that's
the signal to re-export and regenerate. Entries are never auto-added.

## Audit rails

- `pm_publishers` / `ix_publishers` / `ox_publishers` / `mg_publishers` —
  toggle OFF requires ≥1 entry; the passing message states the narrowed count
  loudly.
- `ox_publisher_ids` / `ox_publisher_conflict` — OX entries need IDs; include
  and exclude lists can't coexist.
- `allowlist_coverage` — advisory batch check whenever ANY SSP is allowlisted:
  lists each create-SSP's scoping status so one SSP silently running open is
  impossible to miss (the real failure mode for a sensitive-category batch).

All of these run in `evaluateAudit`, so `/api/runner/create` re-enforces them
server-side. Entries are inert while the toggle is ON — prompts never ship
them, and no publisher checks fire.

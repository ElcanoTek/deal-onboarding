# Refreshing the per-SSP IAB catalog fixtures

The seven JSON files under `frontend/src/lib/sspIabCatalogs/` are **live-pulled
SSP category catalogs** (last pull: **2026-07-14**, read-only). They are the
source of truth every IAB/content-category name Deal Onboarding emits is verified
against (`sspIabCatalogs.test.ts` pins every canonical-map target and every
`IAB_OPTIONS` classification against them), and the data layer the per-SSP
picker UI consumes.

This repo holds **no SSP credentials**, so the refresh runs from your engine
environment (the SSP MCPs there already hold per-SSP auth). Never embed
credentials, tokens, or account cookies in this repo or in the fixtures.

## When to refresh

- An SSP renames/adds/removes catalog entries (a live deal fails category
  resolution that the fixtures say should pass, or vice versa).
- Before shipping changes to the canonical maps in
  `frontend/src/lib/dealPromptYaml.ts`.
- Periodically ahead of a release audit.

Catalogs DO drift: the 2026-07-14 IX pull renamed three TV genres vs the
2026-07-10 probe (`Business/Financial` → `Business and financial`,
`Health and Wellness` → `Health and wellness`, `Home and Garden` →
`Home and garden`).

## How each catalog is pulled (read-only)

All pulls run through the engine's per-SSP MCPs from a non-production engine environment
(so the MCPs' own auth/env is used — see your engine's MCP docs for env setup). Record the pull date.

| Fixture | SSP | Source (tool / endpoint) |
|---|---|---|
| `indexexchange-contentGenre.json` | Index Exchange | IX MCP targeting discovery: `ix_list_targeting_keys` → key **11** (`contentGenre`), then `ix_list_targeting_values` for that key. The account/publisher ids are discovered from your own IX account. 94 values. |
| `indexexchange-iabContentCategory.json` | Index Exchange | Same discovery path: `ix_list_targeting_keys` → the account-discovered key **1066** (`iabContentCategory`), then `ix_list_targeting_values`. 385 values. The key id is account-discovered — never hardcode it in emission code. |
| `openx-categories_iab_v2.json` | OpenX | OpenX MCP option-set lookup (the same `optionsByPath` surface `ox_list_iab_categories` resolves against): option path `categories_iab_v2`. 698 values, IAB Content Taxonomy 2.x names + numeric ids. |
| `openx-categories_v1.json` | OpenX | Same surface, option path `categories_v1`. 494 values. **Reference only** — emission always targets the v2 set. |
| `pubmatic-iabCategories.json` | PubMatic | `GET /v1/common/iabCategories` (PubMatic common API, via the PubMatic MCP's session). 392 values; PubMatic-internal numeric `id` (the IAB code is dropped in the normalized fixture). |
| `xandr-content-category-universal.json` | Xandr | `GET /content-category?category_type=universal` (Xandr platform API, via the Xandr MCP's session; paginate to the full set). 802 values. Keep ONLY the label + id in the fixture; the raw rows also carry `type`/`parent_category`, and app-store rows are identifiable by label prefix (`Apple AppStore:`, `Google PlayStore:`, `Windows Store:`) — canonical-map targets must never point at those. |
| `medianet-content-categories.json` | Media.net | Media.net Select API v9 content-categories resource (via the Media.net MCP's session — the same catalog `mn_block_deal_content` excludes resolve against). 392 values; `id` is the IAB 1.x code (`IAB1-1`). Note: the live label for IAB11 literally embeds double quotes (`"Law, Gov't & Politics"`) — keep the bytes as pulled. |

## Normalizing into the fixture shape

Each fixture is checked in as:

```json
{
  "ssp": "<ssp>",
  "key": "<catalog key>",
  "taxonomy": "<one-line taxonomy description>",
  "pulledAt": "YYYY-MM-DD",
  "values": [{ "label": "<exact catalog name>", "id": <id if any> }]
}
```

- `label` is **byte-exact** as returned by the SSP (no trimming beyond JSON
  encoding, no de-quoting, no case changes).
- Drop every other per-value field (`code`, `type`, `parent_category`,
  `iab_code`, duplicate `value`, …) — keep file sizes reasonable.
- Set `pulledAt` to the pull date on every refreshed file.

## After refreshing

1. Update `pulledAt` and, if counts changed, the count pins in
   `frontend/src/lib/sspIabCatalogs.test.ts`.
2. Run `cd frontend && npx vitest run src/lib/sspIabCatalogs.test.ts
   src/lib/dealPromptYaml.test.ts src/lib/contractGolden.test.ts`.
   Failures are the point: they name every canonical-map target /
   `*_IAB_VERIFIED` pin in `frontend/src/lib/dealPromptYaml.ts` that drifted.
   Fix the maps deliberately (never guess a rename — inspect the new catalog),
   then re-run.
3. If IX genre spellings changed, expect emission-golden updates too (the
   genre strings are on the wire).

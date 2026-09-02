# Deal Naming — Canonical Spec

**This document is the authority for the deal names Deal Onboarding
generates.** It descends from a curation desk's naming workbook; two decisions
are **LOCKED**: the **slot vocabulary** (§2) and **multi-DSP expansion** (§6).
The operator-configurable parts are the Curator default (`ORG_NAME`), the
campaign-id prefix (`CAMPAIGN_ID_PREFIX`), and the attribution default
(`DEFAULT_ATTRIBUTION_CODE`).

Implementations (change together, never separately — the shared golden
fixture pins them):

| Layer | File |
|---|---|
| Frontend generator + vocabulary | `frontend/src/lib/dealNameSlots.ts` (single source; `useDealMatrix` re-exports) |
| Server generator (audit + submit gate) | `internal/validation/rules.go` (`generateNamedDeals`) |
| Shared golden fixture | `internal/validation/testdata/deal_naming_golden.json` — read by **both** `internal/validation/deal_naming_golden_test.go` and `frontend/src/lib/deal_naming_golden.test.ts` |

## 1. The 12 slots

```
{Curator}_{SSP}_{DSP}_{Agency}_{Brand}_{DataPartner}_{Segment}_{Channel}_{Inventory}_{Geo}_{CampaignID}_{Attribution}
```

Twelve slots joined by `_`. A **generated** name always has exactly 12 slots —
the audit's `qa_naming_template` check asserts this for generated names and
overrides alike.

| # | Slot | Kind | Source / rule |
|---|---|---|---|
| 1 | Curator | value* | Data partner (sanitized) if set, else `ORG_NAME` (default `Curator`) |
| 2 | SSP | label | LOCKED vocabulary, §2 |
| 3 | DSP | label | LOCKED vocabulary, §2; unknown DSPs pass through sanitized |
| 4 | Agency | value | sanitized; fallback `Agency` |
| 5 | Brand | value | sanitized; fallback `Brand` |
| 6 | DataPartner | label | **literal `NA`** whenever the data partner IS the curator or is unset — i.e. always today. The partner must NEVER appear in both slot 1 and slot 6 (e.g. curator `Partner` ⇒ DataPartner `NA`). Reserved for a future secondary data overlay. |
| 7 | Segment | value | the deal's audience/theme, sanitized; fallback `Audience` |
| 8 | Channel | label | `Display`, `OLV`, `CTV`, `OTT`, `Native`, `Audio` (`"OLV (Online Video)"` → `OLV`). Known values normalize; unrecognized values fail the `channel_code` audit check (the name path sanitizes them). Fallback `Channel`. |
| 9 | Inventory | label | `All` \| `In-app` \| `Web` (workbook truth — **not** `InApp`/`Web Only`). Known form values normalize; unrecognized values fail the `inventory_code` audit check. |
| 10 | Geo | value | **first state** if any state entry is set, else first country (uppercased), else `Global`. zip/dma entries never reach the name. SSP-AWARE: on SSPs with no include-state wire — Index Exchange and Media.net — state entries are skipped (first country, else `Global`), so the name never claims a state the create cannot target. |
| 11 | CampaignID | value | **required** (`<PREFIX>#####`, default prefix `DEAL`). The audit fails `campaign_id` when blank — nothing mints a random id. Previews show the `<PREFIX>#####` placeholder. |
| 12 | Attribution | value | sanitized; default `DEFAULT_ATTRIBUTION_CODE` (`A1`) |

\* Curator is the sanitized data-partner value when one is entered, else the
sanitized `ORG_NAME`.

Example:

```
DataCo_Index_Yahoo_Soundwave_SNAP_NA_SNAP proxy users_Display_All_US_DEAL00174_B14
```

## 2. Slot vocabulary (LOCKED)

**SSP slot codes** — the legacy `IX`/`PM`/`MN`/`XN`/`TL`/`MG` abbreviations
are retired from emission (parsers still accept them, §8):

| SSP | Slot code |
|---|---|
| Index Exchange | `Index` |
| OpenX | `OpenX` |
| PubMatic | `Pubmatic` |
| Magnite | `Magnite` |
| Xandr | `Xandr` |
| Media.net | `Media.net` |
| TripleLift | `TripleLift` |

**DSP slot codes** — the `AMZN`/`YAHOO`/`MM`/`ADL`/`BSW` abbreviations are
retired; unknown DSP names pass through sanitized (nothing invents a code):

| DSP | Slot code |
|---|---|
| The Trade Desk | `TTD` |
| The Trade Desk - RTB | `TTD` |
| DV360 | `DV360` |
| Amazon DSP | `Amazon` |
| Yahoo DSP | `Yahoo` |

**Data partner:** free text, sanitized like any value slot — there is no
built-in partner code table. Enter the code you want to see in slot 1.

All vocabulary lookups are **case- and whitespace-insensitive** on input.

## 3. Value-slot sanitization

Value slots (Curator-when-freeform, Agency, Brand, Segment, Attribution) keep
**`[A-Za-z0-9 .-]`** — **spaces are PRESERVED** inside slots (matching the workbook and historical booked names:
`SNAP proxy users` stays spaced):

- ALL Unicode whitespace (NBSP, tabs, NEL, BOM, …) normalizes to a **single
  ASCII space**; runs collapse and the ends trim. The Go/TS implementations
  are byte-identical (an ASCII-only `noSpaces` once diverged from the TS
  regex and 422'd the submit gate with `audit_brief_mismatch`);
- underscores go (dropped, not spaced) — so a value like brand `Sun_Bum`
  (→ `SunBum`) can never shift slot positions into a 13-slot name;
- everything else outside the charset (punctuation, symbols) is dropped;
- a slot left empty **after** sanitization takes its documented fallback —
  never a double underscore.

Label slots come from the vocabulary tables verbatim.

Additional shared rules (byte-identical in Go and TS — the gate invariant):

- **Input trimming** strips the UNION whitespace class — everything in Go's
  `unicode.IsSpace` **plus** U+0085 (NEL) **plus** U+FEFF (BOM). Go's
  `TrimSpace` and JS's `trim()`/`\s` disagree on NEL and BOM; a pasted BOM in
  a free-text field (campaign id, DSP name) must not make the generators
  diverge. Applied to campaign ids, overrides, DSP rows, geo values, and all
  vocabulary lookup keys.
- **Uppercasing is ASCII-only** (`[a-z]` → `[A-Z]`; everything else is left
  for the sanitizer). Unicode-aware uppercasing diverges between languages
  (JS `"ß".toUpperCase()` → `"SS"`, Go keeps `ß`), so `Großbritannien` →
  `GROBRITANNIEN` in both.
- **Control characters are rejected**: a final deal name containing any rune
  below U+0020, or U+007F/U+0085/U+FEFF (only a `nameOverride` can carry
  them), fails the `deal_name_charset` audit check. `quote()` in the prompt
  writer escapes them as defense-in-depth, but the submit gate's
  prompt-binding matches raw names — failing early at `/api/audit` is the
  honest behavior.

## 3b. Name-length ceilings (per SSP)

The `deal_name_length` audit check fails an over-long name up front instead of
letting it die mid-batch at the SSP API (verified against the engine MCPs +
vendor docs):

| SSP | Max name length | Source |
|---|---|---|
| Index Exchange | **255** | IX API rejects >255; enforced in the IX MCP (create + update) |
| Xandr | **255** | enforced in the Xandr MCP |
| Media.net | **255** | `display_name` 1–255 in the MN MCP (cutlass#747 lifted the old 30-char create guard; the prompt ships the canonical name as `display_name`; the separate `deal_id` slug stays ≤30) |
| PubMatic | **250** | PubMatic UI name cap (2026-08). The old 64-char worry was the retired name-derived dealId — creates omit dealId and PubMatic mints `PM-XXXX-NNNN` |
| OpenX | none documented | no MCP or vendor-doc cap found; note the auto `Package for {deal: <name>} [<ts>]` package name runs ~45 chars longer than the deal name |
| Magnite ClearLine | none documented | the ClearLine API guide's field-constraint table has no `name` length entry |
| TripleLift | none documented | name passes through unvalidated |

## 4. Documented deviations from the workbook

> The workbook once stripped the spaces it kept in value slots
> (`SNAP proxy users` → `SNAPproxyusers`); that deviation was REVERSED:
> spaces are valid in deal names. Slot parsing splits on `_`, so spaces inside
> a slot never ambiguate slot positions. Deal ids are unaffected (the Media.net
> deal-id slug maps spaces to `_`).

## 5. Multi-DSP expansion (LOCKED)

**Total deals = Audiences × Channels × SSPs × DSPs.**

- The active DSPs are all `dsps[]` rows with a name when the *multiple DSPs*
  toggle is on, else only the first row.
- Each selected DSP yields **its own deal** carrying that DSP's slot-3 code
  and **that DSP's seat id** in `prompt_inputs` (rule 16: a seat per DSP).
- Expansion is deal-major, DSP-minor, and applies everywhere at once: the
  audit (`total_deals`, `deal_names`, QA report), the deal-matrix preview,
  the batch prompt, the typed `critical_actions`, the structured brief
  (create **and** sheet-only rows). The `/api/runner/create` gate compares
  these sets 1:1.
- A deal with a `nameOverride` is a single, already-named deal — it does
  **not** expand.
- **Sheet-only rows never expand either**: a `sheetOnly` deal already exists
  from a previous (possibly pre-expansion) batch, so fabricating per-DSP
  "already created" names would put deals that never existed on the client
  deal-sheet email. A sheet-only row contributes exactly **one** name/pair on
  its first active DSP. **Follow-up batches should carry the recorded deal
  name as `nameOverride`** — that is the name the deal was actually booked
  under.
- **Known limitation — one deal per DSP slot code**: two DSP rows that
  resolve to the same slot code (e.g. `The Trade Desk` + `The Trade Desk -
  RTB`, both `TTD`) would generate identical names, so the audit fails
  `qa_duplicate_deals` naming the shared code. Run separate batches (or set
  distinct DSPs) to create the same deal on two seats of one DSP.

## 6. Name overrides

A deal may carry a `nameOverride`. It rides **verbatim** — the generators never
rewrite a hand-entered name — and the deal does not expand across DSPs. The
`attribution_slot` audit rule requires a full 12-slot override's last slot to
match the form's attribution code, and `deal_name_charset` rejects control
characters an override could smuggle in.

## 7. Parsing (accept both, emit only the new)

The `/api/parse-deal` system prompt (`internal/handlers/parse.go`) recognizes
the LOCKED vocabulary **and** tolerates the legacy `IX`/`PM`/`MN`/`XN`/`TL`/`MG`
codes for names already booked. Lookups are case-insensitive. Only the new
vocabulary is ever emitted.

## 8. Golden fixture

`internal/validation/testdata/deal_naming_golden.json` holds fictional cases
(a data-partner curator, a verbatim full-name override, the NBSP/tab Go↔TS
byte-parity case, an underscore-bearing brand, mixed geo, multi-DSP, the full
SSP vocabulary sweep, inventory normalization, …) built on the default
`Curator` / `DEAL` / `A1` operator settings. **Both** test suites read
this one file; add new naming behavior there first.

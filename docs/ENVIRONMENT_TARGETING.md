# Environment Targeting — per-SSP mapping

The deal card's **Environment** field (`inventoryType`: `All` | `Web Only` |
`In-App`) declares which inventory environments a deal may serve into. This
document is the authority for how that selection reaches (or fails to reach)
each SSP's wire. It exists because a silently widened environment once shipped
In-app deals with Web included.

**Invariant: the Environment selection is NEVER silently discarded.** An SSP
either receives it on the wire, or the prompt carries a loud
`# NOT SUPPORTED on <SSP>: Environment …` marker (helper
`environmentNotSupportedLines` in `dealPromptYaml.ts`) so the agent reports it
as NOT APPLIED. `All` needs no wire anywhere.

| SSP | Wire | All | Web Only | In-App |
|---|---|---|---|---|
| **Index Exchange** | `inventory_channels` → inventoryChannel key 272 (cutlass#872) | omit → deal_type default (display/olv/**ott** → App+Site, ctv → App) | `[Web]` → `["Site"]` | `[In-App]` → `["App"]` — preserved verbatim, never widened |
| **PubMatic** | `platforms` (deal-level enum) | `[1,2,4,5]` | `[1,2]` (Desktop + Mobile Web) | `[4,5]` (App iOS + App **Android** — `[4]` alone was iOS-only, fixed 2026-08-11) — OTT no longer pins, so it resolves from Environment exactly as OLV does (cutlass#898) |
| **Media.net** | `environments` (Web \| MobileApp \| CTV) | `[Web, MobileApp]` | `[Web]` | `[MobileApp]` ⚠ MCP then requires `app_platform` (`missing_app_platform` blocker) — open follow-up. A **CTV** channel ships `[CTV]` regardless: its devices exist only in that environment (cutlass#898) |
| **OpenX** | **OTT only** — `rendering_context.distribution_channel` now takes a caller override (cutlass#898); DISPLAY/OLV/NATIVE still derive it from `targeting.channel` | OTT `"WEB,APP"` | OTT `"WEB"`, others loud marker | OTT `"APP"`, others loud marker |
| **Xandr** | none — no `supply_type_targets` in the MCP; device axis has no web/app dimension | — | loud marker | loud marker |
| **Magnite** | **Streaming only** — web/app is encoded in the DEVICE values (`Mobile In-app` vs `Mobile Web`), so Inventory Type ships as `environment` and selects the device set (cutlass#898). DV+ has no such distinction | full device set | drops the In-app variants | drops the Web variants; `Computer` too (no desktop app) |
| **TripleLift** | none — no environment leaf; `channel` (WEB/CTV) is batch-level config | — | loud marker | loud marker |

## How environment interacts with device & format per SSP

- **Index Exchange** — three sibling keys set by `deal_type`, all defaults,
  each preserved verbatim when explicit (DeviceType since issue #713,
  inventoryChannel since cutlass#872): DeviceType (key 3: display/olv/ott →
  PC+Phone+Tablet, ctv → CTV+Connected device+STB),
  inventoryChannel (key 272: display/olv/ott → App+Site, ctv → App-only), and
  creativeTypeSize (key 10: Banner_ANY vs Video_ANY).
- **OpenX** — `rendering_context` combines Format (BANNER/VIDEO from channel),
  distribution_channel (above), and devices; CTV forces APP even against
  caller input. OTT no longer does (cutlass#898).
- **PubMatic** — `platforms` is the ONLY real control (the wire `deviceTypes`
  field is sent but not persisted by PubMatic). CTV channel overrides the
  environment entirely (`[7]`); OTT does not override at all.
- **Magnite** — the environment axis doesn't exist; DV+ formats ride
  `mg_sizes` (per-channel catalogs), CTV rides SpringServe.
- **Xandr** — device defaults by channel (display/olv → desktop+phone+tablet,
  ctv → TV devices, ott → phone+tablet); no web/app axis.
- **TripleLift** — `commercializedFormats` follows the deal channel; the
  supply axis is domain-level (`EB_SUPPLY_DOMAIN_ID`), not environment.

## Follow-ups (not yet wired)

1. **OpenX** — the MCP has the right construct (`distribution_channel`); a
   caller override param (mirroring IX `inventory_channels`) would make
   Web-only / In-app-only DISPLAY/OLV deals expressible.
2. **Media.net In-App** — Deal Onboarding emits `environments: [App]` correctly, but
   the MCP blocks App-only deals without `app_platform`, which Deal Onboarding never
   collects/emits — every Media.net In-App deal fails at prepare (loud).
3. **Xandr** — honoring the environment needs `supply_type_targets` support
   in the Xandr MCP (new work, deferred under the fleet migration).

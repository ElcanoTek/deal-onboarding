// Frontend model-slug constants — ported from fleet
// (web/src/app/lib/modelAliases.ts). The product's blessed slugs live here
// as named constants; no env plumbing required.
//
// There are no user-facing "default"/"advanced" aliases — the picker pins
// two rows by their real display names. What remains is two ROLE slots:
//   - DEFAULT_MODEL — what the composer starts on (shown with the
//     "recommended" pill in the picker)
//   - ADVANCED_MODEL — the stronger escalation target (also pinned)
//
// Beyond the two pinned slots we classify every other slug as either
// "tested" (validated end-to-end against Deal Onboarding's chat/import/parse
// prompts) or "experimental" (anything else the user picks or types in).
//
// Keep the slugs in sync with the server-side mirror
// (internal/handlers/models_catalog.go → defaultChatModel /
// advancedChatModel) and with fleet's modelAliases.ts.
//
// Pinned slugs are EXACT model versions — deliberately NOT the `~`-prefixed
// OpenRouter floating aliases: fleet root-caused (2026-06-04) that the `~`
// sigil defeats send-side reasoning reconstruction, dropping thinking
// signatures across tool loops. Trade-off: lab refreshes require bumping
// these constants — and their server-side mirrors — by hand.

export const DEFAULT_MODEL = 'z-ai/glm-5.2'
export const DEFAULT_MODEL_LABEL = 'Z.AI: GLM 5.2'

export const ADVANCED_MODEL = 'openai/gpt-5.6-sol'
export const ADVANCED_MODEL_LABEL = 'OpenAI: GPT-5.6 Sol'

// TIER_MODELS is the ordered list the picker pins to the top of the
// dropdown when no search query is active. Rows render their display
// names; the picker adds the "recommended" pill.
export const TIER_MODELS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: DEFAULT_MODEL, label: DEFAULT_MODEL_LABEL },
  { slug: ADVANCED_MODEL, label: ADVANCED_MODEL_LABEL },
]

// TESTED_MODELS lists slugs validated end-to-end against Deal Onboarding's chat,
// import, and parse prompts but not pinned to the top of the picker —
// the previous hardcoded catalog earns this badge. Anything not here and
// not pinned is "experimental": it should work, but we haven't checked.
const TESTED_MODELS: ReadonlySet<string> = new Set([
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.4',
])

// ModelTier keys are INTERNAL badge categories (the visible pill for the
// two pinned rows reads "recommended"); "default"/"advanced" survive as
// key names only to keep the badge plumbing stable.
export type ModelTier = 'default' | 'advanced' | 'tested' | 'experimental'

// labelForModel returns the display name for a pinned slug, or the raw
// slug otherwise — the picker chip shows real model names, never aliases.
export function labelForModel(slug: string): string {
  if (slug === DEFAULT_MODEL) return DEFAULT_MODEL_LABEL
  if (slug === ADVANCED_MODEL) return ADVANCED_MODEL_LABEL
  return slug
}

// tierForModel classifies a slug into a UI badge category. Pinned slugs
// get their slot key (rendered as the "recommended" pill); everything
// else is "tested" or "experimental".
export function tierForModel(slug: string): ModelTier {
  if (slug === DEFAULT_MODEL) return 'default'
  if (slug === ADVANCED_MODEL) return 'advanced'
  if (TESTED_MODELS.has(slug)) return 'tested'
  return 'experimental'
}

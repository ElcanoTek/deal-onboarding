// Magnite DV+ ad-format catalog data layer (mirrors the sspIabCatalogs
// pattern). The JSON fixture under magniteAdFormats/ is the LIVE-PULLED
// ClearLine format metadata (read-only GET /api/v1/metadata/ad-formats via
// magnite_list_ad_formats, 2026-08-21) and is the source of truth for every
// `sizes:` id Deal Onboarding can emit on a Magnite DV+ deal — the deal-card picker
// offers exactly this catalog, so an id the API would 422 is impossible to
// select. Deal Onboarding has no SSP credentials (front-door boundary), so the
// catalog ships as a committed fixture; to refresh, re-run the read-only pull
// against any DV+ marketplace and regenerate the JSON (same runbook idiom as
// scripts/refresh-iab-catalogs.md).
//
// Before this layer existed, the picker offered a curated 13-size subset of
// the 478 Display formats — 465 live display sizes were impossible to book
// through the form (the "change ad sizes to dropdown, include all available
// sizes" bug, 2026-08-21).

import catalog from './magniteAdFormats/magnite-ad-formats.json'

export interface MagniteAdFormat {
  id: number
  name: string
  /** ClearLine format family. One family per deal; Audio deals use feedTypes,
   *  not sizes, so Audio formats never reach the picker. */
  format: 'Display' | 'Native' | 'Video' | 'Audio'
  width?: number | null
  height?: number | null
}

export const MAGNITE_AD_FORMAT_CATALOG: MagniteAdFormat[] = (
  catalog as { formats: MagniteAdFormat[] }
).formats

/** Magnite's deal-create constraint: at most 15 sizes per DV+ deal (and one
 *  format family — enforced upstream by the channel → family mapping). */
export const MAGNITE_SIZES_MAX = 15

/** Picker label: dimensions appended whenever the format carries them —
 *  required for uniqueness (the catalog has several formats sharing a name,
 *  e.g. multiple "Custom Horizontal" rows differing only by size). */
export function magniteFormatLabel(f: MagniteAdFormat): string {
  return f.width && f.height ? `${f.name} — ${f.width}×${f.height}` : f.name
}

function pickerOptions(family: MagniteAdFormat['format']): { id: number; label: string }[] {
  return MAGNITE_AD_FORMAT_CATALOG.filter(f => f.format === family).map(f => ({
    id: f.id,
    label: magniteFormatLabel(f),
  }))
}

/** Full DV+ catalogs by family — 1:1 with what the create API accepts. */
export const MAGNITE_DISPLAY_FORMAT_OPTIONS = pickerOptions('Display')
export const MAGNITE_VIDEO_FORMAT_OPTIONS = pickerOptions('Video')
export const MAGNITE_NATIVE_FORMAT_OPTIONS = pickerOptions('Native')

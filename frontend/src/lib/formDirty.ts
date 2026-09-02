import { FormData } from '../types/deal'

/** Mirrors the server's create-draft viability guard: a form carrying some
 *  campaign identity or at least one started deal represents real trader work.
 *  Used both to gate saving (a blank form gets a toast instead of
 *  an empty queue row) and to warn before actions that would overwrite the
 *  workspace form (promote, parse-replace) — the DEAL07290 loss, 2026-08-17. */
export function formWorthSaving(form: FormData): boolean {
  return !!(
    form.brand.trim() || form.agency.trim() ||
    form.campaignName.trim() || form.campaignId.trim() ||
    form.deals.some(d => d.theme.trim() || d.channel)
  )
}

/** Short human label for the build at risk of being overwritten, so the
 *  warning names WHICH work would be lost ("DEAL07290 — Uncommon Schools"). */
export function formOverwriteLabel(form: FormData): string {
  const bits = [form.campaignId.trim(), form.brand.trim() || form.campaignName.trim()].filter(Boolean)
  return bits.join(' — ') || 'an unsaved build'
}

import { useCallback, useSyncExternalStore } from 'react';
import { DealEntry, FormData, GeoEntry, GeoType, DEFAULT_FORM, migrateCampaignGeoDefaults, migrateCampaignIabCategories, migrateCampaignLanguage, newDeal } from '../types/deal';
import { EMAIL_RE } from '../lib/sectionStatus';
import { splitEmails } from '../lib/recipients';

const STORAGE_KEY = 'deal-onboarding-form-state-v1';

const GEO_TYPES: GeoType[] = ['country', 'state', 'zip', 'dma'];

/** Normalize a stored geo list to the typed {type, value} shape. Saves from
 *  before the per-SSP geo change hold the legacy {country, state} shape; left
 *  as-is they crash render paths that read g.value. A legacy entry can carry
 *  both country and state, so it expands into one typed entry per field. */
function hydrateGeoList(raw: unknown): GeoEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoEntry[] = [];
  let n = 0;
  const mkId = (existing?: unknown): string =>
    typeof existing === 'string' && existing ? existing : `g-${Date.now()}-${(n++).toString(36)}`;
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const rec = g as Record<string, unknown>;
    // Already the new shape.
    if (typeof rec.type === 'string' && GEO_TYPES.includes(rec.type as GeoType) && typeof rec.value === 'string') {
      out.push({ id: mkId(rec.id), type: rec.type as GeoType, value: rec.value });
      continue;
    }
    // Legacy {country, state}.
    const country = typeof rec.country === 'string' ? rec.country.trim() : '';
    const state = typeof rec.state === 'string' ? rec.state.trim() : '';
    if (country) out.push({ id: mkId(rec.id), type: 'country', value: country });
    if (state) out.push({ id: mkId(), type: 'state', value: state });
  }
  return out;
}

/** Normalize a deal loaded from storage so old saves don't crash on
 *  schema changes (e.g. the typed geo model, removed sub-theme). */
function hydrateDeal(raw: unknown): DealEntry {
  const base = newDeal();
  if (!raw || typeof raw !== 'object') return base;
  const rec = raw as Partial<DealEntry>;
  return {
    ...base,
    ...rec,
    geoInclude: hydrateGeoList(rec.geoInclude),
    geoExclude: hydrateGeoList(rec.geoExclude),
  };
}

/** Reset stale seeded format defaults to the new empty = auto state.
 *
 *  Pre-2026-07 forms were seeded with pre-checked PubMatic Banner/Desktop and
 *  Media.net Banner values, which suppress the channel-derived fallbacks in
 *  the prompt builders (an untouched CTV batch emitted Banner/Desktop). Only
 *  the EXACT old seeded values migrate — any other selection is a deliberate
 *  trader choice and is kept. */
function migrateSeededFormatDefaults(form: FormData): FormData {
  let next = form;
  const pm = next.pubmaticConfig;
  const pmSeededFormats = pm.adFormats.length === 1 && pm.adFormats[0] === 'Banner (3)';
  const pmSeededPlatforms = pm.platforms.length === 1 && pm.platforms[0] === 'Desktop (1)';
  if (pmSeededFormats || pmSeededPlatforms) {
    next = {
      ...next,
      pubmaticConfig: {
        ...pm,
        adFormats: pmSeededFormats ? [] : pm.adFormats,
        platforms: pmSeededPlatforms ? [] : pm.platforms,
      },
    };
  }
  if (next.medianetConfig.adFormat === 'Banner (0)') {
    next = { ...next, medianetConfig: { ...next.medianetConfig, adFormat: '' } };
  }
  return next;
}

/** Applied standard-list ids must be registry ids — but LLM-authored drafts
 *  have leaked ad-hoc UPLOAD ids into these arrays (an attachment id in
 *  appliedAppBundleListIds failed the /api/runner/create standard-list gate on
 *  every retry, and the chips/summary — which resolve against the live
 *  registry — showed nothing to remove). Drop any applied id that matches an
 *  attached upload's id: that file already rides domainLists/appBundleLists +
 *  per-deal picks, so the entry is pure poison. Non-file stale ids stay (they
 *  are harmless — collectSubmitListIds and the prompt builders both resolve
 *  applied ids against the registry). */
function scrubAppliedListIds(applied: unknown, files: Array<{ id?: string }>): string[] {
  if (!Array.isArray(applied)) return [];
  const fileIds = new Set(files.map(f => f?.id).filter(Boolean));
  return applied.filter((id): id is string => typeof id === 'string' && !fileIds.has(id));
}

/** Merge a stored/partial form onto DEFAULT_FORM, hydrating nested config
 *  objects + deals so older saves load cleanly. Exported so the Deal Assistant
 *  can hydrate an LLM-authored form the same way. */
export function hydrateForm(parsed: Partial<FormData> | null | undefined): FormData {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_FORM };
  // Scrub the retired campaign-level viewability default. It's not read by
  // any prompt code anymore, but the raw spread below would keep round-
  // tripping a stale persisted '70' (localStorage) into the
  // form JSON the deal chat sends the LLM verbatim — which could copy it
  // back into per-deal targets. Same class of scrub as
  // migrateSeededFormatDefaults, applied at the single hydration funnel.
  // Copy first — callers own their objects.
  parsed = { ...parsed };
  delete (parsed as Record<string, unknown>).defaultViewabilityTarget;
  // Scrub recipient tokens that can never pass validation. The pre-#379
  // session prefill stamped the admin account's literal "admin" identity into
  // dealSheetRecipient, and every persistence layer (localStorage form,
  // chat-authored forms) kept round-tripping it back into
  // fresh forms. Scrubbing only at workspace mount missed drafts loaded
  // after mount — this funnel is the one place every saved form passes.
  if (typeof parsed.dealSheetRecipient === 'string' && parsed.dealSheetRecipient) {
    parsed.dealSheetRecipient = splitEmails(parsed.dealSheetRecipient).filter(a => EMAIL_RE.test(a)).join(', ');
  }
  return migrateSeededFormatDefaults(migrateCampaignLanguage(migrateCampaignIabCategories(migrateCampaignGeoDefaults({
    ...DEFAULT_FORM,
    ...parsed,
    ixConfig: { ...DEFAULT_FORM.ixConfig, ...(parsed.ixConfig || {}) },
    openxConfig: { ...DEFAULT_FORM.openxConfig, ...(parsed.openxConfig || {}) },
    pubmaticConfig: { ...DEFAULT_FORM.pubmaticConfig, ...(parsed.pubmaticConfig || {}) },
    medianetConfig: { ...DEFAULT_FORM.medianetConfig, ...(parsed.medianetConfig || {}) },
    xandrConfig: { ...DEFAULT_FORM.xandrConfig, ...(parsed.xandrConfig || {}) },
    tripleliftConfig: { ...DEFAULT_FORM.tripleliftConfig, ...(parsed.tripleliftConfig || {}) },
    magniteConfig: { ...DEFAULT_FORM.magniteConfig, ...(parsed.magniteConfig || {}) },
    reportingLabels: { ...DEFAULT_FORM.reportingLabels, ...(parsed.reportingLabels || {}) },
    defaultGeoInclude: hydrateGeoList(parsed.defaultGeoInclude),
    defaultGeoExclude: hydrateGeoList(parsed.defaultGeoExclude),
    appliedDomainListIds: scrubAppliedListIds(parsed.appliedDomainListIds, [...(parsed.domainLists || []), ...(parsed.appBundleLists || [])]),
    appliedAppBundleListIds: scrubAppliedListIds(parsed.appliedAppBundleListIds, [...(parsed.domainLists || []), ...(parsed.appBundleLists || [])]),
    deals: Array.isArray(parsed.deals) ? parsed.deals.map(hydrateDeal) : [],
  }))));
}

function loadFromStorage(): FormData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return hydrateForm(JSON.parse(raw) as Partial<FormData>);
  } catch (err) {
    // Corrupt storage falls back to a blank form — surface why, so a trader
    // reporting "my saved form vanished" has a diagnosable trail.
    console.warn('deal-onboarding: discarding unreadable saved form state', err);
  }
  return { ...DEFAULT_FORM };
}

// ---------------------------------------------------------------------------
// Shared external store.
//
// The form is a single module-level singleton, not per-component state, so
// every consumer (the builder sections, the Deal Assistant dock) sees the SAME
// form and writes are synchronous — no persist-on-effect race.
// ---------------------------------------------------------------------------

let currentForm: FormData = loadFromStorage();

const listeners = new Set<() => void>();
function emit() { listeners.forEach(l => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

function persistForm(form: FormData) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form)); } catch { /* ignore */ }
}

export function setFormState(next: FormData) {
  currentForm = next;
  persistForm(next);
  emit();
}

export function resetFormState() {
  currentForm = { ...DEFAULT_FORM };
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  emit();
}

type FormUpdater = FormData | ((prev: FormData) => FormData);

export function useFormState() {
  const form = useSyncExternalStore(subscribe, () => currentForm, () => currentForm);

  const setForm = useCallback((next: FormUpdater) => {
    const value = typeof next === 'function' ? (next as (p: FormData) => FormData)(currentForm) : next;
    setFormState(value);
  }, []);

  const update = useCallback(<K extends keyof FormData>(key: K, value: FormData[K]) => {
    setFormState({ ...currentForm, [key]: value });
  }, []);

  const reset = useCallback(() => resetFormState(), []);

  return { form, update, setForm, reset };
}


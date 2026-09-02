import { ReactNode, useEffect, useRef, useState, type JSX } from 'react'
import { FormData, PubMaticConfig, PublisherAllowlistEntry, effectivePubMaticPublisherEntries, BuyerEntry, OpenXConfig, MagniteConfig, MAGNITE_PRICE_TYPES, magnitePriceTypeHasFloor, sspsInUse } from '../types/deal'
import { PublisherScope } from './PublisherScope'
import { FormSection } from './FormSection'
import { xandrInsertionOrderNames } from '../lib/xandrInsertionOrders'

// =============================================================================
// SSP Configuration — one uniform panel per SSP in use.
//
// Every panel follows the same skeleton: the one or two fields a trader must
// confirm per batch sit at the top; everything with a safe default folds into
// a single "Advanced" disclosure. Helper text is one short generic line per
// field, or none. Field ids are load-bearing (audit "Fix →" jumps resolve to
// them via sectionStatus.ts ELEMENT_ID) — keep them stable.
// =============================================================================

// Custom IX accounts the user has added — persisted in localStorage so they
// survive across sessions and are selectable from the Account dropdown.
const IX_CUSTOM_ACCOUNTS_KEY = 'deal-onboarding-ix-custom-accounts'

interface IxAccount { id: string; name: string }

function loadCustomIxAccounts(): IxAccount[] {
  try {
    const raw = localStorage.getItem(IX_CUSTOM_ACCOUNTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter(a => a && typeof a.id === 'string' && typeof a.name === 'string')
  } catch { /* ignore */ }
  return []
}

function persistCustomIxAccounts(accs: IxAccount[]): void {
  try { localStorage.setItem(IX_CUSTOM_ACCOUNTS_KEY, JSON.stringify(accs)) } catch { /* ignore */ }
}

// PubMatic ad-format enum (cutlass#727, live-verified): Banner=3, Video=13.
// 'Video (12)' was a legacy value PubMatic rewrote to 13 server-side, and
// 'Native (13)' was a mislabel (13 IS Video — it booked live VIDEO deals);
// the true Native id is vendor-blocked (cutlass#754), so Native is not
// offered. Persisted 'Video (12)' picks still resolve to 13 via the
// PUBMATIC_AD_FORMAT_ID alias in dealPromptYaml.ts.
const PM_AD_FORMATS = ['Banner (3)', 'Video (13)', 'Native (12)']
const PM_PLATFORMS = ['Desktop (1)', 'Mobile Web (2)', 'Mobile App (4)', 'Mobile App Android (5)', 'CTV (7)']
// TripleLift commercialized-format enum values (uppercase, per the SSP API).
const TL_FORMATS = [
  'BRANDED_VIDEO', 'DISPLAY', 'IMAGE', 'INSTREAM', 'OUTSTREAM',
  'CAROUSEL', 'CINEMAGRAPH', 'COLLECTION', 'HIGH_IMPACT_DISPLAY',
  'L_BAR', 'PAUSE_AD', 'SCROLL', 'SPLIT_SCREEN', 'SPOTS',
  'VERTICAL_VIDEO', 'WINDOW',
]
const OX_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP']
// cutlass#766: PRIVATE_AUCTION is deliberately NOT offered — it is not creatable
// via the OpenX API (dealCreate requires open_auction_access, a field absent
// from the create schema, so every attempt dies with an opaque
// INTERNAL_SERVER_ERROR). A persisted/parsed PRIVATE_AUCTION value renders as a
// disabled option and is hard-blocked by the ox_pmp_type audit rule + the
// prompt builder's # BLOCKED marker.
const OX_PMP_DEAL_TYPES = ['PREFERRED_DEAL', 'PROGRAMMATIC_GUARANTEED']

// OpenX "Expected Sensitive Category" enum — the platform's full catalog
// (trader-supplied from the OpenX UI, 2026-08-17). This is a MANUAL
// post-create step: the OpenX partner API does not expose the field
// (verified 2026-08-17 — dealCreate rejects it, dealById never returns it;
// it lives only on the UI's internal API), so a set value renders as a
// post_create_ui_fix reminder on every OpenX deal + a QA-checklist item,
// never as an MCP create arg. Labels match the platform's spelling exactly
// so the trader can pick the same value in the OpenX UI.
const OX_SENSITIVE_CATEGORIES = [
  'Alcohol',
  'Cannabis & Cannabis Products',
  'Gambling (Online)',
  'Government',
  'Healthcare',
  'Intimate Apparel',
  'Legal',
  'Lotteries (state-sponsored)',
  'Pharmaceutical',
  'Politics',
  'Religion',
  'Sexual Health',
  'Software',
  'Tobacco & Smoking Products',
]

interface Props {
  form: FormData
  update: <K extends keyof FormData>(key: K, val: FormData[K]) => void
  /** Backend audit failures keyed by fieldPath (e.g. "ixConfig.accountId").
   *  Panels read their own slice off this map to surface red outlines + inline
   *  error text. */
  formIssues?: Record<string, string>
}

interface SectionProps extends Props {
  open?: boolean
  onToggle?: (next: boolean) => void
  filled?: number
  total?: number
  issues?: number
}

/** The shared "everything with a safe default" disclosure — one per panel.
 *  Rendered as the canonical flag +/− accordion (.mini-accordion). `forceOpen`
 *  pops the disclosure whenever a contained field has a live or audit error,
 *  so red outlines and the audit "Fix →" jump stay visible — the trader can
 *  still collapse it afterwards. */
function AdvancedOptions({ forceOpen, children }: { forceOpen?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement | null>(null)
  useEffect(() => {
    if (forceOpen && ref.current) ref.current.open = true
  }, [forceOpen])
  return (
    <details ref={ref} className="mini-accordion">
      <summary className="mini-accordion__summary">Advanced</summary>
      <div className="mini-accordion__body">{children}</div>
    </details>
  )
}

/** Comma-separated list input that edits as free text and commits the parsed
 *  list on blur — a controlled join(', ') value would eat the comma the
 *  moment it is typed. */
function CommaListInput({ id, value, placeholder, onCommit }: {
  id: string
  value: string[]
  placeholder?: string
  onCommit: (next: string[]) => void
}) {
  const [text, setText] = useState(value.join(', '))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(value.join(', '))
  }, [value, editing])
  return (
    <input
      id={id}
      type="text"
      className="field-input"
      value={text}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        setEditing(false)
        onCommit(text.split(',').map(s => s.trim()).filter(Boolean))
      }}
    />
  )
}

function newOpenXBuyer(): BuyerEntry {
  return { id: String(Date.now()), buyerId: '' }
}

// -----------------------------------------------------------------------------
// Index Exchange — essential: Account. Advanced: auction type, account manager.
// -----------------------------------------------------------------------------

// Known IX Marketplace accounts offered in the dropdown. Empty by default —
// the operator types (or configures) the curator account id; a typed id not in
// this list is kept as a custom entry.
const IX_BUILTIN_ACCOUNTS: IxAccount[] = []

function IXPanel({ form, update, formIssues }: Props) {
  const cfg = form.ixConfig
  const [customAccounts, setCustomAccounts] = useState<IxAccount[]>(loadCustomIxAccounts)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newId, setNewId] = useState('')
  const [addError, setAddError] = useState('')

  useEffect(() => { persistCustomIxAccounts(customAccounts) }, [customAccounts])

  // Hide saved duplicates of any built-in account instead of listing an id twice.
  const visibleCustom = customAccounts.filter(a => !IX_BUILTIN_ACCOUNTS.some(b => b.id === a.id))
  const allAccounts = [...IX_BUILTIN_ACCOUNTS, ...visibleCustom]
  const selectedIsCustom = visibleCustom.some(a => a.id === cfg.accountId)
  const accountAuditError = formIssues?.['ixConfig.accountId']

  const handleSaveNew = () => {
    const name = newName.trim()
    const id = newId.trim()
    if (!name || !id) { setAddError('Both Name and ID are required.'); return }
    if (!/^\d+$/.test(id)) { setAddError('Account ID must be numeric.'); return }
    if (allAccounts.some(a => a.id === id)) { setAddError(`Account ID ${id} already exists.`); return }
    setCustomAccounts(prev => [...prev, { id, name }])
    update('ixConfig', { ...cfg, accountId: id })
    setNewName('')
    setNewId('')
    setAddError('')
    setAdding(false)
  }

  const handleRemoveCustom = (id: string) => {
    setCustomAccounts(prev => prev.filter(a => a.id !== id))
    if (cfg.accountId === id) update('ixConfig', { ...cfg, accountId: '' })
  }

  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">Index Exchange</div>

      <div className="field-group">
        <label className="field-label required" htmlFor="ix-account">Account</label>
        <select
          id="ix-account"
          className={`field-select${accountAuditError ? ' field-input--error' : ''}`}
          value={cfg.accountId || ''}
          onChange={e => update('ixConfig', { ...cfg, accountId: e.target.value })}
          aria-invalid={accountAuditError ? true : undefined}
        >
          <option value="" disabled>Select or add an account…</option>
          <optgroup label="Accounts">
            {IX_BUILTIN_ACCOUNTS.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
            ))}
          </optgroup>
          {visibleCustom.length > 0 && (
            <optgroup label="Saved custom accounts">
              {visibleCustom.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
              ))}
            </optgroup>
          )}
        </select>
        {accountAuditError ? (
          <span className="field-error">{accountAuditError}</span>
        ) : (
          <span className="field-helper">The account deals are created under — your organization's curator account id at Index Exchange.</span>
        )}
      </div>

      <PublisherScope
        toggleId="ix-max-publishers"
        inputId="ix-publishers"
        catalogSlices={['index']}
        allPublishers={cfg.allPublishers !== false}
        onToggle={on => update('ixConfig', { ...cfg, allPublishers: on })}
        entries={cfg.publisherEntries || []}
        onEntriesChange={entries => update('ixConfig', { ...cfg, publisherEntries: entries })}
        error={formIssues?.['ixConfig.publisherEntries']}
      />

      <AdvancedOptions>
        <div className="field-group field-group--compact">
          <label className="field-label" htmlFor="ix-auction">Auction Type</label>
          <select id="ix-auction" className="field-select"
            value={cfg.auctionType}
            onChange={e => update('ixConfig', { ...cfg, auctionType: e.target.value as 'First Price' | 'Fixed Price' })}>
            <option>First Price</option>
            <option>Fixed Price</option>
          </select>
          <span className="field-helper">First Price is standard.</span>
        </div>

        <div className="field-group">
          <span className="field-label">Manage accounts</span>
          {!adding ? (
            <div className="ix-account-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
                + Add account
              </button>
              {selectedIsCustom && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm ix-account-remove"
                  onClick={() => handleRemoveCustom(cfg.accountId)}
                >
                  Remove "{visibleCustom.find(a => a.id === cfg.accountId)?.name}"
                </button>
              )}
            </div>
          ) : (
            <div className="ix-account-add-row">
              <input
                type="text"
                className="field-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Account name"
                autoFocus
              />
              <input
                type="text"
                className="field-input"
                value={newId}
                onChange={e => setNewId(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="Account ID"
                inputMode="numeric"
                style={{ maxWidth: '12rem' }}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveNew}>Save</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setAddError(''); setNewName(''); setNewId('') }}>Cancel</button>
            </div>
          )}
          {addError && <span className="field-error">{addError}</span>}
        </div>
      </AdvancedOptions>
    </div>
  )
}

// -----------------------------------------------------------------------------
// OpenX — essential: deal price, fee partner. Advanced: everything defaultable.
// -----------------------------------------------------------------------------

function OpenXPanel({ form, update, formIssues }: Props) {
  const cfg = form.openxConfig
  const err = (path: string) => formIssues?.[path]
  const updateCfg = (patch: Partial<OpenXConfig>) => {
    update('openxConfig', { ...cfg, ...patch })
  }

  const updateBuyer = (id: string, buyerId: string) => {
    updateCfg({ buyers: cfg.buyers.map(b => (b.id === id ? { ...b, buyerId } : b)) })
  }
  const addBuyer = () => updateCfg({ buyers: [...cfg.buyers, newOpenXBuyer()] })
  const removeBuyer = (id: string) => {
    if (cfg.buyers.length <= 1) return
    updateCfg({ buyers: cfg.buyers.filter(b => b.id !== id) })
  }

  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">OpenX</div>

      <div className="field-row">
        <div className="field-group">
          <label className="field-label" htmlFor="ox-deal-price">Deal Price <span className="field-label__hint">optional</span></label>
          <div className="input-with-prefix">
            <span className="input-prefix">$</span>
            <input
              id="ox-deal-price"
              type="number"
              className={`field-input${err('openxConfig.dealPrice') ? ' field-input--error' : ''}`}
              value={cfg.dealPrice}
              onChange={e => updateCfg({ dealPrice: e.target.value })}
              min="0"
              step="0.01"
              placeholder="e.g. 8.50"
              aria-invalid={err('openxConfig.dealPrice') ? true : undefined}
            />
          </div>
          {err('openxConfig.dealPrice') && <span className="field-error">{err('openxConfig.dealPrice')}</span>}
          <span className="field-helper">Optional batch-wide bid floor (CPM). Blank = each deal's Floor CPM, or $0.10.</span>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="ox-fee-partner">Fee Partner</label>
          <input
            id="ox-fee-partner"
            type="text"
            className="field-input"
            value={cfg.feePartner}
            onChange={e => updateCfg({ feePartner: e.target.value })}
            placeholder="e.g. your organization"
          />
          <span className="field-helper">Receives the curator fee.</span>
        </div>
      </div>

      <PublisherScope
        toggleId="ox-max-publishers"
        inputId="ox-publishers"
        catalogSlices={['openx']}
        allPublishers={cfg.allPublishers !== false}
        onToggle={on => updateCfg({ allPublishers: on })}
        entries={cfg.publisherEntries || []}
        onEntriesChange={entries => updateCfg({ publisherEntries: entries })}
        idRequired
        error={err('openxConfig.publisherEntries')}
      />
      {(cfg.allPublishers === false) && (cfg.publisherEntries || []).length > 0 && cfg.excludedPublisherIds.some(s => s.trim()) && (
        <span className="field-error">OpenX can't combine a publisher list with Excluded Publisher IDs (Advanced) — clear one.</span>
      )}

      <AdvancedOptions forceOpen={!!(err('openxConfig.packageName') || err('openxConfig.pmpDealType') || err('openxConfig.grossShare'))}>
        <div className="toggle-wrap">
          <label className="toggle" htmlFor="ox-auto-package">
            <input
              id="ox-auto-package"
              type="checkbox"
              checked={cfg.autoPackageName}
              onChange={e => updateCfg({ autoPackageName: e.target.checked })}
            />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
          <span className="toggle-label">Auto-generate package name</span>
        </div>
        {!cfg.autoPackageName && (
          <div className="field-group">
            <label className="field-label required" htmlFor="ox-package">Package Name</label>
            <input id="ox-package" type="text" className={`field-input${err('openxConfig.packageName') ? ' field-input--error' : ''}`}
              value={cfg.packageName}
              onChange={e => updateCfg({ packageName: e.target.value })}
              placeholder="Exact OpenX package name"
              aria-invalid={err('openxConfig.packageName') ? true : undefined} />
            {err('openxConfig.packageName') && <span className="field-error">{err('openxConfig.packageName')}</span>}
          </div>
        )}

        <div className="field-row">
          <div className="field-group">
            <label className="field-label" htmlFor="ox-pmp">PMP Deal Type</label>
            <select id="ox-pmp" className={`field-select${err('openxConfig.pmpDealType') ? ' field-input--error' : ''}`}
              value={cfg.pmpDealType}
              onChange={e => updateCfg({ pmpDealType: e.target.value })}
              aria-invalid={err('openxConfig.pmpDealType') ? true : undefined}>
              {OX_PMP_DEAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              {(cfg.pmpDealType === 'PRIVATE_AUCTION' || cfg.pmpDealType === '2') && (
                // Legacy persisted/parsed PRIVATE_AUCTION — shown disabled so the
                // trader sees what is set and switches to a creatable type.
                <option value={cfg.pmpDealType} disabled>{cfg.pmpDealType} (not creatable via API — cutlass#766)</option>
              )}
            </select>
            {err('openxConfig.pmpDealType') && <span className="field-error">{err('openxConfig.pmpDealType')}</span>}
            <span className="field-helper">PREFERRED_DEAL is the standard setup.</span>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="ox-currency">Currency</label>
            <select
              id="ox-currency"
              className="field-select"
              value={cfg.currency}
              onChange={e => updateCfg({ currency: e.target.value })}
            >
              {OX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="ox-gross-share">Gross Share (%)</label>
            <input
              id="ox-gross-share"
              type="number"
              className={`field-input${err('openxConfig.grossShare') ? ' field-input--error' : ''}`}
              value={cfg.grossShare}
              onChange={e => updateCfg({ grossShare: e.target.value })}
              min="0"
              max="100"
              step="0.01"
              placeholder="Optional"
              aria-invalid={err('openxConfig.grossShare') ? true : undefined}
            />
            {err('openxConfig.grossShare') && <span className="field-error">{err('openxConfig.grossShare')}</span>}
            <span className="field-helper">Blank = the campaign's curated deal fee.</span>
          </div>
        </div>

        <div className="field-row">
          <div className="field-group">
            <label className="field-label" htmlFor="ox-rendering">Rendering Context</label>
            <select id="ox-rendering" className="field-select"
              value={cfg.renderingContext}
              onChange={e => updateCfg({ renderingContext: e.target.value })}>
              <option value="">Auto (match channel)</option>
              <option>Banner</option>
              <option>Video</option>
              <option>Native</option>
            </select>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="ox-domain">Domain Match Style</label>
            <select id="ox-domain" className="field-select"
              value={cfg.domainTargetingOption}
              onChange={e => updateCfg({ domainTargetingOption: e.target.value })}>
              <option value="">Default (subdomain match)</option>
              <option value="SUBDOMAIN">SUBDOMAIN</option>
              <option value="ROOT">ROOT (apex match)</option>
            </select>
            <span className="field-helper">Match style for uploaded domain lists.</span>
          </div>
        </div>

        <div className="field-group">
          <span className="field-label">Buyer IDs</span>
          <span className="field-helper">Optional DSP seat IDs allowed to bid — the first is treated as the main buyer. Blank = the demand partner's default seats.</span>
          <div className="dynamic-list">
            {cfg.buyers.map((buyer, index) => (
              <div key={buyer.id} className="dynamic-list-item">
                <input
                  id={index === 0 ? 'ox-buyer-first' : undefined}
                  type="text"
                  className="field-input"
                  value={buyer.buyerId}
                  onChange={e => updateBuyer(buyer.id, e.target.value)}
                  placeholder="e.g. 123456"
                  aria-label={`Buyer ID ${index + 1}`}
                />
                {cfg.buyers.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label="Remove buyer"
                    onClick={() => removeBuyer(buyer.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={addBuyer}>+ Add Buyer</button>
          </div>
        </div>

        <div className="field-row">
          <div className="field-group">
            <label className="field-label" htmlFor="ox-inventory-categories">Inventory Categories</label>
            <CommaListInput
              id="ox-inventory-categories"
              value={cfg.inventoryCategories}
              placeholder="Optional, comma-separated"
              onCommit={list => updateCfg({ inventoryCategories: list })}
            />
            <span className="field-helper">CTV deals default to the CTV app-bundle category when blank.</span>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="ox-excluded-publishers">Excluded Publisher IDs</label>
            <CommaListInput
              id="ox-excluded-publishers"
              value={cfg.excludedPublisherIds}
              placeholder="Optional, comma-separated"
              onCommit={list => updateCfg({ excludedPublisherIds: list })}
            />
            <span className="field-helper">Cannot be combined with an include list on the same deal.</span>
          </div>
        </div>

        <div className="field-group field-group--compact">
          <label className="field-label" htmlFor="expectedAdCategory">Expected Sensitive Category</label>
          <select
            id="expectedAdCategory"
            className="field-select"
            value={form.expectedAdCategory}
            onChange={e => update('expectedAdCategory', e.target.value)}
          >
            <option value="">— None —</option>
            {OX_SENSITIVE_CATEGORIES.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <span className="field-helper">Set for political or other sensitive campaigns; leave blank otherwise. Manual step: the OpenX API can't set this — the run summary and QA checklist will remind you to apply it in the OpenX UI after the deals are created.</span>
        </div>
      </AdvancedOptions>
    </div>
  )
}

// -----------------------------------------------------------------------------
// PubMatic — essential: publisher scope. Advanced: format/platform overrides.
// -----------------------------------------------------------------------------

function PubMaticPanel({ form, update, formIssues }: Props) {
  const cfg = form.pubmaticConfig
  const err = (path: string) => formIssues?.[path]
  const updateCfg = (patch: Partial<PubMaticConfig>) =>
    update('pubmaticConfig', { ...cfg, ...patch })

  const toggleFormat = (f: string) => {
    const cur = cfg.adFormats
    updateCfg({ adFormats: cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f] })
  }
  const togglePlatform = (p: string) => {
    const cur = cfg.platforms
    updateCfg({ platforms: cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p] })
  }
  // The allowlist edits publisherEntries and collapses legacy publisherNames
  // into it (single source of truth after the first edit — old drafts show
  // their names as chips via effectivePubMaticPublisherEntries).
  const setPublisherEntries = (entries: PublisherAllowlistEntry[]) =>
    updateCfg({ publisherEntries: entries, publisherNames: [''] })

  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">PubMatic</div>

      <PublisherScope
        toggleId="pm-maxreach"
        inputId="pm-publishers"
        catalogSlices={['pubmatic']}
        allPublishers={cfg.maxReach}
        onToggle={on => updateCfg({ maxReach: on })}
        entries={effectivePubMaticPublisherEntries(cfg)}
        onEntriesChange={setPublisherEntries}
        error={err('pubmaticConfig.publisherNames')}
        maxOnExtra={(
          <div className="field-group field-group--compact">
            <label className="field-label" htmlFor="pm-maxpub">Max Allowed Publishers</label>
            <input id="pm-maxpub" type="number" className="field-input"
              value={cfg.maxAllowedPublishers}
              onChange={e => updateCfg({ maxAllowedPublishers: e.target.value })}
              min="1" max="200" placeholder="Default 200" />
          </div>
        )}
      />

      <AdvancedOptions>
        <div className="field-group">
          <span className="field-label">Ad Formats</span>
          <span className="field-helper">Leave empty to match each deal's channel.</span>
          {/* PubMatic accepts Video alongside Banner/Native, but its own docs say
              the pairing makes detailed video targeting unavailable — buyers are
              told to create separate deals per format. Advisory only; the QA
              report carries the same finding as qa_pm_ad_format_mix. */}
          {cfg.adFormats.some(f => f.startsWith('Video')) &&
            cfg.adFormats.some(f => f.startsWith('Banner') || f.startsWith('Native')) && (
            <span className="field-helper">
              Heads up: pairing Video with Banner/Native on one deal makes PubMatic's detailed
              video targeting unavailable. PubMatic advises separate deals per format.
            </span>
          )}
          <div className="checkbox-group">
            {PM_AD_FORMATS.map(f => (
              <label key={f} className="ds-checkbox-wrap">
                <input type="checkbox" checked={cfg.adFormats.includes(f)}
                  onChange={() => toggleFormat(f)} />
                <span className="ds-checkbox">
                  <span className="ds-checkbox__box" />
                  <span className="ds-checkbox__label">{f}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="field-group">
          <span className="field-label">Platforms</span>
          <span className="field-helper">Leave empty to derive from each deal's channel and inventory type.</span>
          <div className="checkbox-group">
            {PM_PLATFORMS.map(p => (
              <label key={p} className="ds-checkbox-wrap">
                <input type="checkbox" checked={cfg.platforms.includes(p)}
                  onChange={() => togglePlatform(p)} />
                <span className="ds-checkbox">
                  <span className="ds-checkbox__box" />
                  <span className="ds-checkbox__label">{p}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </AdvancedOptions>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Media.net — essential: margin. Advanced: format/environment overrides.
// -----------------------------------------------------------------------------

function MediaNetPanel({ form, update, formIssues }: Props) {
  const cfg = form.medianetConfig
  const err = (path: string) => formIssues?.[path]
  const toggleEnv = (env: string) => {
    const cur = cfg.environments
    update('medianetConfig', { ...cfg, environments: cur.includes(env) ? cur.filter(e => e !== env) : [...cur, env] })
  }
  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">Media.net</div>

      <PublisherScope
        toggleId="mn-max-publishers"
        inputId="mn-publishers"
        allPublishers
        onToggle={() => {}}
        entries={[]}
        onEntriesChange={() => {}}
        unsupportedNote="Media.net can't target publisher accounts (platform limitation) — all eligible publishers always run. To scope web inventory, apply an Include site list in the Files step."
      />

      <div className="field-row">
        <div className="field-group">
          <label className="field-label required" htmlFor="mn-margin-val">Margin Value</label>
          <input id="mn-margin-val" type="number" className={`field-input${err('medianetConfig.marginValue') ? ' field-input--error' : ''}`}
            value={cfg.marginValue}
            onChange={e => update('medianetConfig', { ...cfg, marginValue: e.target.value })}
            min="0" step="0.01" placeholder="e.g. 30"
            aria-invalid={err('medianetConfig.marginValue') ? true : undefined} />
          {err('medianetConfig.marginValue') && <span className="field-error">{err('medianetConfig.marginValue')}</span>}
          <span className="field-helper">Curator margin. Max 50 as a percentage, 25 as a fixed CPM.</span>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="mn-margin-type">Margin Type</label>
          <select id="mn-margin-type" className="field-select"
            value={cfg.marginType}
            onChange={e => update('medianetConfig', { ...cfg, marginType: e.target.value })}>
            <option>Percentage (1)</option>
            <option>Fixed (0)</option>
          </select>
        </div>
      </div>

      <AdvancedOptions>
        <div className="field-row">
          <div className="field-group">
            <label className="field-label" htmlFor="mn-format">Ad Format</label>
            <select id="mn-format" className="field-select"
              value={cfg.adFormat}
              onChange={e => update('medianetConfig', { ...cfg, adFormat: e.target.value })}>
              <option value="">Auto (match channel)</option>
              <option>Banner (0)</option>
              <option>Native (1)</option>
              <option>Video (2)</option>
            </select>
          </div>
          <div className="field-group">
            <span className="field-label">Environments</span>
            <span className="field-helper">Blank = derived from each deal's inventory type.</span>
            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-1)' }}>
              {['Web', 'App'].map(env => (
                <label key={env} className="ds-checkbox-wrap">
                  <input type="checkbox" checked={cfg.environments.includes(env)}
                    onChange={() => toggleEnv(env)} />
                  <span className="ds-checkbox">
                    <span className="ds-checkbox__box" />
                    <span className="ds-checkbox__label">{env}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </AdvancedOptions>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Xandr (Microsoft Curate) — essential: insertion order. Advanced: the rest.
// -----------------------------------------------------------------------------

function XandrPanel({ form, update, formIssues }: Props) {
  const cfg = form.xandrConfig
  const err = (path: string) => formIssues?.[path]
  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">Xandr (Microsoft Curate)</div>

      <PublisherScope
        toggleId="xn-max-publishers"
        inputId="xn-publishers"
        allPublishers
        onToggle={() => {}}
        entries={[]}
        onEntriesChange={() => {}}
        unsupportedNote="Xandr prohibits publisher-account targeting on Curate profiles — all eligible publishers always run. To scope inventory, reference a Curate deal list in Advanced → Deal List Names (built once in the Xandr UI)."
      />

      <div className="field-group">
        <label className="field-label required" htmlFor="xn-io">Insertion Order</label>
        <select id="xn-io" className={`field-select${err('xandrConfig.insertionOrder') ? ' field-input--error' : ''}`}
          value={cfg.insertionOrder}
          onChange={e => update('xandrConfig', { ...cfg, insertionOrder: e.target.value })}
          aria-invalid={err('xandrConfig.insertionOrder') ? true : undefined}>
          {xandrInsertionOrderNames.map(io => <option key={io} value={io}>{io}</option>)}
        </select>
        {err('xandrConfig.insertionOrder') && <span className="field-error">{err('xandrConfig.insertionOrder')}</span>}
        <span className="field-helper">The deal is created and billed under this insertion order.</span>
      </div>

      <AdvancedOptions>
        <div className="field-row">
          <div className="field-group">
            <label className="field-label" htmlFor="xn-code">Deal Code</label>
            <input id="xn-code" type="text" className="field-input"
              value={cfg.dealCode}
              onChange={e => update('xandrConfig', { ...cfg, dealCode: e.target.value })}
              placeholder="Blank = the deal name" />
            <span className="field-helper">Unique code for this deal. Blank uses the deal name.</span>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="xn-type">Deal Type</label>
            <select id="xn-type" className="field-select"
              value={cfg.dealType}
              onChange={e => update('xandrConfig', { ...cfg, dealType: e.target.value })}>
              <option>Curated</option>
              <option>Private Auction</option>
              <option>Open Auction</option>
              <option>Programmatic Guaranteed</option>
            </select>
            <span className="field-helper">Curated is the standard setup.</span>
          </div>
        </div>
        <div className="field-row">
          <div className="field-group">
            <label className="field-label" htmlFor="xn-revenue">Revenue Type</label>
            <select id="xn-revenue" className="field-select"
              value={cfg.revenueType}
              onChange={e => update('xandrConfig', { ...cfg, revenueType: e.target.value })}>
              <option value="vcpm">vcpm (Dynamic CPM)</option>
              <option value="cpm">cpm (Fixed Price)</option>
            </select>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="xn-payment">Payment Type</label>
            <select id="xn-payment" className="field-select"
              value={cfg.paymentType}
              onChange={e => update('xandrConfig', { ...cfg, paymentType: e.target.value })}>
              <option>CPM</option>
              <option>Revshare</option>
            </select>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="xn-deal-lists">Deal Lists</label>
            <input id="xn-deal-lists" type="text" className="field-input"
              value={cfg.dealListNames}
              onChange={e => update('xandrConfig', { ...cfg, dealListNames: e.target.value })}
              placeholder="Optional, comma-separated" />
            <span className="field-helper">Optional inventory allow lists.</span>
          </div>
        </div>
      </AdvancedOptions>
    </div>
  )
}

// -----------------------------------------------------------------------------
// TripleLift — essential: channel. Advanced: price type, formats, political.
// -----------------------------------------------------------------------------

function TripleLiftPanel({ form, update, formIssues }: Props) {
  const cfg = form.tripleliftConfig
  const err = (path: string) => formIssues?.[path]
  const toggleFormat = (f: string) => {
    const cur = cfg.commercializedFormats
    update('tripleliftConfig', { ...cfg, commercializedFormats: cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f] })
  }
  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">TripleLift</div>

      <PublisherScope
        toggleId="tl-max-publishers"
        inputId="tl-publishers"
        allPublishers
        onToggle={() => {}}
        entries={[]}
        onEntriesChange={() => {}}
        unsupportedNote="TripleLift can't target publisher accounts (platform limitation) — all eligible publishers always run. To scope web inventory, apply an Include site list in the Files step (applied post-create as supply-domain targeting)."
      />

      <div className="field-group field-group--compact">
        <label className="field-label" htmlFor="tl-channel">Channel</label>
        <select id="tl-channel" className={`field-select${err('tripleliftConfig.channel') ? ' field-input--error' : ''}`}
          value={cfg.channel}
          onChange={e => update('tripleliftConfig', { ...cfg, channel: e.target.value })}
          aria-invalid={err('tripleliftConfig.channel') ? true : undefined}>
          <option value="">Auto — match each deal's channel</option>
          <option value="WEB">WEB (force)</option>
          <option value="CTV">CTV (force)</option>
        </select>
        {err('tripleliftConfig.channel') && <span className="field-error">{err('tripleliftConfig.channel')}</span>}
        <span className="field-helper">Auto sends CTV deals to the CTV pool and every other channel to WEB, per deal. Only force a value to override that for the whole batch.</span>
      </div>

      <AdvancedOptions forceOpen={!!err('tripleliftConfig.dealPriceType')}>
        <div className="field-group field-group--compact">
          <label className="field-label" htmlFor="tl-price-type">Deal Price Type</label>
          <select id="tl-price-type" className={`field-select${err('tripleliftConfig.dealPriceType') ? ' field-input--error' : ''}`}
            value={cfg.dealPriceType}
            onChange={e => update('tripleliftConfig', { ...cfg, dealPriceType: e.target.value })}
            aria-invalid={err('tripleliftConfig.dealPriceType') ? true : undefined}>
            <option value="FLOOR">FLOOR</option>
            <option value="FIXED">FIXED</option>
            <option value="CEILING">CEILING</option>
          </select>
          {err('tripleliftConfig.dealPriceType') && <span className="field-error">{err('tripleliftConfig.dealPriceType')}</span>}
          <span className="field-helper">How the deal CPM applies. FLOOR is standard.</span>
        </div>

        <div className="field-group">
          <span className="field-label">Commercialized Formats</span>
          <span className="field-helper">Leave empty to match each deal's channel.</span>
          <div className="checkbox-grid">
            {TL_FORMATS.map(f => (
              <label key={f} className="ds-checkbox-wrap">
                <input type="checkbox" checked={cfg.commercializedFormats.includes(f)}
                  onChange={() => toggleFormat(f)} />
                <span className="ds-checkbox">
                  <span className="ds-checkbox__box" />
                  <span className="ds-checkbox__label" style={{ fontSize: 'var(--font-size-caption)' }}>{f}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="toggle-wrap">
          <label className="toggle" htmlFor="tl-political-ads">
            <input id="tl-political-ads" type="checkbox" checked={cfg.allowPoliticalAds}
              onChange={e => update('tripleliftConfig', { ...cfg, allowPoliticalAds: e.target.checked })} />
            <span className="toggle-track" /><span className="toggle-thumb" />
          </label>
          <span className="toggle-label">Allow political ads</span>
        </div>
        <span className="field-helper">Off by default. Turn on only when this batch may serve political advertising.</span>
      </AdvancedOptions>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Magnite — essential: marketplace + pricing. No advanced section needed.
// -----------------------------------------------------------------------------

function MagnitePanel({ form, update, formIssues }: Props) {
  const cfg = form.magniteConfig
  const err = (path: string) => formIssues?.[path]
  const updateCfg = (patch: Partial<MagniteConfig>) =>
    update('magniteConfig', { ...cfg, ...patch })

  // Marketplace options: none are preset — the operator types the ClearLine
  // marketplace name or id.
  const presetMarketplaces: string[] = []
  const hasPresets = presetMarketplaces.length > 0
  const valueIsPreset = cfg.marketplace.trim() !== '' && presetMarketplaces.includes(cfg.marketplace)
  const [customMarketplace, setCustomMarketplace] = useState(false)
  const showMarketplaceText = !hasPresets || customMarketplace || (cfg.marketplace.trim() !== '' && !valueIsPreset)

  const presetPriceType: string | undefined = undefined
  const priceType = cfg.priceType || 'Market Rate with Minimum'
  const showFloor = magnitePriceTypeHasFloor(presetPriceType || priceType)

  // "All eligible publishers" defaults ON — undefined (pre-toggle drafts)
  // means true, matching the locked all-publishers wire.
  const allPublishers = cfg.allPublishers !== false
  // ClearLine's CTV and DV+ publisher catalogs are disjoint — validate the
  // allowlist against the slice(s) this batch's Magnite channels book into.
  const mgChannels = form.deals.filter(d => d.ssp === 'Magnite').map(d => d.channel)
  const magniteCatalogSlices: ('magnite_ctv' | 'magnite_dvplus')[] = [
    ...(mgChannels.some(c => c === 'CTV' || c === 'Audio') ? ['magnite_ctv' as const] : []),
    ...(mgChannels.some(c => c !== 'CTV' && c !== 'Audio') ? ['magnite_dvplus' as const] : []),
  ]
  if (magniteCatalogSlices.length === 0) magniteCatalogSlices.push('magnite_ctv', 'magnite_dvplus')
  return (
    <div className="ssp-panel">
      <div className="ssp-panel-title">Magnite</div>

      <div className="field-row">
        <div className="field-group">
          <label className="field-label required" htmlFor="mg-marketplace">Marketplace</label>
          {hasPresets && !showMarketplaceText ? (
            <select id="mg-marketplace"
              className={`field-select${err('magniteConfig.marketplace') ? ' field-input--error' : ''}`}
              value={valueIsPreset ? cfg.marketplace : ''}
              onChange={e => {
                if (e.target.value === '__custom__') { setCustomMarketplace(true); updateCfg({ marketplace: '' }) }
                else updateCfg({ marketplace: e.target.value })
              }}>
              <option value="">Select a marketplace…</option>
              {presetMarketplaces.map(m => <option key={m} value={m}>{m}</option>)}
              <option value="__custom__">Custom / other…</option>
            </select>
          ) : (
            <>
              <input id="mg-marketplace" type="text"
                className={`field-input${err('magniteConfig.marketplace') ? ' field-input--error' : ''}`}
                value={cfg.marketplace}
                onChange={e => updateCfg({ marketplace: e.target.value })}
                placeholder="Marketplace name or ID" />
              {hasPresets && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                  onClick={() => { setCustomMarketplace(false); updateCfg({ marketplace: '' }) }}>
                  ← Choose from list
                </button>
              )}
            </>
          )}
          {err('magniteConfig.marketplace') && <span className="field-error">{err('magniteConfig.marketplace')}</span>}
          <span className="field-helper">Cannot be changed after the deal is created.</span>
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="mg-price-type">Price Type</label>
          <select id="mg-price-type"
            className={`field-select${err('magniteConfig.priceType') ? ' field-input--error' : ''}`}
            value={priceType}
            onChange={e => updateCfg({ priceType: e.target.value as MagniteConfig['priceType'] })}
            disabled={!!presetPriceType}
            aria-invalid={err('magniteConfig.priceType') ? true : undefined}>
            {MAGNITE_PRICE_TYPES.map(pt => <option key={pt} value={pt}>{pt}</option>)}
          </select>
          {err('magniteConfig.priceType') && <span className="field-error">{err('magniteConfig.priceType')}</span>}
          <span className="field-helper">
            Market Rate with a minimum floor is the standard setup.
          </span>
        </div>

        {showFloor && (
          <div className="field-group">
            <label className="field-label" htmlFor="mg-floor">
              {(presetPriceType || priceType) === 'CPM' ? 'Fixed CPM Floor' : 'Minimum Floor'}
            </label>
            <div className="input-with-prefix">
              <span className="input-prefix">$</span>
              <input id="mg-floor" type="number"
                className={`field-input${err('magniteConfig.floorCpm') ? ' field-input--error' : ''}`}
                value={cfg.floorCpm}
                onChange={e => updateCfg({ floorCpm: e.target.value })}
                min="0" step="0.01" placeholder="0.10"
                aria-invalid={err('magniteConfig.floorCpm') ? true : undefined} />
            </div>
            {err('magniteConfig.floorCpm') && <span className="field-error">{err('magniteConfig.floorCpm')}</span>}
            <span className="field-helper">Per-publisher minimum — not the deal CPM. Leave at 0.10 unless instructed otherwise.</span>
          </div>
        )}
      </div>

      <PublisherScope
        toggleId="mg-all-publishers"
        inputId="mg-publishers"
        catalogSlices={magniteCatalogSlices}
        allPublishers={allPublishers}
        onToggle={on => updateCfg({ allPublishers: on })}
        entries={cfg.publisherEntries || []}
        onEntriesChange={entries => updateCfg({ publisherEntries: entries })}
        error={err('magniteConfig.publisherEntries')}
      />

      <span className="field-helper">
        Ad formats are picked per deal on each deal card.
      </span>
    </div>
  )
}

const PANEL_MAP: Record<string, (props: Props) => JSX.Element> = {
  'Index Exchange': IXPanel,
  'OpenX': OpenXPanel,
  'PubMatic': PubMaticPanel,
  'Media.net': MediaNetPanel,
  'Xandr': XandrPanel,
  'TripleLift': TripleLiftPanel,
  'Magnite': MagnitePanel,
}

export function SspSelection({ form, update, open, onToggle, filled, total, issues, formIssues }: SectionProps) {
  const used = sspsInUse(form.deals)

  return (
    <FormSection number="05" title="SSP Configuration" anchorId="section-ssp" open={open} onToggle={onToggle} filled={filled} total={total} issues={issues}>
      {used.length === 0 ? (
        <div className="banner-info">
          No SSPs in use yet. Assign an SSP on each deal card above — its config panel appears here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {used.map(ssp => {
            const Panel = PANEL_MAP[ssp]
            return Panel ? <Panel key={ssp} form={form} update={update} formIssues={formIssues} /> : null
          })}
        </div>
      )}
    </FormSection>
  )
}

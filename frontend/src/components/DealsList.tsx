import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { DealEntry, FormData, CHANNEL_OPTIONS, SSP_OPTIONS, GeoEntry, GeoType, GEO_TYPE_LABEL, sspGeoTypes, StandardList, UploadedFile, dealSupportsAdDuration, dealNameLengthError, isVideoChannel, newDeal, sspReq, magniteFormatKind, MAGNITE_FORMATS_BY_KIND, MAGNITE_POPULAR_SIZE_IDS } from '../types/deal'
import { MAGNITE_SIZES_MAX } from '../lib/magniteAdFormats'
import { DealIssue } from '../lib/sectionStatus'
import { JUMP_REVEAL_EVENT } from '../lib/reveal'
import { generateDealName } from '../hooks/useDealMatrix'
import { activeDsps } from '../lib/dealNameSlots'
import { DealListAssignment, dealListAssignments, dealListLabel, exclusionOverridePhrase, resolveReportingLabels, sspIabPartitionForUi } from '../lib/dealPromptYaml'
import { effectiveIabCategories, effectiveIabExcludes, IAB_OPTIONS } from '../lib/inferIab'
import { SSP_IAB_CAPABILITIES, sspCatalogHasLabel, sspIabPickerOptions } from '../lib/sspIabCatalogs'
import { FormSection } from './FormSection'
import { ConfirmDialog } from './ConfirmDialog'

// Friendly display names for the IX reporting-label keys (template keys are
// camelCase / lowercase; these read better in the card panel).
const LABEL_DISPLAY: Record<string, string> = {
  advertiser: 'Advertiser',
  agency: 'Agency',
  salesperson: 'Salesperson',
  externalReferenceID: 'External reference ID',
  custom: 'Custom',
}

const COUNTRY_OPTIONS = [
  { code: '', label: '— Country —' },
  { code: 'US', label: 'United States (US)' },
  { code: 'CA', label: 'Canada (CA)' },
  { code: 'GB', label: 'United Kingdom (GB)' },
  { code: 'AU', label: 'Australia (AU)' },
  { code: 'DE', label: 'Germany (DE)' },
  { code: 'FR', label: 'France (FR)' },
  { code: 'ES', label: 'Spain (ES)' },
  { code: 'IT', label: 'Italy (IT)' },
  { code: 'JP', label: 'Japan (JP)' },
  { code: 'MX', label: 'Mexico (MX)' },
  { code: 'BR', label: 'Brazil (BR)' },
  { code: 'IN', label: 'India (IN)' },
]

interface Props {
  form: FormData
  update: <K extends keyof FormData>(key: K, val: FormData[K]) => void
  open?: boolean
  onToggle?: (next: boolean) => void
  filled?: number
  total?: number
  issues?: number
  dealIssues?: DealIssue[]
  /** Standard (curated) lists, for the per-deal site/app-bundle list selector. */
  standardLists?: StandardList[]
}

/** Which array a geo row lives in. The deal keeps geoInclude/geoExclude as
 *  separate arrays — the prompt builders and the geo_exclude_unsupported audit
 *  rule both read them that way — while the card presents one list with a
 *  direction per row. */
export type GeoDir = 'include' | 'exclude'

/** The card's single geo list: includes first, then exclusions, each tagged
 *  with the array it came from. Order within a direction is preserved. */
export function geoRowsOf(deal: DealEntry): { entry: GeoEntry; dir: GeoDir }[] {
  return [
    ...deal.geoInclude.map(entry => ({ entry, dir: 'include' as GeoDir })),
    ...deal.geoExclude.map(entry => ({ entry, dir: 'exclude' as GeoDir })),
  ]
}

const geoArrayKey = (dir: GeoDir): 'geoInclude' | 'geoExclude' => (dir === 'exclude' ? 'geoExclude' : 'geoInclude')

/** Edit one row in place, in whichever array it currently lives. */
export function patchGeoRow(deal: DealEntry, id: string, dir: GeoDir, patch: Partial<GeoEntry>): Partial<DealEntry> {
  const key = geoArrayKey(dir)
  return { [key]: deal[key].map(g => (g.id === id ? { ...g, ...patch } : g)) }
}

export function removeGeoRow(deal: DealEntry, id: string, dir: GeoDir): Partial<DealEntry> {
  const key = geoArrayKey(dir)
  return { [key]: deal[key].filter(g => g.id !== id) }
}

/** Flip a row's direction: move the entry between the two arrays, keeping its
 *  id, type and value so the trader never re-types a value to change intent.
 *  A no-op move returns an empty patch rather than rewriting both arrays. */
export function moveGeoRow(deal: DealEntry, id: string, from: GeoDir, to: GeoDir): Partial<DealEntry> {
  if (from === to) return {}
  const fromKey = geoArrayKey(from)
  const toKey = geoArrayKey(to)
  const entry = deal[fromKey].find(g => g.id === id)
  if (!entry) return {}
  return {
    [fromKey]: deal[fromKey].filter(g => g.id !== id),
    [toKey]: [...deal[toKey], entry],
  }
}

function newGeo(type: GeoType = 'country'): GeoEntry {
  return { id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, value: '' }
}

/** Canonical +/− accordion at card scale (.mini-accordion). `forceOpen` nudges
 *  it open — a contained field error or a jump-reveal targeting a field inside
 *  — while leaving the trader free to collapse it again. Mirrors the SSP
 *  panels' AdvancedOptions.
 *
 *  The nudge is the imperative effect ONLY; `open` is deliberately NOT a JSX
 *  prop. Passing `open={forceOpen || undefined}` alongside the effect made the
 *  element controlled, with two consequences that both contradict the contract
 *  above: React force-CLOSED the group whenever forceOpen went true -> false,
 *  and while it was true the trader could not collapse it at all.
 *
 *  The close was the visible bug. Typing in a field flips
 *  formChangedSinceAudit, which makes auditDealIssues drop that field's own
 *  finding until the debounced re-audit returns — so forceOpen dropped on each
 *  keystroke, collapsing the group mid-edit and blurring the focused input,
 *  then reopening a moment later. Leaving the element uncontrolled means a
 *  cleared error simply stops forcing it open; nothing slams it shut. */
function CardAccordion({ summary, forceOpen, children }: { summary: ReactNode; forceOpen?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement | null>(null)
  useEffect(() => {
    if (forceOpen && ref.current) ref.current.open = true
  }, [forceOpen])
  return (
    <details ref={ref} className="mini-accordion">
      <summary className="mini-accordion__summary">{summary}</summary>
      <div className="mini-accordion__body">{children}</div>
    </details>
  )
}

/** Tile selector — the OpenX/PubMatic Core Targeting idiom: big tap-target
 *  tiles instead of a dropdown, for the couple of fields that reshape the
 *  whole deal (channel, environment). Single-select; `allowClear` lets a
 *  second click clear back to the unset/default state. */
function TileGroup({ id, options, value, onSelect, allowClear, error, ariaLabel }: {
  id?: string
  options: { value: string; label: string; hint?: string }[]
  value: string
  onSelect: (next: string) => void
  allowClear?: boolean
  error?: boolean
  ariaLabel: string
}) {
  return (
    <div id={id} className={`tile-group${error ? ' tile-group--error' : ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map(o => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`tile${active ? ' is-active' : ''}`}
            onClick={() => onSelect(active && allowClear ? '' : o.value)}
          >
            <span className="tile__label">{o.label}</span>
            {o.hint && <span className="tile__hint">{o.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** One advanced-targeting row — the Index-console accordion idiom: a title,
 *  an honest one-line summary of the CURRENT value (never "click to see"),
 *  and the editor inside. `state` drives the summary treatment: 'set' shows
 *  the value plainly, 'open' (nothing set = targeting wide open) gets the
 *  quiet green check the Media.net "All targeted" states use, 'attention'
 *  turns the row amber (contained audit finding — also forces it open). */
function TargetingGroup({ title, summary, state = 'set', forceOpen, anchorId, children }: {
  title: string
  summary: ReactNode
  state?: 'set' | 'open' | 'attention'
  forceOpen?: boolean
  anchorId?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement | null>(null)
  useEffect(() => {
    if (forceOpen && ref.current) ref.current.open = true
  }, [forceOpen])
  return (
    <details ref={ref} id={anchorId} className={`targeting-group targeting-group--${state}`}>
      <summary className="targeting-group__head">
        <svg className="targeting-group__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        <span className="targeting-group__title">{title}</span>
        <span className="targeting-group__summary">
          {state === 'open' && (
            <svg className="targeting-group__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          )}
          {state === 'attention' && (
            <svg className="targeting-group__warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
          )}
          {summary}
        </span>
      </summary>
      <div className="targeting-group__body">{children}</div>
    </details>
  )
}

/** Comma-separated list input that edits as free text and commits the parsed
 *  list on blur — a controlled join(', ') value would eat the comma the
 *  moment it is typed. Local mirror of SspSelection's CommaListInput; used by
 *  the per-deal allowed-ad-durations field. */
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

/** Free-text chip adder: type a name, press Enter, get a chip. Used by the
 *  per-deal IAB Include/Exclude blocks so SSP-native catalog names can ride
 *  alongside the picker. `onAdd` may return false to REJECT the name (e.g.
 *  it fails the per-SSP catalog validation) — the input keeps its text so
 *  the trader can fix it instead of retyping. */
function ChipInput({ ariaLabel, placeholder, onAdd }: {
  ariaLabel: string
  placeholder?: string
  onAdd: (name: string) => boolean | void
}) {
  const [text, setText] = useState('')
  return (
    <input
      type="text"
      className="field-input chip-input"
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const name = text.trim()
        if (!name) return
        if (onAdd(name) === false) return
        setText('')
      }}
    />
  )
}

/** Searchable per-SSP category picker: the curated IAB_OPTIONS names the SSP
 *  can carry pinned on top as "Common categories" (they map per-SSP via the
 *  canonical maps in dealPromptYaml.ts), the SSP's FULL live catalog below —
 *  1:1 with what the API accepts, so an unresolvable pick is impossible via
 *  the picker. IX options carry a key tag ('· genre' / '· IAB') because all
 *  of a deal's names must land on ONE targeting key (cutlass#831). */
function IabCatalogPicker({ ssp, side, commonNames, selected, onPick }: {
  ssp: NonNullable<DealEntry['ssp']>
  side: 'include' | 'exclude'
  commonNames: string[]
  selected: string[]
  onPick: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const options = useMemo(() => sspIabPickerOptions(ssp), [ssp])
  const q = query.trim().toLowerCase()
  const common = commonNames.filter(n => !q || n.toLowerCase().includes(q))
  const matches = options.filter(o => !q || o.label.toLowerCase().includes(q))
  const shown = matches.slice(0, 40)
  return (
    <div className="iab-picker">
      <input
        type="search"
        className="field-input"
        value={query}
        placeholder={`Search the ${ssp} category catalog…`}
        aria-label={`Search ${side} categories (${ssp} catalog)`}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="iab-picker__list">
        {common.length > 0 && <div className="iab-picker__group">Common categories</div>}
        {common.map(n => (
          <button
            key={`common-${n}`}
            type="button"
            className="iab-picker__option"
            disabled={selected.includes(n)}
            onClick={() => onPick(n)}
          >
            {n}
          </button>
        ))}
        <div className="iab-picker__group">{ssp} catalog{q ? '' : ` · ${options.length} entries`}</div>
        {shown.map(o => (
          <button
            key={`${o.keyTag || 'cat'}-${o.label}`}
            type="button"
            className="iab-picker__option"
            disabled={selected.includes(o.label)}
            onClick={() => onPick(o.label)}
          >
            {o.label}
            {o.keyTag && <span className="iab-picker__key"> · {o.keyTag}</span>}
          </button>
        ))}
        {matches.length === 0 && (
          <div className="iab-picker__more">No catalog match — {ssp} only accepts its own category names.</div>
        )}
        {matches.length > shown.length && (
          <div className="iab-picker__more">+{matches.length - shown.length} more — keep typing to narrow</div>
        )}
      </div>
    </div>
  )
}

/** Searchable Magnite DV+ display-size picker — the FULL live ClearLine
 *  catalog (magnite_list_ad_formats, committed as the lib/magniteAdFormats
 *  fixture), replacing the old curated 13-checkbox subset that made most of
 *  the catalog unbookable. Same idiom as IabCatalogPicker: type to narrow,
 *  click to add; selections render as removable chips above the picker.
 *  Dimension queries match either × or x ("300×600" / "300x600"). */
function MagniteSizePicker({ dealId, catalog, selected, atMax, onAdd }: {
  dealId: string
  catalog: { id: number; label: string }[]
  selected: string[]
  atMax: boolean
  onAdd: (idStr: string) => void
}) {
  const [query, setQuery] = useState('')
  const norm = (s: string) => s.toLowerCase().replace(/×/g, 'x')
  const q = norm(query.trim())
  const matches = q ? catalog.filter(o => norm(o.label).includes(q)) : catalog
  const shown = matches.slice(0, 40)
  return (
    <div className="iab-picker">
      <input
        type="search"
        className="field-input"
        value={query}
        placeholder="Search display sizes — name or dimensions (e.g. 300x600)…"
        aria-label={`Search Magnite display sizes for deal ${dealId}`}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="iab-picker__list">
        <div className="iab-picker__group">Magnite display catalog{q ? '' : ` · ${catalog.length} sizes`}</div>
        {shown.map(o => {
          const idStr = String(o.id)
          return (
            <button
              key={o.id}
              type="button"
              className="iab-picker__option"
              disabled={selected.includes(idStr) || atMax}
              onClick={() => onAdd(idStr)}
            >
              {o.label}
            </button>
          )
        })}
        {matches.length === 0 && (
          <div className="iab-picker__more">No size matches — the picker only offers Magnite&apos;s own ad-format catalog.</div>
        )}
        {matches.length > shown.length && (
          <div className="iab-picker__more">+{matches.length - shown.length} more — keep typing to narrow</div>
        )}
      </div>
    </div>
  )
}

/** Per-deal IAB categories section. Include precedence (effectiveIabCategories):
 *  explicit picks win; else the "Auto-infer IAB categories" toggle (OPT-IN,
 *  default OFF) governs — off ships NOTHING. Excludes stay explicit-only.
 *  The picker is per-SSP (IabCatalogPicker); chips the deal's SSP cannot
 *  carry render struck-through via sspIabPartitionForUi — the exact
 *  partition the prompt builders emit with, so nothing silently drops. */
function DealIabSection({ deal, form, patchDeal }: {
  deal: DealEntry
  form: FormData
  patchDeal: (id: string, patch: Partial<DealEntry>) => void
}) {
  const cap = deal.ssp ? SSP_IAB_CAPABILITIES[deal.ssp] : undefined
  const explicit = deal.iabCategories !== undefined
  const autoInfer = deal.autoInferIab === true
  const effective = effectiveIabCategories(deal, form)
  const excludes = effectiveIabExcludes(deal)
  const partition = sspIabPartitionForUi(deal.ssp, effective, excludes)
  const [includeError, setIncludeError] = useState('')
  const [excludeError, setExcludeError] = useState('')

  // The curated names this SSP can actually carry (via its canonical map) —
  // the picker's pinned "Common categories" group. Names in the SSP's
  // NOT-SUPPORTED set are omitted: the picker only offers what the API takes.
  const commonNames = useMemo(
    () => IAB_OPTIONS.filter(n => sspIabPartitionForUi(deal.ssp, [n], []).unsupportedInclude.length === 0),
    [deal.ssp],
  )

  const setIncludes = (next: string[]) =>
    patchDeal(deal.id, { iabCategories: next })
  // Adding a pick MATERIALIZES the displayed set as explicit picks first —
  // on a toggle-on deal the inferred names the trader was looking at become
  // explicit (never silently discarded), then the new name appends.
  const addInclude = (name: string) => {
    if (effective.includes(name)) {
      if (explicit) return
      setIncludes([...effective])
      return
    }
    setIncludes([...effective, name])
  }
  const removeInclude = (name: string) => setIncludes(effective.filter(c => c !== name))
  // Exclude writes: empty → field removed (undefined). Excludes have no
  // toggle state to preserve — undefined and [] both mean "none".
  const setExcludes = (next: string[]) =>
    patchDeal(deal.id, { iabCategoriesExclude: next.length > 0 ? next : undefined })
  const addExclude = (name: string) => {
    if (!excludes.includes(name)) setExcludes([...excludes, name])
  }
  const removeExclude = (name: string) => setExcludes(excludes.filter(c => c !== name))

  // Free-text names must resolve in the SSP's live catalog(s) — an inline
  // error chip instead of silently accepting a name the create would reject.
  const catalogError = (name: string): string =>
    sspCatalogHasLabel(deal.ssp, name)
      ? ''
      : `"${name}" is not in the ${deal.ssp} catalog — pick from the list; the API only accepts its own category names.`
  const onFreeTextInclude = (name: string): boolean => {
    const err = catalogError(name)
    setIncludeError(err)
    if (err) return false
    addInclude(name)
    return true
  }
  const onFreeTextExclude = (name: string): boolean => {
    const err = catalogError(name)
    setExcludeError(err)
    if (err) return false
    addExclude(name)
    return true
  }

  const chip = (name: string, side: 'included' | 'excluded', unsupported: boolean, onRemove?: () => void) => (
    <span key={name} className={`chip${unsupported ? ' chip--unsupported' : ''}`}>
      <span className={unsupported ? 'chip__strike' : undefined}>{name}</span>
      {unsupported && deal.ssp && <span className="chip__note">— not supported on {deal.ssp}</span>}
      {onRemove && (
        <button type="button" className="chip__remove" aria-label={`Remove ${side} category ${name}`} onClick={onRemove}>×</button>
      )}
    </span>
  )

  // No SSP yet: the picker is per-SSP, so there is nothing 1:1 to offer.
  // Existing values stay visible and removable — never invisible state.
  if (!deal.ssp || !cap) {
    return (
      <div className="deal-card__section" id={`deal-iabCategories-${deal.id}`}>
        <span className="deal-card__section-title">IAB categories</span>
        <span className="field-helper">Select an SSP first — the category picker is 1:1 with each SSP's own catalog.</span>
        {effective.length > 0 && (
          <div className="chip-row">{effective.map(c => chip(c, 'included', false, () => removeInclude(c)))}</div>
        )}
        {excludes.length > 0 && (
          <div className="chip-row">{excludes.map(c => chip(c, 'excluded', false, () => removeExclude(c)))}</div>
        )}
      </div>
    )
  }

  // No category surface at all (TripleLift / Magnite): no toggle, no picker —
  // say so. Legacy picks/excludes stay visible (struck) and removable.
  if (!cap.includes) {
    return (
      <div className="deal-card__section" id={`deal-iabCategories-${deal.id}`}>
        <span className="deal-card__section-title">IAB categories</span>
        <span className="field-helper">
          IAB categories: not supported by this SSP's API — {cap.notSupportedReason}.
        </span>
        {effective.length > 0 && (
          <>
            <div className="chip-row">
              {effective.map(c => chip(c, 'included', true, () => {
                const next = effective.filter(x => x !== c)
                patchDeal(deal.id, { iabCategories: next.length > 0 ? next : undefined })
              }))}
            </div>
            <span className="field-helper">These picks will NOT be applied — clear them or apply contextual scoping in the SSP UI.</span>
          </>
        )}
        {excludes.length > 0 && (
          <>
            <div className="chip-row">{excludes.map(c => chip(c, 'excluded', true, () => removeExclude(c)))}</div>
            <span className="field-helper">Category exclusions have no {deal.ssp} API surface — they become a trader UI follow-up in the prompt.</span>
          </>
        )}
      </div>
    )
  }

  const includeHint = explicit
    ? 'custom — explicit picks override the toggle'
    : autoInfer
      ? 'inferred — review before submit'
      : 'off — nothing will be applied'
  const excludeCapNote =
    cap.excludes === 'create'
      ? `${deal.ssp}: exclusions applied via API at deal creation`
      : cap.excludes === 'post-create'
        ? `${deal.ssp}: excludes applied post-create (${cap.excludesVia})`
        : `${deal.ssp}: no category-exclusion surface on this SSP's API`

  return (
    <div className="deal-card__section" id={`deal-iabCategories-${deal.id}`}>
      <span className="deal-card__section-title">IAB categories</span>

      <div className="field-group">
        <span className="field-label">
          <span className="seg-tag seg-tag--allow">INCLUDE</span>{' '}
          categories
          <span className="field-label__hint">{includeHint}</span>
        </span>
        <div className="toggle-wrap">
          <label className="toggle" htmlFor={`deal-autoInferIab-${deal.id}`}>
            <input
              id={`deal-autoInferIab-${deal.id}`}
              type="checkbox"
              checked={autoInfer}
              onChange={e => patchDeal(deal.id, { autoInferIab: e.target.checked || undefined })}
            />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
          <span className="toggle-label">Auto-infer IAB categories</span>
        </div>
        {effective.length > 0 ? (
          <div className="chip-row">
            {/* Removing a chip on a toggle-on deal MATERIALIZES the remaining
                displayed set as explicit picks — editing always converts the
                preview into a decision, never a silent drift. */}
            {effective.map(c =>
              chip(c, 'included', partition.unsupportedInclude.includes(c), () => removeInclude(c)))}
          </div>
        ) : (
          <span className="field-helper">
            {explicit
              ? 'Explicitly none — no IAB categories will be sent for this deal.'
              : autoInfer
                ? 'Nothing inferred from this deal’s details yet — nothing will be applied; pick categories below if the plan needs them.'
                : 'No IAB categories — none will be applied to this deal.'}
          </span>
        )}
        {partition.ixSplitNames.length > 0 && (
          <div className="banner-warning">
            <strong>Index Exchange: picks split across targeting keys.</strong>
            <p className="field-helper">
              IX resolves ALL of a deal's include + exclude categories on ONE key ({partition.ixKey} was
              selected for this deal — never mixed). {partition.ixSplitNames.join(', ')} only resolve on the
              other key and will NOT be applied. Re-pick so every name lives on one key — the picker tags
              each option '· genre' (contentGenre) or '· IAB' (iabContentCategory).
            </p>
          </div>
        )}
        <CardAccordion summary="Add include categories">
          <IabCatalogPicker ssp={deal.ssp} side="include" commonNames={commonNames} selected={effective} onPick={addInclude} />
          <ChipInput
            ariaLabel="Add custom include category"
            placeholder={`${deal.ssp} catalog name to include — Enter adds (validated)`}
            onAdd={onFreeTextInclude}
          />
          {includeError && <span className="chip chip--invalid" role="alert">{includeError}</span>}
          {explicit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => { setIncludeError(''); patchDeal(deal.id, { iabCategories: undefined }) }}
            >
              Clear picks
            </button>
          )}
        </CardAccordion>
      </div>

      <div className="field-group">
        <span className="field-label">
          <span className="seg-tag seg-tag--block">EXCLUDE</span>{' '}
          categories
          <span className="field-label__hint">explicit only — never inferred</span>
        </span>
        {excludes.length > 0 ? (
          <div className="chip-row">
            {excludes.map(c =>
              chip(c, 'excluded', cap.excludes === 'none' || partition.unsupportedExclude.includes(c), () => removeExclude(c)))}
          </div>
        ) : (
          <span className="field-helper">
            {cap.excludes === 'none'
              ? `Not available — ${excludeCapNote.replace(`${deal.ssp}: `, '')}.`
              : 'No exclusions — nothing is blocked by category for this deal.'}
          </span>
        )}
        {cap.excludes !== 'none' && (
          <CardAccordion summary="Add exclude categories">
            <IabCatalogPicker ssp={deal.ssp} side="exclude" commonNames={commonNames} selected={excludes} onPick={addExclude} />
            <ChipInput
              ariaLabel="Add custom exclude category"
              placeholder={`${deal.ssp} catalog name to exclude — Enter adds (validated)`}
              onAdd={onFreeTextExclude}
            />
            {excludeError && <span className="chip chip--invalid" role="alert">{excludeError}</span>}
          </CardAccordion>
        )}
        {(cap.excludes !== 'none' || excludes.length > 0) && (
          <span className="field-helper">{excludeCapNote}</span>
        )}
      </div>
    </div>
  )
}

const GEO_PLACEHOLDER: Record<GeoType, string> = {
  country: '',
  state: 'e.g. California',
  zip: 'e.g. 10001, 90210',
  dma: 'e.g. 602 (Nielsen DMA)',
}

const DEAL_LANGUAGES = ['', 'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Japanese', 'Mandarin']

// Viewability buckets, WHOLE percents. IX's Viewability targeting key is a
// discrete "X% or higher" catalog — arbitrary integers fail the whole create
// at the MCP ("No match found for viewability threshold: 0.71", DEAL07255
// where a scroll tick turned a typed 70 into 71). Deciles are the standard
// IX bucket grid (70 verified live 2026-07-20); OpenX/PubMatic/Media.net
// accept any integer, so the stricter grid is safe everywhere. Mirrored by
// the Go audit's viewability_code rule — change BOTH together.
const VIEWABILITY_TARGETS = ['10', '20', '30', '40', '50', '60', '70', '80', '90']

interface SegmentListProps {
  label: string
  /** 'allow' (include) or 'block' (exclude) — renders a colored badge so the
   *  two lists are unmistakable at a glance. */
  tone?: 'allow' | 'block'
  hint?: string
  required?: boolean
  segments: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  helperText?: string
  errorMessage?: string
}

function SegmentList({ label, tone, hint, required, segments, onChange, placeholder, helperText, errorMessage }: SegmentListProps) {
  // Show one empty input as a starting point when the array is empty.
  const display = segments.length === 0 ? [''] : segments
  const filledCount = segments.filter(s => s.trim()).length

  const updateAt = (i: number, value: string) => {
    if (segments.length === 0) {
      onChange([value])
      return
    }
    const next = segments.slice()
    next[i] = value
    onChange(next)
  }

  const removeAt = (i: number) => {
    if (segments.length === 0) return
    onChange(segments.filter((_, idx) => idx !== i))
  }

  const addEmpty = () => {
    onChange([...(segments.length === 0 ? [] : segments), ''])
  }

  // Smart paste: a multi-line clipboard payload becomes multiple inputs at once.
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, atIndex: number) => {
    const text = e.clipboardData.getData('text')
    if (!text.includes('\n')) return // single line — let normal paste happen
    e.preventDefault()
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
    if (lines.length === 0) return
    const base = segments.length === 0 ? [''] : segments
    const before = base.slice(0, atIndex).filter(Boolean)
    const after = base.slice(atIndex + 1).filter(Boolean)
    onChange([...before, ...lines, ...after])
  }

  // Strip empty rows when the user moves focus away — keeps the list tidy.
  const handleBlur = () => {
    const cleaned = segments.filter(s => s.trim())
    if (cleaned.length !== segments.length) onChange(cleaned)
  }

  return (
    <div className="field-group">
      <span className={`field-label${required ? ' required' : ''}`}>
        {tone && <span className={`seg-tag seg-tag--${tone}`}>{tone === 'allow' ? 'ALLOW' : 'BLOCK'}</span>}{' '}
        {label}
        {hint && <span className="field-label__hint">{hint}</span>}
        {filledCount > 0 && <span className="field-count-badge">{filledCount}</span>}
      </span>
      <div className="segment-list">
        {display.map((s, i) => (
          <div key={i} className="segment-list-item">
            <input
              type="text"
              className={`field-input segment-list-input${errorMessage && filledCount === 0 ? ' field-input--error' : ''}`}
              value={s}
              onChange={e => updateAt(i, e.target.value)}
              onPaste={e => handlePaste(e, i)}
              onBlur={handleBlur}
              placeholder={placeholder}
              aria-label={`${tone === 'block' ? 'Block' : 'Allow'} ${label} ${i + 1}`}
            />
            {display.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={`Remove segment ${i + 1}`}
                onClick={() => removeAt(i)}
                tabIndex={-1}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.95rem', height: '0.95rem' }} aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm segment-list-add" onClick={addEmpty}>
          + Add {label.endsWith('s') ? label.slice(0, -1) : label}
        </button>
      </div>
      {helperText && <span className="field-helper">{helperText}</span>}
      {errorMessage && filledCount === 0 && <span className="field-error">{errorMessage}</span>}
    </div>
  )
}

export function DealsList({ form, update, open, onToggle, filled, total, issues, dealIssues, standardLists = [] }: Props) {
  // Options for a per-deal list selector of the given scope: the trader's
  // uploaded files for that pool + the matching standard lists.
  const listOptions = (scope: 'domain' | 'app_bundle'): { id: string; name: string }[] => {
    const uploads: UploadedFile[] = scope === 'domain' ? form.domainLists : form.appBundleLists
    const std = standardLists.filter(l => l.scope === scope)
    return [
      ...uploads.map(u => ({ id: u.id, name: u.name })),
      ...std.map(s => ({ id: s.id, name: s.name })),
    ]
  }

  const issuesByDeal = new Map<string, DealIssue[]>()
  for (const iss of dealIssues || []) {
    const list = issuesByDeal.get(iss.dealId) || []
    list.push(iss)
    issuesByDeal.set(iss.dealId, list)
  }

  const patchDeal = (id: string, patch: Partial<DealEntry>) => {
    update('deals', form.deals.map(d => d.id === id ? { ...d, ...patch } : d))
  }

  const addDeal = () => {
    update('deals', [...form.deals, newDeal()])
  }

  const duplicateDeal = (id: string) => {
    const source = form.deals.find(d => d.id === id)
    if (!source) return
    const copy: DealEntry = {
      ...source,
      id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nameOverride: '',
      // A typed exception is per deal, not a reusable targeting default.
      exclusionOverride: undefined,
      geoInclude: source.geoInclude.map(g => ({ ...g, id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })),
      geoExclude: source.geoExclude.map(g => ({ ...g, id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })),
      includeSegments: [...source.includeSegments],
      excludeSegments: [...source.excludeSegments],
    }
    update('deals', [...form.deals, copy])
  }

  // Removing the last deal returns the section to its zero state (the
  // "No deals yet" empty card) — replacing it with a fresh blank card made
  // the Remove button look like it did nothing.
  // Also drop the removed deal's id from every uploaded file's appliesTo —
  // a stale id would silently shrink the file's scope (resolve() ignores
  // dead ids as a backstop, but the stored state should stay clean).
  const removeDeal = (id: string) => {
    update('deals', form.deals.filter(d => d.id !== id))
    const strip = (files: UploadedFile[]) =>
      files.map(f => f.appliesTo?.includes(id) ? { ...f, appliesTo: f.appliesTo.filter(x => x !== id) } : f)
    if (form.domainLists.some(f => f.appliesTo?.includes(id))) update('domainLists', strip(form.domainLists))
    if (form.appBundleLists.some(f => f.appliesTo?.includes(id))) update('appBundleLists', strip(form.appBundleLists))
  }

  // Per-card collapse state, keyed by deal id (default: expanded). Collapsed
  // cards render a one-line summary so a long batch is scannable; the body
  // stays out of the DOM.
  const [collapsedIds, setCollapsedIds] = useState<Record<string, boolean>>({})
  const setCardCollapsed = (id: string, next: boolean) =>
    setCollapsedIds(prev => (!!prev[id] === next ? prev : { ...prev, [id]: next }))
  const collapseAllDeals = () => {
    const next: Record<string, boolean> = {}
    for (const d of form.deals) next[d.id] = true
    setCollapsedIds(next)
  }
  const expandAllDeals = () => setCollapsedIds({})
  const anyCollapsed = form.deals.some(d => collapsedIds[d.id])

  // A card that PICKS UP issues pops open so the red outlines are visible —
  // only ids newly added to the error set expand, so fixing one deal never
  // re-expands another the trader deliberately collapsed.
  const errDealKey = useMemo(
    () => Array.from(new Set((dealIssues || []).map(i => i.dealId))).sort().join('|'),
    [dealIssues],
  )
  const prevErrIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const current = new Set(errDealKey ? errDealKey.split('|') : [])
    const added = Array.from(current).filter(id => !prevErrIdsRef.current.has(id))
    prevErrIdsRef.current = current
    if (added.length === 0) return
    setCollapsedIds(prev => {
      let changed = false
      const next = { ...prev }
      for (const id of added) {
        if (next[id]) { next[id] = false; changed = true }
      }
      return changed ? next : prev
    })
  }, [errDealKey])

  // Jump-reveal contract: audit/QA "Fix →" resolves to element ids suffixed
  // with the deal id (e.g. deal-theme-<id>). Expand the owning card — and,
  // for fields living inside the Optional-extras accordion, nudge that open
  // too — before the jump's delayed getElementById runs. See lib/reveal.ts.
  const [extrasRevealIds, setExtrasRevealIds] = useState<Record<string, boolean>>({})
  // Which deal:scope list pickers are open — the assignment row shows a chip
  // (or empty state) by default and only reveals the select on demand.
  const [listPickerFor, setListPickerFor] = useState<Record<string, boolean>>({})
  // Targeting-accordion reveals: a jump into the IAB editor or the read-only
  // geo-exclusion rows must open the owning TargetingGroup, same contract as
  // the Performance & video extras.
  const [revealGroups, setRevealGroups] = useState<Record<string, { content?: boolean; geography?: boolean }>>({})
  useEffect(() => {
    const onReveal = (e: Event) => {
      const elementId = (e as CustomEvent<string>).detail
      if (typeof elementId !== 'string' || !elementId) return
      setCollapsedIds(prev => {
        const hit = form.deals.find(d => prev[d.id] && elementId.endsWith(`-${d.id}`))
        return hit ? { ...prev, [hit.id]: false } : prev
      })
      const extras = /^deal-(?:vcr|viewability|language|adDurations|maxAdDurationSecs)-(.+)$/.exec(elementId)
      if (extras) setExtrasRevealIds(prev => (prev[extras[1]] ? prev : { ...prev, [extras[1]]: true }))
      const grp = /^deal-(iabCategories|geoExclude)-(.+)$/.exec(elementId)
      if (grp) {
        const key = grp[1] === 'iabCategories' ? 'content' as const : 'geography' as const
        setRevealGroups(prev => (prev[grp[2]]?.[key] ? prev : { ...prev, [grp[2]]: { ...prev[grp[2]], [key]: true } }))
      }
    }
    window.addEventListener(JUMP_REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(JUMP_REVEAL_EVENT, onReveal)
  }, [form.deals])

  // Deal id pending removal confirmation. A pristine deal (nothing typed in)
  // is removed without nagging — the dialog only guards real work.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const dealHasContent = (d: DealEntry): boolean =>
    Boolean(
      d.theme || d.ssp || d.channel || d.cpm || d.nameOverride ||
      d.includeSegments.some(s => s.trim()) || d.excludeSegments.some(s => s.trim()) ||
      d.geoInclude.length > 0 || d.geoExclude.length > 0,
    )
  const requestRemoveDeal = (deal: DealEntry) => {
    if (dealHasContent(deal)) setConfirmRemoveId(deal.id)
    else removeDeal(deal.id)
  }
  const confirmRemoveDeal = form.deals.find(d => d.id === confirmRemoveId)
  const confirmRemoveIndex = confirmRemoveDeal ? form.deals.findIndex(d => d.id === confirmRemoveId) : -1

  const fieldError = (dealId: string, field: string): string | undefined => {
    const issues = issuesByDeal.get(dealId) || []
    return issues.find(i => i.field === field)?.message
  }

  const renderDeal = (deal: DealEntry, index: number) => {
    const dealErrors = issuesByDeal.get(deal.id) || []
    const hasErrors = dealErrors.length > 0
    const isVideo = deal.channel ? isVideoChannel(deal.channel) : false
    const generatedName = generateDealName(form, deal)
    // Multi-DSP expansion: this card is one form row but N created deals
    // (one per active DSP). The input shows the first DSP's name; the label
    // hint says how many per-DSP variants exist — consistent with the deal
    // matrix sidebar, which lists every expanded row. Overrides never expand.
    const dspVariantCount = deal.nameOverride.trim() ? 1 : activeDsps(form).length
    const req = deal.ssp ? sspReq(deal.ssp) : { needsFloor: false, requiresSegments: false, hasSharedFloor: false, notes: '' }
    const segmentsRequired = req.requiresSegments
    const floorRequired = req.needsFloor
    const sspChosen = !!deal.ssp
    const geoTypes = sspGeoTypes(deal.ssp)
    const exclusionBlock = dealErrors.find(e =>
      (e.field === 'excludeSegments' || e.field === 'geoExclude' || e.field === 'defaultGeoExclude') &&
      /exclusion|excluded geo|excluded audience/i.test(e.message) &&
      !/competitive-separation|client contractual/i.test(e.message))
    // Typing changes the form and intentionally clears stale audit issues;
    // keep this control mounted while its draft acknowledgement is edited.
    const showExclusionOverride = !!exclusionBlock || !!deal.exclusionOverride?.acknowledgement
    const eligibleSsps = SSP_OPTIONS

    // One site/app-bundle list row: the three-state selector plus an explicit
    // allow/block indicator. Uploaded files carry their own inclusionType, so we
    // render a toggle that flips it (applies wherever the file is used — the
    // list's allow/block nature is intrinsic to the file). Curated/standard
    // lists have a fixed kind, so they show a read-only badge instead.
    // ── Domains & app bundles: ASSIGNMENT-ONLY UI. Lists are acquired via
    //    chat or the Files step; this row only shows
    //    what ships for THIS deal and adjusts the assignment among lists that
    //    already exist — it never uploads. Wire-exact via dealListAssignments:
    //    OpenX ships both dimensions (separate url_targeting / app_inventory
    //    args); every other SSP ships only the channel-routed one, so the
    //    other dimension renders nothing (or an amber warning if a leftover
    //    explicit pick can never ship — the old two-dropdown UI showed that
    //    state as a live-looking control that silently did nothing).
    const listAssignments = dealListAssignments(form, deal, standardLists)
    const renderListAssignment = (scope: 'domain' | 'app_bundle') => {
      const a: DealListAssignment = scope === 'domain' ? listAssignments.domain : listAssignments.app_bundle
      const listId = scope === 'domain' ? deal.domainListId : deal.appBundleListId
      const noun = scope === 'domain' ? 'site' : 'app-bundle'
      const targetsNoun = scope === 'domain' ? 'domains' : 'app bundles'
      const label = scope === 'domain' ? 'Site list (domains)' : 'App-bundle list'
      const pickerKey = `${deal.id}:${scope}`
      const pickerOpen = !!listPickerFor[pickerKey]
      const setPickerOpen = (open: boolean) => setListPickerFor(prev => ({ ...prev, [pickerKey]: open }))
      const options = listOptions(scope)
      const patchListId = (next: string | undefined) => {
        // Reset the per-deal allow/block override alongside the selection so a
        // stale override can't apply to a different list.
        patchDeal(deal.id, scope === 'domain'
          ? { domainListId: next, domainListInclusion: undefined }
          : { appBundleListId: next, appBundleListInclusion: undefined })
        setPickerOpen(false)
      }
      // Allow/Block always flips the per-deal override — never the shared
      // file's inclusionType, which would silently retarget every other deal
      // using the same upload.
      const setInc = (inc: 'Include' | 'Exclude') =>
        patchDeal(deal.id, scope === 'domain' ? { domainListInclusion: inc } : { appBundleListInclusion: inc })

      const picker = (
        <select
          className="field-select"
          value=""
          aria-label={`Choose a ${noun} list for deal ${index + 1}`}
          onChange={e => { if (e.target.value) patchListId(e.target.value) }}
        >
          <option value="">— Choose a {noun} list —</option>
          {(() => {
            const uploads: UploadedFile[] = scope === 'domain' ? form.domainLists : form.appBundleLists
            const std = standardLists.filter(l => l.scope === scope)
            return (
              <>
                {uploads.length > 0 && (
                  <optgroup label="This batch's files">
                    {uploads.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </optgroup>
                )}
                {std.length > 0 && (
                  <optgroup label="Standard library (curated)">
                    {std.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                )}
              </>
            )
          })()}
        </select>
      )

      // Channel-inapplicable dimension: render nothing — unless a leftover
      // explicit pick exists, which gets an honest warning instead of a
      // live-looking control that ships nothing.
      if (!a.ships) {
        if (listId && a.file) {
          return (
            <div className="list-assign list-assign--warn" key={scope} role="alert">
              <span>
                <strong>{a.file.name}</strong> is an {noun} list — {deal.channel ? `${deal.channel.replace(' (Online Video)', '')} deals` : 'this deal'} send{deal.channel ? '' : 's'} {scope === 'domain' ? 'app-bundle' : 'site'} lists only, so it will not ship.
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => patchListId(undefined)}>Remove</button>
            </div>
          )
        }
        return null
      }

      const shipsWhy = deal.ssp === 'OpenX'
        ? (scope === 'domain' ? 'web inventory · OpenX sends both list kinds' : 'app inventory · OpenX sends both list kinds')
        : scope === 'domain' ? 'ships with this deal (web inventory)' : 'ships with this deal (app inventory)'

      // A list ships: the chip states it plainly — name, allow/block, origin.
      if (a.file) {
        const srcLabel = a.explicit ? 'this deal' : a.file.source === 'curated' ? 'curated' : 'from campaign'
        return (
          <div className="field-group" key={scope}>
            <span className="field-label">{label} <span className="field-label__hint">{shipsWhy}</span></span>
            <div className="list-assign">
              <span className="list-assign__name" title={a.file.name}>{a.file.name}</span>
              <div className="listtype-toggle" role="group" aria-label={`${label} allow or block`}>
                <button
                  type="button"
                  className={`listtype-toggle__btn listtype-toggle__btn--allow${a.file.op === 'allowlist' ? ' is-active' : ''}`}
                  aria-pressed={a.file.op === 'allowlist'}
                  onClick={() => setInc('Include')}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className={`listtype-toggle__btn listtype-toggle__btn--block${a.file.op === 'blocklist' ? ' is-active' : ''}`}
                  aria-pressed={a.file.op === 'blocklist'}
                  onClick={() => setInc('Exclude')}
                >
                  Block
                </button>
              </div>
              <span className={`list-assign__src list-assign__src--${a.explicit ? 'deal' : a.file.source}`}>{srcLabel}</span>
              <button
                type="button"
                className="icon-action list-assign__remove"
                title={`Don't use a ${noun} list for this deal`}
                aria-label={`Remove ${noun} list from deal ${index + 1}`}
                onClick={() => patchListId('')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: '0.85rem', height: '0.85rem' }}><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            {pickerOpen
              ? picker
              : options.length > 1 && (
                  <button type="button" className="btn btn-ghost btn-sm list-assign__change" onClick={() => setPickerOpen(true)}>Change list</button>
                )}
            {a.disclosure === 'not_applied' && (
              <span className="field-helper">
                NOT APPLIED on {deal.ssp}: {deal.ssp === 'Xandr' ? 'Xandr takes no list file; configure a Curate deal list in the Xandr UI' : 'this SSP has no targeting field for this list'}
              </span>
            )}
            {a.disclosure === 'post_create_supply_domain' && (
              <span className="field-helper">TripleLift applies this POST-CREATE to supply-domain (site) targeting via tl_merge_deal_supply_domains</span>
            )}
            {deal.ssp === 'OpenX' && scope === 'app_bundle' && a.file.op === 'blocklist' && (
              <span className="field-helper">OpenX app-bundle targeting is include-only — a Block list will not ship on OpenX; flip to Allow or remove it.</span>
            )}
          </div>
        )
      }

      // The deal opted out of an existing campaign list — say so, offer the
      // way back. This replaces the old "No list (this deal only)" mystery.
      if (a.optedOutOf) {
        return (
          <div className="field-group" key={scope}>
            <span className="field-label">{label} <span className="field-label__hint">{shipsWhy}</span></span>
            <p className="list-assign__empty">
              Campaign list <strong>{a.optedOutOf}</strong> is not applied to this deal.{' '}
              <button type="button" className="btn-link" onClick={() => patchListId(undefined)}>Restore</button>
            </p>
          </div>
        )
      }

      // Nothing ships and nothing was opted out: the calm default.
      return (
        <div className="field-group" key={scope}>
          <span className="field-label">{label} <span className="field-label__hint">{shipsWhy}</span></span>
          <p className="list-assign__empty">No {noun} list — this deal targets all {targetsNoun}.</p>
          {pickerOpen
            ? picker
            : options.length > 0
              ? <button type="button" className="btn btn-ghost btn-sm list-assign__change" onClick={() => setPickerOpen(true)}>+ Add {noun} list</button>
              : <span className="field-helper">No lists in this batch yet — add them in the Files step (the next step).</span>}
        </div>
      )
    }

    const isCollapsed = !!collapsedIds[deal.id]
    const channelShort = deal.channel ? deal.channel.replace(' (Online Video)', '') : ''

    // ── Derived display state for the restructured card (Deal settings /
    //    Pricing / Targeting) — honest summaries for the accordion rows and
    //    the pricing provenance line. ──
    const feeIsPercent = form.feeType === 'Percentage of Media'
    const floorProvenance = (() => {
      if (!floorRequired) return ''
      if (deal.cpm.trim()) return `Effective floor: $${deal.cpm.trim()} (this deal)`
      const shared = isVideo ? form.defaultVideoCpm : form.defaultDisplayCpm
      if (shared) return `Effective floor: $${shared} (campaign ${isVideo ? 'video' : 'display'} default)`
      if (req.hasSharedFloor && deal.ssp === 'OpenX' && form.openxConfig.dealPrice) return `Effective floor: $${form.openxConfig.dealPrice} (OpenX batch Deal Price)`
      if (deal.ssp === 'Index Exchange') return 'Effective floor: $0.10 (IX minimum — ships automatically)'
      return 'No floor yet — set one here'
    })()
    const allowSegCount = deal.includeSegments.filter(s => s.trim()).length
    const blockSegCount = deal.excludeSegments.filter(s => s.trim()).length
    const segmentsAttention = !!(fieldError(deal.id, 'includeSegments') || fieldError(deal.id, 'excludeSegments'))
    const listResolved = dealListLabel(form, deal, standardLists)
    // Exclusions are a supported shape on the emitting SSPs (OpenX/PubMatic/
    // Xandr/Magnite — geoExcludeEmittingSSPs in rules.go), so their mere
    // presence is no longer "attention": only a real audit error is. An
    // unshippable shape still surfaces via fieldError(geoExclude).
    const geoRows = geoRowsOf(deal)
    const geoAttention = !!fieldError(deal.id, 'geoExclude')
    const geoSummary = (() => {
      const vals = deal.geoInclude.map(g => g.value.trim()).filter(Boolean)
      const base = vals.length === 0
        ? 'Global — no geo targeting'
        : vals.length <= 3 ? vals.join(', ') : `${vals.slice(0, 3).join(', ')} +${vals.length - 3}`
      const exCount = deal.geoExclude.filter(g => g.value.trim()).length
      return exCount > 0 ? `${base} · ${exCount} excluded` : base
    })()
    const iabIncludeCount = effectiveIabCategories(deal, form).length
    const iabExcludeCount = effectiveIabExcludes(deal).length
    const contentAttention = !!(fieldError(deal.id, 'iabCategories') || fieldError(deal.id, 'iabCategoriesExclude'))
    const perfParts = [
      deal.viewabilityTarget.trim() ? `Viewability ${deal.viewabilityTarget.trim()}%` : '',
      isVideo && deal.vcr.trim() ? `VCR ${deal.vcr.trim()}%` : '',
      deal.language || '',
      (deal.adDurations?.length ?? 0) > 0
        ? `${(deal.adDurations ?? []).join('/')}s ads`
        : deal.maxAdDurationSecs ? `max ${deal.maxAdDurationSecs}s` : '',
    ].filter(Boolean)
    const perfAttention = !!(
      fieldError(deal.id, 'vcr') || fieldError(deal.id, 'viewabilityTarget') || fieldError(deal.id, 'language')
      || fieldError(deal.id, 'adDurations') || fieldError(deal.id, 'maxAdDurationSecs'))

    return (
      <div key={deal.id} className={`deal-card${hasErrors ? ' deal-card--error' : ''}${isCollapsed ? ' deal-card--collapsed' : ''}`}>
        <div className="deal-card__header">
          {/* The title row is the collapse toggle (canonical flag +/− pattern);
              the labeled actions stay siblings so they never toggle the card. */}
          <button
            type="button"
            className="deal-card__toggle"
            aria-expanded={!isCollapsed}
            aria-controls={isCollapsed ? undefined : `deal-body-${deal.id}`}
            onClick={() => setCardCollapsed(deal.id, !isCollapsed)}
          >
            <span className="deal-card__number">Deal {index + 1}</span>
            {hasErrors ? (
              <span className="deal-card__badge deal-card__badge--error">{dealErrors.length} issue{dealErrors.length !== 1 ? 's' : ''}</span>
            ) : deal.theme && deal.channel && deal.ssp && (!segmentsRequired || deal.includeSegments.length > 0) ? (
              <span className="deal-card__badge deal-card__badge--ok">Ready</span>
            ) : (
              <span className="deal-card__badge deal-card__badge--partial">Incomplete</span>
            )}
            {isCollapsed && (
              <span className="deal-card__summary">
                <span className="deal-card__summary-theme">{deal.theme.trim() || 'Untitled audience'}</span>
                {deal.ssp && <span className="ssp-pill">{deal.ssp}</span>}
                {channelShort && <span className="chip chip--meta">{channelShort}</span>}
              </span>
            )}
          </button>
          {/* Icon action cluster: duplicate · remove · disclosure, with the
              +/− toggle on the far right. Icon-only (tooltips + aria-labels
              carry the names); the danger tint keeps remove unmistakable. */}
          <div className="deal-card__actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Duplicate deal ${index + 1}`}
              title="Duplicate this deal"
              onClick={() => duplicateDeal(deal.id)}
            >
              <svg viewBox="0 0 24 24" className="deal-card__action-icon" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#copy" /></svg>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm deal-card__remove"
              aria-label={`Remove deal ${index + 1}`}
              title="Remove this deal"
              onClick={() => requestRemoveDeal(deal)}
            >
              <svg viewBox="0 0 24 24" className="deal-card__action-icon" aria-hidden="true"><use href="/design-system/icons/core-icons.svg#trash" /></svg>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm deal-card__disclosure-btn"
              aria-expanded={!isCollapsed}
              aria-controls={isCollapsed ? undefined : `deal-body-${deal.id}`}
              aria-label={isCollapsed ? `Expand deal ${index + 1}` : `Collapse deal ${index + 1}`}
              title={isCollapsed ? 'Expand' : 'Collapse'}
              onClick={() => setCardCollapsed(deal.id, !isCollapsed)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="deal-card__disclosure-icon" aria-hidden="true">
                {isCollapsed ? <path d="M12 5v14M5 12h14" /> : <path d="M5 12h14" />}
              </svg>
            </button>
          </div>
        </div>

        {isCollapsed ? null : (
        <div id={`deal-body-${deal.id}`} className="deal-card__body">

        {/* ═══ DEAL SETTINGS — identity: who this deal is for and where it
            books. Mirrors the consoles' Basic/General section. ═══ */}
        <div className="deal-part">
          <span className="deal-part__title">Deal settings</span>

          {/* SSP leads the card — it decides which console the deal books
              into and flavors every section below it. */}
          <div className="field-row">
            <div className="field-group">
              <label className="field-label required" htmlFor={`deal-ssp-${deal.id}`}>SSP</label>
              <select
                id={`deal-ssp-${deal.id}`}
                className={`field-select${fieldError(deal.id, 'ssp') ? ' field-input--error' : ''}`}
                value={deal.ssp}
                onChange={e => {
                  const nextSsp = e.target.value as DealEntry['ssp']
                  patchDeal(deal.id, { ssp: nextSsp, exclusionOverride: undefined })
                }}
              >
                <option value="">— Select SSP —</option>
                {eligibleSsps.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {fieldError(deal.id, 'ssp') && <span className="field-error">{fieldError(deal.id, 'ssp')}</span>}
            </div>
            <div className="field-group">
              <label className="field-label required" htmlFor={`deal-theme-${deal.id}`}>Theme / Audience</label>
              <input
                id={`deal-theme-${deal.id}`}
                type="text"
                className={`field-input${fieldError(deal.id, 'theme') ? ' field-input--error' : ''}`}
                value={deal.theme}
                onChange={e => patchDeal(deal.id, { theme: e.target.value })}
                placeholder="e.g. In-market auto / Cold and Flu / Digital Consumer"
              />
              {fieldError(deal.id, 'theme') && <span className="field-error">{fieldError(deal.id, 'theme')}</span>}
            </div>
          </div>

          {/* DEAL NAME — auto-generated, but editable in place. Editing captures
              the value into nameOverride; Reset clears it back to auto.
              Length is checked LIVE on every keystroke (the audit's
              deal_name_length rule re-confirms server-side, anchored to this
              same field via deals[N].nameOverride) so the trader sees the
              ceiling the moment they type past it, not on the debounced
              re-audit. */}
          {(() => {
            // generatedName resolves the override itself: override verbatim,
            // none → the standard name. The length check must see the name
            // that actually ships.
            const finalName = generatedName
            const nameError = deal.ssp
              ? (dealNameLengthError(deal.ssp, deal.channel, finalName, !!deal.nameOverride.trim()) ?? fieldError(deal.id, 'nameOverride'))
              : fieldError(deal.id, 'nameOverride')
            // Show the raw override while the trader types (spaces survive).
            const shown = deal.nameOverride ? deal.nameOverride : generatedName
            return (
          <div className="deal-card__name">
            <label className="field-label" htmlFor={`deal-name-${deal.id}`}>
              Deal name <span className="field-label__hint">{deal.nameOverride.trim() ? 'custom — overrides auto-generation' : `auto-generated · click to edit${dspVariantCount > 1 ? ` · ×${dspVariantCount} DSP variants (matrix shows all)` : ''}`}</span>
            </label>
            <div className="deal-card__name-row">
              <input
                id={`deal-name-${deal.id}`}
                type="text"
                className={`field-input deal-card__name-input${nameError ? ' field-input--error' : ''}`}
                value={shown}
                onChange={e => patchDeal(deal.id, { nameOverride: e.target.value })}
                spellCheck={false}
                title={shown}
              />
              {deal.nameOverride.trim() && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm deal-card__name-reset"
                  onClick={() => patchDeal(deal.id, { nameOverride: '' })}
                  title="Reset to the auto-generated name"
                >
                  Reset to auto
                </button>
              )}
            </div>
            {nameError && <span className="field-error">{nameError}</span>}
          </div>
            )
          })()}

          {showExclusionOverride && deal.ssp && (
            <div className="banner-warning">
              <strong>Trader override — creates without the blocked exclusion(s)</strong>
              <p className="field-helper">This never overrides client contractual exclusions. The authenticated submit records your identity, time, deal, SSP, and every stripped value.</p>
              <label className="field-label" htmlFor={`deal-exclusion-override-${deal.id}`}>
                Type exactly: <code>{exclusionOverridePhrase(deal.ssp)}</code>
              </label>
              <input
                id={`deal-exclusion-override-${deal.id}`}
                className="field-input"
                value={deal.exclusionOverride?.ssp === deal.ssp ? deal.exclusionOverride.acknowledgement : ''}
                onChange={e => patchDeal(deal.id, { exclusionOverride: { ssp: deal.ssp, acknowledgement: e.target.value } })}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          {/* SSP requirements hint banner */}
          {sspChosen && req.notes && (
            <div className="deal-card__ssp-note">
              <strong>{deal.ssp}:</strong> {req.notes}
            </div>
          )}

          {/* REPORTING LABELS — Index Exchange only. The full set is resolved
              exactly as it'll be emitted; only External reference ID is
              per-deal editable, the rest come from campaign settings. */}
          {(() => {
            if (deal.ssp !== 'Index Exchange') return null
            const showExtRef = true
            const readOnly = resolveReportingLabels(form, deal, generatedName)
              .filter(l => l.key !== 'externalReferenceID')
            return (
              <div className="deal-card__section">
                <span className="deal-card__section-title">
                  Reporting labels <span className="field-label__hint">Index Exchange</span>
                </span>
                {showExtRef && (
                  <div className="field-group">
                    <label className="field-label" htmlFor={`deal-extref-${deal.id}`}>
                      External reference ID <span className="field-label__hint">per-deal · editable</span>
                    </label>
                    <input
                      id={`deal-extref-${deal.id}`}
                      type="text"
                      className="field-input"
                      value={deal.externalReferenceId}
                      onChange={e => patchDeal(deal.id, { externalReferenceId: e.target.value })}
                      placeholder="e.g. the client's opportunity or PO reference"
                      style={{ fontFamily: 'var(--font-code)', fontSize: 'var(--font-size-caption)' }}
                    />
                  </div>
                )}
                {readOnly.map(l => (
                  <div key={l.key} className="deal-card__label-row">
                    <span className="deal-card__label-key">{LABEL_DISPLAY[l.key] || l.key}</span>
                    <span className="deal-card__label-value" title={l.value}>{l.value}</span>
                    <span className="field-label__hint">from campaign settings</span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>

        {/* ═══ PRICING — the deal's floor plus the curated fee, together
            like every SSP console (OpenX Curated Deal Fees, Xandr Margin,
            Magnite Rev Share, Media.net Margin, TripleLift Curation fees). ═══ */}
        <div className="deal-part">
          <span className="deal-part__title">Pricing</span>

          {floorRequired && (
            <div className="field-row">
              <div className="field-group">
                <label className="field-label required" htmlFor={`deal-cpm-${deal.id}`}>
                  Floor CPM
                  <span className="field-label__hint">
                    blank = ${isVideo ? (form.defaultVideoCpm || '0.10') : (form.defaultDisplayCpm || '0.10')}
                    {req.hasSharedFloor && deal.ssp === 'OpenX' && form.openxConfig.dealPrice && ` or OpenX config $${form.openxConfig.dealPrice}`}
                  </span>
                </label>
                <input
                  id={`deal-cpm-${deal.id}`}
                  type="number"
                  className={`field-input${fieldError(deal.id, 'cpm') ? ' field-input--error' : ''}`}
                  value={deal.cpm}
                  onChange={e => patchDeal(deal.id, { cpm: e.target.value })}
                  placeholder={isVideo ? form.defaultVideoCpm || '0.10' : form.defaultDisplayCpm || '0.10'}
                  step="0.01"
                  min="0"
                />
                <span className="field-helper">{floorProvenance}</span>
                {fieldError(deal.id, 'cpm') && <span className="field-error">{fieldError(deal.id, 'cpm')}</span>}
              </div>
            </div>
          )}
          {!floorRequired && deal.ssp === 'Magnite' && (
            <p className="field-helper" style={{ margin: 0 }}>
              Magnite deals take no per-deal CPM — margin rides on rev-share and the ClearLine floor stays the
              publisher-tab floor from the Magnite panel (the $0.10 standard), never the deal CPM.
            </p>
          )}

          {/* Curated deal fee — the curator's margin, read-only here: it's a
              campaign-level commercial term set in the Campaign section; each
              SSP carries it on its own wire (rev-share / gross share). */}
          <div className="pricing-fee" title="The curated deal fee — set once per campaign in the Campaign section; every SSP carries it as its own margin field.">
            <span className="pricing-fee__label">Curated deal fee</span>
            <span className="pricing-fee__value">
              {form.curatedDealFee
                ? `${feeIsPercent ? '' : '$'}${form.curatedDealFee}${feeIsPercent ? '%' : ''} · ${form.feeType || 'fee type not set'}`
                : 'Not set'}
            </span>
            <span className="pricing-fee__note">
              {deal.ssp === 'Magnite'
                ? 'rides ClearLine rev-share'
                : deal.ssp === 'OpenX'
                  ? (form.openxConfig.grossShare ? `OpenX gross share override: ${form.openxConfig.grossShare}%` : 'emitted as OpenX gross share')
                  : 'from the Campaign section'}
            </span>
          </div>
        </div>

        {/* ═══ TARGETING — Core Targeting always visible (channel/environment
            tiles, the OpenX/PubMatic idiom), advanced dimensions as the
            Index-style accordion with honest value summaries. ═══ */}
        <div className="deal-part">
          <span className="deal-part__title">Targeting</span>

          <div className="field-group">
            <span className="field-label required" id={`deal-channel-label-${deal.id}`}>
              Channel <span className="field-label__hint">drives the deal name, video rules & list scoping</span>
            </span>
            <TileGroup
              id={`deal-channel-${deal.id}`}
              ariaLabel={`Deal ${index + 1} channel`}
              options={CHANNEL_OPTIONS.map(c => ({ value: c, label: c.replace(' (Online Video)', '') }))}
              value={deal.channel}
              error={!!fieldError(deal.id, 'channel')}
              onSelect={next => {
                const nextChannel = next as DealEntry['channel']
                const patch: Partial<DealEntry> = { channel: nextChannel, exclusionOverride: undefined }
                // Magnite ad-format ids are channel-specific (display/video/native).
                // If the format family changes, the old ids are invalid for the new
                // channel — clear them so we never emit a wrong-format `sizes` list.
                if (deal.ssp === 'Magnite' && (deal.magniteSizes?.length ?? 0) > 0
                    && magniteFormatKind(nextChannel) !== magniteFormatKind(deal.channel)) {
                  patch.magniteSizes = []
                }
                patchDeal(deal.id, patch)
              }}
            />
            {fieldError(deal.id, 'channel') && <span className="field-error">{fieldError(deal.id, 'channel')}</span>}
          </div>

          <div className="field-group">
            <span className="field-label" id={`deal-inv-label-${deal.id}`}>
              Environment <span className="field-label__hint">inventory the deal may serve into</span>
            </span>
            <TileGroup
              id={`deal-inv-${deal.id}`}
              ariaLabel={`Deal ${index + 1} environment`}
              options={[
                { value: 'All', label: 'All' },
                { value: 'Web Only', label: 'Web' },
                { value: 'In-App', label: 'In-app' },
              ]}
              value={deal.inventoryType}
              allowClear
              onSelect={next => patchDeal(deal.id, { inventoryType: next as DealEntry['inventoryType'] })}
            />
            {!deal.inventoryType && (
              <span className="field-helper">Using the campaign default ({form.defaultInventoryType || 'All'}) — pick a tile to pin this deal.</span>
            )}
          </div>

          {/* MAGNITE AD FORMATS — required core targeting for DV+ deals; the
              API 422s size-less display/video/native creates. */}
          {(() => {
            if (deal.ssp !== 'Magnite') return null
            const kind = magniteFormatKind(deal.channel)
            if (!kind) {
              if (deal.channel === 'Audio') {
                return (
                  <div className="field-group" id={`deal-magniteSizes-${deal.id}`}>
                    <span className="field-label">Ad formats <span className="field-label__hint">Audio · DV+</span></span>
                    <p className="field-helper" style={{ margin: 0 }}>Audio DV+ deals use <code>feedTypes</code>, not ad sizes — set them in the ClearLine console or via the agent. Nothing to pick here.</p>
                  </div>
                )
              }
              return null // CTV → SpringServe (no sizes), or channel not chosen yet
            }
            const catalog = MAGNITE_FORMATS_BY_KIND[kind]
            const selected = deal.magniteSizes || []
            const atMax = selected.length >= MAGNITE_SIZES_MAX
            const toggle = (idStr: string) => {
              // Magnite rejects >15 sizes per deal — adding locks at the cap
              // (removals always work).
              if (!selected.includes(idStr) && atMax) return
              patchDeal(deal.id, { magniteSizes: selected.includes(idStr) ? selected.filter(s => s !== idStr) : [...selected, idStr] })
            }
            const errMsg = fieldError(deal.id, 'magniteSizes')
            const kindLabel = kind === 'display' ? 'display sizes' : kind === 'video' ? 'video formats' : 'native formats'
            const labelById = new Map(catalog.map(f => [String(f.id), f.label]))
            return (
              <div className="field-group" id={`deal-magniteSizes-${deal.id}`}>
                <span className="field-label required">
                  Ad formats <span className="field-label__hint">Magnite {kind} · DV+</span>
                </span>
                {errMsg && <span className="field-error">{errMsg}</span>}
                <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
                  {kind === 'display' && (
                    <button type="button" className="btn btn-secondary btn-sm"
                      onClick={() => patchDeal(deal.id, { magniteSizes: MAGNITE_POPULAR_SIZE_IDS.map(String) })}>
                      Select most popular
                    </button>
                  )}
                  {selected.length > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => patchDeal(deal.id, { magniteSizes: [] })}>Clear</button>
                  )}
                </div>
                {kind === 'display' ? (
                  // Display: 478 live sizes — a searchable picker, not 478
                  // checkboxes. Selections are removable chips; a stale id
                  // (from an old draft) still renders and stays removable.
                  <>
                    {selected.length > 0 && (
                      <div className="chip-row">
                        {selected.map(idStr => (
                          <span key={idStr} className="chip">
                            {labelById.get(idStr) || `format id ${idStr}`}
                            <button
                              type="button"
                              className="chip__remove"
                              aria-label={`Remove display size ${labelById.get(idStr) || idStr}`}
                              onClick={() => toggle(idStr)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <MagniteSizePicker
                      dealId={deal.id}
                      catalog={catalog}
                      selected={selected}
                      atMax={atMax}
                      onAdd={toggle}
                    />
                    <span className="field-helper">
                      {selected.length}/{MAGNITE_SIZES_MAX} display sizes — one format type per deal, max {MAGNITE_SIZES_MAX} (Magnite create limit). Required or Magnite rejects the DV+ create.{atMax ? ' Cap reached — remove a size to add another.' : ''}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="checkbox-group">
                      {catalog.map(f => {
                        const idStr = String(f.id)
                        const isSelected = selected.includes(idStr)
                        return (
                          <label key={f.id} className="ds-checkbox-wrap">
                            <input type="checkbox" checked={isSelected} disabled={!isSelected && atMax} onChange={() => toggle(idStr)} />
                            <span className="ds-checkbox"><span className="ds-checkbox__box" /><span className="ds-checkbox__label">{f.label}</span></span>
                          </label>
                        )
                      })}
                    </div>
                    <span className="field-helper">Pick the {kindLabel} for this deal — one format type per deal, max {MAGNITE_SIZES_MAX}. Required or Magnite rejects the DV+ create.{atMax ? ' Cap reached — untick a format to add another.' : ''}</span>
                  </>
                )}
              </div>
            )
          })()}

          <div className="targeting-groups">
            {/* SEGMENTS / AUDIENCES — OpenX deals target PRE-BUILT audiences
                (segments are combined into an audience at build time, in the
                OpenX UI or by the data provider's push into the seat), so the
                card speaks OpenX's noun there; every other SSP targets raw
                segments and keeps the generic label. */}
            <TargetingGroup
              title={deal.ssp === 'OpenX' ? 'Audiences' : 'Segments'}
              state={segmentsAttention ? 'attention' : allowSegCount + blockSegCount > 0 ? 'set' : segmentsRequired ? 'attention' : 'open'}
              forceOpen={segmentsAttention || (segmentsRequired && allowSegCount === 0)}
              summary={
                allowSegCount + blockSegCount > 0
                  ? [allowSegCount > 0 ? `${allowSegCount} allow` : '', blockSegCount > 0 ? `${blockSegCount} block` : ''].filter(Boolean).join(' · ')
                  : segmentsRequired ? `required for ${deal.ssp}` : deal.ssp === 'OpenX' ? 'No audiences' : 'No segments'
              }
            >
              <div className="field-row">
                <SegmentList
                  label={deal.ssp === 'OpenX' ? 'audiences' : 'segments'}
                  tone="allow"
                  hint={!segmentsRequired ? `optional for ${deal.ssp || 'this SSP'}` : undefined}
                  required={segmentsRequired}
                  segments={deal.includeSegments}
                  onChange={next => patchDeal(deal.id, { includeSegments: next })}
                  placeholder={deal.ssp === 'OpenX' ? 'Cross Pixel > Audience portraits > Psychographics > Church Goers' : 'Health > Current > Cough and Cold Symptoms'}
                  helperText={deal.ssp === 'OpenX' ? 'OpenX targets pre-built audiences, not raw segments — each name must already exist in the target seat’s OpenAudience catalog before the run (built in the OpenX UI or pushed by the data provider). AND-logic between segments belongs inside the audience.' : undefined}
                  errorMessage={fieldError(deal.id, 'includeSegments')}
                />
                <SegmentList
                  label={deal.ssp === 'OpenX' ? 'audiences' : 'segments'}
                  tone="block"
                  hint="optional"
                  segments={deal.excludeSegments}
                  onChange={next => patchDeal(deal.id, { excludeSegments: next })}
                  placeholder="Weather Block List"
                  errorMessage={fieldError(deal.id, 'excludeSegments')}
                />
              </div>
            </TargetingGroup>

            {/* DOMAINS & APP BUNDLES */}
            <TargetingGroup
              title="Domains & app bundles"
              state={listResolved ? 'set' : 'open'}
              summary={listResolved
                ? `${listResolved.name} (${listResolved.op})${listResolved.disclosure === 'not_applied' ? ' — not applied on this SSP' : ''}`
                : 'All domains and app bundles'}
            >
              {renderListAssignment('domain')}
              {renderListAssignment('app_bundle')}
              {!listAssignments.domain.ships && !listAssignments.app_bundle.ships && !deal.channel && (
                <p className="list-assign__empty">Pick a channel first — it decides whether this deal sends a site list or an app-bundle list.</p>
              )}
            </TargetingGroup>

            {/* GEOGRAPHY */}
            <TargetingGroup
              title="Geography"
              anchorId={`deal-geo-group-${deal.id}`}
              state={geoAttention ? 'attention' : geoRows.some(r => r.entry.value.trim()) ? 'set' : 'open'}
              forceOpen={geoAttention || !!revealGroups[deal.id]?.geography}
              summary={geoSummary}
            >
              {/* Geo rows carry a DIRECTION. geoInclude and geoExclude stay
                  separate arrays on the deal (the prompt builders and the
                  geo_exclude_unsupported audit rule both read them that way),
                  but the trader sees ONE list with an Include/Exclude select
                  per row — flipping direction moves the entry between arrays,
                  preserving id/type/value so nothing has to be re-typed.

                  This replaces the old read-only "exclusions NOT applied"
                  block. That copy went stale on 2026-07-11 (#244,
                  569b755) when geo-exclude emission landed for OpenX/PubMatic/
                  Xandr/Magnite; it told traders to delete exclusions that in
                  fact ship correctly. Unshippable per-SSP shapes are still
                  caught — by the audit, which names the actual reason. */}
              <div className="field-group" id={`deal-geoExclude-${deal.id}`}>
                <label className="field-label">
                  Geo <span className="field-label__hint">{deal.ssp ? `${deal.ssp} accepts ${geoTypes.map(t => GEO_TYPE_LABEL[t]).join(' / ')}` : 'new deals start at US (house default); blank = Global (no geo targeting)'}</span>
                </label>
                {geoRows.length === 0 ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => patchDeal(deal.id, { geoInclude: [newGeo(geoTypes[0])] })}
                  >
                    + Add geo
                  </button>
                ) : (
                  <div className="deal-card__geo-list">
                    {geoRows.map(({ entry: g, dir }) => {
                      // Keep the stored type selectable even if the current SSP no
                      // longer offers it (e.g. after switching SSP) so the value
                      // stays visible until the trader fixes it.
                      const typeOpts = geoTypes.includes(g.type) ? geoTypes : [g.type, ...geoTypes]
                      const patchGeo = (patch: Partial<GeoEntry>) => patchDeal(deal.id, patchGeoRow(deal, g.id, dir, patch))
                      return (
                        <div key={g.id} className="deal-card__geo-row">
                          <select
                            className="field-select deal-card__geo-dir"
                            aria-label="Geo direction"
                            value={dir}
                            onChange={e => patchDeal(deal.id, moveGeoRow(deal, g.id, dir, e.target.value as GeoDir))}
                          >
                            <option value="include">Include</option>
                            <option value="exclude">Exclude</option>
                          </select>
                          <select
                            className="field-select deal-card__geo-type"
                            aria-label="Geo type"
                            value={g.type}
                            onChange={e => patchGeo({ type: e.target.value as GeoType, value: '' })}
                          >
                            {typeOpts.map(t => <option key={t} value={t}>{GEO_TYPE_LABEL[t]}</option>)}
                          </select>
                          {g.type === 'country' ? (
                            <select
                              className="field-select"
                              aria-label="Country"
                              value={g.value}
                              onChange={e => patchGeo({ value: e.target.value })}
                            >
                              {COUNTRY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                            </select>
                          ) : (
                            <input
                              type="text"
                              className={`field-input${dir === 'exclude' && fieldError(deal.id, 'geoExclude') ? ' field-input--error' : ''}`}
                              aria-label={`${dir === 'exclude' ? 'Exclude' : 'Include'} ${GEO_TYPE_LABEL[g.type]}`}
                              value={g.value}
                              onChange={e => patchGeo({ value: e.target.value })}
                              placeholder={GEO_PLACEHOLDER[g.type]}
                            />
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            aria-label={`Remove geo ${dir === 'exclude' ? 'exclusion' : ''}`.trim()}
                            onClick={() => patchDeal(deal.id, removeGeoRow(deal, g.id, dir))}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
                          </button>
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => patchDeal(deal.id, { geoInclude: [...deal.geoInclude, newGeo(geoTypes[0])] })}
                    >
                      + Add geo
                    </button>
                  </div>
                )}
                {fieldError(deal.id, 'geoExclude') && <span className="field-error">{fieldError(deal.id, 'geoExclude')}</span>}
              </div>

            </TargetingGroup>

            {/* CONTENT — IAB CATEGORIES */}
            <TargetingGroup
              title="Content — IAB categories"
              state={contentAttention ? 'attention' : iabIncludeCount + iabExcludeCount > 0 ? 'set' : 'open'}
              forceOpen={contentAttention || !!revealGroups[deal.id]?.content}
              summary={
                iabIncludeCount + iabExcludeCount > 0
                  ? [iabIncludeCount > 0 ? `${iabIncludeCount} included` : '', iabExcludeCount > 0 ? `${iabExcludeCount} excluded` : ''].filter(Boolean).join(' · ')
                  : deal.autoInferIab ? 'Auto-infer on — nothing inferred yet' : 'None — nothing applied'
              }
            >
              <DealIabSection deal={deal} form={form} patchDeal={patchDeal} />
            </TargetingGroup>

            {/* PERFORMANCE & VIDEO */}
            <TargetingGroup
              title="Performance & video"
              state={perfAttention ? 'attention' : perfParts.length > 0 ? 'set' : 'open'}
              forceOpen={perfAttention || !!extrasRevealIds[deal.id]}
              summary={perfParts.length > 0 ? perfParts.join(' · ') : 'Defaults — nothing pinned'}
            >
              <div className="field-row">
                <div className="field-group">
                  <label className="field-label" htmlFor={`deal-viewability-${deal.id}`}>
                    Viewability target <span className="field-label__hint">SSP buckets — default 70%</span>
                  </label>
                  {/* Dropdown, not a number input: IX only accepts its discrete
                      "X% or higher" catalog buckets — a free-typed 71 (the
                      DEAL07255 scroll casualty) fails the whole create at the
                      SSP. The vocabulary is pinned in VIEWABILITY_TARGETS and
                      enforced by the viewability_code audit rule; a persisted
                      off-vocabulary value renders as an explicit invalid
                      option so it stays visible until re-picked. */}
                  <select
                    id={`deal-viewability-${deal.id}`}
                    className="field-select"
                    value={deal.viewabilityTarget}
                    onChange={e => patchDeal(deal.id, { viewabilityTarget: e.target.value })}
                  >
                    <option value="">— None —</option>
                    {VIEWABILITY_TARGETS.map(v => (
                      <option key={v} value={v}>{v}% or higher{v === '70' ? ' (default)' : ''}</option>
                    ))}
                    {deal.viewabilityTarget.trim() !== '' && !VIEWABILITY_TARGETS.includes(deal.viewabilityTarget.trim()) && (
                      <option value={deal.viewabilityTarget}>{deal.viewabilityTarget}% — unsupported, pick a bucket</option>
                    )}
                  </select>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor={`deal-language-${deal.id}`}>
                    Language <span className="field-label__hint">blank = any</span>
                  </label>
                  <select
                    id={`deal-language-${deal.id}`}
                    className="field-select"
                    value={deal.language}
                    onChange={e => patchDeal(deal.id, { language: e.target.value })}
                  >
                    {DEAL_LANGUAGES.map(l => <option key={l} value={l}>{l || '— None —'}</option>)}
                  </select>
                </div>
                {isVideo && (
                  <div className="field-group">
                    <label className="field-label" htmlFor={`deal-vcr-${deal.id}`}>
                      VCR target <span className="field-label__hint">% — reporting only</span>
                    </label>
                    <input
                      id={`deal-vcr-${deal.id}`}
                      type="number"
                      className={`field-input${fieldError(deal.id, 'vcr') ? ' field-input--error' : ''}`}
                      value={deal.vcr}
                      onChange={e => patchDeal(deal.id, { vcr: e.target.value })}
                      placeholder={form.defaultVcr || '80'}
                      min="0"
                      max="100"
                    />
                    {fieldError(deal.id, 'vcr') && <span className="field-error">{fieldError(deal.id, 'vcr')}</span>}
                  </div>
                )}
              </div>
              {/* AD-DURATION TARGETING — CTV/OLV/OTT only (the brief-schema
                  ad_duration gate; Audio has no duration targeting). Two
                  alternative shapes: an allowed list of creative lengths OR a
                  max cap — integer SECONDS, undefined = unset. PubMatic and
                  TripleLift cannot express it; the generated prompt fails loud
                  there and the batch summary reports it as NOT APPLIED. */}
              {dealSupportsAdDuration(deal.channel) && (
                <div className="field-row">
                  <div className="field-group">
                    <label className="field-label" htmlFor={`deal-adDurations-${deal.id}`}>
                      Allowed ad durations <span className="field-label__hint">seconds, comma-separated</span>
                    </label>
                    <CommaListInput
                      id={`deal-adDurations-${deal.id}`}
                      value={deal.adDurations || []}
                      placeholder="e.g. 15, 30"
                      onCommit={list => patchDeal(deal.id, { adDurations: list.length > 0 ? list : undefined })}
                    />
                    <span className="field-helper">Only these creative lengths run (e.g. “only 15s and 30s ads”). Blank = no restriction.</span>
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor={`deal-maxAdDurationSecs-${deal.id}`}>
                      Max ad duration <span className="field-label__hint">seconds — alternative to the list</span>
                    </label>
                    <input
                      id={`deal-maxAdDurationSecs-${deal.id}`}
                      type="number"
                      className="field-input"
                      value={deal.maxAdDurationSecs || ''}
                      onChange={e => patchDeal(deal.id, { maxAdDurationSecs: e.target.value || undefined })}
                      placeholder="e.g. 30"
                      min="1"
                    />
                    <span className="field-helper">Caps ad length (e.g. “max 30 seconds”). Not expressible on PubMatic/TripleLift — the prompt flags it.</span>
                  </div>
                </div>
              )}
            </TargetingGroup>
          </div>
        </div>
        </div>
        )}
      </div>
    )
  }

  return (
    <FormSection
      number="04"
      title="Deals"
      anchorId="section-deals"
      open={open}
      onToggle={onToggle}
      filled={filled}
      total={total}
      issues={issues}
      headerExtra={form.deals.length > 0 ? <span className="chip">{form.deals.length}</span> : undefined}
    >
      {form.deals.length === 0 ? (
        <div className="deals-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="deals-empty-state__icon">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <line x1="3" y1="10" x2="21" y2="10" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
          <h3 className="deals-empty-state__title">No deals yet</h3>
          <p className="deals-empty-state__copy">
            Paste a trader brief into <strong>Parse Deal Data</strong> (top of the page) to auto-create deal cards, or start one manually below.
          </p>
          <button type="button" className="btn btn-primary" onClick={addDeal}>
            + Add your first deal
          </button>
        </div>
      ) : (
        <>
          {form.deals.length > 1 && (
            <div className="deals-list__bulk">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={anyCollapsed ? expandAllDeals : collapseAllDeals}
              >
                {anyCollapsed ? 'Expand all deals' : 'Collapse all deals'}
              </button>
            </div>
          )}

          <div className="deals-list">
            {form.deals.map((d, i) => renderDeal(d, i))}
          </div>

          <div className="deals-list__actions">
            <button type="button" className="btn btn-secondary" onClick={addDeal}>
              + Add Deal
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => duplicateDeal(form.deals[form.deals.length - 1].id)}>
              Duplicate last deal
            </button>
          </div>
        </>
      )}

      {confirmRemoveDeal && (
        <ConfirmDialog
          title={`Remove Deal ${confirmRemoveIndex + 1}?`}
          body={
            <>
              This deletes <strong>{confirmRemoveDeal.theme || `Deal ${confirmRemoveIndex + 1}`}</strong> and its
              configuration (segments, geo, lists) from the form. It can't be undone — use Duplicate first if you
              want to keep a copy.
            </>
          }
          confirmLabel="Remove deal"
          onConfirm={() => { removeDeal(confirmRemoveDeal.id); setConfirmRemoveId(null) }}
          onCancel={() => setConfirmRemoveId(null)}
        />
      )}
    </FormSection>
  )
}

// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { FormData } from '../types/deal'
import { campaignIdPlaceholder, useOperatorConfig } from '../lib/operatorConfig'
import { FormSection } from './FormSection'

const FUNNELS = ['', 'Awareness', 'Consideration', 'Conversion', 'Retention']

const FEE_TYPES = ['Fixed CPM', 'Percentage of Media', 'Flat Fee']

interface Props {
  form: FormData
  update: <K extends keyof FormData>(key: K, val: FormData[K]) => void
  open?: boolean
  onToggle?: (next: boolean) => void
  filled?: number
  total?: number
  issues?: number
  /** Audit failures keyed by fieldPath — red-outlines the offending input. */
  formIssues?: Record<string, string>
}

/** Campaign section — the campaign-level identity and commercial terms that
 *  every deal in the batch shares: agency, brand/advertiser, campaign name and
 *  id, data partner, funnel, attribution code, the curated deal fee, pacing
 *  and KPI goals, and the optional salesperson reporting label. */
export function Campaign({ form, update, open, onToggle, filled, total, issues, formIssues }: Props) {
  const err = (path: string) => formIssues?.[path]
  const operator = useOperatorConfig()
  const idPlaceholder = campaignIdPlaceholder(operator)
  const idLength = operator.campaignIdPrefix.length + 5

  // The Curated Deal Fee is a percentage on "Percentage of Media" and a dollar
  // amount otherwise — the input adorns itself to match so a 30 can't read as
  // $30 CPM (or a $1.00 as 1%).
  const feeIsPercent = form.feeType === 'Percentage of Media'
  const feePlaceholder = feeIsPercent ? '30' : form.feeType === 'Flat Fee' ? '5000' : '1.00'

  return (
    <FormSection number="02" title="Campaign" anchorId="section-client" open={open} onToggle={onToggle} filled={filled} total={total} issues={issues}>
      <div className="field-row">
        <div className="field-group">
          <label className="field-label required" htmlFor="agency">Agency</label>
          <input
            id="agency"
            type="text"
            className={`field-input${err('agency') ? ' field-input--error' : ''}`}
            value={form.agency}
            onChange={e => update('agency', e.target.value)}
            placeholder="e.g. Northwind Media (or NA for a direct deal)"
            aria-invalid={err('agency') ? true : undefined}
          />
          {err('agency') && <span className="field-error">{err('agency')}</span>}
        </div>
        <div className="field-group">
          <label className="field-label required" htmlFor="brand">Brand / Advertiser</label>
          <input
            id="brand"
            type="text"
            className={`field-input${err('brand') ? ' field-input--error' : ''}`}
            value={form.brand}
            onChange={e => update('brand', e.target.value)}
            placeholder="e.g. Contoso"
            aria-invalid={err('brand') ? true : undefined}
          />
          {err('brand') && <span className="field-error">{err('brand')}</span>}
        </div>
      </div>

      <div className="field-row">
        <div className="field-group">
          <label className="field-label" htmlFor="campaignName">Campaign Name</label>
          <input
            id="campaignName"
            type="text"
            className="field-input"
            value={form.campaignName}
            onChange={e => update('campaignName', e.target.value)}
            placeholder="Optional — the generated deal names are the canonical reference"
          />
        </div>
        <div className="field-group">
          <label className="field-label required" htmlFor="campaignId">
            Campaign ID <span className="field-label__hint">{idPlaceholder} · baked into every deal name</span>
          </label>
          <input
            id="campaignId"
            type="text"
            className={`field-input${err('campaignId') ? ' field-input--error' : ''}`}
            value={form.campaignId}
            onChange={e => update('campaignId', e.target.value.toUpperCase())}
            placeholder={`e.g. ${operator.campaignIdPrefix}00137`}
            maxLength={idLength}
            pattern={`${operator.campaignIdPrefix}[0-9]{5}`}
            style={{ fontFamily: 'var(--font-code)' }}
            aria-invalid={err('campaignId') ? true : undefined}
          />
          {err('campaignId') && <span className="field-error">{err('campaignId')}</span>}
        </div>
      </div>

      <div className="field-row-3">
        <div className="field-group">
          <label className="field-label" htmlFor="dataPartner">
            Data Partner <span className="field-label__hint">optional · becomes deal-name slot 1</span>
          </label>
          <input
            id="dataPartner"
            type="text"
            className="field-input"
            value={form.dataPartner}
            onChange={e => update('dataPartner', e.target.value)}
            placeholder={`Blank = ${operator.orgName}`}
          />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="funnel">
            Funnel <span className="field-label__hint">optional</span>
          </label>
          <select
            id="funnel"
            className="field-select"
            value={form.funnel}
            onChange={e => update('funnel', e.target.value)}
          >
            {FUNNELS.map(f => (
              <option key={f} value={f}>{f || '— None —'}</option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="attributionCode">Attribution Code</label>
          <input
            id="attributionCode"
            type="text"
            className="field-input"
            value={form.attributionCode}
            onChange={e => update('attributionCode', e.target.value.toUpperCase())}
            placeholder={operator.defaultAttributionCode}
            maxLength={8}
            style={{ fontFamily: 'var(--font-code)' }}
          />
        </div>
      </div>

      {/* Commercials — the curation fee is a campaign-level term agreed with
          the client, so it lives here, not among per-deal fields. */}
      <div className="field-row-3">
        <div className="field-group">
          <label className="field-label required" htmlFor="curatedDealFee">Curated Deal Fee</label>
          <div className={feeIsPercent ? 'input-with-suffix' : 'input-with-prefix'}>
            {!feeIsPercent && <span className="input-prefix">$</span>}
            <input
              id="curatedDealFee"
              type="number"
              className={`field-input${err('curatedDealFee') ? ' field-input--error' : ''}`}
              value={form.curatedDealFee}
              onChange={e => update('curatedDealFee', e.target.value)}
              placeholder={feePlaceholder}
              step="0.01"
              min="0"
              max={feeIsPercent ? 100 : undefined}
              required
              aria-invalid={err('curatedDealFee') ? true : undefined}
            />
            {feeIsPercent && <span className="input-suffix">%</span>}
          </div>
          {err('curatedDealFee') && <span className="field-error">{err('curatedDealFee')}</span>}
        </div>
        <div className="field-group">
          <label className="field-label required" htmlFor="feeType">Fee Type</label>
          <select
            id="feeType"
            className={`field-select${err('feeType') ? ' field-input--error' : ''}`}
            value={form.feeType}
            onChange={e => update('feeType', e.target.value)}
            required
            aria-invalid={err('feeType') ? true : undefined}
          >
            <option value="">— Select fee type —</option>
            {FEE_TYPES.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          {err('feeType') && <span className="field-error">{err('feeType')}</span>}
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="dailyPacingGoal">Daily Pacing Goal</label>
          <div className="input-with-prefix">
            <span className="input-prefix">$</span>
            <input
              id="dailyPacingGoal"
              type="number"
              className="field-input"
              value={form.dailyPacingGoal}
              onChange={e => update('dailyPacingGoal', e.target.value)}
              placeholder="10000"
              step="0.01"
              min="0"
            />
          </div>
        </div>
      </div>

      <div className="field-row">
        <div className="field-group">
          <label className="field-label" htmlFor="kpiGoal">Campaign KPI Goal</label>
          <input
            id="kpiGoal"
            type="text"
            className="field-input"
            value={form.kpiGoal}
            onChange={e => update('kpiGoal', e.target.value)}
            placeholder="e.g. ROAS, DPVR, Viewability, Conversions"
          />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="salesperson">
            Salesperson <span className="field-label__hint">optional · Index Exchange reporting label</span>
          </label>
          <input
            id="salesperson"
            type="text"
            className={`field-input${err('reportingLabels.salesperson') || err('salesperson') ? ' field-input--error' : ''}`}
            value={form.reportingLabels.salesperson}
            onChange={e => update('reportingLabels', { ...form.reportingLabels, salesperson: e.target.value })}
            placeholder="e.g. Jane Doe"
            aria-invalid={err('reportingLabels.salesperson') || err('salesperson') ? true : undefined}
          />
          {(err('reportingLabels.salesperson') || err('salesperson')) && <span className="field-error">{err('reportingLabels.salesperson') || err('salesperson')}</span>}
        </div>
      </div>
    </FormSection>
  )
}

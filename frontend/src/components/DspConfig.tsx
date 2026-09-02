import { FormData, DspEntry } from '../types/deal'
import { seatOptionalDsp, splitSeatIds } from '../lib/seatPolicy'
import { FormSection } from './FormSection'

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

function newDSP(): DspEntry {
  return { id: String(Date.now()), dsp: '', seatId: '' }
}

export function DspConfig({ form, update, open, onToggle, filled, total, issues, formIssues }: Props) {
  const err = (path: string) => formIssues?.[path]
  const updateDSP = (id: string, field: keyof DspEntry, val: string) => {
    update('dsps', form.dsps.map(d => d.id === id ? { ...d, [field]: val } : d))
  }

  const addDSP = () => {
    update('dsps', [...form.dsps, newDSP()])
  }

  const removeDSP = (id: string) => {
    if (form.dsps.length <= 1) return
    update('dsps', form.dsps.filter(d => d.id !== id))
  }

  return (
    <FormSection number="03" title="DSP Configuration" anchorId="section-dsp" open={open} onToggle={onToggle} filled={filled} total={total} issues={issues}>
      <div className="dynamic-list">
        {form.dsps.map((d, i) => (
          <div key={d.id} className="dynamic-list-item">
            <div className="dynamic-list-item-fields">
              <div className="field-row">
                <div className="field-group">
                  <label className="field-label required" htmlFor={`dsp-${d.id}`}>
                    {i === 0 ? 'DSP' : `DSP ${i + 1}`}
                  </label>
                  <input
                    id={`dsp-${d.id}`}
                    type="text"
                    className={`field-input${err(`dsps[${i}].dsp`) ? ' field-input--error' : ''}`}
                    value={d.dsp}
                    onChange={e => updateDSP(d.id, 'dsp', e.target.value)}
                    placeholder="e.g. The Trade Desk"
                    aria-invalid={err(`dsps[${i}].dsp`) ? true : undefined}
                  />
                  {err(`dsps[${i}].dsp`) && <span className="field-error">{err(`dsps[${i}].dsp`)}</span>}
                </div>
                <div className="field-group">
                  <label className={`field-label${seatOptionalDsp(d.dsp) ? '' : ' required'}`} htmlFor={`seat-${d.id}`}>Seat ID</label>
                  <input
                    id={`seat-${d.id}`}
                    type="text"
                    className={`field-input${err(`dsps[${i}].seatId`) ? ' field-input--error' : ''}`}
                    value={d.seatId}
                    onChange={e => updateDSP(d.id, 'seatId', e.target.value)}
                    placeholder={seatOptionalDsp(d.dsp) ? 'Optional for this DSP' : 'e.g. 12345'}
                    aria-invalid={err(`dsps[${i}].seatId`) ? true : undefined}
                  />
                  {err(`dsps[${i}].seatId`) && <span className="field-error">{err(`dsps[${i}].seatId`)}</span>}
                  {/* Multi-seat receipt (seen live): only Magnite takes a buyer
                      LIST, so surface the parsed count the moment a trader
                      pastes one rather than letting the audit be the first
                      place they learn the field split at all. The seat_multi
                      rule is what actually blocks a non-Magnite batch. */}
                  {!err(`dsps[${i}].seatId`) && splitSeatIds(d.seatId).length > 1 && (
                    <span className="field-hint">
                      {splitSeatIds(d.seatId).length} buyer seats — Magnite only (every other SSP takes a single seat).
                      {/* Echo the split back: the raw list runs past the right
                          edge of a single-line input, so this is the only place
                          the trader can actually SEE every seat that will ship. */}
                      <span className="seat-id-parsed__list">{splitSeatIds(d.seatId).join(' · ')}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
            {form.multipleDsps && form.dsps.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label="Remove DSP"
                onClick={() => removeDSP(d.id)}
                style={{ marginTop: '1.5rem', flexShrink: 0 }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1rem', height: '1rem' }} aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="toggle-wrap">
        <label className="toggle" htmlFor="multipleDsps">
          <input
            id="multipleDsps"
            type="checkbox"
            checked={form.multipleDsps}
            onChange={e => update('multipleDsps', e.target.checked)}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </label>
        <span className="toggle-label">Multiple DSPs</span>
      </div>

      {form.multipleDsps && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={addDSP}>
          + Add DSP
        </button>
      )}
    </FormSection>
  )
}

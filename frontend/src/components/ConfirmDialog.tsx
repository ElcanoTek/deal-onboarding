import { ReactNode } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  title: string
  /** Explain what the action actually does — destructive actions never rely
   *  on the button label alone. */
  body: ReactNode
  confirmLabel: string
  /** 'danger' renders the confirm button destructively (default). */
  tone?: 'danger' | 'primary'
  busy?: boolean
  /** Extra class(es) on the modal card — e.g. a flat variant. */
  className?: string
  /** Darker mock scrim behind the dialog (edit/delete flows). */
  dim?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Small confirmation dialog for destructive actions (remove
 *  deal…). Replaces window.confirm with the design-system modal: focus
 *  trapped, Escape cancels, the destructive button styled as such. */
export function ConfirmDialog({ title, body, confirmLabel, tone = 'danger', busy, className, dim, onConfirm, onCancel }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>({ onEscape: () => { if (!busy) onCancel() } })
  return (
    <div
      className={`modal-backdrop${dim ? ' modal-backdrop--dim' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div className={`modal${className ? ` ${className}` : ''}`} ref={trapRef}>
        <h2 className="modal-title" id="confirm-dialog-title">{title}</h2>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          {/* Cancel takes initial focus — confirming should be deliberate. */}
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy && <span className="btn-spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

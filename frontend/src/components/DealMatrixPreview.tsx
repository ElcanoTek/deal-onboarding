// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useState } from 'react'
import { DealMatrix } from '../hooks/useDealMatrix'

interface Props {
  matrix: DealMatrix
}

export function DealMatrixPreview({ matrix }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false)

  const inner = (
    <>
      <div className="deal-count-display">
        <div className="deal-count-number">{matrix.totalDeals}</div>
        <div className="deal-count-formula">{matrix.formula}</div>
        {(matrix.sspCounts.length > 0 || matrix.channelCounts.length > 0) && (
          <div className="matrix-tallies">
            {matrix.sspCounts.map(([ssp, n]) => (
              <span key={`s-${ssp}`} className="ssp-pill">{ssp}{n > 1 ? ` ×${n}` : ''}</span>
            ))}
            {matrix.channelCounts.map(([ch, n]) => (
              <span key={`c-${ch}`} className="chip chip--meta">{ch}{n > 1 ? ` ×${n}` : ''}</span>
            ))}
          </div>
        )}
      </div>

      {matrix.items.length > 0 ? (
        <div className="deal-names-list" role="list" aria-label="Deal snapshot">
          {matrix.items.map((item, i) => (
            <div key={item.id} className="matrix-deal" role="listitem">
              <div className="matrix-deal__top">
                <span className="matrix-deal__idx">{i + 1}</span>
                <span className="matrix-deal__theme" title={item.theme || undefined}>
                  {item.theme || 'Untitled audience'}
                </span>
                {item.sspCode && <span className="ssp-pill">{item.sspCode}</span>}
                {item.channel && <span className="chip chip--meta">{item.channel}</span>}
              </div>
              <div className="matrix-deal__name" title={item.name}>{item.name}</div>
              <div className="matrix-deal__meta">
                {item.geo}
                {item.sheetOnly ? ' · sheet-only' : ''}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="deal-names-empty">
          Add at least one deal to see deal names.
        </div>
      )}
    </>
  )

  return (
    <div className="sidebar-area">
      {/* Mobile collapsed toggle */}
      <button
        type="button"
        className="mobile-sidebar-toggle"
        aria-expanded={mobileOpen}
        aria-controls="deal-matrix-body"
        onClick={() => setMobileOpen(o => !o)}
      >
        <span>Deal Matrix — {matrix.totalDeals} Deal{matrix.totalDeals !== 1 ? 's' : ''}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ width: '1rem', height: '1rem', transform: mobileOpen ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}
          aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className="sidebar-sticky">
        <div className="sidebar-card">
          <div className="sidebar-header">
            <div className="sidebar-title">Deal Matrix</div>
            <div className="sidebar-subtitle">Updates live as you fill the form</div>
          </div>
          {/* Desktop: always visible */}
          <div className="sidebar-collapsible-body is-open" id="deal-matrix-body" aria-live="polite">
            {inner}
          </div>
          {/* Mobile: toggled */}
          <div className="sidebar-collapsible-body mobile-only" style={{ display: 'none' }}>
            {inner}
          </div>
        </div>
      </div>

      {/* Mobile: the toggle is the only affordance — hide the whole card
          shell when closed (an empty bordered card with just the header
          reads as broken), show body + shell when open. */}
      <style>{`
        @media (max-width: 767px) {
          .sidebar-area .sidebar-sticky { display: ${mobileOpen ? 'flex' : 'none'} !important; }
          #deal-matrix-body { display: flex !important; flex-direction: column; }
        }
      `}</style>
    </div>
  )
}

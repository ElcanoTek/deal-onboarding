// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FORM, FormData, newDeal } from '../types/deal'
import { appliedResultLine, applyProposal, buildProposalDiff, countChangedDeals, undoApplied, AssistantProposal } from './assistantProposal'

function form(deals: FormData['deals']): FormData {
  return { ...DEFAULT_FORM, brand: 'Contoso', deals }
}

const d1 = { ...newDeal(), id: 'd1', theme: 'Sports', channel: 'CTV' as const, ssp: 'Index Exchange' as const, cpm: '8' }
const d2 = { ...newDeal(), id: 'd2', theme: 'News', channel: 'Display' as const, ssp: 'OpenX' as const, cpm: '0.5' }

describe('assistant proposal — diff preview → Apply → onFormChange → Undo', () => {
  const current = form([d1, d2])
  const proposal: AssistantProposal = {
    form: form([{ ...d1, cpm: '12' }, d2]),
    summary: 'Set CPM to 12 on the CTV deal.',
    changes: [{ path: 'deals[0].cpm', description: '8 → 12' }, { path: 'brand', description: 'unchanged' }],
    validation: [],
  }

  it('renders the diff per deal without touching the form', () => {
    const onFormChange = vi.fn()
    const diff = buildProposalDiff(current, proposal)
    expect(diff.rows).toEqual([
      { scope: 'Deal 1', description: 'cpm: 8 → 12' },
      { scope: 'Campaign', description: 'unchanged' },
    ])
    expect(diff.dealsBefore).toBe(2)
    expect(diff.dealsAfter).toBe(2)
    expect(diff.dealsChanged).toBe(1)
    // The preview alone never mutates the form.
    expect(onFormChange).not.toHaveBeenCalled()
  })

  it('Apply hands the COMPLETE proposed form to onFormChange exactly once', () => {
    const onFormChange = vi.fn()
    const snapshot = applyProposal(current, proposal, onFormChange)
    expect(onFormChange).toHaveBeenCalledTimes(1)
    expect(onFormChange).toHaveBeenCalledWith(proposal.form)
    expect(snapshot.previous).toBe(current)
    expect(snapshot.dealsChanged).toBe(1)
  })

  it('Undo restores the pre-apply form through onFormChange', () => {
    const onFormChange = vi.fn()
    const snapshot = applyProposal(current, proposal, onFormChange)
    undoApplied(snapshot, onFormChange)
    expect(onFormChange).toHaveBeenLastCalledWith(current)
    expect(onFormChange.mock.calls[1][0].deals[0].cpm).toBe('8')
  })

  it('counts added, removed, and edited deals', () => {
    const d3 = { ...newDeal(), id: 'd3', theme: 'Weather', channel: 'OLV (Online Video)' as const }
    expect(countChangedDeals(form([d1, d2]), form([d1, d2]))).toBe(0)
    expect(countChangedDeals(form([d1, d2]), form([d1, d3]))).toBe(2) // d2 removed, d3 added
    expect(countChangedDeals(form([d1, d2]), form([{ ...d1, theme: 'Sport' }, { ...d2, cpm: '1' }]))).toBe(2)
  })

  it('groups deals[] paths under "Deals"', () => {
    const diff = buildProposalDiff(current, { ...proposal, changes: [{ path: 'deals[]', description: 'Removed 1 OpenX deal.' }] })
    expect(diff.rows[0]).toEqual({ scope: 'Deals', description: 'Removed 1 OpenX deal.' })
  })

  it('formats the applied result line from the re-audit', () => {
    expect(appliedResultLine(6, null)).toBe('Applied: 6 deals changed. Audit: pending.')
    expect(appliedResultLine(1, { status: 'passed', checks: [{ passed: true }] })).toBe('Applied: 1 deal changed. Audit: passed.')
    expect(appliedResultLine(6, { status: 'failed', checks: [{ passed: false }, { passed: false }, { passed: true }] })).toBe('Applied: 6 deals changed. Audit: 2 failures remain.')
    expect(appliedResultLine(2, { status: 'failed', checks: [{ passed: false }] })).toBe('Applied: 2 deals changed. Audit: 1 failure remains.')
  })
})

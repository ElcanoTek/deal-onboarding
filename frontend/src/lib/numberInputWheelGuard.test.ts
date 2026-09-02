// @vitest-environment jsdom
// (The suite default is node — dealPromptYaml etc. are pure functions — but
// this guard is DOM behavior, so this file opts into jsdom.)
import { afterEach, describe, expect, it } from 'vitest'
import { installNumberInputWheelGuard } from './numberInputWheelGuard'

// Guard against the scroll footgun that shipped $0.08/$0.07 floors on the
// DEAL07254 E2E batch: a wheel event over a FOCUSED <input type="number">
// spins the value. The guard blurs the input (killing the spin) while page
// scrolling keeps working (no preventDefault).

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
  document.body.innerHTML = ''
})

function mount(type: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = type
  document.body.appendChild(input)
  return input
}

describe('installNumberInputWheelGuard', () => {
  it('blurs a focused number input when the wheel fires over it', () => {
    cleanup = installNumberInputWheelGuard(document)
    const input = mount('number')
    input.focus()
    expect(document.activeElement).toBe(input)
    input.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    expect(document.activeElement).not.toBe(input)
  })

  it('leaves a focused number input alone when scrolling elsewhere on the page', () => {
    cleanup = installNumberInputWheelGuard(document)
    const input = mount('number')
    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)
    input.focus()
    elsewhere.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    // Browsers only spin the value when the wheel is OVER the focused input —
    // scrolling the rest of the page must not kick the trader out of the field.
    expect(document.activeElement).toBe(input)
  })

  it('ignores non-number inputs and never calls preventDefault', () => {
    cleanup = installNumberInputWheelGuard(document)
    const text = mount('text')
    text.focus()
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
    text.dispatchEvent(ev)
    expect(document.activeElement).toBe(text)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('stops guarding after cleanup', () => {
    const uninstall = installNumberInputWheelGuard(document)
    uninstall()
    const input = mount('number')
    input.focus()
    input.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    expect(document.activeElement).toBe(input)
  })
})

describe('select guarding', () => {
  it('blurs a focused select when the wheel fires over it (Firefox spins selects)', () => {
    cleanup = installNumberInputWheelGuard(document)
    const select = document.createElement('select')
    select.appendChild(document.createElement('option'))
    document.body.appendChild(select)
    select.focus()
    select.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    expect(document.activeElement).not.toBe(select)
  })
})

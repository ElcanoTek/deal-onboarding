/** Jump-target reveal contract.
 *
 *  Audit / QA "Fix →" jumps resolve a field to a DOM element id, then
 *  getElementById + scrollIntoView after a short delay. Collapsible containers
 *  (the deal cards) keep collapsed content out of the DOM, so a jump into a
 *  collapsed card would silently no-op. Jump sites call requestJumpReveal(id)
 *  BEFORE their delayed lookup; any container owning that element expands in
 *  the intervening render. Unknown ids are ignored — dispatching is always
 *  safe. */

export const JUMP_REVEAL_EVENT = 'deal-onboarding:reveal-jump-target'

export function requestJumpReveal(elementId: string): void {
  if (!elementId) return
  window.dispatchEvent(new CustomEvent<string>(JUMP_REVEAL_EVENT, { detail: elementId }))
}

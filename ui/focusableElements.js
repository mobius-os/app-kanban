const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function visibleFocusableElements(dialog, styleFor = globalThis.getComputedStyle) {
  return Array.from(dialog?.querySelectorAll(FOCUSABLE) || [])
    .filter(element => element.getClientRects().length > 0
      && !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && styleFor(element).visibility !== 'hidden')
}

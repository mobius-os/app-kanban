import test from 'node:test'
import assert from 'node:assert/strict'

import { visibleFocusableElements } from '../ui/focusableElements.js'

function element({ rendered = true, hiddenAncestor = false, visibility = 'visible' } = {}) {
  return {
    getClientRects: () => rendered ? [{}] : [],
    closest: () => hiddenAncestor ? {} : null,
    visibility,
  }
}

test('modal focus excludes CSS-hidden and semantically hidden controls', () => {
  const visible = element()
  const displayNone = element({ rendered: false })
  const hiddenAncestor = element({ hiddenAncestor: true })
  const visibilityHidden = element({ visibility: 'hidden' })
  const dialog = { querySelectorAll: () => [displayNone, visible, hiddenAncestor, visibilityHidden] }
  assert.deepEqual(
    visibleFocusableElements(dialog, candidate => ({ visibility: candidate.visibility })),
    [visible],
  )
})

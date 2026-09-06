import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'
const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
test('long lists scroll instead of compressing card content', () => {
  assert.match(CSS, /\.kb-board \{[^}]*min-height: 0/s)
  assert.match(CSS, /\.kb-card \{[^}]*flex-shrink: 0/s)
  assert.match(CSS, /\.kb-cards \{[^}]*overflow-y: auto/s)
})
test('mobile list navigation changes the viewport, not the board data', () => {
  const nav = board.slice(board.indexOf('<nav className="kb-list-nav"'), board.indexOf('</nav>') + 6)
  assert.match(nav, /scrollIntoView/)
  assert.doesNotMatch(nav, /reorderColumn|moveCard|renameColumn/)
})

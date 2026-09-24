import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CSS } from '../theme.js'

const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')

test('startup keeps a visible app-owned loading state until boards resolve', () => {
  assert.match(app, /import \{[^}]*listBoardsWithStatus[^}]*\} from '\.\/storage\.js'/)
  assert.match(app, /function LoadingBoards\(\)/)
  assert.match(app, /role="status"/)
  assert.match(app, /Loading boards…/)
  assert.match(app, /!resolved \? <LoadingBoards \/>/)
  assert.doesNotMatch(app, /!resolved \? null/)
})

test('startup spinner is themed and respects reduced motion', () => {
  assert.match(CSS, /\.kb-loading \{[^}]*justify-content: center/s)
  assert.match(CSS, /\.kb-loading-spinner \{[^}]*animation: kb-loading-spin/s)
  const reducedMotion = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reducedMotion, /\.kb-loading-spinner \{ animation: none; \}/)
})

test('the all-boards destination is persisted instead of reopening a stale board', () => {
  const showHome = app.slice(app.indexOf('const showHome = useCallback'), app.indexOf('const closeBoard'))
  assert.match(showHome, /await saveLastBoardId\(null\)/)
  assert.ok(showHome.indexOf('await saveLastBoardId(null)') < showHome.indexOf('setOpenId(null)'),
    'the gallery is not presented as settled until its destination is durable')
  assert.doesNotMatch(showHome, /boardEntryDestinationRef\.current\s*=\s*null/,
    'gallery visibility must not erase the board destination owned by browser Forward')
  assert.match(app, /navRef\.current\.close\(\)[\s\S]*await showHome\(\)/)
  assert.match(app, /onForward: \(\) => \{ navRef\.current = handle; void showHome\(\) \}/)
  assert.match(app, /onForward:[\s\S]*boardEntryDestinationRef\.current[\s\S]*showBoard\(boardEntryDestinationRef\.current\)/,
    'browser Forward must restore the destination retained by the history entry')
})

test('an individual board uses a shaped skeleton rather than a second visible loading message', () => {
  assert.match(board, /className="kb-board kb-board-skeleton" role="status" aria-busy="true"/)
  assert.match(board, /className="kb-visually-hidden">Loading board…<\/span>/)
  assert.doesNotMatch(board, /: 'Loading board…'/)
  assert.match(CSS, /\.kb-board-skeleton-col \{[^}]*flex: 0 0 336px/s)
  assert.match(CSS, /\.kb-board-skeleton-card \{[^}]*height: 92px/s)
})

test('the board skeleton reuses the settled header, lane, card-stack, and responsive geometry', () => {
  assert.match(board, /kb-header kb-board-header kb-board-skeleton-header/)
  assert.match(board, /kb-col-head kb-board-skeleton-col-head/)
  assert.match(board, /kb-cards kb-board-skeleton-cards/)
  assert.match(CSS, /\.kb-board-skeleton-col \{[^}]*width: 336px[^}]*border-radius: 14px/s)
  assert.match(CSS, /\.kb-board-skeleton-card \{[^}]*border-radius: 11px/s)
  assert.match(CSS, /\.kb-board-skeleton-col \{ flex-basis: min\(336px, calc\(100vw - 32px\)\)/)
})

test('reduced motion disables every pulsing skeleton element', () => {
  const reducedMotion = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
  for (const className of [
    'icon', 'header-title', 'nav-pill', 'line', 'count',
    'actions', 'dot', 'card', 'add',
  ]) {
    assert.match(reducedMotion, new RegExp(`\\.kb-board-skeleton-${className}`))
  }
  assert.match(reducedMotion, /animation: none/)
})

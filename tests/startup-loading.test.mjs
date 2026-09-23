import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CSS } from '../theme.js'

const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')

test('startup keeps a visible app-owned loading state until boards resolve', () => {
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
  assert.match(app, /const showHome = useCallback\(\(\) => \{[\s\S]*openBoardIdRef\.current = null[\s\S]*saveLastBoardId\(null\)/)
  assert.match(app, /navRef\.current\.close\(\)[\s\S]*showHome\(\)/)
  assert.match(app, /onForward: \(\) => \{ navRef\.current = handle; showHome\(\) \}/)
})

test('an individual board uses a shaped skeleton rather than a second visible loading message', () => {
  assert.match(board, /className="kb-board kb-board-skeleton" role="status" aria-busy="true"/)
  assert.match(board, /className="kb-visually-hidden">Loading board…<\/span>/)
  assert.doesNotMatch(board, /: 'Loading board…'/)
  assert.match(CSS, /\.kb-board-skeleton-col \{[^}]*flex: 0 0 320px/s)
  assert.match(CSS, /\.kb-board-skeleton-card \{[^}]*height: 92px/s)
})

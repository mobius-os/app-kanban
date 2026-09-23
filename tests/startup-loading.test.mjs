import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CSS } from '../theme.js'

const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

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

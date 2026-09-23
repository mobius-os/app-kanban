import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { listBoards } from '../storage.js'

test('an unavailable board directory rejects instead of returning an empty collection', async () => {
  const previous = globalThis.window
  globalThis.window = { mobius: { storage: { list: async () => { throw new Error('Offline read unavailable') } } } }
  try { await assert.rejects(listBoards(), /Offline read unavailable/) }
  finally { globalThis.window = previous }
})

test('load failure preserves last loaded boards and offers an explicit retry', () => {
  const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setBoards\(\[\]\)/)
  assert.match(source, /setLoadError\(true\)/)
  assert.match(source, /Boards couldn’t be loaded/)
  assert.match(source, /setLoadAttempt\(attempt => attempt \+ 1\)/)
})

test('a cold offline directory has honest app-owned copy and no futile retry', () => {
  const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(source, /No boards are available offline yet/)
  assert.match(source, /Reconnect to load your boards\./)
  assert.match(source, /directoryUnavailable && !online/)
})


test('an unavailable board exposes retry and the owning all-boards callback', () => {
  const source = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const fallback = source.slice(source.indexOf('  if (!board) {'), source.indexOf('  const openCard_ ='))
  assert.match(fallback, /onClick=\{onAllBoards\}/)
  assert.match(fallback, /setLoadAttempt\(attempt => attempt \+ 1\)/)
  assert.doesNotMatch(fallback, /onClick=\{onClose\}/)
})

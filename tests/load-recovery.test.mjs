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


test('an unavailable board exposes retry and the owning all-boards callback', () => {
  const source = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const fallback = source.slice(source.indexOf('  if (!board) return'), source.indexOf('  if (!board) return') + 700)
  assert.match(fallback, /onClick=\{onAllBoards\}/)
  assert.match(fallback, /setLoadAttempt\(attempt => attempt \+ 1\)/)
  assert.doesNotMatch(fallback, /onClick=\{onClose\}/)
})

test('a transient shared refresh failure does not claim that edits need recovery', () => {
  const source = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const recovery = source.slice(
    source.indexOf('  const recoveryButton ='),
    source.indexOf('  const refreshMembers ='),
  )
  assert.match(recovery, /recoveredCount > 0 \|\| queuedCount > 0/)
  assert.doesNotMatch(recovery, /loadFailure/)

  const polling = source.slice(
    source.indexOf('  // Shared boards: poll the shared object'),
    source.indexOf('  const mutate = useCallback'),
  )
  assert.match(polling, /setLoadFailure\(false\)/)
  assert.doesNotMatch(polling, /setLoadFailure\(true\)/)
  assert.match(polling, /source: 'shared-board-poll'/)
  assert.match(polling, /if \(!pullFailureReported\)/)
})

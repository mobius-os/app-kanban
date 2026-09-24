import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createBoardLoadCoordinator } from '../request-guard.js'

function deferred() {
  let resolve
  const promise = new Promise(next => { resolve = next })
  return { promise, resolve }
}

test('a reconnect waits for startup to restore the saved destination', async () => {
  const coordinator = createBoardLoadCoordinator()
  const migration = deferred()
  const events = []
  let savedDestination = null

  const startup = async () => {
    const isCurrent = coordinator.beginStartup()
    await migration.promise
    events.push('membership recovery')
    savedDestination = 'saved-board'
    if (isCurrent()) events.push('startup boards')
    if (coordinator.finishStartup()) reconnect()
  }
  const reconnect = () => {
    const isCurrent = coordinator.beginRefresh()
    if (isCurrent?.()) events.push('fresh boards')
  }

  const startupRun = startup()
  reconnect()
  assert.deepEqual(events, [])
  migration.resolve()
  await startupRun

  assert.equal(savedDestination, 'saved-board')
  assert.deepEqual(events, ['membership recovery', 'startup boards', 'fresh boards'])
})

test('the newest post-startup refresh wins when directory reads finish reversed', async () => {
  const coordinator = createBoardLoadCoordinator()
  coordinator.beginStartup()
  coordinator.finishStartup()
  const first = coordinator.beginRefresh()
  const second = coordinator.beginRefresh()
  const visible = []

  if (second()) visible.push('fresh boards')
  if (first()) visible.push('stale boards')

  assert.deepEqual(visible, ['fresh boards'])
})

test('manifest ships the board-load coordinator used by app startup', () => {
  const manifest = JSON.parse(readFileSync(new URL('../mobius.json', import.meta.url), 'utf8'))
  assert.ok(manifest.source_files.includes('request-guard.js'))
})

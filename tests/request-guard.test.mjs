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

test('multiple reconnect requests during startup become one refresh after initialization', () => {
  const coordinator = createBoardLoadCoordinator()
  const isStartupCurrent = coordinator.beginStartup()
  assert.equal(coordinator.beginRefresh(), null)
  assert.equal(coordinator.beginRefresh(), null)
  assert.equal(isStartupCurrent(), true)

  const shouldRefresh = coordinator.finishStartup()
  assert.equal(shouldRefresh, true)
  assert.equal(coordinator.finishStartup(), false)
  assert.equal(coordinator.beginRefresh()(), true)
})

test('a late failed directory read cannot replace a newer successful result', () => {
  const coordinator = createBoardLoadCoordinator()
  const oldRead = coordinator.beginRefresh()
  const latestRead = coordinator.beginRefresh()
  const state = { boards: null, error: false }

  if (latestRead()) state.boards = ['fresh-board']
  if (oldRead()) state.error = true

  assert.deepEqual(state, { boards: ['fresh-board'], error: false })
})

test('App queues reconnect refresh until startup finishes and restores its destination', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const startup = app.slice(app.indexOf('  useEffect(() => {\n    const isCurrent = boardLoadCoordinatorRef.current.beginStartup()'), app.indexOf('  useEffect(() => {\n    const check ='))
  assert.match(startup, /await migrateLegacy\(\)/)
  assert.match(startup, /await recoverMemberships\(\)/)
  assert.match(startup, /loadUi\(\)/)
  assert.match(startup, /setOpenId\(ui\.lastBoardId\)/)
  assert.match(startup, /finishStartup\(\)\) void refresh\(\)/)
  assert.ok(startup.indexOf('setOpenId(ui.lastBoardId)') < startup.indexOf('finishStartup()'))
})

test('manifest ships the board-load coordinator used by app startup', () => {
  const manifest = JSON.parse(readFileSync(new URL('../mobius.json', import.meta.url), 'utf8'))
  assert.ok(manifest.source_files.includes('request-guard.js'))
})

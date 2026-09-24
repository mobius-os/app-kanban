import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createBoardLoadCoordinator } from '../request-guard.js'
import { includeSharedBoards } from '../storage.js'
import { sharingFromBoards } from '../publication.js'

// Execute the actual refresh callback without rendering its JSX siblings.
const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
const start = app.indexOf('  const refresh = useCallback(')
const end = app.indexOf('\n  useEffect(', start)
assert.ok(start >= 0 && end > start)

function harness(listing, shared = { byBoard: {} }) {
  const state = { boards: [{ id: 'old' }], loadError: true }
  const context = {
    useCallback: callback => callback,
    boardLoadCoordinatorRef: { current: createBoardLoadCoordinator() },
    listBoardsWithStatus: async () => {
      if (listing instanceof Error) throw listing
      return listing
    },
    loadShareMap: async () => shared,
    sharingFromBoards,
    includeSharedBoards,
    refreshInvitations() {},
    readySignalled: { current: true },
    window: {},
  }
  for (const key of ['boards', 'loadError', 'directoryUnavailable', 'shareMap', 'resolved']) {
    context[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => { state[key] = value }
  }
  return { state, refresh: runInNewContext(`${app.slice(start, end)}\nrefresh`, context) }
}

for (const source of ['derived', 'legacy-cache']) {
  test(`${source}: offline refresh shows newly written boards and drops removed ones`, async () => {
    const { state, refresh } = harness({ boards: [{ id: 'new' }], complete: false, source })
    await refresh()
    assert.deepEqual(state.boards.map(board => board.id), ['new'])
    assert.equal(state.loadError, false)
    assert.equal(state.directoryUnavailable, false)
    assert.equal(state.resolved, true)
  })
}

test('an incomplete empty listing retains shared membership discovery', async () => {
  const { state, refresh } = harness({ boards: [], complete: false, source: 'derived' }, {
    byBoard: { shared: { label: 'Shared board' } },
  })
  await refresh()
  assert.deepEqual(state.boards.map(board => board.id), ['shared'])
  assert.equal(state.directoryUnavailable, false)
})

test('cold offline absence remains distinct from a complete empty listing', async () => {
  for (const complete of [false, true]) {
    const { state, refresh } = harness({ boards: [], complete, source: complete ? 'server' : 'derived' })
    await refresh()
    assert.deepEqual(state.boards, [])
    assert.equal(state.directoryUnavailable, !complete)
  }
})

test('a failed directory read still preserves the last loaded boards', async () => {
  const { state, refresh } = harness(new Error('unavailable'))
  await refresh()
  assert.deepEqual(state.boards, [{ id: 'old' }])
  assert.equal(state.loadError, true)
})

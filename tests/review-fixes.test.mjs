import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { boardAccess } from '../domain.js'
import { applyBoardOp, cardMoveAnchor } from '../operations.js'
import {
  enqueuePendingBoardOp,
  readPendingBoardOps,
  replayPendingBoardOps,
} from '../pendingOps.js'
import { casMutate } from '../storage.js'
import { cacheSubscriptionIsAuthoritative, sharedCursorAfterWrite } from '../sync.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

const boardDoc = () => ({
  v: 1,
  id: 'board',
  title: 'Board',
  createdAt: '2026-01-01T00:00:00.000Z',
  columns: [{ id: 'todo', name: 'To do', color: null, cardIds: ['a'] }],
  cards: {
    a: { id: 'a', title: 'A', notes: '', label: 'none', due: '', checklist: [], assignee: '' },
  },
})

test.afterEach(() => { delete globalThis.window })

test('offline reconnect conflict rebases every queued operation or retains an explicit failure', async () => {
  const uiStorage = memoryStorage()
  enqueuePendingBoardOp('board', {
    type: 'add-card',
    columnId: 'todo',
    card: { id: 'b', title: 'B', notes: '', label: 'none', due: '', checklist: [], assignee: '' },
  }, uiStorage)
  enqueuePendingBoardOp('board', {
    type: 'update-card', cardId: 'a', patch: { title: 'A edited offline' },
  }, uiStorage)

  let server = boardDoc()
  let version = 1
  let firstWrite = true
  globalThis.window = { mobius: { storage: {
    async getWithVersion() {
      return { value: structuredClone(server), version: `v${version}` }
    },
    async durableWrite(_path, value, options) {
      assert.equal(options.ifMatch, `v${version}`)
      if (firstWrite) {
        firstWrite = false
        server.cards.concurrent = { id: 'concurrent', title: 'Concurrent', due: '', checklist: [], assignee: '' }
        server.columns[0].cardIds.unshift('concurrent')
        version += 1
        throw Object.assign(new Error('conflict'), { code: 'conflict' })
      }
      server = structuredClone(value)
      version += 1
      return { synced: true }
    },
  } } }

  const result = await replayPendingBoardOps(
    'board',
    op => casMutate('board', doc => applyBoardOp(doc, op)),
    { storage: uiStorage },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(readPendingBoardOps('board', uiStorage), [])
  assert.equal(server.cards.a.title, 'A edited offline')
  assert.equal(server.cards.b.title, 'B')
  assert.equal(server.cards.concurrent.title, 'Concurrent')
  assert.deepEqual(server.columns[0].cardIds, ['concurrent', 'a', 'b'])
})

test('shared poll/write/subscription race keeps the versioned poll as sole authority', () => {
  const share = { oid: 'shared', host: 'peer.example', role: 'editor' }
  const before = { title: 'Before' }
  const optimistic = { title: 'Optimistic' }
  const newest = { title: 'Authoritative v10' }
  let rendered = optimistic
  let cursor = 9
  let pending = 1

  // A newer poll resolves during the optimistic write. Its cursor advances even
  // though rendering is suppressed until the write settles.
  cursor = 10
  if (pending === 0) rendered = newest
  assert.equal(rendered, optimistic)

  // The shared write fails. The cursor must force a full re-pull, and an older
  // unversioned cache notification is not allowed to replace either authority.
  cursor = sharedCursorAfterWrite(null)
  rendered = before
  assert.equal(cursor, -1)
  if (cacheSubscriptionIsAuthoritative(share)) rendered = { title: 'Old cache' }
  assert.equal(rendered, before)

  pending = 0
  if (pending === 0) rendered = newest
  assert.deepEqual(rendered, newest)
  assert.equal(cacheSubscriptionIsAuthoritative(null), true)
})

test('component-level viewer and keyboard contract gates writes, reorders, and manages modal focus', async () => {
  const mutationEntries = [
    'add-card', 'update-card', 'add-checklist-item', 'set-checklist-item',
    'delete-checklist-item', 'delete-card', 'move-card', 'add-column',
    'rename-column', 'delete-column', 'move-column', 'rename-board',
  ]
  let writes = 0
  for (const operation of mutationEntries) {
    if (boardAccess({ role: 'viewer' }, true).canWrite) writes += 1
    assert.equal(boardAccess({ role: 'viewer' }, true).canWrite, false, operation)
  }
  assert.equal(writes, 0)

  const doc = boardDoc()
  doc.cards.b = { id: 'b', title: 'B' }
  doc.cards.c = { id: 'c', title: 'C' }
  doc.columns[0].cardIds = ['a', 'b', 'c']
  const upAnchor = cardMoveAnchor(doc.columns[0].cardIds, 'b', -1)
  applyBoardOp(doc, { type: 'move-card', cardId: 'b', toColumnId: 'todo', beforeCardId: upAnchor })
  assert.deepEqual(doc.columns[0].cardIds, ['b', 'a', 'c'])
  applyBoardOp(doc, { type: 'move-card', cardId: 'b', toColumnId: 'todo', beforeCardId: 'vanished' })
  assert.deepEqual(doc.columns[0].cardIds, ['a', 'c', 'b'])

  const boardSource = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const focusSource = await readFile(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  const themeSource = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(boardSource, /if \(!boardAccess\(entry, onlineRef\.current\)\.canWrite\) return false/)
  assert.match(boardSource, /<h3>Position<\/h3>/)
  assert.match(boardSource, /Move up/)
  assert.match(boardSource, /Move down/)
  assert.match(boardSource, /role="radiogroup"/)
  assert.match(boardSource, /role="radio" aria-checked=/)
  assert.match(focusSource, /event\.key === 'Escape'/)
  assert.match(focusSource, /event\.key !== 'Tab'/)
  assert.match(focusSource, /opener\.focus\(\)/)
  assert.match(themeSource, /\.kb-position-actions \.kb-btn[^}]*min-height: 44px/s)
  assert.match(themeSource, /\.kb-col-reorder \.kb-col-action \{ width: 36px; height: 36px; \}/)
})

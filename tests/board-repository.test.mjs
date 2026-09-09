import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoardRepository, isDiscardableBoardError, isRetryableBoardError } from '../boardRepository.js'

const board = () => ({ v: 1, title: 'Board', columns: [{ id: 'todo', name: 'To do', cardIds: [] }], cards: {} })
const op = { type: 'add-card', columnId: 'todo', card: { id: 'new', title: 'New' } }
function fixture(shared = false) {
  let local = board()
  let remote = board()
  let version = 1
  let writes = 0
  const entry = { host: 'peer.example', oid: 'object', role: 'editor' }
  const storage = {
    async getWithVersion(path) {
      return path === 'shared.json'
        ? { value: { byBoard: shared ? { b: entry } : {} }, version: 'map' }
        : { value: structuredClone(local), version: 'local' }
    },
    async durableWrite(path, doc) { local = structuredClone(doc); writes++ },
    async set(path, doc) { local = structuredClone(doc) },
    async list() { return [{ name: 'b.json' }] },
  }
  let conflict = false
  const request = async (path, options = {}) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body)
      if (conflict) {
        conflict = false
        remote.cards.concurrent = { id: 'concurrent', title: 'Other writer' }
        remote.columns[0].cardIds.push('concurrent')
        version++
        return Response.json({ status: 'conflict' })
      }
      assert.equal(body.expected_version, version)
      remote = body.doc
      return Response.json({ status: 'ok', version: ++version })
    }
    return Response.json({ doc: remote, version })
  }
  return { storage, request, entry, local: () => local, remote: () => remote,
    writes: () => writes, conflict: () => { conflict = true } }
}

test('private board edits use its authoritative document', async () => {
  const f = fixture()
  const repo = createBoardRepository(f)
  assert.equal((await repo.mutate('b', op)).authority, 'private')
  assert.equal((await repo.read('b')).doc.cards.new.title, 'New')
  assert.equal(f.writes(), 1)
})
test('shared board ignores an edited cache and rebases on the shared authority', async () => {
  const f = fixture(true)
  f.local().cards.cacheOnly = { id: 'cacheOnly', title: 'Not authoritative' }
  const repo = createBoardRepository(f)
  assert.equal((await repo.read('b')).doc.cards.cacheOnly, undefined)
  f.conflict()
  const saved = await repo.mutate('b', op)
  assert.equal(saved.authority, 'shared')
  assert.ok(saved.doc.cards.concurrent)
  assert.equal(f.writes(), 0)
  assert.equal(f.local().cards.new.title, 'New')
  await repo.mutate('b', op)
  assert.deepEqual(f.remote().columns[0].cardIds, ['concurrent', 'new'])
})
test('shared failure never falls back to writing the cache', async () => {
  const f = fixture(true)
  f.request = async () => { throw new Error('Offline') }
  const repo = createBoardRepository(f)
  await assert.rejects(repo.read('b'), /Offline/)
  await assert.rejects(repo.mutate('b', op), /Offline/)
  assert.equal(f.local().cards.new, undefined)
  assert.equal(f.writes(), 0)
})
test('authoritative revocation overrides a stale local editor role', async () => {
  const f = fixture(true)
  f.request = async () => Response.json({ detail: 'Forbidden' }, { status: 403 })
  const error = await createBoardRepository(f).mutate('b', op).catch(value => value)
  assert.match(error.message, /read-only/)
  assert.equal(isRetryableBoardError(error), false)
  assert.equal(isDiscardableBoardError(error), true)
  assert.equal(f.local().cards.new, undefined)
  assert.equal(f.writes(), 0)
})
test('sharing lookup failure never becomes a private-board edit', async () => {
  const f = fixture()
  f.storage.getWithVersion = async () => { throw new Error('Unavailable') }
  await assert.rejects(createBoardRepository(f).mutate('b', op), /Unavailable/)
  assert.equal(f.writes(), 0)
})
test('malformed sharing maps are terminal and never become private-board edits', async () => {
  const f = fixture()
  f.storage.getWithVersion = async path => path === 'shared.json'
    ? { value: { byBoard: [] }, version: 'map' }
    : { value: board(), version: 'local' }
  const error = await createBoardRepository(f).mutate('b', op).catch(value => value)
  assert.match(error.message, /malformed/)
  assert.equal(isRetryableBoardError(error), false)
  assert.equal(isDiscardableBoardError(error), false)
  assert.equal(f.writes(), 0)
})
test('cache failure after a shared commit does not report the operation as failed', async () => {
  const f = fixture(true)
  f.storage.set = async () => { throw new Error('Cache unavailable') }
  const saved = await createBoardRepository(f).mutate('b', op)
  assert.ok(saved.doc.cards.new)
  assert.ok(f.remote().cards.new)
})
test('viewer membership and missing targets cannot yield successful card edits', async () => {
  const f = fixture(true)
  f.entry.role = 'viewer'
  await assert.rejects(createBoardRepository(f).mutate('b', op), /read-only/)
  f.entry.role = 'editor'
  await assert.rejects(createBoardRepository(f).mutate('b', { ...op, columnId: 'missing' }), /no longer exists/)
  assert.equal(f.remote().cards.new, undefined)
})
test('terminal board errors are classified and unsafe entity ids are rejected', async () => {
  const f = fixture(true)
  f.entry.role = 'viewer'
  const denied = await createBoardRepository(f).mutate('b', op).catch(value => value)
  assert.equal(isRetryableBoardError(denied), false)
  f.entry.role = 'editor'
  const unsafe = { ...op, card: { ...op.card, id: '__proto__' } }
  await assert.rejects(createBoardRepository(f).mutate('b', unsafe), /invalid/)
  assert.equal(Object.hasOwn(f.remote().cards, '__proto__'), false)
})
test('replayed adds and deletes stay idempotent after the original column disappears', async () => {
  const f = fixture(true)
  const repo = createBoardRepository(f)
  await repo.mutate('b', op)
  f.remote().columns = [{ id: 'other', name: 'Other', cardIds: ['new'] }]
  await repo.mutate('b', op)
  assert.deepEqual(f.remote().columns[0].cardIds, ['new'])
  await repo.mutate('b', { type: 'delete-card', cardId: 'new' })
  await repo.mutate('b', { type: 'delete-card', cardId: 'new' })
  assert.equal(f.remote().cards.new, undefined)
})

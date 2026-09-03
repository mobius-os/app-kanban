import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptInvitation,
  configureSync,
  createInvite,
  deleteSharedObject,
  joinWithInvite,
  leaveBoard,
  loadShareMap,
  pushSharedOp,
  removeShareEntry,
  shareBoard,
} from '../sync.js'

test.afterEach(() => {
  delete globalThis.window
  delete globalThis.fetch
})

test('malformed sharing metadata becomes an empty map', async () => {
  globalThis.window = { mobius: { storage: { async get() { return [] } } } }
  assert.deepEqual(await loadShareMap(), { byBoard: {} })
})

test('creating a shareable invite omits the address from the request', async () => {
  configureSync('test-token')
  let request = null
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({
      invite: 'object@host.example#secret',
      role: 'viewer',
      expires_at: '2026-09-08T00:00:00Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await createInvite('object', 'viewer')
  assert.equal(request.url, '/api/common/objects/object/invites')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(request.body, { role: 'viewer' })
  assert.equal(result.invite, 'object@host.example#secret')
})

test('share-map updates retry conflicts without dropping a concurrent board', async () => {
  const reads = [
    { value: { byBoard: { remove: { oid: 'old' } } }, version: 'v1' },
    { value: { byBoard: { remove: { oid: 'old' }, concurrent: { oid: 'new' } } }, version: 'v2' },
  ]
  const writes = []
  globalThis.window = { mobius: { storage: {
    async getWithVersion() { return reads.shift() },
    async durableWrite(path, value, options) {
      writes.push({ path, value: structuredClone(value), options })
      if (writes.length === 1) throw Object.assign(new Error('conflict'), { code: 'conflict' })
    },
  } } }

  await removeShareEntry('remove')
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1], {
    path: 'shared.json',
    value: { byBoard: { concurrent: { oid: 'new' } } },
    options: { ifMatch: 'v2' },
  })
})

test('accepting an invitation durably saves both the board and membership', async () => {
  configureSync('test-token')
  const writes = []
  globalThis.window = { mobius: { storage: {
    async durableWrite(path, value, options = {}) {
      writes.push({ path, value: structuredClone(value), options })
    },
    async getWithVersion() { return { value: null, version: null } },
  } } }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/common/objects/join')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return new Response(JSON.stringify({
      membership: { id: 'remote-id', host: 'peer.example', role: 'viewer', label: 'Shared' },
      doc: { v: 1, title: 'Shared', columns: [], cards: {}, future: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await acceptInvitation({ id: 'remote-id', host: 'peer.example', label: 'Shared' })
  assert.equal(result.boardId, 'remote-id')
  assert.equal(writes[0].path, 'boards/remote-id.json')
  assert.equal(writes[0].value.future, true)
  assert.deepEqual(writes[1], {
    path: 'shared.json',
    value: { byBoard: { 'remote-id': { oid: 'remote-id', host: 'peer.example', role: 'viewer', version: 0 } } },
    options: { ifNoneMatch: true },
  })
})

test('joining with an invite sends the capability string and sets up the local board', async () => {
  configureSync('test-token')
  const writes = []
  globalThis.window = { mobius: { storage: {
    async durableWrite(path, value, options = {}) {
      writes.push({ path, value: structuredClone(value), options })
    },
    async getWithVersion() { return { value: null, version: null } },
  } } }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/common/objects/join')
    assert.deepEqual(JSON.parse(options.body), {
      app: 'kanban',
      invite: 'remote-id@peer.example#secret',
    })
    return new Response(JSON.stringify({
      membership: { id: 'remote-id', host: 'peer.example', role: 'editor', label: 'Joined' },
      doc: { v: 1, title: 'Joined', columns: [], cards: {} },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await joinWithInvite('  remote-id@peer.example#secret  ')
  assert.equal(result.boardId, 'remote-id')
  assert.equal(writes[0].path, 'boards/remote-id.json')
  assert.deepEqual(writes[1].value.byBoard['remote-id'], {
    oid: 'remote-id', host: 'peer.example', role: 'editor', version: 0,
  })
})

test('shared CAS retries against the newest document and preserves concurrent fields', async () => {
  configureSync('test-token')
  const puts = []
  const replies = [
    { status: 'ok', version: 1, doc: { v: 1, title: 'old', columns: [], cards: {} } },
    { status: 'conflict', version: 2, doc: { v: 1, title: 'other', columns: [], cards: {}, future: 'kept' } },
    { status: 'ok', version: 2, doc: { v: 1, title: 'other', columns: [], cards: {}, future: 'kept' } },
    { status: 'ok', version: 3 },
  ]
  globalThis.fetch = async (_url, options = {}) => {
    const reply = replies.shift()
    if (options.method === 'PUT') puts.push(JSON.parse(options.body))
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const landed = await pushSharedOp(
    { host: 'peer.example', oid: 'object' },
    board => { board.title = 'mine'; return board },
  )
  assert.equal(puts.length, 2)
  assert.equal(puts[1].expected_version, 2)
  assert.equal(puts[1].doc.title, 'mine')
  assert.equal(puts[1].doc.future, 'kept')
  assert.equal(landed.version, 3)
  assert.equal(landed.doc.future, 'kept')
})

test('enabling sharing publishes a fresh storage read instead of a rendered snapshot', async () => {
  configureSync('test-token')
  let published = null
  globalThis.window = { mobius: { storage: {
    async get(path) {
      assert.equal(path, 'boards/local.json')
      return { v: 1, id: 'local', title: 'Fresh', columns: [], cards: {}, fresh: true }
    },
    async getWithVersion() { return { value: null, version: null } },
    async durableWrite() {},
  } } }
  globalThis.fetch = async (_url, options) => {
    published = JSON.parse(options.body)
    return new Response(JSON.stringify({ id: 'shared', host: 'me.example', version: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  await shareBoard('local')
  assert.equal(published.doc.title, 'Fresh')
  assert.equal(published.doc.fresh, true)
})

test('shared deletion and leave retries treat an already-absent object as success', async () => {
  configureSync('test-token')
  const writes = []
  globalThis.window = { mobius: { storage: {
    async getWithVersion() {
      return { value: { byBoard: { board: { oid: 'object' } } }, version: 'v1' }
    },
    async durableWrite(path, value, options) {
      writes.push({ path, value: structuredClone(value), options })
    },
  } } }
  globalThis.fetch = async () => new Response(
    JSON.stringify({ detail: 'No such object.' }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  )

  assert.deepEqual(await deleteSharedObject('object'), { status: 'deleted' })
  await leaveBoard('board', { host: 'peer.example', oid: 'object' })
  assert.deepEqual(writes.at(-1), {
    path: 'shared.json',
    value: { byBoard: {} },
    options: { ifMatch: 'v1' },
  })
})

import { configureSync as configureFixture } from '../sync.js'
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
  getSharedAsset,
  putSharedAsset,
  deleteSharedAsset,
  pushSharedOp,
  removeShareEntry,
  shareBoard,
  sharedBoardPollDelay,
} from '../sync.js'

test('an actively viewed shared board polls quickly and relaxes when idle', () => {
  assert.equal(sharedBoardPollDelay(10_000, 20_000), 1000)
  assert.equal(sharedBoardPollDelay(1_000, 20_000), 3000)
})

test('shared image operations stay scoped to the board host and object', async () => {
  configureSync('test-token', 1)
  const calls = []
  const request = async (url, options = {}) => {
    calls.push({ url, options })
    const body = options.method === 'GET' || !options.method
      ? { status: 'ok', asset: { id: 'image', mime: 'image/webp', data: 'abc' } }
      : { status: options.method === 'DELETE' ? 'deleted' : 'ok' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'board-object' }
  await putSharedAsset(entry, 'image', 'image/webp', 'abc', request)
  assert.deepEqual(await getSharedAsset(entry, 'image', request), {
    id: 'image', mime: 'image/webp', data: 'abc',
  })
  await deleteSharedAsset(entry, 'image', request)
  assert.deepEqual(calls.map(call => [call.url, call.options.method || 'GET']), [
    ['/api/apps/1/service/boards/peer.example/board-object/assets/image', 'PUT'],
    ['/api/apps/1/service/boards/peer.example/board-object/assets/image', 'GET'],
    ['/api/apps/1/service/boards/peer.example/board-object/assets/image', 'DELETE'],
  ])
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token')
  assert.deepEqual(JSON.parse(calls[0].options.body), { mime: 'image/webp', data: 'abc' })
})

test.afterEach(() => {
  delete globalThis.window
  delete globalThis.fetch
})

test('malformed sharing metadata becomes an empty map', async () => {
  globalThis.window = { mobius: { storage: { async get() { return [] } } } }
  assert.deepEqual(await loadShareMap(), { byBoard: {} })
})

test('creating a shareable invite omits the address from the request', async () => {
  configureSync('test-token', 1)
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
  assert.equal(request.url, '/api/apps/1/service/boards/object/invites')
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
  configureSync('test-token', 1)
  const writes = []
  globalThis.window = { mobius: { storage: {
    async durableWrite(path, value, options = {}) {
      writes.push({ path, value: structuredClone(value), options })
    },
    async getWithVersion() { return { value: null, version: null } },
  } } }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/apps/1/service/boards/join')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return new Response(JSON.stringify({
      version: 1,
      membership: { id: 'remote-id', member_id: 'fixture-member', transport: 'kanban/1', host: 'peer.example', role: 'viewer', label: 'Shared' },
      doc: { v: 1, title: 'Shared', columns: [], cards: {}, future: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await acceptInvitation({ id: 'remote-id', transport: 'kanban/1', host: 'peer.example', label: 'Shared' })
  assert.equal(result.boardId, 'remote-id')
  assert.equal(writes[1].path, 'boards/remote-id.json')
  assert.equal(writes[1].value.future, true)
  assert.deepEqual(writes[0], {
    path: 'shared.json',
    value: { byBoard: { 'remote-id': { oid: 'remote-id', member_id: 'fixture-member', transport: 'kanban/1', host: 'peer.example', role: 'viewer', version: 1, label: 'Shared' } } },
    options: { ifNoneMatch: true },
  })
})

test('joining with an invite sends the capability string and sets up the local board', async () => {
  configureSync('test-token', 1)
  const writes = []
  globalThis.window = { mobius: { storage: {
    async durableWrite(path, value, options = {}) {
      writes.push({ path, value: structuredClone(value), options })
    },
    async getWithVersion() { return { value: null, version: null } },
  } } }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/apps/1/service/boards/join')
    assert.deepEqual(JSON.parse(options.body), {
      app: 'kanban',
      invite: 'remote-id@peer.example#secret',
    })
    return new Response(JSON.stringify({
      version: 1,
      membership: { id: 'remote-id', member_id: 'fixture-member', transport: 'kanban/1', host: 'peer.example', role: 'editor', label: 'Joined' },
      doc: { v: 1, title: 'Joined', columns: [], cards: {} },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await joinWithInvite('  remote-id@peer.example#secret  ')
  assert.equal(result.boardId, 'remote-id')
  assert.equal(writes[1].path, 'boards/remote-id.json')
  assert.deepEqual(writes[0].value.byBoard['remote-id'], {
    oid: 'remote-id', member_id: 'fixture-member', transport: 'kanban/1', host: 'peer.example', role: 'editor', version: 1, label: 'Joined',
  })
})

test('shared CAS retries against the newest document and preserves concurrent fields', async () => {
  configureSync('test-token', 1)
  const puts = []
  const replies = [
    { status: 'ok', version: 1, doc: { v: 1, title: 'old', columns: [], cards: {} } },
    { status: 'conflict', version: 2, doc: { v: 1, title: 'other', columns: [], cards: {}, future: 'kept' } },
    { status: 'ok', version: 3 },
  ]
  globalThis.fetch = async (_url, options = {}) => {
    const reply = replies.shift()
    if (options.method === 'PUT') puts.push(JSON.parse(options.body))
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const landed = await pushSharedOp(
    { transport: 'kanban/1', host: 'peer.example', oid: 'object' },
    board => { board.title = 'mine'; return board },
  )
  assert.equal(puts.length, 2)
  assert.equal(puts[1].expected_version, 2)
  assert.equal(puts[1].doc.title, 'mine')
  assert.equal(puts[1].doc.future, 'kept')
  assert.equal(landed.version, 3)
  assert.equal(landed.doc.future, 'kept')
})

test('enabling sharing publishes a CAS-fenced fresh snapshot, never the private marker', async () => {
  configureSync('test-token', 1)
  let published = null
  const files = {'boards/local.json':{v:1,id:'local',title:'Fresh',columns:[],cards:{},fresh:true}}
  globalThis.window = {mobius:{storage:{
    async get(path) { return structuredClone(files[path] || null) },
    async getWithVersion(path) { return {value:structuredClone(files[path] || null),version:files[path]?'v1':null} },
    async durableWrite(path,value) { files[path]=structuredClone(value) },
  }}}
  globalThis.fetch = async (url, options) => {
    if(url.endsWith('/health')) return Response.json({protocol:'kanban/1',host:'me.example'})
    published=JSON.parse(options.body)
    assert.ok(files['boards/local.json']._kanbanPublication)
    assert.ok(files['shared.json'].byBoard.local.publishing)
    return Response.json({id:published.id,host:'me.example',version:1})
  }
  await shareBoard('local')
  assert.equal(published.doc.title,'Fresh')
  assert.equal(published.doc.fresh,true)
  assert.equal(published.doc._kanbanPublication,undefined)
})

test('shared deletion and leave retries treat an already-absent object as success', async () => {
  configureSync('test-token', 1)
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
    JSON.stringify({ protocol: 'kanban/1', code: 'board-missing', detail: 'No such object.' }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  )

  assert.deepEqual(await deleteSharedObject('object'), { status: 'deleted' })
  await leaveBoard('board', { transport: 'kanban/1', host: 'peer.example', oid: 'object' })
  assert.deepEqual(writes.at(-1), {
    path: 'shared.json',
    value: { byBoard: {} },
    options: { ifMatch: 'v1' },
  })
})

test('verified collaborators appear once without merging lookalike handles', async () => {
  const { groupCollaborators } = await import('../sync.js')
  const result = groupCollaborators([
    { member_id: 'one.example', transport: 'kanban/1', host: 'one.example', handle: 'ana', collaborator_id: 'verified-group', pending: true, active: false },
    { transport: 'kanban/1', host: 'two.example', handle: 'ana', collaborator_id: 'verified-group', pending: false, active: true },
    { transport: 'kanban/1', host: 'other.example', handle: 'ana', pending: true },
  ])
  assert.equal(result.length, 2)
  assert.deepEqual(result[0].hosts, ['one.example', 'two.example'])
  assert.equal(result[0].pending, false)
  assert.equal(result[0].active, true)
})

test('delivery feedback distinguishes partial success and never promises an automatic retry', async () => {
  const { inviteDeliveryNotice } = await import('../sync.js')
  const partial = inviteDeliveryNotice({ recipients: [
    { delivery: 'delivered' }, { delivery: 'unreachable' },
  ] })
  assert.equal(partial.kind, 'warn')
  assert.match(partial.text, /1 of 2/)
  assert.match(partial.text, /Send again/)
  assert.equal(inviteDeliveryNotice({ delivery: 'unreachable' }).kind, 'warn')
  assert.equal(inviteDeliveryNotice({ delivery: 'delivered' }).kind, 'ok')
  assert.match(inviteDeliveryNotice({ recipients: [{ delivery: 'delivered' }, { delivery: 'delivered' }] }).text, /all 2/)
})

test('remove collaborator explicitly revokes all grouped deployments, but legacy members stay scoped', async () => {
  const { revokeCollaborator } = await import('../sync.js')
  configureSync('test-token', 1)
  const urls = []
  globalThis.fetch = async (url, options) => {
    urls.push(url)
    assert.equal(options.method, 'DELETE')
    return new Response(JSON.stringify({ status: 'revoked' }), { status: 200 })
  }
  await revokeCollaborator('oid', { member_id: 'one.example', transport: 'kanban/1', host: 'one.example', collaborator_id: 'group' })
  await revokeCollaborator('oid', { member_id: 'legacy.example', transport: 'kanban/1', host: 'legacy.example' })
  assert.deepEqual(urls, [
    '/api/apps/1/service/boards/oid/members/one.example?all_deployments=true',
    '/api/apps/1/service/boards/oid/members/legacy.example',
  ])
})

test('assignees on any verified deployment retain their collaborator selection without changing the card', async () => {
  const { groupCollaborators, collaboratorForHost } = await import('../sync.js')
  const members = groupCollaborators([
    { member_id: 'one.example', transport: 'kanban/1', host: 'one.example', collaborator_id: 'group', pending: false },
    { transport: 'kanban/1', host: 'two.example', collaborator_id: 'group', pending: false },
    { transport: 'kanban/1', host: 'other.example', pending: false },
  ])
  const card = { assignee: 'Test member', assigneeHost: 'two.example' }
  assert.equal(collaboratorForHost(members, card.assigneeHost).host, 'one.example')
  assert.equal(card.assigneeHost, 'two.example')
  assert.equal(collaboratorForHost(members, 'other.example').host, 'other.example')
  assert.equal(collaboratorForHost(members, 'unknown.example'), undefined)
})

test.beforeEach(() => configureFixture('fixture', 1))

test('shell string app identity uses the same numeric service route', async () => {
  for (const id of [118, '118']) {
    configureSync('test-token', id)
    let path
    await getSharedAsset({transport:'kanban/1',host:'main.example',oid:'board'}, 'asset', async url => {
      path = url
      return Response.json({asset:{id:'asset'}})
    })
    assert.equal(path, '/api/apps/118/service/boards/main.example/board/assets/asset')
  }
  for (const id of [null, undefined, true, {}, '', ' ', '0', 0, -1, '118/other', '1e2', '1.5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => configureSync('test-token', id), /identity is required/)
  }
})

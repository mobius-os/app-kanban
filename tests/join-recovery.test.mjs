import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptInvitation, loadShareMap } from '../sync.js'
import { listBoards, includeSharedBoards } from '../storage.js'
import { createBoardRepository } from '../boardRepository.js'

function fixture(failPath) {
  const values = new Map(), writes = []
  const doc = { v: 1, title: 'Shared', columns: [], cards: {} }
  const storage = {
    async get(path) { return structuredClone(values.get(path) ?? null) },
    async getWithVersion(path) { return { value: await this.get(path), version: null } },
    async durableWrite(path, value) {
      writes.push(path)
      if (path === failPath) throw new Error('Test write failure')
      values.set(path, structuredClone(value))
    },
    async list() { return [] },
  }
  globalThis.window = { mobius: { storage, signal() {} } }
  globalThis.fetch = async () => Response.json({
    membership: { id: 'joined', host: 'peer.example', role: 'viewer', label: 'Shared' }, doc,
  })
  return { storage, values, writes, doc }
}
test.afterEach(() => { delete globalThis.window; delete globalThis.fetch })

test('failed authority save never leaves a private-looking joined board cache', async () => {
  const f = fixture('shared.json')
  await assert.rejects(acceptInvitation({ host: 'peer.example', id: 'joined' }), /Test write failure/)
  assert.equal(f.values.has('boards/joined.json'), false)
  assert.deepEqual(f.writes, ['shared.json'])
})

test('failed cache save retains shared ownership and can be discovered and read', async () => {
  const f = fixture('boards/joined.json')
  const result = await acceptInvitation({ host: 'peer.example', id: 'joined' })
  assert.equal(result.boardId, 'joined')
  const map = await loadShareMap()
  assert.equal(map.byBoard.joined.role, 'viewer')
  assert.deepEqual(includeSharedBoards([], map).map(({ id, title, unavailable }) => ({ id, title, unavailable })), [{ id: 'joined', title: 'Shared', unavailable: true }])
  assert.deepEqual(f.writes, ['shared.json', 'boards/joined.json'])
  const repo = createBoardRepository({ storage: f.storage,
    request: async () => Response.json({ status: 'ok', version: 1, doc: f.doc }) })
  const rows = await repo.list()
  assert.equal(rows[0].id, 'joined')
  assert.equal(rows[0].authority, 'shared')
  await assert.rejects(repo.mutate('joined', { type: 'rename-board', title: 'Must not edit' }), /read-only/)
})

test('unreadable board entries remain discoverable instead of triggering empty seeding', async () => {
  const f = fixture()
  f.storage.list = async () => [{ name: 'private.json', path: 'boards/private.json' }]
  f.storage.get = async () => { throw new Error('Unavailable') }
  const rows = await listBoards()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'private')
  assert.equal(rows[0].unavailable, true)
})


test('shared discovery keeps cached previews and never duplicates an existing board', () => {
  const board = { id: 'joined', title: 'Newer title', cardCount: 2 }
  assert.deepEqual(includeSharedBoards([board], { byBoard: { joined: { label: 'Old title' } } }), [board])
})

import { configureSync as configureFixture } from '../sync.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptInvitation, loadShareMap } from '../sync.js'
import { listBoards, includeSharedBoards } from '../storage.js'
import { acknowledgeRecoveredBoardOps, replayPendingBoardOps, readRecoveredBoardOps, exportUnsyncedBoardOps } from '../pendingOps.js'
import { replayOutcomeForBoardError, createBoardRepository } from '../boardRepository.js'

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
    async list(prefix) { return [...values.entries()].filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => ({path, content: structuredClone(content)})) },
    async remove(path) { values.delete(path) },
  }
  globalThis.window = { mobius: { storage, signal() {} } }
  globalThis.fetch = async () => Response.json({
    membership: { id: 'joined', transport: 'kanban/1', host: 'peer.example', role: 'viewer', label: 'Shared' }, doc,
  })
  return { storage, values, writes, doc }
}
test.afterEach(() => { delete globalThis.window; delete globalThis.fetch })

test('failed authority save never leaves a private-looking joined board cache', async () => {
  const f = fixture('shared.json')
  await assert.rejects(acceptInvitation({ transport: 'kanban/1', host: 'peer.example', id: 'joined' }), /Test write failure/)
  assert.equal(f.values.has('boards/joined.json'), false)
  assert.deepEqual(f.writes, ['shared.json'])
})

test('failed cache save retains shared ownership and can be discovered and read', async () => {
  const f = fixture('boards/joined.json')
  const result = await acceptInvitation({ transport: 'kanban/1', host: 'peer.example', id: 'joined' })
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

test.beforeEach(() => configureFixture('fixture', 1))


test('a fresh invitation reuses the legacy alias and leaves its queued edits intact', async () => {
  const f = fixture()
  f.values.set('shared.json', {byBoard:{original:{oid:'joined',host:'peer.example',role:'editor'}}})
  const queueKey = 'pending-board-ops/original/fixture.json'
  const pending = {id:'fixture',op:{type:'rename-board',title:'Offline work'}}
  f.values.set(queueKey,pending)
  const result = await acceptInvitation({host:'peer.example',id:'joined'})
  assert.equal(result.boardId,'original')
  assert.equal((await loadShareMap()).byBoard.original.transport,'kanban/1')
  assert.equal((await loadShareMap()).byBoard.joined,undefined)
  assert.deepEqual(f.values.get(queueKey),pending)
})

test('a successful join never replaces a different host using the same local ID', async () => {
  const f = fixture()
  const prior={oid:'joined',host:'other.example',role:'editor'}
  f.values.set('shared.json',{byBoard:{joined:prior}})
  await assert.rejects(acceptInvitation({host:'peer.example',id:'joined'}),/different board/)
  assert.deepEqual((await loadShareMap()).byBoard.joined,prior)
  assert.equal(f.values.has('boards/joined.json'),false)
})


test('rejoining as a viewer archives editor intent without writing to the host', async () => {
  const f = fixture()
  f.values.set('shared.json', {byBoard:{original:{oid:'joined',host:'peer.example',role:'editor'}}})
  const intent = {id:'offline',op:{type:'rename-board',title:'Unsent work'}}
  f.values.set('pending-board-ops/original/offline.json', intent)
  await acceptInvitation({host:'peer.example',id:'joined'})
  const repository = createBoardRepository({storage:f.storage, request:async()=>{throw new Error('Must not write')}})
  const result = await replayPendingBoardOps('original', async op => {
    try { return {status:'landed',doc:(await repository.mutate('original',op)).doc} }
    catch (error) { return replayOutcomeForBoardError(error) }
  }, {storage:f.storage})
  assert.equal(result.ok,true)
  assert.equal(result.discarded,1)
  const recovery = await exportUnsyncedBoardOps('original',f.storage)
  assert.deepEqual(recovery.recovered[0].op,intent.op)
  assert.equal(recovery.recovered[0].code,'read-only')
  assert.deepEqual(recovery.pending,[])
  assert.equal(f.values.get('boards/original.json').title,'Shared')
})

test('acknowledging a downloaded recovery hides its notice without deleting the recovery copy', async () => {
  const f = fixture()
  const recovered = {id:'offline',op:{type:'rename-board',title:'Keep me'},code:'read-only'}
  f.values.set('recovered-board-ops/original/offline.json', recovered)

  const downloaded = await exportUnsyncedBoardOps('original', f.storage)
  const arrivedAfterDownload = {id:'zz-later',op:{type:'rename-board',title:'Do not hide me'},code:'read-only'}
  f.values.set('recovered-board-ops/original/zz-later.json', arrivedAfterDownload)
  await acknowledgeRecoveredBoardOps('original', downloaded.recovered.map(entry => entry.id), f.storage)

  assert.deepEqual(await readRecoveredBoardOps('original', f.storage), [arrivedAfterDownload])
  assert.deepEqual((await exportUnsyncedBoardOps('original', f.storage)).recovered, [recovered, arrivedAfterDownload])
  assert.equal(f.values.has('recovered-board-ops/original/offline.json'), true)
})

for (const failure of ['throw', 'queued', 'queued-string', 'queued-status', 'remove']) {
  test(`recovery ${failure} failure never loses intent and retry archives once`, async () => {
    const f = fixture()
    const key='pending-board-ops/original/offline.json'
    const intent={id:'offline',op:{type:'rename-board',title:'Keep me'}}
    f.values.set(key,intent)
    const write=f.storage.durableWrite, remove=f.storage.remove
    if(failure==='remove') f.storage.remove=async()=>{throw new Error('Remove failed')}
    else f.storage.durableWrite=async()=>{if(failure==='queued')return {queued:true}; if(failure==='queued-string')return 'queued'; if(failure==='queued-status')return {status:'queued'}; throw new Error('Archive failed')}
    const reject=async()=>({status:'discarded',error:Object.assign(new Error('Read only'),{code:'read-only'})})
    const first=await replayPendingBoardOps('original',reject,{storage:f.storage})
    assert.equal(first.ok,false)
    assert.deepEqual(f.values.get(key),intent)
    f.storage.durableWrite=write; f.storage.remove=remove
    const retry=await replayPendingBoardOps('original',reject,{storage:f.storage})
    assert.equal(retry.ok,true)
    assert.equal((await readRecoveredBoardOps('original',f.storage)).length,1)
    assert.equal(f.values.has(key),false)
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { alertCapacity, capacityAlertMessage, formatBytes, CAPACITY_ALERTS_PATH } from '../capacityAlerts.js'

const capacity = ({ board = false, files = false } = {}) => ({
  bytes: board ? 1.9 * 1048576 : 100 * 1024, limit: 2 * 1048576, share: board ? 0.95 : 0.05, nearlyFull: board,
  files: files ? 460 : 10, fileLimit: 500, fileBytes: 20 * 1048576, fileByteLimit: 100 * 1048576,
  fileShare: files ? 0.92 : 0.02, filesNearlyFull: files,
})

function harness({ sendable = true } = {}) {
  const files = {}
  const pushes = []
  const storage = {
    async get(path) { return structuredClone(files[path] ?? null) },
    async set(path, value) { files[path] = structuredClone(value) },
  }
  const notify = async push => { if (sendable) pushes.push(push); return sendable }
  const look = (state, boardId = 'b1') => alertCapacity({ storage, notify, boardId, boardTitle: 'Roadmap', capacity: capacity(state) })
  return { files, pushes, look }
}

test('a board passing 90% tells its owner once, not on every look', async () => {
  const h = harness()
  assert.deepEqual(await h.look({}), [])
  assert.deepEqual(await h.look({ board: true }), ['board'])
  assert.deepEqual(await h.look({ board: true }), [])
  assert.equal(h.pushes.length, 1)
  assert.equal(h.pushes[0].tag, 'kanban-capacity:b1:board')
  assert.equal(h.pushes[0].title, '“Roadmap” is 95% full')
})

test('after making room, filling up again tells the owner again', async () => {
  const h = harness()
  await h.look({ board: true })
  await h.look({})
  assert.deepEqual(h.files[CAPACITY_ALERTS_PATH].b1, { board: false, files: false })
  assert.deepEqual(await h.look({ board: true }), ['board'])
  assert.equal(h.pushes.length, 2)
})

test('board text and attachments are told separately, per board', async () => {
  const h = harness()
  assert.deepEqual(await h.look({ board: true, files: true }), ['board', 'files'])
  assert.deepEqual(await h.look({ files: true }, 'b2'), ['files'])
  assert.match(h.pushes[1].body, /^460 of 500 files, 20 MB of 100 MB\./u)
})

test('a push that could not be sent is tried again on the next look', async () => {
  const offline = harness({ sendable: false })
  assert.deepEqual(await offline.look({ board: true }), [])
  assert.equal(offline.files[CAPACITY_ALERTS_PATH], undefined)
})

test('sizes read in KB below a megabyte and MB above it', () => {
  assert.equal(formatBytes(250 * 1024), '250 KB')
  assert.equal(formatBytes(2 * 1048576), '2 MB')
  assert.equal(formatBytes(1.85 * 1048576), '1.9 MB')
  assert.match(capacityAlertMessage('board', '', capacity({ board: true })).body, /^1\.9 MB of 2 MB used\./u)
})

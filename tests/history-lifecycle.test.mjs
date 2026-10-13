// Card history is complete and goes away with what it describes: a shared
// edit and its activity are saved together, assignee changes are recorded,
// failures are visible, and deleting a list or board deletes its history.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { applyBoardPieces, configureSync } from '../sync.js'
import { createBoardRepository } from '../boardRepository.js'
import { activityPath, cardTimeline, describeActivity, describeCardChange } from '../activity.js'
import { applyBoardOp } from '../operations.js'
import { assignmentHistory, createAssignmentEvent } from '../assignment.js'
import { assignmentLogPath, boardPath } from '../storage.js'
import { deleteBoard } from '../boardDeletion.js'
import { attachmentPath } from '../attachments.js'
import { enqueuePendingBoardOp, readPendingBoardOps } from '../pendingOps.js'
import { CAPACITY_ALERTS_PATH } from '../capacityAlerts.js'
import { asOlderHost } from './older-host.mjs'

beforeEach(() => configureSync('fixture', 1))

const card = (id, extra = {}) => ({ id, title: id, notes: '', label: 'none', due: '', checklist: [], attachments: [], assignee: '', assigneeHost: '', ...extra })
const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }

// A stand-in for the board's host: piece saves carry their activity, and a
// reply can be lost after the host committed (`loseNextReply`).
function sharedHost({ older = false } = {}) {
  let version = 1
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card('c1') } }
  const activity = {}
  const sent = []
  let loseNextReply = false
  const storage = {
    async getWithVersion(path) {
      return path === 'shared.json' ? { value: { byBoard: { b: entry } }, version: 'map' } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite() { throw new Error('A shared board must not write its cache as authority.') },
    async set() {},
  }
  const host = async (url, options = {}) => {
    if (url.endsWith('/changes')) {
      const body = JSON.parse(options.body)
      sent.push(body)
      if (body.expected_version !== version) return Response.json({ status: 'conflict', doc, version })
      doc = applyBoardPieces(doc, body.pieces); version++
      const saved = {}
      for (const [cardId, items] of Object.entries(body.activity || {})) {
        activity[cardId] = [...(activity[cardId] || []), ...items.map(item => ({ ...item, by: { host: 'self.example', name: 'Me' } }))]
        saved[cardId] = activity[cardId]
      }
      if (loseNextReply) { loseNextReply = false; throw new TypeError('network connection lost') }
      return Response.json({ status: 'ok', version, doc, activity: saved })
    }
    if (url.includes('/cards/')) return Response.json({ status: 'ok', notes: '', notes_version: 0, external: false, activity: [] })
    if ((options.method || 'GET') === 'PUT') {
      doc = JSON.parse(options.body).doc; version++
      return Response.json({ status: 'ok', version })
    }
    return Response.json({ doc, version })
  }
  return { storage, request: older ? asOlderHost(host) : host, activity, sent, doc: () => doc, loseReply: () => { loseNextReply = true } }
}

test('a shared edit sends its activity with the save, in one request', async () => {
  const host = sharedHost()
  const saved = await createBoardRepository(host).mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(host.sent.length, 1)
  assert.deepEqual(Object.keys(host.sent[0].activity), ['c1'])
  assert.equal(saved.activity.status, 'saved')
  assert.deepEqual(saved.activity.entries.map(item => item.type), ['renamed'])
})

test('an edit whose reply was lost still has its activity, and replaying it adds none', async () => {
  const host = sharedHost()
  const repo = createBoardRepository(host)
  host.loseReply()
  await assert.rejects(repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } }))
  // The host committed the edit and its activity together before the reply was lost.
  assert.deepEqual(host.activity.c1.map(item => item.type), ['renamed'])
  // The queued edit replays against the landed card: nothing changes, nothing is described twice.
  const replay = await repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(replay.activity.status, 'none')
  assert.equal(host.activity.c1.length, 1)
})

test('a host that cannot save activity is reported, never shown as saved', async () => {
  const host = sharedHost({ older: true })
  const saved = await createBoardRepository(host).mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(host.doc().cards.c1.title, 'Renamed')
  assert.equal(saved.activity.status, 'unsupported')
})

test('a private board reports activity it could not write; the edit stands', async () => {
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card('c1') } }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      return path.startsWith('activity/') ? { value: null, version: null } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite(path, value) {
      if (path.startsWith('activity/')) throw Object.assign(new Error('storage unavailable'), { code: 'unavailable' })
      doc = structuredClone(value)
    },
  }
  const saved = await createBoardRepository({ storage }).mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(doc.cards.c1.title, 'Renamed')
  assert.equal(saved.activity.status, 'failed')
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /result\?\.status === 'failed'[\s\S]{0,80}setSyncNote\(/u)
  // Replayed queued edits report their activity too, so a failure there is not dropped.
  assert.match(board, /\.mutate\(boardId, op, \{ sharedState: confirmedSharedRef\.current \}\)[\s\S]{0,240}noteActivity\(landed\.activity\)/u)
})

test('an assignee change is recorded, from a plain edit as much as from the picker', async () => {
  const drafts = describeCardChange({ op: { type: 'update-card' },
    before: { card: card('c1'), column: 'To do' }, after: { card: card('c1', { assignee: 'Ana', assigneeHost: 'ana.example' }), column: 'To do' } })
  assert.deepEqual(drafts.map(describeActivity), ['assigned this card to Ana'])
  const host = sharedHost()
  const saved = await createBoardRepository({ ...host, via: 'agent' }).mutate('b',
    { type: 'update-card', cardId: 'c1', patch: { assignee: 'Ana', assigneeHost: 'ana.example' } })
  const [event] = assignmentHistory(host.doc().cards.c1)
  assert.deepEqual([event.from.label, event.to.label], ['', 'Ana'])
  // The activity line names the card's assignment event, so the sheet shows them as one line.
  const [line] = saved.activity.entries
  assert.deepEqual([line.type, line.id], ['assigned', event.id])
})

test('an assignment recorded in activity is one timeline line with the host’s author, and can still be restored', () => {
  const event = createAssignmentEvent({ id: 'ev1', at: '2026-10-13T08:00:00.000Z', by: { label: 'Claimed', host: 'forged.example' },
    from: { label: 'Ben', host: 'ben.example' }, to: { label: 'Ana', host: 'ana.example' } })
  const older = createAssignmentEvent({ id: 'ev0', at: '2026-10-12T08:00:00.000Z', from: { label: '' }, to: { label: 'Ben', host: 'ben.example' } })
  const timeline = cardTimeline({
    card: card('c1', { assignee: 'Ana', assigneeHost: 'ana.example' }),
    activity: [{ id: 'ev1', at: '2026-10-13T08:00:01.000Z', type: 'assigned', from: 'Ben', to: 'Ana', by: { host: 'self.example', name: 'Me' } }],
    assignmentTimeline: [event, older],
    actorName: item => item.by.name,
  })
  assert.deepEqual(timeline.map(item => [item.actor, item.text || 'from the card']), [
    ['Me', 'reassigned this card from Ben to Ana'],
    [undefined, 'from the card'],
  ])
  assert.equal(timeline[0].event, event)
})

// A private board in app storage, with a file attached to each card.
function privateBoard(columns) {
  const cards = {}
  for (const column of columns) for (const id of column.cardIds) {
    cards[id] = card(id, { attachments: [{ id: `f-${id}`, name: `${id}.png`, mime: 'image/png', path: attachmentPath('b', `f-${id}`, 'image/png') }] })
  }
  const files = { [boardPath('b')]: { v: 1, title: 'B', columns, cards } }
  for (const id of Object.keys(cards)) {
    files[activityPath('b', id)] = { v: 1, entries: [] }
    files[cards[id].attachments[0].path] = 'blob'
  }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      return { value: structuredClone(files[path] ?? null), version: files[path] ? 'v' : null }
    },
    async durableWrite(path, value) { files[path] = structuredClone(value) },
    async remove(path) { delete files[path] },
  }
  return { storage, files }
}

test('deleting a list deletes the activity and files of its cards on a private board', async () => {
  const { storage, files } = privateBoard([{ id: 'todo', name: 'To do', cardIds: ['c1', 'c2'] }, { id: 'done', name: 'Done', cardIds: ['c3'] }])
  await createBoardRepository({ storage }).mutate('b', { type: 'delete-column', columnId: 'todo' })
  assert.deepEqual(Object.keys(files).sort(), [boardPath('b'), activityPath('b', 'c3'), attachmentPath('b', 'f-c3', 'image/png')].sort())
})

test('a removed attachment’s file is deleted with the edit, also when a queued edit is replayed', async () => {
  const { storage, files } = privateBoard([{ id: 'todo', name: 'To do', cardIds: ['c1'] }])
  const path = attachmentPath('b', 'f-c1', 'image/png')
  // The app queues the edit while offline; the replay runs the same repository edit.
  await createBoardRepository({ storage }).mutate('b', { type: 'remove-file', cardId: 'c1', attachmentId: 'f-c1' })
  assert.equal(files[path], undefined)
  // A path outside this board's files is never deleted, whatever a card claims.
  files[boardPath('b')].cards.c1.attachments = [{ id: 'x', name: 'x', mime: 'image/png', path: 'ui.json' }]
  files['ui.json'] = {}
  await createBoardRepository({ storage }).mutate('b', { type: 'delete-card', cardId: 'c1' })
  assert.deepEqual(files['ui.json'], {})
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(board.slice(board.indexOf('const deleteCard ='), board.indexOf('const attachFiles =')), /deleteCardAttachment/u)
})

test('a shared host that deletes files itself is not asked again; an older host is', async () => {
  for (const older of [false, true]) {
    const host = sharedHost({ older })
    host.doc().cards.c1.attachments = [{ id: 'f1', name: 'f1.png', mime: 'image/png' }]
    const deleted = []
    const request = (url, options = {}) => {
      if (url.endsWith('/assets/f1') && options.method === 'DELETE') { deleted.push('f1'); return Response.json({ status: 'deleted' }) }
      return host.request(url, options)
    }
    configureSync('fixture', 1)
    await createBoardRepository({ ...host, request }).mutate('b', { type: 'remove-file', cardId: 'c1', attachmentId: 'f1' })
    assert.deepEqual(deleted, older ? ['f1'] : [], older ? 'older host' : 'current host')
  }
})

const file = id => ({ id, name: `${id}.png`, mime: 'image/png' })

test('two members changing a card’s files at once both keep their change, and no file is deleted by mistake', async () => {
  const host = sharedHost()
  host.doc().cards.c1.attachments = [file('A')]
  const deleted = []
  const request = (url, options = {}) => {
    if (url.includes('/assets/') && options.method === 'DELETE') { deleted.push(url.split('/').pop()); return Response.json({ status: 'deleted' }) }
    return host.request(url, options)
  }
  const repo = createBoardRepository({ ...host, request })
  // This member read the card while it held only A.
  const stale = { host: entry.host, oid: entry.oid, version: 1, doc: structuredClone(host.doc()) }
  // Meanwhile another member attached C (the host is now one version ahead).
  await createBoardRepository(host).mutate('b', { type: 'attach-file', cardId: 'c1', attachment: file('C') })
  // Adding B from the stale copy conflicts, is applied again to the fresh card, and keeps C.
  await repo.mutate('b', { type: 'attach-file', cardId: 'c1', attachment: file('B') }, { sharedState: stale })
  assert.deepEqual(host.doc().cards.c1.attachments.map(item => item.id), ['A', 'C', 'B'])
  // Removing A from a stale copy removes only A.
  await repo.mutate('b', { type: 'remove-file', cardId: 'c1', attachmentId: 'A' }, { sharedState: stale })
  assert.deepEqual(host.doc().cards.c1.attachments.map(item => item.id), ['C', 'B'])
  // A whole list written from an old view (a queued edit from an earlier
  // build) can add files but never removes one.
  await repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { attachments: [file('A')] } })
  assert.deepEqual(host.doc().cards.c1.attachments.map(item => item.id), ['C', 'B', 'A'])
  assert.deepEqual(deleted, [])
})

test('a stale whole file list cannot take a card past its file limit', () => {
  const doc = { columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }],
    cards: { c1: card('c1', { attachments: Array.from({ length: 7 }, (_, i) => file(`x${i}`)) }) } }
  applyBoardOp(doc, { type: 'update-card', cardId: 'c1', patch: { attachments: [file('a'), file('b'), file('c')] } })
  assert.deepEqual(doc.cards.c1.attachments.map(item => item.id), ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'a'])
})

test('an upload whose card edit is refused for good is deleted; one waiting for a retry is kept', async () => {
  const { storage, files } = privateBoard([{ id: 'todo', name: 'To do', cardIds: ['c1'] }])
  const path = attachmentPath('b', 'up1', 'image/png')
  files[path] = 'blob'
  const upload = { ...file('up1'), path }
  await assert.rejects(createBoardRepository({ storage }).mutate('b', { type: 'attach-file', cardId: 'gone', attachment: upload }),
    error => error.code === 'missing-card')
  assert.equal(files[path], undefined)
  // A full card refuses another file, and that upload goes too.
  files[path] = 'blob'
  files[boardPath('b')].cards.c1.attachments = Array.from({ length: 8 }, (_, i) => file(`x${i}`))
  await assert.rejects(createBoardRepository({ storage }).mutate('b', { type: 'attach-file', cardId: 'c1', attachment: upload }),
    error => error.code === 'too-many-attachments')
  assert.equal(files[path], undefined)
  // An unreachable shared host keeps the upload for the queued retry.
  const host = sharedHost()
  const deleted = []
  const offline = (url, options = {}) => {
    if (url.includes('/assets/') && options.method === 'DELETE') { deleted.push(url); return Response.json({}) }
    if (url.endsWith('/changes')) throw new TypeError('network connection lost')
    return host.request(url, options)
  }
  await assert.rejects(createBoardRepository({ ...host, request: offline }).mutate('b', { type: 'attach-file', cardId: 'c1', attachment: file('up2') }))
  assert.deepEqual(deleted, [])
})

test('deleting a board deletes everything kept about it, and nothing about other boards', async () => {
  const files = {}
  const storage = {
    async get(path) { return structuredClone(files[path] ?? null) },
    async set(path, value) { files[path] = structuredClone(value) },
    async remove(path) { delete files[path] },
    async list(prefix, options = {}) {
      return Object.keys(files).filter(path => path.startsWith(prefix))
        .map(path => ({ name: path.slice(prefix.length), ...(options.includeContent ? { content: files[path] } : {}) }))
    },
    async getWithVersion(path) { return { value: structuredClone(files[path] ?? null), version: files[path] ? 'v' : null } },
    async durableWrite(path, value) { files[path] = structuredClone(value) },
  }
  for (const id of ['b', 'keep']) {
    files[boardPath(id)] = {}
    files[activityPath(id, 'c1')] = {}
    files[attachmentPath(id, 'f1', 'image/png')] = 'blob'
    files[assignmentLogPath(id)] = {}
    await enqueuePendingBoardOp(id, { type: 'rename-board', title: 'Queued card text' }, storage)
    files[`recovered-board-ops/${id}/r1.json`] = { id: 'r1', op: {} }
    files[`recovery-acknowledgements/${id}/r1.json`] = { id: 'r1' }
  }
  files[CAPACITY_ALERTS_PATH] = { b: { board: true }, keep: { files: true } }
  files['ui.json'] = { lastBoardId: 'b', boardViews: { b: 'mine', keep: 'all' }, collapsedLists: { b: ['x'] },
    openedLists: { b: [], keep: ['y'] }, seenCards: { b: {}, keep: {} } }

  await deleteBoard('b', storage)
  assert.deepEqual(Object.keys(files).filter(path => path.includes('/b/') || path.includes('/b.json') || path.endsWith('/b')), [])
  assert.equal((await readPendingBoardOps('keep', storage)).length, 1)
  assert.ok(files[attachmentPath('keep', 'f1', 'image/png')] && files[activityPath('keep', 'c1')] && files[assignmentLogPath('keep')])
  assert.deepEqual(files[CAPACITY_ALERTS_PATH], { keep: { files: true } })
  assert.deepEqual(files['ui.json'], { lastBoardId: null, boardViews: { keep: 'all' }, collapsedLists: {},
    openedLists: { keep: ['y'] }, seenCards: { keep: {} } })
})

test('a cleanup that fails is reported after the board itself is gone', async () => {
  const files = { [boardPath('b')]: {}, [activityPath('b', 'c1')]: {} }
  const storage = {
    async get() { return null }, async set() {},
    async remove(path) { if (path.startsWith('activity/')) throw new Error('offline'); delete files[path] },
    async list(prefix) { return Object.keys(files).filter(path => path.startsWith(prefix)).map(path => ({ name: path.slice(prefix.length) })) },
    async getWithVersion() { return { value: null, version: null } },
    async durableWrite() {},
  }
  await assert.rejects(deleteBoard('b', storage), /some of what was kept about it could not be/u)
  assert.equal(files[boardPath('b')], undefined)
})

test('a colour-only label and the card counts are announced to screen readers', async () => {
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const tile = board.slice(board.indexOf('function Card('), board.indexOf('function memberRecords('))
  for (const name of ['kb-card-label', 'kb-card-count']) {
    for (const span of tile.match(new RegExp(`<span className=[^>]*${name}[^>]*>`, 'gu'))) {
      assert.match(span, /role="img"/u, span)
      assert.match(span, /aria-label=/u, span)
    }
  }
})

test('applying an assignment through a plain edit is idempotent on replay', () => {
  const doc = { columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card('c1') } }
  const op = { type: 'update-card', cardId: 'c1', patch: { assignee: 'Ana' }, assignmentEvent: { id: 'e1', at: '2026-10-13T08:00:00.000Z' } }
  applyBoardOp(doc, op)
  applyBoardOp(doc, op)
  assert.equal(assignmentHistory(doc.cards.c1).length, 1)
})

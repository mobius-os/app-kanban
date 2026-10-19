import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { configureSync, pullShared, pushSharedOp, changedPieces, applyBoardPieces } from '../sync.js'

const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }
const card = (id, title = id) => ({ id, title, notes: '' })
const board = () => ({ v: 1, title: 'Board', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1', 'c2'] }],
  cards: { c1: card('c1'), c2: card('c2') } })

beforeEach(() => configureSync('fixture', 1))

// A host that stores the board in pieces, like collaboration/service.py.
function piecesHost() {
  let doc = board()
  let version = 1
  const log = []   // [{version, cards: [ids], columns, meta}]
  const calls = []
  const saves = []   // each POST /changes body, as sent
  const since = from => {
    const touched = log.filter(e => e.version > from)
    const cards = new Set(touched.flatMap(e => e.cards))
    const changes = { cards: Object.fromEntries([...cards].map(id => [id, doc.cards[id] ?? null])) }
    if (touched.some(e => e.columns)) changes.columns = doc.columns
    if (touched.some(e => e.meta)) changes.meta = { v: doc.v, title: doc.title }
    return { version, since: from, changes }
  }
  const request = async (url, options = {}) => {
    const method = options.method || 'GET'
    const path = url.replace('/api/apps/1/service/boards/peer.example/obj', '')
    calls.push(`${method} ${path}`)
    if (method === 'POST' && path === '/changes') {
      const { pieces, expected_version: expected } = JSON.parse(options.body)
      saves.push(JSON.parse(options.body))
      const touched = new Set(log.filter(e => e.version > expected)
        .flatMap(e => [...e.cards.map(id => `card:${id}`), ...(e.columns ? ['columns'] : []), ...(e.meta ? ['meta'] : [])]))
      const mine = [...Object.keys(pieces.cards).map(id => `card:${id}`), ...('columns' in pieces ? ['columns'] : []), ...('meta' in pieces ? ['meta'] : [])]
      if (mine.some(piece => touched.has(piece))) return Response.json({ status: 'conflict', ...since(expected) })
      doc = applyBoardPieces(doc, pieces)
      version++
      log.push({ version, cards: Object.keys(pieces.cards), columns: 'columns' in pieces, meta: 'meta' in pieces })
      return Response.json({ status: 'ok', ...since(expected) })
    }
    const query = new URL(url, 'https://x').searchParams
    const from = Number(query.get('since_version'))
    if (version <= from) return Response.json({ status: 'ok', version })
    return Response.json(query.get('changes') === '1' && from >= 1 ? { status: 'ok', ...since(from) } : { status: 'ok', version, doc })
  }
  const otherWriter = (id, title) => {
    doc = applyBoardPieces(doc, { cards: { [id]: card(id, title) } })
    version++
    log.push({ version, cards: [id], columns: false, meta: false })
  }
  return { request, calls, saves, otherWriter, doc: () => doc, version: () => version }
}

test('applying the changed pieces to the old board gives the new board', () => {
  const before = board()
  const after = { ...board(), title: 'Renamed', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1', 'c3'] }],
    cards: { c1: card('c1', 'Edited'), c3: card('c3') } }
  const pieces = changedPieces(before, after)
  assert.deepEqual(Object.keys(pieces.cards).sort(), ['c1', 'c2', 'c3'])
  assert.equal(pieces.cards.c2, null)
  assert.deepEqual(applyBoardPieces(before, pieces), after)
  assert.deepEqual(changedPieces(before, board()), { cards: {} })
})

test('a move carries the moved card so the host keeps its history', async () => {
  const host = piecesHost()
  const moved = { c1: [{ id: 'm1', type: 'moved' }] }
  await pushSharedOp(entry, doc => { doc.columns[0].cardIds = ['c2', 'c1'] }, null, host.request, null, () => moved)
  assert.deepEqual(Object.keys(host.saves.at(-1).pieces.cards), ['c1'])
  assert.equal(host.saves.at(-1).pieces.cards.c1.title, 'c1')
  assert.deepEqual(host.saves.at(-1).activity, moved)
  await pushSharedOp(entry, doc => { doc.columns[0].cardIds = ['c1', 'c2'] }, null, host.request)
  assert.deepEqual(host.saves.at(-1).pieces.cards, {})
})

test('an edit sends only the card it changed, never the whole board', async () => {
  const host = piecesHost()
  const landed = await pushSharedOp(entry, doc => { doc.cards.c2.title = 'Mine' }, null, host.request)
  assert.deepEqual(host.calls, ['GET /state?since_version=-1', 'POST /changes'])
  assert.equal(landed.version, 2)
  assert.equal(landed.doc.cards.c2.title, 'Mine')
  assert.equal(host.doc().cards.c2.title, 'Mine')
})

test('a later poll asks only for changes, and its caller still receives the whole board', async () => {
  const host = piecesHost()
  await pullShared(entry, -1, host.request)
  host.otherWriter('c1', 'From someone else')
  const state = await pullShared(entry, 1, host.request)
  assert.equal(host.calls.at(-1), 'GET /state?since_version=1&changes=1')
  assert.equal(state.version, 2)
  assert.equal(state.doc.cards.c1.title, 'From someone else')
  assert.equal(state.doc.cards.c2.title, 'c2')
  // Nothing new: the reply confirms the version the caller holds, without a board.
  const unchanged = await pullShared(entry, 2, host.request)
  assert.equal(unchanged.doc, undefined)
  assert.equal(unchanged.version, 2)
})

test('edits to different cards both land without a conflict', async () => {
  const host = piecesHost()
  await pullShared(entry, -1, host.request)
  host.otherWriter('c1', 'Theirs')
  const landed = await pushSharedOp(entry, doc => { doc.cards.c2.title = 'Mine' }, null, host.request)
  assert.deepEqual(host.calls.slice(1), ['GET /state?since_version=1&changes=1', 'POST /changes'])
  assert.equal(landed.doc.cards.c1.title, 'Theirs')
  assert.equal(landed.doc.cards.c2.title, 'Mine')
})

test('a conflict on the same card rebases on the changes it carries, without another read', async () => {
  const host = piecesHost()
  const confirmed = { host: entry.host, oid: entry.oid, version: 1, doc: board() }
  host.otherWriter('c1', 'Theirs')
  const landed = await pushSharedOp(entry, doc => { doc.cards.c1.notes = `${doc.cards.c1.title}: noted` }, null, host.request, confirmed)
  assert.deepEqual(host.calls, ['POST /changes', 'POST /changes'])
  assert.equal(landed.doc.cards.c1.notes, 'Theirs: noted')
  assert.equal(host.doc().cards.c1.title, 'Theirs')
})

test('an operation that changes nothing sends nothing', async () => {
  const host = piecesHost()
  const confirmed = { host: entry.host, oid: entry.oid, version: 1, doc: board() }
  const landed = await pushSharedOp(entry, doc => doc, null, host.request, confirmed)
  assert.deepEqual(host.calls, [])
  assert.equal(landed.version, 1)
})

test('a host on an older Kanban gets whole boards, and is remembered', async () => {
  let version = 1
  let remote = board()
  const calls = []
  const request = async (url, options = {}) => {
    const method = options.method || 'GET'
    calls.push(method)
    if (url.endsWith('/changes')) {
      return Response.json({ protocol: 'kanban/1', code: 'invalid-operation', detail: 'Unsupported board operation.' }, { status: 400 })
    }
    if (method === 'PUT') { remote = JSON.parse(options.body).doc; return Response.json({ status: 'ok', version: ++version }) }
    return Response.json({ status: 'ok', version, doc: remote })
  }
  await pushSharedOp(entry, doc => { doc.cards.c1.title = 'One' }, null, request)
  await pushSharedOp(entry, doc => { doc.cards.c1.title = 'Two' }, null, request)
  assert.deepEqual(calls, ['GET', 'POST', 'PUT', 'GET', 'PUT'])
  assert.equal(remote.cards.c1.title, 'Two')
})

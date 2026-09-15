import { configureSync as configureFixture } from '../sync.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { rememberSharedState, pushSharedOp, listInvitations } from '../sync.js'
import { createBoardRepository } from '../boardRepository.js'

const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'object', role: 'editor' }
const doc = (title = 'Board') => ({ v: 1, title, columns: [], cards: {} })
const confirmed = () => rememberSharedState(null, entry, { version: 3, doc: doc() })

test('a confirmed snapshot makes an uncontended edit one version-checked request', async () => {
  const before = confirmed()
  const calls = []
  const saved = await pushSharedOp(entry, value => { value.title = 'Edited' }, null,
    async (url, options) => {
      calls.push(options.method)
      assert.equal(JSON.parse(options.body).expected_version, 3)
      return Response.json({ status: 'ok', version: 4 })
    }, before)
  assert.deepEqual(calls, ['PUT'])
  assert.equal(saved.doc.title, 'Edited')
  assert.equal(before.doc.title, 'Board')
})

test('conflicts rebase on the returned authority without a redundant read', async () => {
  const calls = []
  const saved = await pushSharedOp(entry, value => { value.title = 'Edited' }, null,
    async (url, options) => {
      calls.push(options.method)
      if (calls.length === 1) return Response.json({ status: 'conflict', version: 8, doc: { ...doc(), extra: 'keep' } })
      const body = JSON.parse(options.body)
      assert.equal(body.expected_version, 8)
      assert.equal(body.doc.extra, 'keep')
      return Response.json({ status: 'ok', version: 9 })
    }, confirmed())
  assert.deepEqual(calls, ['PUT', 'PUT'])
  assert.equal(saved.doc.extra, 'keep')
})

test('optimistic or another host snapshot cannot bypass an authoritative read', async () => {
  for (const seed of [{ doc: doc(), version: 3 }, { ...confirmed(), transport: 'kanban/1', host: 'other.example' }]) {
    const calls = []
    await pushSharedOp(entry, value => value, null, async (url, options = {}) => {
      calls.push(options.method || 'GET')
      return Response.json(options.method === 'PUT'
        ? { status: 'ok', version: 4 } : { status: 'ok', version: 3, doc: doc() })
    }, seed)
    assert.deepEqual(calls, ['GET', 'PUT'])
  }
})

test('a stale snapshot cannot falsely declare a newly created card missing', async () => {
  const calls = []
  const saved = await pushSharedOp(entry, value => {
    if (!value.cards.new) throw new Error('Card missing')
    value.cards.new.title = 'Edited'
  }, null, async (url, options = {}) => {
    calls.push(options.method || 'GET')
    return Response.json(options.method === 'PUT' ? { status: 'ok', version: 5 }
      : { status: 'ok', version: 4, doc: { ...doc(), cards: { new: { title: 'New' } } } })
  }, confirmed())
  assert.deepEqual(calls, ['GET', 'PUT'])
  assert.equal(saved.doc.cards.new.title, 'Edited')
})

test('a newer poll seen during an edit survives an older write reply and an unchanged poll', () => {
  let state = confirmed()
  state = rememberSharedState(state, entry, { version: 6, doc: doc('Other editor') })
  state = rememberSharedState(state, entry, { version: 5, doc: doc('My older reply') })
  state = rememberSharedState(state, entry, { version: 6 })
  assert.equal(state.doc.title, 'Other editor')
  assert.equal(state.version, 6)
  assert.equal(rememberSharedState(state, { ...entry, oid: 'other' }, { version: 1 }), null)
})

test('repository checks current membership before using a confirmed snapshot', async () => {
  let calls = 0
  const repo = createBoardRepository({ storage: {
    async getWithVersion() { return { value: { byBoard: { b: { ...entry, role: 'viewer' } } } } },
  }, request: async () => { calls++; throw new Error('must not request') } })
  await assert.rejects(repo.mutate('b', { type: 'rename-board', title: 'No' }, { sharedState: confirmed() }), /read-only/)
  assert.equal(calls, 0)
})

test('overlapping invitation refreshes share one request and failures are retryable', async () => {
  const original = globalThis.fetch
  let calls = 0, settle
  globalThis.fetch = () => { calls++; return new Promise(resolve => { settle = resolve }) }
  try {
    const first = listInvitations(), second = listInvitations()
    await Promise.resolve()
    assert.equal(calls, 1)
    settle(Response.json({ detail: 'unavailable' }, { status: 503 }))
    await Promise.all([assert.rejects(first), assert.rejects(second)])
    const retry = listInvitations()
    await Promise.resolve()
    assert.equal(calls, 2)
    settle(Response.json({ invitations: [{ id: 'new' }] }))
    assert.deepEqual(await retry, [{ id: 'new' }])
  } finally { globalThis.fetch = original }
})


test('a completed write from the previous host is never relabelled as the new authority', () => {
  const nextEntry = { ...entry, transport: 'kanban/1', host: 'migrated.example' }
  const current = rememberSharedState(null, nextEntry, { version: 1, doc: doc('Migrated') })
  assert.equal(rememberSharedState(current, nextEntry, confirmed()), current)
  assert.equal(rememberSharedState(confirmed(), null, { version: 4, doc: doc() }), null)
})

test.beforeEach(() => configureFixture('fixture', 1))

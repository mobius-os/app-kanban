import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptSharedPoll,
  createSharedRefreshLifecycle,
  sharedPollAvailability,
} from '../sync.js'
import { hasRecoverableBoardOps } from '../pendingOps.js'

const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'shared-board' }
const document = title => ({ v: 1, title, columns: [], cards: {} })

function harness(hasCachedBoard = false) {
  const signals = []
  const availability = []
  const lifecycle = createSharedRefreshLifecycle({
    onSignal: error => signals.push(error),
    onAvailability: state => availability.push(state),
  })
  return { lifecycle, signals, availability, hasCachedBoard: () => hasCachedBoard }
}

test('a failed polling streak is reported again only after authoritative integration succeeds', async () => {
  const fixture = harness(false)
  let confirmed = null
  const fail = message => fixture.lifecycle.refresh({
    pull: async () => { throw new Error(message) },
    integrate: async () => true,
    hasCachedBoard: fixture.hasCachedBoard,
  })

  await fail('offline one')
  await fail('offline two')
  await fixture.lifecycle.refresh({
    pull: async () => ({ version: 1 }),
    integrate: async state => { confirmed = acceptSharedPoll(confirmed, entry, state); return true },
    hasCachedBoard: fixture.hasCachedBoard,
  })
  assert.equal(fixture.signals.length, 1, 'a fulfilled but invalid response stays in the same failed streak')

  await fixture.lifecycle.refresh({
    pull: async () => ({ version: 1, doc: document('Recovered') }),
    integrate: async state => { confirmed = acceptSharedPoll(confirmed, entry, state); return true },
    hasCachedBoard: fixture.hasCachedBoard,
  })
  await fail('offline after recovery')

  assert.equal(confirmed.doc.title, 'Recovered')
  assert.equal(fixture.signals.length, 2)
  assert.deepEqual(fixture.availability.map(state => state.kind), [
    'unavailable', 'unavailable', 'unavailable', 'ready', 'unavailable',
  ])
})

test('a malformed advancing response stays failed until that exact version integrates', async () => {
  const fixture = harness(true)
  let confirmed = null
  const integrate = async state => {
    confirmed = acceptSharedPoll(confirmed, entry, state)
    return true
  }
  const refresh = state => fixture.lifecycle.refresh({
    pull: async () => state,
    integrate,
    hasCachedBoard: fixture.hasCachedBoard,
  })

  await refresh({ version: 1, doc: document('Current') })
  for (const malformed of [[], 'not a board', 42]) {
    const result = await refresh({ version: 2, doc: malformed })
    assert.equal(result.status, 'failed')
    assert.equal(confirmed.version, 1)
    assert.equal(confirmed.doc.title, 'Current')
  }

  assert.equal(fixture.signals.length, 1, 'malformed responses remain one failed streak')
  assert.deepEqual(fixture.availability.map(state => state.kind), [
    'ready', 'reconnecting', 'reconnecting', 'reconnecting',
  ])

  const recovered = await refresh({ version: 2, doc: document('Recovered') })
  assert.equal(recovered.status, 'ready')
  assert.equal(confirmed.version, 2)
  assert.equal(confirmed.doc.title, 'Recovered')
  assert.equal(fixture.availability.at(-1).kind, 'ready')
})

test('a cached board reconnects without inventing recoverable edits', async () => {
  const fixture = harness(true)
  await fixture.lifecycle.refresh({
    pull: async () => { throw new Error('host offline') },
    integrate: async () => true,
    hasCachedBoard: fixture.hasCachedBoard,
  })

  assert.equal(fixture.availability.at(-1).kind, 'reconnecting')
  assert.match(fixture.availability.at(-1).message, /showing your last copy/i)
  assert.equal(hasRecoverableBoardOps(0, 0), false)
})

test('an uncached transient failure becomes ready when a later poll integrates', async () => {
  const fixture = harness(false)
  let rendered = null
  await fixture.lifecycle.refresh({
    pull: async () => { throw new Error('temporarily unreachable') },
    integrate: async () => true,
    hasCachedBoard: fixture.hasCachedBoard,
  })
  assert.equal(fixture.availability.at(-1).kind, 'unavailable')
  assert.equal(fixture.lifecycle.shouldContinue(), true)

  await fixture.lifecycle.refresh({
    pull: async () => ({ version: 2, doc: document('From authority') }),
    integrate: async state => {
      rendered = acceptSharedPoll(null, entry, state).doc
      return true
    },
    hasCachedBoard: fixture.hasCachedBoard,
  })

  assert.equal(rendered.title, 'From authority')
  assert.equal(fixture.availability.at(-1).kind, 'ready')
})

test('terminal shared-board failures stop automatic retry and stay actionable', async () => {
  for (const code of ['membership-revoked', 'migration-required', 'board-missing']) {
    for (const cached of [false, true]) {
      const fixture = harness(cached)
      const error = Object.assign(new Error(code), { code })
      await fixture.lifecycle.refresh({
        pull: async () => { throw error },
        integrate: async () => true,
        hasCachedBoard: fixture.hasCachedBoard,
      })
      assert.equal(fixture.availability.at(-1).kind, 'terminal', `${code}, cached=${cached}`)
      assert.equal(fixture.availability.at(-1).retryable, false, code)
      assert.equal(fixture.lifecycle.shouldContinue(), false, code)
      assert.match(fixture.availability.at(-1).message, /saved edits are unchanged/i, code)
    }
  }

  assert.equal(sharedPollAvailability(new Error('offline'), false).kind, 'unavailable')
})

test('queued and recovered edits independently preserve the recovery affordance', () => {
  assert.equal(hasRecoverableBoardOps(1, 0), true)
  assert.equal(hasRecoverableBoardOps(0, 1), true)
  assert.equal(hasRecoverableBoardOps(2, 3), true)
  assert.equal(hasRecoverableBoardOps(0, 0), false)
})

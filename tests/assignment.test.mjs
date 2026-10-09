import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSIGNMENT_HISTORY_LIMIT,
  applyAssignment,
  cardAssignmentTimeline,
  cardMatchesView,
  createAssignmentEvent,
  describeAssignmentEvent,
  isAssignedToMe,
  nextAssignmentLog,
  observeAssignments,
  restorableAssignment,
} from '../assignment.js'
import { applyBoardOp } from '../operations.js'
import { cardMatchesFilters } from '../domain.js'
import { saveBoardView } from '../storage.js'

const ME = { hosts: ['me.example'], names: ['alice'] }
const mine = { assignee: '@alice', assigneeHost: 'me.example' }
const theirs = { assignee: '@bob', assigneeHost: 'bob.example' }
const nobody = { assignee: '', assigneeHost: '' }

test('Mine follows the account host, not a lookalike name', () => {
  assert.equal(isAssignedToMe(mine, ME), true)
  assert.equal(isAssignedToMe({ assignee: '@alice', assigneeHost: 'impostor.example' }, ME), false)
  assert.equal(isAssignedToMe(theirs, ME), false)
  assert.equal(isAssignedToMe(nobody, ME), false)
})

test('Mine includes old hostname-only cards and private "Me" cards', () => {
  assert.equal(isAssignedToMe({ assignee: 'me.example', assigneeHost: '' }, ME), true)
  assert.equal(isAssignedToMe({ assignee: 'Me', assigneeHost: '' }, { hosts: [], names: ['Me'] }), true)
  assert.equal(isAssignedToMe({ assignee: 'Me', assigneeHost: '' }, ME), false)
})

test('board views select all, my, or unowned cards', () => {
  const cards = [mine, theirs, nobody]
  assert.equal(cards.filter(card => cardMatchesView(card, 'all', ME)).length, 3)
  assert.deepEqual(cards.filter(card => cardMatchesView(card, 'mine', ME)), [mine])
  assert.deepEqual(cards.filter(card => cardMatchesView(card, 'unassigned', ME)), [nobody])
  assert.equal(cards.filter(card => cardMatchesView(card, 'bogus', ME)).length, 3)
})

test('text filter finds a card by the person it is assigned to', () => {
  assert.equal(cardMatchesFilters({ title: 'Fix sync', ...theirs }, 'bob'), true)
  assert.equal(cardMatchesFilters({ title: 'Fix sync', assignee: 'host.example' }, 'casey', [], '@casey'), true)
  assert.equal(cardMatchesFilters({ title: 'Fix sync', ...theirs }, 'alice'), false)
})

const event = (id, from, to, by = { label: '@alice', host: 'me.example' }) =>
  createAssignmentEvent({ id, at: '2026-10-08T10:00:00.000Z', by, from, to })

test('an assignment operation records who changed it, once, even when replayed', () => {
  const board = { columns: [], cards: { c1: { id: 'c1', ...theirs } } }
  const op = { type: 'assign-card', cardId: 'c1', assignee: '', assigneeHost: '',
    event: event('e1', { label: '@bob', host: 'bob.example' }, {}) }
  applyBoardOp(board, op)
  applyBoardOp(board, op)
  assert.equal(board.cards.c1.assignee, '')
  assert.equal(board.cards.c1.assigneeHost, '')
  assert.deepEqual(board.cards.c1.assignmentHistory.map(entry => entry.id), ['e1'])
})

test('card history keeps only the most recent changes', () => {
  const card = { id: 'c1', ...nobody }
  for (let index = 0; index < ASSIGNMENT_HISTORY_LIMIT + 5; index++) {
    applyAssignment(card, { assignee: '@alice', assigneeHost: 'me.example', event: event(`e${index}`, {}, mine) })
  }
  assert.equal(card.assignmentHistory.length, ASSIGNMENT_HISTORY_LIMIT)
  assert.equal(card.assignmentHistory.at(-1).id, `e${ASSIGNMENT_HISTORY_LIMIT + 4}`)
})

test('activity reads naturally from the reader\'s point of view', () => {
  const nameFor = ref => ref.host === 'me.example' ? 'you' : ref.label
  const meRef = { label: '@alice', host: 'me.example' }
  const bob = { label: '@bob', host: 'bob.example' }
  assert.equal(describeAssignmentEvent(event('a', {}, meRef, meRef), nameFor), 'You took this card')
  assert.equal(describeAssignmentEvent(event('b', meRef, {}, bob), nameFor), '@bob removed you')
  assert.equal(describeAssignmentEvent(event('c', bob, {}, bob), nameFor), '@bob stepped off this card')
  assert.equal(describeAssignmentEvent(event('d', bob, meRef, meRef), nameFor), 'You took this card from @bob')
  assert.equal(describeAssignmentEvent({ id: 'e', at: 'x', from: bob, to: {} }, nameFor), '@bob was removed')
})

test('Restore is offered only while the removed person is still off the card', () => {
  const removal = event('r', { label: '@bob', host: 'bob.example' }, {})
  assert.deepEqual(restorableAssignment(removal, nobody), { label: '@bob', host: 'bob.example' })
  assert.equal(restorableAssignment(removal, theirs), null)
  assert.equal(restorableAssignment(event('t', {}, mine), nobody), null)
})

test('the first observation only remembers the board', () => {
  const board = { cards: { c1: { id: 'c1', ...theirs } } }
  const result = observeAssignments(board, null, { makeId: () => 'n1' })
  assert.equal(result.changed, true)
  assert.deepEqual(result.events, [])
  assert.equal(result.seen.cards.c1.host, 'bob.example')
})

test('a change from an app without history is noticed with an unknown author', () => {
  const before = observeAssignments({ cards: { c1: { id: 'c1', ...theirs } } }, null, { makeId: () => 'x' }).seen
  const after = { cards: { c1: { id: 'c1', ...nobody } } }
  const result = observeAssignments(after, before, { now: '2026-10-08T11:00:00.000Z', makeId: () => 'n1' })
  assert.deepEqual(result.events, [{ id: 'n1', cardId: 'c1', at: '2026-10-08T11:00:00.000Z',
    from: { label: '@bob', host: 'bob.example' }, to: { label: '', host: '' } }])
  const timeline = cardAssignmentTimeline({ id: 'c1' }, result.seen.observed)
  assert.equal(timeline[0].observed, true)
  assert.equal(timeline[0].by, undefined)
})

test('a change that carries its own history entry is not noticed twice', () => {
  const before = observeAssignments({ cards: { c1: { id: 'c1', ...theirs } } }, null, { makeId: () => 'x' }).seen
  const card = { id: 'c1', ...theirs }
  applyAssignment(card, { assignee: '', assigneeHost: '', event: event('e1', { label: '@bob', host: 'bob.example' }, {}) })
  const result = observeAssignments({ cards: { c1: card } }, before, { makeId: () => 'n1' })
  assert.deepEqual(result.events, [])
  assert.equal(result.changed, true)
  assert.equal(observeAssignments({ cards: { c1: card } }, result.seen, { makeId: () => 'n2' }).changed, false)
})

test('notices for deleted cards are dropped', () => {
  const seen = { cards: { c1: { label: '', host: '', lastEventId: '' } },
    observed: [{ id: 'n1', cardId: 'c1', at: '2026-10-08T11:00:00.000Z', from: {}, to: {} }] }
  const result = observeAssignments({ cards: {} }, seen, { makeId: () => 'n2' })
  assert.equal(result.changed, true)
  assert.deepEqual(result.seen.observed, [])
})

test('only newer host-confirmed versions are observed', () => {
  const confirmed = version => ({ host: 'bob.example', oid: 'b1', version, doc: { cards: { c1: { id: 'c1', ...theirs } } } })
  const first = nextAssignmentLog(null, confirmed(4), { makeId: () => 'x' })
  assert.equal(first.version, 4)
  assert.equal(first.authority, 'bob.example/b1')
  const stale = { host: 'bob.example', oid: 'b1', version: 3, doc: { cards: { c1: { id: 'c1', ...nobody } } } }
  assert.equal(nextAssignmentLog(first, stale, { makeId: () => 'y' }), undefined)
  assert.equal(nextAssignmentLog(first, confirmed(5), { makeId: () => 'z' }), undefined)
})

test('the chosen view is saved per board without disturbing other preferences', async () => {
  let saved = { lastBoardId: 'b1', boardViews: { b2: 'unassigned' } }
  let version = 'v1'
  globalThis.window = { mobius: { storage: {
    async getWithVersion() { return { value: structuredClone(saved), version } },
    async durableWrite(path, value, options) {
      assert.equal(path, 'ui.json')
      assert.deepEqual(options, { ifMatch: version })
      saved = value
      version = 'v2'
    },
  } } }
  await saveBoardView('b1', 'mine')
  assert.deepEqual(saved, { lastBoardId: 'b1', boardViews: { b2: 'unassigned', b1: 'mine' } })
})

test('folded lists are remembered per board, privately, without disturbing other preferences', async () => {
  const { saveListFolds } = await import('../storage.js')
  let saved = { lastBoardId: 'b1', boardViews: { b1: 'mine' }, collapsedLists: { b2: ['done'] } }
  let version = 'v1'
  globalThis.window = { mobius: { storage: {
    async getWithVersion(path) { assert.equal(path, 'ui.json'); return { value: structuredClone(saved), version } },
    async durableWrite(path, value, options) {
      assert.equal(path, 'ui.json')
      assert.deepEqual(options, { ifMatch: version })
      saved = value
      version = 'v2'
    },
  } } }
  await saveListFolds('b1', { folded: ['backlog', 'backlog'], opened: ['done'] })
  assert.deepEqual(saved, {
    lastBoardId: 'b1', boardViews: { b1: 'mine' },
    collapsedLists: { b2: ['done'], b1: ['backlog'] },
    openedLists: { b1: ['done'] },
  })
})

test('the Done list starts folded for each person until they open it; other lists start open', async () => {
  const { listIsFolded, isDoneColumn } = await import('../domain.js')
  const none = { folded: new Set(), opened: new Set() }
  assert.equal(listIsFolded({ id: 'd', name: ' Done ' }, none), true)
  assert.equal(listIsFolded({ id: 't', name: 'To do' }, none), false)
  assert.equal(listIsFolded({ id: 'd', name: 'Done' }, { folded: new Set(), opened: new Set(['d']) }), false, 'opening Done is remembered')
  assert.equal(listIsFolded({ id: 't', name: 'To do' }, { folded: new Set(['t']), opened: new Set() }), true)
  assert.equal(isDoneColumn({ name: 'Finished' }), false, 'only the list completing a card moves cards into counts as Done')
})

test('what you last saw is remembered per board, privately, without disturbing other preferences', async () => {
  const { saveSeenCards } = await import('../storage.js')
  let saved = { lastBoardId: 'b1', boardViews: { b1: 'changed' }, seenCards: { b2: { x: '1' } } }
  globalThis.window = { mobius: { storage: {
    async getWithVersion() { return { value: structuredClone(saved), version: 'v1' } },
    async durableWrite(path, value) { assert.equal(path, 'ui.json'); saved = value },
  } } }
  await saveSeenCards('b1', { a: 'k3', b: 'z9' })
  assert.deepEqual(saved, { lastBoardId: 'b1', boardViews: { b1: 'changed' }, seenCards: { b2: { x: '1' }, b1: { a: 'k3', b: 'z9' } } })
})

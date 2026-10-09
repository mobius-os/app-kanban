import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addChecklistItem,
  assigneeAvatar,
  cardAssigneeLabel,
  assigneeHue,
  assigneeInitials,
  boardAccess,
  cardMatchesFilters,
  checklistProgress,
  shortLinkText,
  deleteChecklistItem,
  dueDateStatus,
  formatDueDate,
  invitationKey,
  isIsoDate,
  swapColumns,
  toggleChecklistItem,
  visibleToFullIndex,
} from '../domain.js'

test('local boards remain writable offline because the app owns their pending operations', () => {
  assert.deepEqual(boardAccess(null, false), {
    canWrite: true,
    status: 'Offline — changes will wait to sync',
  })
})

test('shared boards become read-only while offline instead of promising lost writes', () => {
  assert.deepEqual(boardAccess({ role: 'editor' }, false), {
    canWrite: false,
    status: 'Reconnecting — shared board is read-only',
  })
})

test('viewer membership never exposes a writable board', () => {
  assert.deepEqual(boardAccess({ role: 'viewer' }, true), {
    canWrite: false,
    status: 'View only',
  })
  assert.deepEqual(boardAccess({ role: 'editor' }, true), {
    canWrite: true,
    status: '',
  })
})

test('invitation identity includes both host and object id', () => {
  assert.notEqual(
    invitationKey({ host: 'one.example', id: 'same' }),
    invitationKey({ host: 'two.example', id: 'same' }),
  )
})

test('due-date classification compares valid date-only ISO values', () => {
  assert.equal(dueDateStatus('2026-08-30', '2026-08-31'), 'overdue')
  assert.equal(dueDateStatus('2026-08-31', '2026-08-31'), 'today')
  assert.equal(dueDateStatus('2026-09-01', '2026-08-31'), 'upcoming')
  assert.equal(dueDateStatus('2026-02-30', '2026-08-31'), null)
  assert.equal(isIsoDate('2024-02-29'), true)
  assert.equal(isIsoDate('2025-02-29'), false)
})

test('due-date face copy is compact and timezone-independent', () => {
  assert.equal(formatDueDate('2026-08-31', '2026-08-31', 'en-US'), 'Today')
  assert.equal(formatDueDate('2026-08-28', '2026-08-31', 'en-US'), '3d over')
  assert.equal(formatDueDate('2026-09-04', '2026-08-31', 'en-US'), 'Sep 4')
  assert.equal(formatDueDate('not-a-date', '2026-08-31', 'en-US'), '')
})

test('assignee initials and avatar colors are compact and deterministic', () => {
  assert.equal(assigneeInitials('  Ada Lovelace  '), 'AL')
  assert.equal(assigneeInitials('Prince'), 'PR')
  assert.equal(assigneeInitials('@hamza'), 'HA')
  assert.equal(assigneeInitials(''), '')
  assert.equal(assigneeHue('Ada Lovelace'), assigneeHue('Ada Lovelace'))
  assert.ok(assigneeHue('Ada Lovelace') >= 0 && assigneeHue('Ada Lovelace') < 360)
  assert.deepEqual(assigneeAvatar('Ada Lovelace'), {
    initials: 'AL',
    hue: assigneeHue('Ada Lovelace'),
    background: `hsl(${assigneeHue('Ada Lovelace')} 70% 82%)`,
    color: '#172033',
  })
})

test('checklist ops add, toggle, delete, and calculate progress without mutating input', () => {
  const original = [{ id: 'one', text: 'First', done: false, future: 'kept' }]
  const added = addChecklistItem(original, { id: 'two', text: '  Second  ', done: true, extra: 2 })
  assert.deepEqual(original, [{ id: 'one', text: 'First', done: false, future: 'kept' }])
  assert.deepEqual(added[1], { id: 'two', text: 'Second', done: true, extra: 2 })

  const toggled = toggleChecklistItem(added, 'one')
  assert.equal(toggled[0].done, true)
  assert.equal(toggled[0].future, 'kept')
  assert.deepEqual(checklistProgress(toggled), { done: 2, total: 2, percent: 100 })

  const deleted = deleteChecklistItem(toggled, 'two')
  assert.deepEqual(deleted, [{ id: 'one', text: 'First', done: true, future: 'kept' }])
  assert.deepEqual(checklistProgress(null), { done: 0, total: 0, percent: 0 })
})

test('filter matching searches title and notes case-insensitively and OR-combines labels', () => {
  const card = { title: 'Ship Release', notes: 'Waiting on QA', label: 'blue' }
  assert.equal(cardMatchesFilters(card, 'release', []), true)
  assert.equal(cardMatchesFilters(card, 'waiting ON', []), true)
  assert.equal(cardMatchesFilters(card, 'missing', []), false)
  assert.equal(cardMatchesFilters(card, '', ['red', 'blue']), true)
  assert.equal(cardMatchesFilters(card, 'ship', ['red']), false)
  assert.equal(cardMatchesFilters({ title: 'Plain', notes: '' }, '', ['none']), true)
})

test('column swap exchanges a neighbor without mutating input and respects boundaries', () => {
  const columns = [{ id: 'a' }, { id: 'b', future: true }, { id: 'c' }]
  assert.deepEqual(swapColumns(columns, 'b', -1).map(column => column.id), ['b', 'a', 'c'])
  assert.deepEqual(swapColumns(columns, 'b', 1).map(column => column.id), ['a', 'c', 'b'])
  assert.deepEqual(swapColumns(columns, 'a', -1), columns)
  assert.deepEqual(columns.map(column => column.id), ['a', 'b', 'c'])
  assert.equal(columns[1].future, true)
})

test('visible-to-full index mapping preserves hidden-card positions during filtered drag', () => {
  const full = ['hidden-1', 'a', 'hidden-2', 'moving', 'b', 'hidden-3']
  const visible = ['a', 'moving', 'b']
  assert.equal(visibleToFullIndex(full, visible, 0, 'moving'), 1)
  assert.equal(visibleToFullIndex(full, visible, 1, 'moving'), 3)
  assert.equal(visibleToFullIndex(full, visible, 2, 'moving'), 4)
  assert.equal(visibleToFullIndex(full, [], 0, 'moving'), 5)
})


test('saved assignee handles survive stale member records without matching names', () => {
  const host = 'peer.example'
  const card = { assignee: '@alice', assigneeHost: host }
  assert.equal(cardAssigneeLabel(card, [{ host, name: host }]), '@alice')
  assert.equal(cardAssigneeLabel({ ...card, assignee: host }, [{ host, handle: 'alice' }]), '@alice')
  assert.equal(cardAssigneeLabel(card, [{ host: 'other.example', name: host, handle: 'bob' }]), '@alice')
  assert.equal(cardAssigneeLabel(card, [{ host: 'linked.example', hosts: [host], handle: 'alice' }]), '@alice')
  assert.equal(cardAssigneeLabel({ assignee: 'Alex' }, [{ host: 'other.example', name: 'Alex', handle: 'bob' }]), 'Alex')
})

test('board size is measured the way the host measures it', async () => {
  const { hostDocumentBytes, boardCapacity, SHARED_BOARD_LIMIT_BYTES } = await import('../domain.js')
  const { execFileSync } = await import('node:child_process')
  const doc = { v: 1, title: 'Board — “quotes”', columns: [{ id: 'a', name: 'To do', cardIds: ['c'] }],
    cards: { c: { id: 'c', title: '✅ Done 🚀', notes: 'line\nline "two" \\ tab\t', due: '', done: true, n: 12, x: null, list: [] } } }
  const python = Number(execFileSync('python3', ['-c', 'import json,sys; print(len(json.dumps(json.load(sys.stdin)).encode()))'], { input: JSON.stringify(doc) }).toString())
  assert.equal(hostDocumentBytes(doc), python)
  assert.equal(boardCapacity({ cards: { a: { notes: 'x'.repeat(SHARED_BOARD_LIMIT_BYTES * 0.96) } } }).nearlyFull, true)
  assert.equal(boardCapacity({ cards: { a: { notes: 'x'.repeat(SHARED_BOARD_LIMIT_BYTES * 0.9) } } }).nearlyFull, false)
})

test('a shared board also warns when its attachment space is nearly used up', async () => {
  const { boardCapacity } = await import('../domain.js')
  const cards = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { id: `c${i}`, attachments: [{ id: `a${i}`, size: 1000 }] }]))
  assert.equal(boardCapacity({ cards: cards(94) }).filesNearlyFull, false)
  assert.equal(boardCapacity({ cards: cards(95) }).filesNearlyFull, true)
  assert.equal(boardCapacity({ cards: { a: { attachments: [{ id: 'big', size: 96 * 1024 * 1024 }] } } }).filesNearlyFull, true)
})

test('a list can be recoloured to a known colour or back to none, nothing else', async () => {
  const { applyBoardOp } = await import('../operations.js')
  const board = () => ({ columns: [{ id: 'todo', name: 'To do', color: 'blue', cardIds: [] }], cards: {} })
  assert.equal(applyBoardOp(board(), { type: 'recolor-column', columnId: 'todo', color: 'pink' }).columns[0].color, 'pink')
  assert.equal(applyBoardOp(board(), { type: 'recolor-column', columnId: 'todo', color: null }).columns[0].color, null)
  assert.equal(applyBoardOp(board(), { type: 'recolor-column', columnId: 'todo', color: 'chartreuse' }).columns[0].color, 'blue')
  assert.equal(applyBoardOp(board(), { type: 'recolor-column', columnId: 'missing', color: 'red' }).columns[0].color, 'blue')
})

test('links shown in titles and checklist items are shortened to the site and last part of the address', () => {
  assert.equal(shortLinkText('https://abseil.io/resources/swe-book/html/ch19.html'), 'abseil.io/…/ch19.html')
  assert.equal(shortLinkText('https://www.example.com/'), 'example.com')
  assert.equal(shortLinkText('https://example.com/pricing?plan=pro'), 'example.com/pricing')
  assert.equal(shortLinkText('https://github.com/mobius-os/mobius/pull/1772'), 'mobius#1772')
  assert.equal(shortLinkText('https://github.com/mobius-os/app-kanban/issues/12'), 'app-kanban#12')
  assert.equal(shortLinkText('https://example.com/a/' + 'x'.repeat(40)), 'example.com/…/' + 'x'.repeat(27) + '…')
  assert.equal(shortLinkText('https://example.com/a/%E2%9C%93-done'), 'example.com/…/✓-done')
  assert.equal(shortLinkText('not a url'), 'not a url')
})

test('a board names its label colours one at a time, so naming different colours never overwrites another', async () => {
  const { applyBoardOp } = await import('../operations.js')
  const { labelDisplayName, MAX_LABEL_NAME_CHARS } = await import('../domain.js')
  let board = { columns: [], cards: {} }
  board = applyBoardOp(board, { type: 'name-label', color: 'red', name: '  Urgent ' })
  board = applyBoardOp(board, { type: 'name-label', color: 'amber', name: 'Needs discussion' })
  board = applyBoardOp(board, { type: 'name-label', color: 'blue', name: 'Bug' })
  assert.deepEqual(board.labelNames, { red: 'Urgent', amber: 'Needs discussion', blue: 'Bug' })
  board = applyBoardOp(board, { type: 'name-label', color: 'amber', name: '' })
  assert.deepEqual(board.labelNames, { red: 'Urgent', blue: 'Bug' }, 'an empty name removes it')
  board = applyBoardOp(board, { type: 'name-label', color: 'none', name: 'Nope' })
  board = applyBoardOp(board, { type: 'name-label', color: 'teal', name: 'Nope' })
  assert.deepEqual(board.labelNames, { red: 'Urgent', blue: 'Bug' }, 'only the six label colours can be named')
  board = applyBoardOp(board, { type: 'name-label', color: 'green', name: 'x'.repeat(40) })
  assert.equal(board.labelNames.green.length, MAX_LABEL_NAME_CHARS)
  assert.equal(labelDisplayName('red', board.labelNames), 'Urgent')
  assert.equal(labelDisplayName('pink', board.labelNames), 'Pink', 'an unnamed colour is called by its colour')
})

test('label names survive loading, and boards that never named a label stay unchanged', async () => {
  const { normalizeBoard } = await import('../storage.js')
  const named = normalizeBoard({ columns: [], cards: {}, labelNames: { red: 'Urgent', teal: 'x', blue: 7 } })
  assert.deepEqual(named.labelNames, { red: 'Urgent' })
  assert.equal('labelNames' in normalizeBoard({ columns: [], cards: {} }), false)
})

test('a card counts as changed when what a person sees on it differs from what they last saw', async () => {
  const { boardFingerprints, changedCardIds } = await import('../domain.js')
  const board = () => ({
    columns: [{ id: 'todo', cardIds: ['a', 'b'] }, { id: 'done', cardIds: [] }],
    cards: { a: { id: 'a', title: 'Fix login', checklist: [] }, b: { id: 'b', title: 'Ship', checklist: [] } },
  })
  assert.equal(changedCardIds(board(), null).size, 0, 'the first visit is the baseline, nothing is changed yet')
  const seen = boardFingerprints(board())
  assert.equal(changedCardIds(board(), seen).size, 0)
  const moved = board(); moved.columns[0].cardIds = ['b']; moved.columns[1].cardIds = ['a']
  assert.deepEqual([...changedCardIds(moved, seen)], ['a'], 'moving a card to another list is a change')
  const relabelled = board(); relabelled.cards.b.label = 'red'
  assert.deepEqual([...changedCardIds(relabelled, seen)], ['b'])
  const ticked = board(); ticked.cards.a.checklist = [{ id: 'i', text: 'Test', done: true }]
  assert.deepEqual([...changedCardIds(ticked, seen)], ['a'])
  const added = board(); added.cards.c = { id: 'c', title: 'New' }; added.columns[0].cardIds.push('c')
  assert.deepEqual([...changedCardIds(added, seen)], ['c'], 'a card added since you looked is new to you')
})

test('the Changed view shows only cards changed since you last looked', async () => {
  const { cardMatchesView, normalizeBoardView } = await import('../assignment.js')
  assert.equal(normalizeBoardView('changed'), 'changed')
  assert.equal(cardMatchesView({ id: 'a' }, 'changed', {}, new Set(['a'])), true)
  assert.equal(cardMatchesView({ id: 'b' }, 'changed', {}, new Set(['a'])), false)
  assert.equal(cardMatchesView({ id: 'b' }, 'changed', {}), false, 'with nothing remembered, nothing is changed')
})

test('the cards you open or change yourself are remembered as seen', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const mutate = source.slice(source.indexOf('const mutate = useCallback('), source.indexOf('const mutate = useCallback(') + 4000)
  assert.match(mutate, /markSeenRef\.current\(ownCardIds, optimistic\)/)
  assert.match(mutate, /markSeenRef\.current\(ownCardIds, landed\.doc\)/)
  assert.match(source, /if \(openCardPrint\) markSeenRef\.current\(\[openCardId\]\)/)
})

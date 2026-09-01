import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addChecklistItem,
  assigneeAvatar,
  assigneeHue,
  assigneeInitials,
  boardAccess,
  cardMatchesFilters,
  checklistProgress,
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

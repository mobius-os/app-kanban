import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'

const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')

test('deleting a list always opens a confirmation, never deletes on the first click', () => {
  // The trash control opens the confirm for every list, including empty ones.
  assert.match(
    board,
    /aria-label=\{`Delete list \$\{col\.name\}`\}[\s\S]*?onClick=\{\(\) => setConfirmDeleteCol\(col\.id\)\}/,
  )
  // Guard against the old shortcut that deleted an empty list immediately.
  assert.doesNotMatch(board, /allCards\.length \? setConfirmDeleteCol\(col\.id\) : deleteColumn\(col\.id\)/)
})

test('the list-delete confirmation focuses Cancel, not the destructive action', () => {
  const start = board.indexOf('kb-col-confirm-actions')
  const actions = board.slice(start, board.indexOf('</div>', start))
  assert.ok(start !== -1, 'confirmation action row should exist')
  // Cancel precedes Delete in DOM order so the modal-focus trap lands on the safe action.
  assert.ok(
    actions.indexOf('>Cancel<') < actions.indexOf('>Delete<'),
    'Cancel should precede Delete in DOM order',
  )
})

test('the list-delete confirmation uses its dedicated card styling', () => {
  assert.match(CSS, /\.kb-col-confirm \{[^}]*border-radius/s)
})

test('deleting a card always asks first, and Cancel comes before Delete', () => {
  assert.match(board, /onDelete=\{canDeleteOpenCard \? \(\) => setConfirmDeleteCard\(true\) : null\}/)
  assert.doesNotMatch(board, /kb-delete-card" onClick=\{\(\) => deleteCard\(/)
  const start = board.indexOf('kb-card-delete-confirm')
  const end = board.indexOf('<CardFooter', start)
  assert.ok(start !== -1 && end > start, 'the confirmation sits beside the delete control')
  const block = board.slice(start, end)
  assert.ok(block.indexOf('>Cancel<') !== -1 && block.indexOf('>Cancel<') < block.indexOf('>Delete<'))
})

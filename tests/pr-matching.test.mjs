import test from 'node:test'
import assert from 'node:assert/strict'
import { pullMatchesCard } from '../prMatching.js'

test('open PR matching uses title and checklist intent, not unrelated cards', () => {
  const card = { title: 'Improve Kanban card links', checklist: [{ text: 'Show linked pull requests' }] }
  assert.equal(pullMatchesCard({ title: 'Improve Kanban card links' }, card), true)
  assert.equal(pullMatchesCard({ title: 'Show linked pull requests' }, card), true)
  assert.equal(pullMatchesCard({ title: 'Fix payment invoices' }, card), false)
})

test('PR description can identify a card when its title differs', () => {
  const card = { title: 'Collaborator recovery', notes: 'Handle failed board refresh without losing pending edits' }
  assert.equal(pullMatchesCard({ title: 'Make retries safe', body: 'Handle failed board refresh without losing pending edits' }, card), true)
})

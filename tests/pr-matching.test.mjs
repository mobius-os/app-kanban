import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePullRequestUrl, pullMatchesCard, pullRequestStatus } from '../prMatching.js'

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

test('plural and singular words match without a hand-written alias table', () => {
  const card = { title: 'Show collaborator attachment previews' }
  assert.equal(pullMatchesCard({ title: 'Show collaborators’ attachments preview' }, card), true)
  assert.equal(pullMatchesCard({ title: 'Recover gracefully from busy errors' }, { title: 'Retry delayed capacity' }), false)
})

test('only GitHub pull request URLs are recognized as pull requests', () => {
  assert.deepEqual(parsePullRequestUrl(' https://github.com/acme/app/pull/12/ '), { owner: 'acme', repo: 'app', number: 12 })
  assert.equal(parsePullRequestUrl('https://github.com/acme/app/issues/12'), null)
  assert.equal(parsePullRequestUrl('https://example.com/acme/app/pull/12'), null)
  assert.equal(parsePullRequestUrl('not a url'), null)
})

test('pull request status never shows a missing GitHub connection or private PR as closed', () => {
  assert.equal(pullRequestStatus(200, { state: 'open' }).label, 'Open')
  assert.equal(pullRequestStatus(200, { state: 'open', draft: true }).label, 'Draft')
  assert.equal(pullRequestStatus(200, { state: 'closed', merged_at: '2026-09-01T00:00:00Z' }).label, 'Merged')
  assert.equal(pullRequestStatus(200, { state: 'closed' }).label, 'Closed')
  const notConnected = pullRequestStatus(401)
  assert.equal(notConnected.label, 'Connect GitHub')
  assert.match(notConnected.hint, /Connect GitHub/)
  assert.equal(pullRequestStatus(404).label, 'Not visible', 'GitHub answers 404 for a private repo the connection cannot read')
  for (const status of [0, 403, 429, 502]) {
    assert.equal(pullRequestStatus(status).label, 'Unavailable')
  }
  for (const status of [0, 401, 403, 404]) assert.equal(pullRequestStatus(status).tone, 'unknown')
})

test('a pull request status carries its GitHub title so the card can name it without a second request', () => {
  assert.equal(pullRequestStatus(200, { state: 'open', title: '  Render app-owned blocks in chat  ' }).title, 'Render app-owned blocks in chat')
  assert.equal(pullRequestStatus(200, { state: 'closed', merged_at: '2026-09-01T00:00:00Z', title: 'Ship it' }).title, 'Ship it')
  assert.equal('title' in pullRequestStatus(200, { state: 'open' }), false, 'no title means the card falls back to repo and number')
  assert.equal('title' in pullRequestStatus(404), false)
})

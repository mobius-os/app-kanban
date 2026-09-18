import test from 'node:test'
import assert from 'node:assert/strict'
import { pullCardScore } from '../prMatching.js'

const pull = (title, repository = 'https://api.github.com/repos/mobius-os/app-kanban') => ({ title, repository_url: repository })

test('a repository mention alone cannot match an unrelated pull request', () => {
  const result = pullCardScore(pull('Add a new app contribution workflow'), { title: 'Improve Kanban', checklist: [] })
  assert.equal(result.eligible, false)
})

test('a related repository pull request remains eligible when its title overlaps the card', () => {
  const result = pullCardScore(pull('Improve Kanban card details'), { title: 'Improve Kanban', checklist: [] })
  assert.equal(result.eligible, true)
})

test('a strong title match remains eligible when a card does not name the repository', () => {
  const result = pullCardScore(
    pull('Cap auto-compact threshold for 1M-window models under the broker body cap', 'https://api.github.com/repos/mobius-os/mobius'),
    { title: 'Revisit compaction: auto-compact threshold vs the gateway body cap', checklist: [] },
  )
  assert.equal(result.eligible, true)
})

test('capacity and backoff wording matches a busy-model retry pull request', () => {
  const result = pullCardScore(
    pull('Recover busy selected models with a delayed retry', 'https://api.github.com/repos/mobius-os/mobius'),
    { title: 'Graciously handle errors with some backoff: selected model is at capacity', checklist: [] },
  )
  assert.equal(result.eligible, true)
})

test('an exact title match remains eligible without a repository mention', () => {
  const result = pullCardScore(pull('Improve Kanban'), { title: 'Improve Kanban', checklist: [] })
  assert.equal(result.eligible, true)
})

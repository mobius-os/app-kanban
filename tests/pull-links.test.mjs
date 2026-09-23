import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBoardOp } from '../operations.js'
import { normalizeBoard } from '../storage.js'

const board = () => ({
  columns: [{ id: 'todo', cardIds: ['card'] }],
  cards: { card: { id: 'card', title: 'Review', pullRequestUrl: 'https://github.com/acme/app/pull/1', pullRequestUrls: [
    'https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/2',
  ] } },
})

test('the scalar PR edit replaces the primary link without dropping another link', () => {
  const doc = board()
  applyBoardOp(doc, { type: 'update-card', cardId: 'card', patch: { pullRequestUrl: 'https://github.com/acme/app/pull/3' } })
  assert.deepEqual(doc.cards.card.pullRequestUrls, [
    'https://github.com/acme/app/pull/3', 'https://github.com/acme/app/pull/2',
  ])
  assert.equal(doc.cards.card.pullRequestUrl, doc.cards.card.pullRequestUrls[0])
})

test('the plural PR edit is authoritative, including removal of every link', () => {
  const doc = board()
  applyBoardOp(doc, { type: 'update-card', cardId: 'card', patch: { pullRequestUrls: [] } })
  assert.deepEqual(doc.cards.card.pullRequestUrls, [])
  assert.equal(doc.cards.card.pullRequestUrl, '')
})

test('normalization preserves a legacy scalar PR link', () => {
  const doc = board()
  delete doc.cards.card.pullRequestUrls
  const result = normalizeBoard(doc)
  assert.deepEqual(result.cards.card.pullRequestUrls, ['https://github.com/acme/app/pull/1'])
})

test('PR link edits rebase on concurrent links without overwriting them', () => {
  const doc = board()
  doc.cards.card.pullRequestUrls.push('https://github.com/acme/app/pull/3')
  applyBoardOp(doc, { type: 'edit-pull-request', cardId: 'card', previousUrl: null, nextUrl: 'https://github.com/acme/app/pull/4' })
  assert.deepEqual(doc.cards.card.pullRequestUrls, [1, 2, 3, 4].map(number => `https://github.com/acme/app/pull/${number}`))
  applyBoardOp(doc, { type: 'edit-pull-request', cardId: 'card', previousUrl: 'https://github.com/acme/app/pull/1', nextUrl: 'https://github.com/acme/app/pull/5' })
  assert.deepEqual(doc.cards.card.pullRequestUrls, [5, 2, 3, 4].map(number => `https://github.com/acme/app/pull/${number}`))
  applyBoardOp(doc, { type: 'edit-pull-request', cardId: 'card', previousUrl: 'https://github.com/acme/app/pull/2', nextUrl: '' })
  assert.deepEqual(doc.cards.card.pullRequestUrls, [5, 3, 4].map(number => `https://github.com/acme/app/pull/${number}`))
})

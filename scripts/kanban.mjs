#!/usr/bin/env node
// Thin command-line transport for the same repository the board screen uses.
import { createBoardRepository } from '../boardRepository.js'
import { configureSync, recoverMemberships } from '../sync.js'
import { uid } from '../storage.js'
import { isIsoDate } from '../domain.js'
import { hasCardCompletion } from '../operations.js'
import { pullCardScore } from '../prMatching.js'


const base = process.env.API_BASE_URL
const token = process.env.AGENT_TOKEN
if (!base || !token) throw new Error('Run inside a Möbius agent turn.')
async function request(path, options = {}) {
  return fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` } })
}
async function checked(response) {
  if (!response.ok) {
    const error = new Error(`Kanban request failed (${response.status}): ${await response.text()}`)
    if ([409, 412].includes(response.status)) error.code = 'conflict'
    throw error
  }
  return response
}
const apps = await (await checked(await request('/api/apps/'))).json()
const matches = apps.filter(app => app.slug === 'kanban')
if (matches.length !== 1) throw new Error('Expected exactly one installed Kanban app.')
const appId = matches[0].id
configureSync(token, appId)
const root = `/api/storage/apps/${appId}/`
const storage = {
  async getWithVersion(path) {
    const response = await request(root + path, { headers: { 'X-Mobius-Version': '1' } })
    if (response.status === 404) return { value: null, version: null }
    await checked(response)
    const version = response.headers.get('ETag')
    if (!version) throw new Error('Storage read lacks a version; cannot safely change this board.')
    return { value: await response.json(), version }
  },
  async durableWrite(path, value, condition = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (condition.ifMatch) headers['If-Match'] = condition.ifMatch
    if (condition.ifNoneMatch) headers['If-None-Match'] = '*'
    await checked(await request(root + path, { method: 'PUT', headers, body: JSON.stringify(value) }))
  },
  async set(path, value) { return this.durableWrite(path, value) },
  async list(prefix) {
    const entries = []
    let cursor = null
    do {
      const query = new URLSearchParams(cursor ? { cursor } : {})
      const page = await (await checked(await request(`/api/storage/apps-list/${appId}/${prefix}?${query}`))).json()
      entries.push(...page.entries)
      cursor = page.next_cursor
    } while (cursor)
    return entries
  },
}
try {
  await recoverMemberships(storage, request)
} catch {
  // Discovery is repairable; it must not make private boards depend on peers.
  // The repository still requires authority confirmation for every shared write.
  console.error('Membership discovery unavailable; using recorded board authorities.')
}
const repository = createBoardRepository({ storage, request })
const [command, boardId] = process.argv.slice(2)
async function input() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return JSON.parse(raw)
}
const labels = new Set(['none', 'red', 'amber', 'green', 'blue', 'purple', 'pink'])
const reservedIds = new Set(['__proto__', 'prototype', 'constructor'])
const validId = value => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  && !reservedIds.has(value)
function normalizedAssignee(value) {
  const normalized = String(value || '').trim().replace(/^@/u, '').toLocaleLowerCase()
  return normalized === 'me' ? null : normalized
}
function validatePatch(patch) {
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) throw new Error('title must be a non-empty string.')
  for (const field of ['notes', 'assignee', 'assigneeHost', 'pullRequestUrl']) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') throw new Error(`${field} must be a string.`)
  }
  if (patch.pullRequestUrls !== undefined && (!Array.isArray(patch.pullRequestUrls) || patch.pullRequestUrls.some(value => typeof value !== 'string'))) throw new Error('pullRequestUrls must be an array of strings.')
  if (patch.label !== undefined && !labels.has(patch.label)) throw new Error('label is invalid.')
  if (patch.due !== undefined && patch.due !== '' && !isIsoDate(patch.due)) throw new Error('due must be empty or a valid YYYY-MM-DD date.')
}
function exactTitle(value) {
  return typeof value === 'string' ? value.trim() : ''
}
function validPrUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}
async function completeMatchingCard(data) {
  const title = exactTitle(data?.title)
  const summary = typeof data?.summary === 'string' ? data.summary.trim() : ''
  const prUrl = typeof data?.prUrl === 'string' ? data.prUrl.trim() : ''
  if (!title || !summary || summary.includes('\n') || !validPrUrl(prUrl)) {
    throw new Error('title, a one-line summary, and a valid http(s) prUrl are required.')
  }
  const boards = await repository.list()
  const unavailable = boards.filter(board => board.status === 'unavailable')
  if (unavailable.length) {
    throw new Error(`Cannot safely complete a card by title while ${unavailable.length} recorded board${unavailable.length === 1 ? ' is' : 's are'} unavailable; retry when every board can be checked.`)
  }
  const matches = []
  for (const board of boards) {
    const state = await repository.read(board.id)
    for (const card of Object.values(state.doc.cards)) {
      if (exactTitle(card?.title) === title) matches.push({ board, card })
    }
  }
  if (matches.length === 0) throw new Error(`No Kanban card exactly matches “${title}”.`)
  if (matches.length > 1) throw new Error(`More than one Kanban card exactly matches “${title}”; use unique card titles before completing it automatically.`)
  const match = matches[0]
  const alreadySaved = hasCardCompletion(match.card.notes, prUrl)
  const saved = await repository.mutate(match.board.id, {
    type: 'complete-card', cardId: match.card.id, expectedTitle: title, summary, prUrl,
  })
  return { status: alreadySaved ? 'already-saved' : 'saved', boardId: match.board.id,
    cardId: match.card.id, card: saved.doc.cards[match.card.id] }
}
async function syncOpenPrs(dryRun) {
  const userResponse = await request('/api/github/api/user')
  if (!userResponse.ok) throw new Error('GitHub identity unavailable; connect GitHub in Settings first.')
  const user = await userResponse.json()
  const ownerLogin = user.login
  const searchResponse = await request(
    `/api/github/api/search/issues?q=${encodeURIComponent(`is:pr is:open author:${ownerLogin}`)}&per_page=50`,
  )
  if (!searchResponse.ok) throw new Error('Could not fetch open pull requests from GitHub.')
  const { items: pulls = [] } = await searchResponse.json()
  if (!pulls.length) return { matched: [], skipped: [], dryRun }
  const boards = await repository.list()
  const unavailable = boards.filter(b => b.status === 'unavailable')
  if (unavailable.length) {
    throw new Error(`Cannot safely sync while ${unavailable.length} recorded board${unavailable.length === 1 ? ' is' : 's are'} unavailable; retry when every board can be checked.`)
  }
  const candidateCards = []
  for (const board of boards) {
    const state = await repository.read(board.id)
    for (const card of Object.values(state.doc.cards)) {
      const assignee = normalizedAssignee(card.assignee)
      if ((assignee === null || assignee === ownerLogin.toLocaleLowerCase()) && !card.pullRequestUrl) {
        candidateCards.push({ board, card })
      }
    }
  }
  const matched = []
  const skipped = []
  const reservedCardIds = new Set()
  for (const pull of pulls) {
    const scored = candidateCards
      .map(({ board, card }) => ({ board, card, score: pullCardScore(pull, card) }))
      .filter(({ card, score }) => score.eligible && !reservedCardIds.has(card.id))
    if (scored.length !== 1) {
      skipped.push({ pr: pull.html_url, title: pull.title, reason: scored.length === 0 ? 'no match' : 'multiple matches' })
      continue
    }
    const { board, card } = scored[0]
    reservedCardIds.add(card.id)
    if (!dryRun) {
      const urls = [...new Set([...(Array.isArray(card.pullRequestUrls) ? card.pullRequestUrls : []), card.pullRequestUrl, pull.html_url].filter(Boolean))]
      await repository.mutate(board.id, { type: 'update-card', cardId: card.id, patch: { pullRequestUrl: urls[0], pullRequestUrls: urls } })
    }
    matched.push({ pr: pull.html_url, prTitle: pull.title, card: card.title, boardId: board.id, cardId: card.id })
  }
  return { matched, skipped, dryRun }
}
try {
  let result
  if (command === 'list') result = await repository.list()
  else if (command === 'read' && validId(boardId)) result = await repository.read(boardId)
  else if (command === 'set-checklist-item' && validId(boardId)) {
    const data = await input()
    if (!data || typeof data !== 'object' || Array.isArray(data) || !validId(data.cardId) || !validId(data.itemId) || typeof data.done !== 'boolean') {
      throw new Error('cardId, itemId, and boolean done are required.')
    }
    const fresh = await repository.read(boardId)
    if (!fresh.doc.cards[data.cardId]?.checklist?.some(item => item?.id === data.itemId)) throw new Error('Checklist item was not found on the current card.')
    const saved = await repository.mutate(boardId, {
      type: 'set-checklist-item', cardId: data.cardId, itemId: data.itemId, done: data.done,
    })
    if (!saved.doc.cards[data.cardId]?.checklist?.some(item => item?.id === data.itemId && item.done === data.done)) throw new Error('Checklist item was not saved.')
    result = { status: 'saved', appId, boardId, cardId: data.cardId, authority: saved.authority,
      version: saved.version, card: saved.doc.cards[data.cardId] }
  }
  else if (['add-card', 'update-card', 'move-card'].includes(command) && validId(boardId)) {
    const data = await input()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Input must be a JSON object.')
    let op
    if (command === 'add-card') {
      if (!validId(data.columnId) || typeof data.title !== 'string' || !data.title.trim()) throw new Error('columnId and a non-empty title are required.')
      if (data.id !== undefined && !validId(data.id)) throw new Error('id must be a safe non-empty string.')
      if (data.notes !== undefined && typeof data.notes !== 'string') throw new Error('notes must be a string.')
      op = { type: command, columnId: data.columnId, card: {
        id: data.id || uid(), title: data.title.trim(), notes: data.notes || '',
        label: 'none', due: '', assignee: '', assigneeHost: '', checklist: [],
        createdAt: new Date().toISOString(),
      } }
    } else if (command === 'update-card') {
      if (!validId(data.cardId) || !data.patch || typeof data.patch !== 'object' || Array.isArray(data.patch)) throw new Error('cardId and patch are required.')
      const fields = ['title', 'notes', 'label', 'due', 'assignee', 'assigneeHost', 'pullRequestUrl', 'pullRequestUrls']
      if (Object.keys(data.patch).some(key => !fields.includes(key))) throw new Error('Patch must contain editable card fields only.')
      validatePatch(data.patch)
      op = { type: command, cardId: data.cardId, patch: data.patch }
    } else {
      if (!validId(data.cardId) || !validId(data.toColumnId)
        || (data.beforeCardId != null && !validId(data.beforeCardId))) throw new Error('cardId and toColumnId are required, with an optional safe beforeCardId.')
      op = { type: command, cardId: data.cardId, toColumnId: data.toColumnId, beforeCardId: data.beforeCardId ?? null }
    }
    const saved = await repository.mutate(boardId, op)
    const cardId = op.card?.id || op.cardId
    result = { status: 'saved', appId, boardId, cardId, authority: saved.authority,
      version: saved.version, card: saved.doc.cards[cardId] }
  } else if (command === 'complete-matching-card') {
    result = await completeMatchingCard(await input())
  } else if (command === 'sync-open-prs') {
    result = await syncOpenPrs(process.argv.includes('--dry-run'))
  } else throw new Error('Usage: kanban.mjs list | read BOARD_ID | add-card/update-card/move-card/set-checklist-item BOARD_ID < input.json | complete-matching-card < input.json | sync-open-prs [--dry-run]')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'not-confirmed', error: error.message }))
  process.exitCode = 1
}

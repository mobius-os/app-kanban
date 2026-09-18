#!/usr/bin/env node
// Thin command-line transport for the same repository the board screen uses.
import { createBoardRepository } from '../boardRepository.js'
import { configureSync, recoverMemberships } from '../sync.js'
import { uid } from '../storage.js'
import { isIsoDate } from '../domain.js'

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
function validatePatch(patch) {
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) throw new Error('title must be a non-empty string.')
  for (const field of ['notes', 'assignee', 'assigneeHost']) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') throw new Error(`${field} must be a string.`)
  }
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
function titleWords(value) {
  const ignored = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'this', 'that', 'to', 'use', 'using', 'with'])
  const aliases = { handles: ['handle', 'name'], handle: ['name'], verified: ['name'], collaborators: ['collaborator', 'user'], collaborator: ['user'], users: ['user'], assignee: ['assign'], assign: ['assignee'], attachments: ['attachment'], previews: ['preview'], entries: ['entry'] }
  return new Set((String(value || '').toLocaleLowerCase().match(/[a-z0-9]+/g) || []).filter(word => !ignored.has(word)).flatMap(word => [word, ...(aliases[word] || [])]))
}
function titleSimilarity(left, right) {
  const a = titleWords(left)
  const b = titleWords(right)
  const overlap = [...a].filter(word => b.has(word)).length
  return overlap ? overlap / new Set([...a, ...b]).size : 0
}
function cardMatchText(card) {
  return [card?.title, ...(Array.isArray(card?.checklist) ? card.checklist.map(item => item?.text) : [])].filter(Boolean).join('\n')
}
function pullRepositoryName(pull) {
  try { return new URL(pull?.repository_url || pull?.html_url || '').pathname.split('/').filter(Boolean).at(-1)?.replace(/^app-/u, '').toLocaleLowerCase() || '' } catch { return '' }
}
function pullCardScore(pull, card) {
  const text = cardMatchText(card)
  const titleScore = titleSimilarity(pull.title, text)
  const repository = pullRepositoryName(pull)
  const repositoryMatch = repository && text.toLocaleLowerCase().includes(repository)
  return { score: titleScore + (repositoryMatch ? 1 : 0), eligible: repositoryMatch || titleScore >= 0.15 }
}
function readyForDone(card, merged) {
  return merged === true && (card?.checklist || []).every(item => item?.done === true)
}
async function allCards() {
  const boards = await repository.list()
  const cards = []
  for (const board of boards) {
    if (board.status === 'unavailable') continue
    const state = await repository.read(board.id)
    for (const card of Object.values(state.doc.cards)) cards.push({ board, card })
  }
  return cards
}
async function assignedToMe(cards) {
  const response = await checked(await request('/api/identity'))
  const identity = await response.json()
  const profile = identity.profile || {}
  const names = new Set([
    profile.handle && `@${String(profile.handle).trim().replace(/^@/u, '')}`,
    profile.handle,
    profile.display_name,
  ].filter(Boolean).map(value => String(value).trim().toLocaleLowerCase()))
  if (names.size === 0) throw new Error('Your profile could not be identified, so assigned cards cannot be matched safely.')
  const hosts = new Set((identity.deployments || []).map(deployment => {
    try { return new URL(deployment?.url || '').hostname.toLocaleLowerCase() } catch { return '' }
  }).filter(Boolean))
  return cards.filter(({ card }) => names.has(String(card.assignee || '').trim().toLocaleLowerCase())
    || hosts.has(String(card.assignee || '').trim().toLocaleLowerCase())
    || hosts.has(String(card.assigneeHost || '').trim().toLocaleLowerCase()))
}
async function moveToDone(boardId, cardId, doc) {
  const doneColumn = doc.columns.find(column => String(column.name || '').trim().toLocaleLowerCase() === 'done')
  if (!doneColumn || doneColumn.cardIds.includes(cardId)) return doc.cards[cardId]
  const moved = await repository.mutate(boardId, {
    type: 'move-card', cardId, toColumnId: doneColumn.id, beforeCardId: null,
  })
  return moved.doc.cards[cardId]
}
async function checkCompletedItems(boardId, card, pullTitle, merged) {
  if (!merged) return card
  let doc = card
  for (const item of card.checklist || []) {
    if (!item?.id || item.done || titleSimilarity(pullTitle, item.text) < 0.1) continue
    const saved = await repository.mutate(boardId, {
      type: 'set-checklist-item', cardId: card.id, itemId: item.id, done: true,
    })
    doc = saved.doc.cards[card.id]
  }
  return doc
}
async function completeMatchingCard(data) {
  const title = exactTitle(data?.title)
  const summary = typeof data?.summary === 'string' ? data.summary.trim() : ''
  const prUrl = typeof data?.prUrl === 'string' ? data.prUrl.trim() : ''
  const merged = data?.merged === true
  if (!title || !summary || !validPrUrl(prUrl)) {
    throw new Error('title, summary, and a valid http(s) prUrl are required.')
  }
  const matches = (await allCards()).filter(({ card }) => exactTitle(card?.title) === title)
  if (matches.length === 0) throw new Error(`No Kanban card exactly matches “${title}”.`)
  if (matches.length > 1) throw new Error(`More than one Kanban card exactly matches “${title}”; use unique card titles before completing it automatically.`)
  const match = matches[0]
  if (String(match.card.notes || '').includes(prUrl)) {
    const state = await repository.read(match.board.id)
    const checked = await checkCompletedItems(match.board.id, state.doc.cards[match.card.id], summary, merged)
    const card = readyForDone(checked, merged)
      ? await moveToDone(match.board.id, match.card.id, { ...state.doc, cards: { ...state.doc.cards, [match.card.id]: checked } })
      : checked
    return { status: 'already-saved', boardId: match.board.id, cardId: match.card.id, card }
  }
  const completion = `✅ Done — ${summary}\nPR: ${prUrl}`
  const notes = [String(match.card.notes || '').trim(), completion].filter(Boolean).join('\n\n')
  const saved = await repository.mutate(match.board.id, {
    type: 'update-card', cardId: match.card.id, patch: { notes },
  })
  const card = readyForDone(saved.doc.cards[match.card.id], merged)
    ? await moveToDone(match.board.id, match.card.id, saved.doc)
    : saved.doc.cards[match.card.id]
  return { status: 'saved', boardId: match.board.id, cardId: match.card.id, card }
}
async function syncOpenPrs({ dryRun = false } = {}) {
  const payloads = await Promise.all(['is:pr is:open author:@me', 'is:pr is:merged author:@me'].map(async q => {
    const search = new URLSearchParams({ q, per_page: '100' })
    return (await checked(await request(`/api/github/api/search/issues?${search}`))).json()
  }))
  const cards = await assignedToMe(await allCards())
  const results = []
  const pulls = [...new Map(payloads.flatMap(payload => Array.isArray(payload.items) ? payload.items : [])
    .filter(pull => typeof pull?.html_url === 'string').map(pull => [pull.html_url, pull])).values()]
  for (const pull of pulls) {
    const title = exactTitle(pull?.title)
    const prUrl = typeof pull?.html_url === 'string' ? pull.html_url : ''
    if (!title || !validPrUrl(prUrl)) continue
    const ranked = cards.map(match => ({ ...match, ...pullCardScore(pull, match.card) }))
      .filter(match => match.eligible)
      .sort((left, right) => right.score - left.score)
    const best = ranked[0]
    if (!best) {
      results.push({ pr: prUrl, title, status: 'skipped-no-match' })
      continue
    }
    if (ranked[1] && ranked[1].score === best.score) {
      results.push({ pr: prUrl, title, status: 'skipped-ambiguous' })
      continue
    }
    if (dryRun) {
      results.push({ pr: prUrl, title, status: 'would-save', boardId: best.board.id, cardId: best.card.id, cardTitle: best.card.title, score: best.score })
      continue
    }
    if (String(best.card.notes || '').includes(prUrl)) {
      const state = await repository.read(best.board.id)
      const merged = Boolean(pull?.pull_request?.merged_at)
      const checked = await checkCompletedItems(best.board.id, state.doc.cards[best.card.id], title, merged)
      if (readyForDone(checked, merged)) await moveToDone(best.board.id, best.card.id, { ...state.doc, cards: { ...state.doc.cards, [best.card.id]: checked } })
      results.push({ pr: prUrl, title, status: 'already-saved', boardId: best.board.id, cardId: best.card.id, cardTitle: best.card.title, score: best.score })
      continue
    }
    const notes = [String(best.card.notes || '').trim(), `✅ Done — ${title}\nPR: ${prUrl}`].filter(Boolean).join('\n\n')
    const saved = await repository.mutate(best.board.id, {
      type: 'update-card', cardId: best.card.id, patch: { notes },
    })
    const merged = Boolean(pull?.pull_request?.merged_at)
    const checked = await checkCompletedItems(best.board.id, saved.doc.cards[best.card.id], title, merged)
    if (readyForDone(checked, merged)) await moveToDone(best.board.id, best.card.id, { ...saved.doc, cards: { ...saved.doc.cards, [best.card.id]: checked } })
    results.push({ pr: prUrl, title, status: 'saved', boardId: best.board.id, cardId: best.card.id, cardTitle: best.card.title, score: best.score })
  }
  return { status: 'saved', results }
}
try {
  let result
  if (command === 'list') result = await repository.list()
  else if (command === 'read' && validId(boardId)) result = await repository.read(boardId)
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
      const fields = ['title', 'notes', 'label', 'due', 'assignee', 'assigneeHost']
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
    result = await syncOpenPrs({ dryRun: process.argv.includes('--dry-run') })
  } else throw new Error('Usage: kanban.mjs list | read BOARD_ID | add-card/update-card/move-card BOARD_ID < input.json | complete-matching-card < input.json | sync-open-prs [--dry-run]')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'not-confirmed', error: error.message }))
  process.exitCode = 1
}

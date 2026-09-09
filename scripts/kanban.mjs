#!/usr/bin/env node
// Thin command-line transport for the same repository the board screen uses.
import { createBoardRepository } from '../boardRepository.js'
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
  } else throw new Error('Usage: kanban.mjs list | read BOARD_ID | add-card/update-card/move-card BOARD_ID < input.json')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'not-confirmed', error: error.message }))
  process.exitCode = 1
}

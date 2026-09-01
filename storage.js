// Data layer for Kanban boards.
//
// Layout: one document per board at `boards/<id>.json`. No shared index file —
// the board list is enumerated with storage.list(), so creating or deleting a
// board never contends with another writer.
//
// Version tolerance contract (important for mixed app versions):
// - Every document carries a schema version `v`.
// - Readers NORMALIZE known fields in memory and PRESERVE unknown fields.
// - Writers never rebuild a document from scratch: every mutation is an op
//   applied to the freshest server copy under compare-and-swap, touching only
//   the fields it knows about. A newer app version's extra fields survive a
//   round-trip through an older app version.

import { COLUMN_COLOR_KEYS, defaultColumnColor, isIsoDate } from './domain.js'

export const SCHEMA_V = 1

export const uid = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const store = () => window.mobius?.storage

export function newBoardDoc(title) {
  return {
    v: SCHEMA_V,
    id: uid(),
    title: title || 'New board',
    createdAt: new Date().toISOString(),
    columns: [
      { id: uid(), name: 'To do', color: null, cardIds: [] },
      { id: uid(), name: 'In progress', color: 'blue', cardIds: [] },
      { id: uid(), name: 'Done', color: 'green', cardIds: [] },
    ],
    cards: {},
  }
}

// Tolerant reader: fill defaults for known fields, keep everything else as-is.
export function normalizeBoard(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  if (typeof doc.v !== 'number') doc.v = 1
  if (typeof doc.title !== 'string') doc.title = 'Board'
  if (!Array.isArray(doc.columns)) doc.columns = []
  doc.columns = doc.columns.filter(col => col && typeof col === 'object' && !Array.isArray(col))
  if (!doc.cards || typeof doc.cards !== 'object' || Array.isArray(doc.cards)) doc.cards = {}
  doc.columns.forEach((col, index) => {
    if (!Array.isArray(col.cardIds)) col.cardIds = []
    if (typeof col.name !== 'string') col.name = 'List'
    if (!Object.hasOwn(col, 'color')) col.color = defaultColumnColor(index)
    else if (col.color !== null && !COLUMN_COLOR_KEYS.includes(col.color)) col.color = null
  })
  for (const [cardId, card] of Object.entries(doc.cards)) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) continue
    if (!isIsoDate(card.due)) card.due = ''
    if (typeof card.assignee !== 'string') card.assignee = ''
    if (!Array.isArray(card.checklist)) card.checklist = []
    card.checklist = card.checklist.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    card.checklist.forEach((item, index) => {
      if (typeof item.id !== 'string' || !item.id) item.id = `${cardId}-check-${index}`
      if (typeof item.text !== 'string') item.text = ''
      item.done = item.done === true
    })
  }
  return doc
}

export function normalizeUi(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { lastBoardId: null }
  if (typeof value.lastBoardId !== 'string' || !value.lastBoardId) value.lastBoardId = null
  return value
}

export async function loadUi() {
  return normalizeUi(await store()?.get('ui.json'))
}

let lastBoardWriteChain = Promise.resolve()
let lastRequestedBoardId = null

async function writeLatestLastBoardId() {
  const s = store()
  if (!s) return null
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, version } = await s.getWithVersion('ui.json')
    const next = structuredClone(normalizeUi(value))
    const requested = lastRequestedBoardId
    next.lastBoardId = requested
    try {
      await s.durableWrite('ui.json', next, version
        ? { ifMatch: version }
        : { ifNoneMatch: true })
      // A newer navigation choice may have arrived while this write was in
      // flight. Keep ownership of the serial chain until that newest id lands.
      if (requested === lastRequestedBoardId) return next
    } catch (error) {
      if (error?.code === 'conflict') continue
      throw error
    }
  }
  throw new Error('Could not save the last-opened board after repeated conflicts.')
}

export function saveLastBoardId(lastBoardId) {
  lastRequestedBoardId = lastBoardId
  const task = lastBoardWriteChain.catch(() => {}).then(writeLatestLastBoardId)
  lastBoardWriteChain = task
  return task
}

export const boardPath = id => `boards/${id}.json`

export async function listBoards() {
  const s = store()
  if (!s) return []
  const entries = await s.list('boards/', { includeContent: true })
  const boards = []
  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue
    let doc = e.content
    if (doc === undefined || doc === null) {
      try { doc = await s.get(e.path.replace(/^.*?boards\//, 'boards/')) } catch { doc = null }
    }
    doc = normalizeBoard(doc)
    if (doc) {
      boards.push({
        id: e.name.replace(/\.json$/, ''),
        title: doc.title,
        cardCount: Object.keys(doc.cards).length,
        columnCount: doc.columns.length,
        columnPreview: doc.columns.slice(0, 5).map(column => ({
          count: column.cardIds.length,
          color: column.color,
        })),
        createdAt: String(doc.createdAt || ''),
      })
    }
  }
  boards.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return boards
}

export async function createBoard(title) {
  const doc = newBoardDoc(title)
  await store().durableWrite(boardPath(doc.id), doc, { ifNoneMatch: true })
  return doc.id
}

export async function deleteBoard(id) {
  await store().remove(boardPath(id))
}

export function subscribeBoard(id, cb) {
  const s = store()
  if (!s) return () => {}
  return s.subscribe(boardPath(id), v => cb(normalizeBoard(v)))
}

export async function getBoard(id) {
  return normalizeBoard(await store().get(boardPath(id)))
}

// Apply `op` to the freshest server copy with CAS retry. `op` mutates the doc
// in place (or returns a replacement) and must only touch fields it owns.
// A missing document aborts the write: mutating a deleted board must never
// resurrect it.
export async function casMutate(id, op, onError) {
  const s = store()
  if (!s) return null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { value, version } = await s.getWithVersion(boardPath(id))
      const base = normalizeBoard(value)
      if (!base) return null
      const next = op(base) || base
      const result = await s.durableWrite(boardPath(id), next, { ifMatch: version })
      if (result === 'queued' || result?.status === 'queued' || result?.queued === true) {
        const queued = new Error('The storage runtime queued a blind CAS write instead of confirming it.')
        queued.code = 'queued'
        throw queued
      }
      return next
    } catch (e) {
      if (e?.code === 'conflict') continue
      onError?.(e)
      return null
    }
  }
  onError?.(new Error('Could not save after repeated conflicts'))
  return null
}

// Create the first board exactly once even when several app frames race:
// the fixed document id makes concurrent seeds collide on if-none-match.
export async function seedFirstBoard() {
  const doc = newBoardDoc('My board')
  doc.id = 'welcome'
  try {
    await store().durableWrite(boardPath(doc.id), doc, { ifNoneMatch: true })
  } catch (e) {
    if (e?.code !== 'conflict') throw e
  }
}

// One-time migration from the v0 single-board layout (`board.json`).
export async function migrateLegacy() {
  const s = store()
  if (!s) return
  try {
    const legacy = await s.get('board.json')
    if (!legacy) return
    const doc = normalizeBoard(structuredClone(legacy))
    doc.v = SCHEMA_V
    // Deterministic id: concurrent migrators collide on if-none-match instead
    // of each minting a fresh id and duplicating the board.
    doc.id = doc.id && typeof doc.id === 'string' ? doc.id : 'migrated-v0'
    doc.createdAt = doc.createdAt || new Date().toISOString()
    try {
      const result = await s.durableWrite(boardPath(doc.id), doc, { ifNoneMatch: true })
      if (result === 'queued' || result?.status === 'queued' || result?.queued === true) {
        throw new Error('Legacy migration is waiting for a durable connection.')
      }
    } catch (e) {
      if (e?.code !== 'conflict') throw e
    }
    // A conflict is success only when the destination is demonstrably our
    // migration. Otherwise deleting the legacy source would discard its data.
    const saved = normalizeBoard(await s.get(boardPath(doc.id)))
    if (!saved || saved.createdAt !== doc.createdAt || saved.title !== doc.title) {
      throw new Error('Legacy board migration could not verify its destination.')
    }
    await s.remove('board.json')
  } catch (error) {
    // Non-fatal: legacy board stays readable on next launch.
    window.mobius?.signal?.('error', {
      message: String(error?.message || error),
      source: 'legacy-migration',
    })
  }
}

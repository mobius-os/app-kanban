import { applyBoardOp } from './operations.js'

let sequence = 0

const defaultStorage = () => globalThis.window?.mobius?.storage || null
const safeBoardId = boardId => encodeURIComponent(String(boardId || ''))
const prefixFor = boardId => `pending-board-ops/${safeBoardId(boardId)}/`
const legacyKeyFor = boardId => `kanban:pending-board-ops:v1:${safeBoardId(boardId)}`

async function migrateLegacyQueue(boardId, storage) {
  let legacy = null
  try { legacy = globalThis.window?.localStorage || null } catch { return }
  if (!legacy?.getItem || !storage?.set) return
  const key = legacyKeyFor(boardId)
  const raw = legacy.getItem(key)
  if (!raw) return
  let entries
  try { entries = JSON.parse(raw) } catch { return }
  if (!Array.isArray(entries)) return
  const valid = entries.filter(entry =>
    entry && typeof entry.id === 'string' && entry.op && typeof entry.op === 'object',
  )
  if (valid.length !== entries.length) return
  for (const entry of valid) {
    await storage.set(`${prefixFor(boardId)}${encodeURIComponent(entry.id)}.json`, entry)
  }
  legacy.removeItem(key)
}

function entryFromListItem(item) {
  const value = item?.content
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.id !== 'string' || !value.op || typeof value.op !== 'object') return null
  return value
}

export async function readPendingBoardOps(boardId, storage = defaultStorage()) {
  if (!storage?.list) return []
  await migrateLegacyQueue(boardId, storage)
  const items = await storage.list(prefixFor(boardId), { includeContent: true })
  return (Array.isArray(items) ? items : [])
    .map(entryFromListItem)
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
}

export async function enqueuePendingBoardOp(boardId, op, storage = defaultStorage()) {
  if (!storage?.set) throw new Error('App storage is unavailable; the change was not saved.')
  const entry = {
    id: `${Date.now().toString(36)}-${(++sequence).toString(36).padStart(4, '0')}-${Math.random().toString(36).slice(2, 7)}`,
    op: structuredClone(op),
  }
  await storage.set(`${prefixFor(boardId)}${entry.id}.json`, entry)
  return entry
}

export async function removePendingBoardOp(boardId, entryId, storage = defaultStorage()) {
  if (!storage?.remove) throw new Error('App storage is unavailable; the synced change could not be cleared.')
  await storage.remove(`${prefixFor(boardId)}${entryId}.json`)
}

export function applyPendingBoardOps(board, entries) {
  if (!board) return board
  return (Array.isArray(entries) ? entries : []).reduce(
    (doc, entry) => applyBoardOp(doc, entry.op) || doc,
    structuredClone(board),
  )
}

// Replay exactly in queue order. Each intent has its own app-storage file, so
// frames cannot overwrite one another's offline changes. An entry disappears
// only after its board write is confirmed.
export async function replayPendingBoardOps(boardId, mutate, {
  storage = defaultStorage(),
  onLanded,
} = {}) {
  let lastDoc = null
  while (true) {
    const entries = await readPendingBoardOps(boardId, storage)
    const entry = entries[0]
    if (!entry) return { ok: true, doc: lastDoc, pending: 0, entries: [] }
    const landed = await mutate(entry.op)
    if (!landed) return { ok: false, doc: lastDoc, pending: entries.length, entries }
    try {
      await removePendingBoardOp(boardId, entry.id, storage)
    } catch {
      return { ok: false, doc: landed, pending: entries.length, entries }
    }
    lastDoc = landed
    const remaining = await readPendingBoardOps(boardId, storage)
    onLanded?.(landed, remaining)
  }
}

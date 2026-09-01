import { applyBoardOp } from './operations.js'

const KEY_PREFIX = 'kanban:pending-board-ops:v1:'
let sequence = 0

const defaultStorage = () => {
  try { return globalThis.localStorage || null } catch { return null }
}

const keyFor = boardId => `${KEY_PREFIX}${encodeURIComponent(boardId)}`

export function readPendingBoardOps(boardId, storage = defaultStorage()) {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(keyFor(boardId)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(entry =>
      entry && typeof entry.id === 'string' && entry.op && typeof entry.op === 'object',
    )
  } catch {
    return []
  }
}

function persist(boardId, entries, storage) {
  if (!storage) throw new Error('UI storage is unavailable; the offline change was not saved.')
  storage.setItem(keyFor(boardId), JSON.stringify(entries))
}

export function enqueuePendingBoardOp(boardId, op, storage = defaultStorage()) {
  const entries = readPendingBoardOps(boardId, storage)
  const entry = {
    id: `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    op: structuredClone(op),
  }
  persist(boardId, [...entries, entry], storage)
  return entry
}

export function removePendingBoardOp(boardId, entryId, storage = defaultStorage()) {
  const entries = readPendingBoardOps(boardId, storage)
  persist(boardId, entries.filter(entry => entry.id !== entryId), storage)
}

export function applyPendingBoardOps(board, boardId, storage = defaultStorage()) {
  if (!board) return board
  return readPendingBoardOps(boardId, storage).reduce(
    (doc, entry) => applyBoardOp(doc, entry.op) || doc,
    structuredClone(board),
  )
}

// Replay exactly in queue order. An entry is removed only after its CAS lands;
// persistence/removal failures leave an idempotent op queued for a safe retry.
export async function replayPendingBoardOps(boardId, mutate, {
  storage = defaultStorage(),
  onLanded,
} = {}) {
  let lastDoc = null
  while (true) {
    const entry = readPendingBoardOps(boardId, storage)[0]
    if (!entry) return { ok: true, doc: lastDoc, pending: 0 }
    const landed = await mutate(entry.op)
    if (!landed) {
      return { ok: false, doc: lastDoc, pending: readPendingBoardOps(boardId, storage).length }
    }
    try {
      removePendingBoardOp(boardId, entry.id, storage)
    } catch {
      return { ok: false, doc: landed, pending: readPendingBoardOps(boardId, storage).length }
    }
    lastDoc = landed
    onLanded?.(landed, readPendingBoardOps(boardId, storage))
  }
}

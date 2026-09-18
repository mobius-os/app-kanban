import { applyBoardOp } from './operations.js'

let sequence = 0

const defaultStorage = () => globalThis.window?.mobius?.storage || null
const safeBoardId = boardId => encodeURIComponent(String(boardId || ''))
const prefixFor = boardId => `pending-board-ops/${safeBoardId(boardId)}/`
const recoveryPrefixFor = boardId => `recovered-board-ops/${safeBoardId(boardId)}/`
const recoveryAcknowledgementPrefixFor = boardId => `recovery-acknowledgements/${safeBoardId(boardId)}/`
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

// Rejected intent stays local and is never replayed with elevated permissions.
// Its stable queue ID makes archive-before-dequeue safe across crashes/retries.
async function readAllRecoveredBoardOps(boardId, storage = defaultStorage()) {
  if (!storage?.list) return []
  const items = await storage.list(recoveryPrefixFor(boardId), { includeContent: true })
  return (Array.isArray(items) ? items : []).map(entryFromListItem).filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
}

export async function readRecoveredBoardOps(boardId, storage = defaultStorage()) {
  if (!storage?.list) return []
  const [recovered, acknowledgements] = await Promise.all([
    readAllRecoveredBoardOps(boardId, storage),
    storage.list(recoveryAcknowledgementPrefixFor(boardId), { includeContent: true }),
  ])
  const acknowledgedIds = new Set((Array.isArray(acknowledgements) ? acknowledgements : [])
    .map(item => item?.content?.id).filter(id => typeof id === 'string'))
  return recovered.filter(entry => !acknowledgedIds.has(entry.id))
}

// Acknowledging a recovery notice never deletes the recovery copy. It only
// prevents an already-downloaded rejected edit from reopening the same banner.
export async function acknowledgeRecoveredBoardOps(boardId, storage = defaultStorage()) {
  if (!storage?.durableWrite) throw new Error('Recovery acknowledgement could not be saved.')
  const recovered = await readAllRecoveredBoardOps(boardId, storage)
  await Promise.all(recovered.map(entry => storage.durableWrite(
    `${recoveryAcknowledgementPrefixFor(boardId)}${encodeURIComponent(entry.id)}.json`,
    { id: entry.id, acknowledgedAt: new Date().toISOString() },
  )))
}

export async function exportUnsyncedBoardOps(boardId, storage = defaultStorage()) {
  const [recovered, pending] = await Promise.all([
    readAllRecoveredBoardOps(boardId, storage), readPendingBoardOps(boardId, storage),
  ])
  return { format: 'kanban-unsynced-edits/1', boardId, recovered, pending }
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
// only after its board write is confirmed or its rejected intent is durably archived.
export async function replayPendingBoardOps(boardId, mutate, {
  storage = defaultStorage(),
  onLanded,
  onDiscarded,
} = {}) {
  let lastDoc = null
  let discarded = 0
  while (true) {
    const entries = await readPendingBoardOps(boardId, storage)
    const entry = entries[0]
    if (!entry) return { ok: true, doc: lastDoc, pending: 0, entries: [], discarded }
    const outcome = await mutate(entry.op)
    if (!outcome || outcome.status === 'retry') {
      return { ok: false, doc: lastDoc, pending: entries.length, entries, discarded }
    }
    if (!['landed', 'discarded'].includes(outcome.status)) {
      throw new Error('Pending operation returned an invalid replay outcome.')
    }
    try {
      if (outcome.status === 'discarded') {
        if (!storage?.durableWrite) throw new Error('Recovery storage is unavailable.')
        const saved = await storage.durableWrite(`${recoveryPrefixFor(boardId)}${entry.id}.json`, {
          ...entry,
          reason: String(outcome.error?.message || 'The change could not be applied.'),
          code: String(outcome.error?.code || 'rejected'),
        })
        if (saved === 'queued' || saved?.queued || saved?.status === 'queued') throw new Error('Recovery copy is not yet confirmed.')
      }
      await removePendingBoardOp(boardId, entry.id, storage)
    } catch (error) {
      return { ok: false, doc: outcome.doc || lastDoc, pending: entries.length, entries, discarded,
        error: `Your edit is still queued: ${error.message}` }
    }
    const remaining = await readPendingBoardOps(boardId, storage)
    if (outcome.status === 'discarded') {
      discarded += 1
      onDiscarded?.(outcome.error, remaining)
      continue
    }
    lastDoc = outcome.doc
    onLanded?.(outcome.doc, remaining)
  }
}

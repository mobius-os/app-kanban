// Board authority belongs here, not to the UI or a caller's guessed file.
// The storage adapter differs between browser and CLI; board semantics do not.
import { boardPath, normalizeBoard, casMutate } from './storage.js'
import { pullShared, pushSharedOp } from './sync.js'
import { applyBoardOp } from './operations.js'

export function createBoardRepository({ storage, request = globalThis.fetch }) {
  async function authority(boardId) {
    // A failed lookup must never be interpreted as "private".
    const { value } = await storage.getWithVersion('shared.json')
    if (value != null && (!value.byBoard || typeof value.byBoard !== 'object')) {
      throw new Error('Board sharing information is malformed.')
    }
    const entry = value?.byBoard?.[boardId] || null
    if (entry && (!entry.host || !entry.oid)) throw new Error('Board sharing address is incomplete.')
    return entry
  }

  async function read(boardId) {
    const entry = await authority(boardId)
    const state = entry
      ? await pullShared(entry, -1, request)
      : await storage.getWithVersion(boardPath(boardId)).then(({ value, version }) => ({ doc: value, version }))
    const doc = normalizeBoard(state.doc)
    if (!doc) throw new Error('Board not found or unavailable.')
    return { doc, version: state.version, authority: entry ? 'shared' : 'private' }
  }

  async function list() {
    const entries = await storage.list('boards/')
    return Promise.all(entries.filter(item => item.name.endsWith('.json')).map(async item => {
      const id = item.name.slice(0, -5)
      const state = await read(id)
      return { id, title: state.doc.title, authority: state.authority,
        columns: state.doc.columns.map(({ id, name }) => ({ id, name })) }
    }))
  }

  async function mutate(boardId, op) {
    const entry = await authority(boardId)
    if (entry && entry.role !== 'editor') throw new Error('This shared board is read-only.')
    const apply = doc => {
      if (op.type === 'add-card' && doc.cards[op.card?.id]) return doc
      if (op.type === 'add-card' && !doc.columns.some(c => c.id === op.columnId)) {
        throw new Error('Target column no longer exists.')
      }
      if (op.cardId && op.type !== 'delete-card' && !doc.cards[op.cardId]) throw new Error('Card no longer exists.')
      if (op.type === 'move-card' && !doc.columns.some(c => c.id === op.toColumnId)) {
        throw new Error('Target column no longer exists.')
      }
      return applyBoardOp(doc, op)
    }
    let error
    const onError = cause => { error = cause }
    const landed = entry
      ? await pushSharedOp(entry, apply, onError, request)
      : await casMutate(boardId, apply, onError, storage).then(doc => doc && ({ doc }))
    if (!landed) throw error || new Error('Board change was not confirmed.')
    // Only a confirmed shared write may refresh the offline copy. Cache failure
    // cannot turn a committed operation into a failed operation.
    if (entry) await storage.set(boardPath(boardId), landed.doc).catch(() => {})
    return { ...landed, authority: entry ? 'shared' : 'private' }
  }
  return { list, read, mutate }
}

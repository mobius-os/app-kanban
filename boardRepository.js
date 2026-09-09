// Board authority belongs here, not to the UI or a caller's guessed file.
// The storage adapter differs between browser and CLI; board semantics do not.
import { boardPath, normalizeBoard, casMutate } from './storage.js'
import { pullShared, pushSharedOp } from './sync.js'
import { applyBoardOp } from './operations.js'

const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

export function boardError(message, code, { discardable = true } = {}) {
  return Object.assign(new Error(message), { code, retryable: false, discardable })
}

export function isRetryableBoardError(error) {
  return error?.retryable !== false
}

export function isDiscardableBoardError(error) {
  return error?.discardable === true
}

export function replayOutcomeForBoardError(error) {
  return isDiscardableBoardError(error)
    ? { status: 'discarded', error }
    : { status: 'retry' }
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validId(value) {
  return typeof value === 'string' && value.trim() !== '' && !RESERVED_IDS.has(value)
}

export function createBoardRepository({ storage, request = globalThis.fetch }) {
  async function authority(boardId) {
    // A failed lookup must never be interpreted as "private".
    const { value } = await storage.getWithVersion('shared.json')
    if (value != null && (!isRecord(value) || !isRecord(value.byBoard))) {
      throw boardError('Board sharing information is malformed.', 'invalid-sharing-map', { discardable: false })
    }
    const entry = value?.byBoard?.[boardId] || null
    if (entry && (!isRecord(entry) || !validId(entry.host) || !validId(entry.oid)
      || !['editor', 'viewer'].includes(entry.role))) {
      throw boardError('Board sharing address is incomplete.', 'invalid-sharing-entry', { discardable: false })
    }
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
    if (entry && entry.role !== 'editor') throw boardError('This shared board is read-only.', 'read-only')
    const apply = doc => {
      if (op.type === 'add-card' && !validId(op.card?.id)) throw boardError('Card id is invalid.', 'invalid-operation')
      if (op.cardId && !validId(op.cardId)) throw boardError('Card id is invalid.', 'invalid-operation')
      if (op.type === 'add-card' && Object.hasOwn(doc.cards, op.card.id)) return doc
      if (op.type === 'add-card' && !doc.columns.some(c => c.id === op.columnId)) {
        throw boardError('Target column no longer exists.', 'missing-column')
      }
      if (op.cardId && op.type !== 'delete-card' && !Object.hasOwn(doc.cards, op.cardId)) {
        throw boardError('Card no longer exists.', 'missing-card')
      }
      if (op.type === 'move-card' && !doc.columns.some(c => c.id === op.toColumnId)) {
        throw boardError('Target column no longer exists.', 'missing-column')
      }
      return applyBoardOp(doc, op)
    }
    let error
    const onError = cause => { error = cause }
    const landed = entry
      ? await pushSharedOp(entry, apply, onError, request)
      : await casMutate(boardId, apply, onError, storage).then(doc => doc && ({ doc }))
    if (!landed && entry && error?.status === 403) {
      throw boardError('This shared board is read-only.', 'read-only')
    }
    if (!landed && entry && error?.status === 404) {
      throw boardError('Board no longer exists.', 'missing-board')
    }
    if (!landed) throw error || boardError('Board no longer exists.', 'missing-board')
    // Only a confirmed shared write may refresh the offline copy. Cache failure
    // cannot turn a committed operation into a failed operation.
    if (entry) await storage.set(boardPath(boardId), landed.doc).catch(() => {})
    return { ...landed, authority: entry ? 'shared' : 'private' }
  }
  return { list, read, mutate }
}

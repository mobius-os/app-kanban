// Board authority belongs here, not to the UI or a caller's guessed file.
// The storage adapter differs between browser and CLI; board semantics do not.
import { boardPath, normalizeBoard, casMutate, uid } from './storage.js'
import { pullShared, pushSharedOp, readSharedCard, writeSharedNotes, appendSharedActivity, cardDetailsUnsupported } from './sync.js'
import { MAX_NOTES_CHARS, activityPath, cardSnapshot, createActivityEntries, describeCardChange, mergeActivity, operationCardId } from './activity.js'
import { PUBLICATION, publicationPending } from './publication.js'
import { applyBoardOp, completeCardNotes } from './operations.js'

const touchesNotes = op => op?.type === 'complete-card'
  || (op?.type === 'update-card' && op.patch && Object.hasOwn(op.patch, 'notes'))

// The board part of an operation whose description was saved separately;
// null when nothing else remains to write.
function withoutNotes(op) {
  if (op.type !== 'update-card') return op
  const { notes, ...patch } = op.patch
  return Object.keys(patch).length ? { ...op, patch } : null
}

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

// A shared board host's refusals that retrying cannot change become final
// board errors (a replayed edit goes to recovery instead of blocking the
// queue). Anything else, such as an unreachable host, stays retryable.
function finalHostRefusal(error) {
  switch (error?.code) {
    case 'read-only':
    case 'membership-revoked': return boardError('This shared board is read-only.', 'read-only')
    case 'board-missing': return boardError('Board no longer exists.', 'missing-board')
    case 'card-missing': return boardError('Card no longer exists.', 'missing-card')
    case 'notes-too-long': return boardError(error.message, 'notes-too-long')
    default: return error
  }
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validId(value) {
  return typeof value === 'string' && value.trim() !== '' && !RESERVED_IDS.has(value)
}

// Refusals that leave the board untouched. Checked on every CAS attempt and,
// before a shared description changes, against a fresh board, so a refused
// operation never leaves its description half-saved.
function refuseInvalidOperation(doc, op) {
  if (op.type === 'add-card' && !validId(op.card?.id)) throw boardError('Card id is invalid.', 'invalid-operation')
  if (op.cardId && !validId(op.cardId)) throw boardError('Card id is invalid.', 'invalid-operation')
  if (op.type === 'add-card' && Object.hasOwn(doc.cards, op.card.id)) return
  if (op.type === 'add-card' && !doc.columns.some(c => c.id === op.columnId)) {
    throw boardError('Target column no longer exists.', 'missing-column')
  }
  if (op.cardId && op.type !== 'delete-card' && !Object.hasOwn(doc.cards, op.cardId)) {
    throw boardError('Card no longer exists.', 'missing-card')
  }
  if (op.type === 'complete-card'
    && String(doc.cards[op.cardId].title || '').trim() !== op.expectedTitle) {
    throw boardError('Card title changed before completion; no card was changed.', 'card-title-changed')
  }
  if (op.type === 'move-card' && !doc.columns.some(c => c.id === op.toColumnId)) {
    throw boardError('Target column no longer exists.', 'missing-column')
  }
}

// `via: 'agent'` marks activity recorded by the agent helper rather than the app.
export function createBoardRepository({ storage, request = globalThis.fetch, via = '' }) {
  async function sharingMap() {
    // A failed lookup must never be interpreted as "private".
    const { value } = await storage.getWithVersion('shared.json')
    if (value != null && (!isRecord(value) || !isRecord(value.byBoard))) {
      throw boardError('Board sharing information is malformed.', 'invalid-sharing-map', { discardable: false })
    }
    return value?.byBoard || {}
  }

  async function authority(boardId) {
    const entry = (await sharingMap())[boardId]
      || (await storage.getWithVersion(boardPath(boardId))).value?.[PUBLICATION] || null
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
    return { doc, version: state.version, authority: entry ? 'shared' : 'private',
      ...(entry ? { host: entry.host, oid: entry.oid } : {}) }
  }

  async function list() {
    const [entries, shared] = await Promise.all([storage.list('boards/'), sharingMap()])
    const ids = new Set([...entries.filter(item => item.name.endsWith('.json')).map(item => item.name.slice(0, -5)), ...Object.keys(shared)])
    return Promise.all([...ids].map(async id => {
      try {
        const state = await read(id)
        return { id, title: state.doc.title, authority: state.authority,
          columns: state.doc.columns.map(({ id, name }) => ({ id, name })) }
      } catch (error) {
        // Discovery is partial, but authority is not: retain the failed board
        // explicitly without inventing columns or reading its stale cache.
        return { id, status: 'unavailable', error: String(error?.message || error) }
      }
    }))
  }

  async function mutate(boardId, op, { sharedState = null } = {}) {
    const entry = await authority(boardId)
    if (entry && entry.role !== 'editor') throw boardError('This shared board is read-only.', 'read-only')
    // On a shared board a description is saved on its own, version-checked and
    // outside the capped document; the board operation then carries the rest.
    // `null` means the host predates card details, so the old path applies.
    let notesChanged = false
    let boardOp = op
    if (entry && touchesNotes(op)) {
      const current = normalizeBoard((await pullShared(entry, -1, request).catch(error => { throw finalHostRefusal(error) })).doc)
      if (!current) throw new Error('Board not found or unavailable.')
      refuseInvalidOperation(current, op)
      const saved = await saveSharedNotesFor(entry, op)
      if (saved !== null) {
        notesChanged = saved
        boardOp = withoutNotes(op)
        sharedState = null
      }
    }
    // The last attempt's before/after snapshots describe what actually landed;
    // a CAS retry re-runs `apply` against the fresher document.
    let change = null
    const apply = doc => {
      if (!entry && doc[PUBLICATION]) throw publicationPending()
      refuseInvalidOperation(doc, boardOp)
      if (boardOp.type === 'add-card' && Object.hasOwn(doc.cards, boardOp.card.id)) return doc
      const cardId = operationCardId(boardOp)
      const before = cardSnapshot(doc, cardId)
      const next = applyBoardOp(doc, boardOp) || doc
      change = { cardId, before, after: cardSnapshot(next, cardId) }
      return next
    }
    let error
    const onError = cause => { error = cause }
    const landed = !boardOp
      ? await pullShared(entry, -1, request).then(state => ({ doc: normalizeBoard(state.doc), version: state.version }))
      : entry
        ? await pushSharedOp(entry, apply, onError, request, sharedState)
        : await casMutate(boardId, apply, onError, storage).then(doc => doc && ({ doc }))
    if (!landed) throw (entry ? finalHostRefusal(error) : error) || boardError('Board no longer exists.', 'missing-board')
    // Only a confirmed shared write may refresh the offline copy. Cache failure
    // cannot turn a committed operation into a failed operation.
    if (entry) await storage.set(boardPath(boardId), landed.doc).catch(() => {})
    const cardId = operationCardId(op)
    const drafts = [
      ...(change ? describeCardChange({ op, before: change.before, after: change.after }) : []),
      ...(notesChanged && op.type !== 'complete-card' ? [{ type: 'notes' }] : []),
    ]
    const activity = await recordActivity(boardId, entry, op, cardId, drafts)
    return { ...landed, activity, authority: entry ? 'shared' : 'private',
      ...(entry ? { host: entry.host, oid: entry.oid } : {}) }
  }

  // Saves `notes` as an edit of the text it started from: `from.version` is
  // that text's version and `from.text` the text itself (when known). The
  // host refuses any other version. When the current text is still the
  // starting text, only our own earlier saves moved the version on (a queued
  // edit that landed, or a save that finished while this edit was typed), so
  // the edit applies to the new version. Any other text is someone else's
  // change and comes back as `status: 'conflict'`.
  async function writeNotesEdit(entry, cardId, notes, from) {
    let version = from.version
    for (let attempt = 0; attempt < 4; attempt++) {
      let result
      try {
        result = await writeSharedNotes(entry, cardId, notes, version, request)
      } catch (error) {
        throw finalHostRefusal(error)
      }
      if (result.status !== 'conflict') return result
      if (result.notes === notes) return { status: 'unchanged', notes_version: result.notes_version }
      if (typeof from.text !== 'string' || result.notes !== from.text) return result
      version = result.notes_version
    }
    throw boardError('The description kept changing while saving; try again.', 'notes-conflict')
  }

  // A completion appends to the newest text, so it may follow the newest
  // version. A replacement text is only safe against the text its author saw:
  // when the board shows just a preview, the edit must name the version it
  // started from (`notesVersion`, plus `notesBefore` for the card sheet's
  // queued edits). Otherwise an edited preview (an older Kanban's queued
  // edit, or an agent working from `read` instead of `read-card`) would
  // replace the whole description.
  async function saveSharedNotesFor(entry, op) {
    const based = op.type === 'update-card' && Number.isInteger(op.notesVersion)
    for (let attempt = 0; attempt < 4; attempt++) {
      let card
      try {
        card = await readSharedCard(entry, op.cardId, request)
      } catch (error) {
        if (cardDetailsUnsupported(error)) return null
        throw finalHostRefusal(error)
      }
      if (typeof card.notes !== 'string') throw boardError('Card no longer exists.', 'missing-card')
      if (op.type === 'update-card' && !based && card.external === true) {
        throw boardError('This description is stored beside the board and the edit does not say which version it changes, so it was not saved.', 'notes-version-required')
      }
      const next = op.type === 'complete-card'
        ? completeCardNotes(card.notes, { summary: op.summary, link: op.link ?? op.prUrl ?? '' })
        : String(op.patch.notes ?? '')
      if (next === card.notes) return false
      // The host keeps a description from growing past its limit. A completion
      // that would is still recorded: the card moves and its activity says so.
      if (op.type === 'complete-card' && next.length > MAX_NOTES_CHARS) return false
      if (based) {
        const result = await writeNotesEdit(entry, op.cardId, next, { version: op.notesVersion, text: op.notesBefore })
        if (result.status === 'conflict') throw boardError('Someone else changed this description first, so this edit was not saved.', 'notes-conflict')
        return result.status !== 'unchanged'
      }
      let result
      try {
        result = await writeSharedNotes(entry, op.cardId, next, card.notes_version, request)
      } catch (error) {
        throw finalHostRefusal(error)
      }
      if (result.status !== 'conflict') return true
    }
    throw boardError('The description kept changing while saving; try again.', 'notes-conflict')
  }

  // Activity is a record of a committed edit, never a condition for it: a
  // failure here is reported in the result and the edit stands.
  async function recordActivity(boardId, entry, op, cardId, drafts) {
    // A shared host prunes a deleted card's details itself (collaboration/service.py).
    if (op.type === 'delete-card' && !entry && validId(op.cardId)) {
      await Promise.resolve(storage.remove?.(activityPath(boardId, op.cardId))).catch(() => {})
    }
    if (!cardId || !drafts.length) return { cardId: cardId || null, entries: [], status: 'none' }
    const entries = createActivityEntries(drafts, { via, makeId: uid })
    try {
      const saved = entry
        ? await appendSharedActivity(entry, cardId, entries, request)
        : await appendPrivateActivity(boardId, cardId, entries)
      return { cardId, entries: saved, status: 'saved' }
    } catch (error) {
      return { cardId, entries, status: cardDetailsUnsupported(error) ? 'unsupported' : 'failed' }
    }
  }

  async function appendPrivateActivity(boardId, cardId, entries) {
    const path = activityPath(boardId, cardId)
    for (let attempt = 0; attempt < 6; attempt++) {
      const { value, version } = await storage.getWithVersion(path)
      const merged = mergeActivity(value?.entries, entries)
      try {
        await storage.durableWrite(path, { v: 1, entries: merged }, version ? { ifMatch: version } : { ifNoneMatch: true })
        return merged
      } catch (error) {
        if (error?.code !== 'conflict') throw error
      }
    }
    throw boardError('Could not save card activity after repeated conflicts.', 'activity-conflict')
  }

  // What the board document does not carry: a long description's full text
  // (shared boards only; `notes` is null when the board's copy is complete)
  // and the card's activity. `status: 'unsupported'` means the board's host
  // runs a Kanban without card details.
  async function readCard(boardId, cardId) {
    if (!validId(cardId)) throw boardError('Card id is invalid.', 'invalid-operation')
    const entry = await authority(boardId)
    if (!entry) {
      const { value } = await storage.getWithVersion(activityPath(boardId, cardId))
      return { status: 'ok', notes: null, notesVersion: null, activity: mergeActivity(value?.entries, []) }
    }
    try {
      const card = await readSharedCard(entry, cardId, request)
      return { status: 'ok', notes: typeof card.notes === 'string' ? card.notes : null,
        notesVersion: Number.isInteger(card.notes_version) ? card.notes_version : 0,
        activity: mergeActivity(card.activity, []) }
    } catch (error) {
      if (cardDetailsUnsupported(error)) return { status: 'unsupported', notes: null, notesVersion: null, activity: [] }
      throw error
    }
  }

  // The card sheet's description save. On a shared board it is an edit of
  // the text the editor started from (`from`: `{ version, text }`), so a
  // concurrent edit comes back as `{ status: 'conflict', notes, notesVersion }`
  // instead of being overwritten. Private boards and older hosts save through
  // the board. A thrown retryable error means the host could not be reached.
  async function saveNotes(boardId, cardId, notes, from) {
    const entry = await authority(boardId)
    const throughBoard = async () => ({ status: 'saved', ...(await mutate(boardId, { type: 'update-card', cardId, patch: { notes } })) })
    if (!entry || !Number.isInteger(from?.version)) return throughBoard()
    if (entry.role !== 'editor') throw boardError('This shared board is read-only.', 'read-only')
    let result
    try {
      result = await writeNotesEdit(entry, cardId, notes, from)
    } catch (error) {
      if (cardDetailsUnsupported(error)) return throughBoard()
      throw error
    }
    if (result.status === 'conflict') return { status: 'conflict', notes: result.notes, notesVersion: result.notes_version }
    const activity = result.status === 'unchanged'
      ? { cardId, entries: [], status: 'none' }
      : await recordActivity(boardId, entry, { type: 'update-card', cardId }, cardId, [{ type: 'notes' }])
    return { status: 'saved', card: result.card, notesVersion: result.notes_version, version: result.version, activity }
  }
  return { list, read, mutate, readCard, saveNotes }
}

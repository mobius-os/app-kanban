// Board authority belongs here, not to the UI or a caller's guessed file.
// The storage adapter differs between browser and CLI; board semantics do not.
import { boardPath, normalizeBoard, casMutate, uid } from './storage.js'
import { deleteSharedAsset, pullShared, pushSharedOp, readSharedCard, writeSharedNotes, postSharedComment, olderHostRefused } from './sync.js'
import { MAX_NOTES_CHARS, activityPath, cardSnapshot, createActivityEntries, describeCardChange, mergeActivity, operationCardId } from './activity.js'
import { COMMENT_ID, MAX_COMMENT_CHARS, MAX_COMMENTS_PER_CARD, commentsPath, mergeComments, newCommentId } from './comments.js'
import { PUBLICATION, publicationPending } from './publication.js'
import { MAX_CARD_ATTACHMENTS, attachmentPrefix } from './attachments.js'
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

// A plain edit that sets the assignee gets one assignment event identity for
// all of its attempts, so the card's history and its activity entry match
// (operations.js 'update-card', activity.js describeCardChange).
function withAssignmentEvent(op) {
  if (op?.type !== 'update-card' || !op.patch || op.assignmentEvent) return op
  if (!Object.hasOwn(op.patch, 'assignee') && !Object.hasOwn(op.patch, 'assigneeHost')) return op
  return { ...op, assignmentEvent: { id: uid(), at: new Date().toISOString() } }
}

const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

// Every file the board's cards attach, by attachment id.
function boardFiles(doc) {
  const files = new Map()
  for (const card of Object.values(doc?.cards || {})) {
    for (const file of Array.isArray(card?.attachments) ? card.attachments : []) {
      if (file && typeof file.id === 'string') files.set(file.id, file)
    }
  }
  return files
}

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
    case 'invalid-activity': return boardError('The board host refused this change.', 'invalid-activity')
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
  if (op.type === 'attach-file') {
    const files = doc.cards[op.cardId].attachments || []
    if (!files.some(file => file?.id === op.attachment?.id) && files.length >= MAX_CARD_ATTACHMENTS) {
      throw boardError(`A card can hold up to ${MAX_CARD_ATTACHMENTS} attachments.`, 'too-many-attachments')
    }
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

  // An uploaded file that its card edit can never attach (the card is gone,
  // the card is full, the board became read-only) is deleted with the refusal,
  // so it does not linger unattached. A retryable failure keeps it for the retry.
  async function mutate(boardId, op, options) {
    try {
      return await applyOperation(boardId, op, options)
    } catch (error) {
      if (op?.type === 'attach-file' && op.attachment && !isRetryableBoardError(error)) {
        const entry = await authority(boardId).catch(() => null)
        await removeFiles(boardId, entry, [op.attachment], true)
      }
      throw error
    }
  }

  async function applyOperation(boardId, requested, { sharedState = null } = {}) {
    const op = withAssignmentEvent(requested)
    const entry = await authority(boardId)
    if (entry && entry.role !== 'editor') throw boardError('This shared board is read-only.', 'read-only')
    const cardId = operationCardId(op)
    const describe = drafts => createActivityEntries(drafts, { via, makeId: uid })
    // On a shared board a description is saved on its own, version-checked and
    // outside the capped document; the board operation then carries the rest.
    // `null` means the host predates card details, so the old path applies.
    // The description's activity (or a completion's) is saved with it.
    let notesSaved = null
    let boardOp = op
    if (entry && touchesNotes(op)) {
      const current = normalizeBoard((await pullShared(entry, -1, request).catch(error => { throw finalHostRefusal(error) })).doc)
      if (!current) throw new Error('Board not found or unavailable.')
      refuseInvalidOperation(current, op)
      const entries = describe(op.type === 'complete-card' ? [{ type: 'completed', text: op.summary }] : [{ type: 'notes' }])
      const saved = await saveSharedNotesFor(entry, op, entries)
      if (saved !== null) {
        boardOp = withoutNotes(op)
        sharedState = null
        if (saved.changed) notesSaved = { entries, activity: saved.activity }
      }
    }
    // The last attempt's before/after snapshots describe what actually landed;
    // a CAS retry re-runs `apply` against the fresher document.
    let change = null
    const apply = doc => {
      if (!entry && doc[PUBLICATION]) throw publicationPending()
      refuseInvalidOperation(doc, boardOp)
      if (boardOp.type === 'add-card' && Object.hasOwn(doc.cards, boardOp.card.id)) return doc
      const before = cardSnapshot(doc, cardId)
      const cardIds = Object.keys(doc.cards)
      const filesBefore = boardFiles(doc)
      const next = applyBoardOp(doc, boardOp) || doc
      const filesAfter = boardFiles(next)
      change = { before, after: cardSnapshot(next, cardId), removed: cardIds.filter(id => !Object.hasOwn(next.cards, id)),
        files: [...filesBefore.values()].filter(file => !filesAfter.has(file.id)) }
      return next
    }
    // A completion already recorded with its description is not recorded twice.
    const boardDrafts = () => (change && !(op.type === 'complete-card' && notesSaved)
      ? describeCardChange({ op, before: change.before, after: change.after }) : [])
    // A shared save sends the activity of the attempt being sent; the host
    // commits it with the save, so an edit that landed never lacks its history.
    let sent = null
    const describeSave = () => {
      sent = cardId ? describe(boardDrafts()) : []
      return sent.length ? { [cardId]: sent } : null
    }
    let error
    const onError = cause => { error = cause }
    const landed = !boardOp
      ? await pullShared(entry, -1, request).then(state => ({ doc: normalizeBoard(state.doc), version: state.version, unchanged: true }))
      : entry
        ? await pushSharedOp(entry, apply, onError, request, sharedState, describeSave)
        : await casMutate(boardId, apply, onError, storage).then(doc => doc && ({ doc }))
    if (!landed) throw (entry ? finalHostRefusal(error) : error) || boardError('Board no longer exists.', 'missing-board')
    const { activity: savedActivity, unchanged, ...result } = landed
    // Only a confirmed shared write may refresh the offline copy. Cache failure
    // cannot turn a committed operation into a failed operation.
    if (entry) await storage.set(boardPath(boardId), result.doc).catch(() => {})
    const activity = entry
      ? sharedActivity(cardId, notesSaved, unchanged ? null : { entries: sent || [], activity: savedActivity?.[cardId] })
      : await recordPrivateActivity(boardId, cardId, describe(boardDrafts()), change?.removed || [])
    // A host that answers a piece save with `activity` deleted removed files in the same save.
    if (change?.files.length && !unchanged) await removeFiles(boardId, entry, change.files, !savedActivity)
    return { ...result, activity, authority: entry ? 'shared' : 'private',
      ...(entry ? { host: entry.host, oid: entry.oid } : {}) }
  }

  // Files the landed edit removed from the board (a removed attachment, or a
  // deleted card or list). A private board's files are in app storage; a
  // shared board's host deletes its own unless it predates doing so. Failures
  // leave a file behind, never undo the edit; deleting the board removes it.
  async function removeFiles(boardId, entry, files, hostKeepsFiles) {
    const prefix = attachmentPrefix(boardId)
    await Promise.allSettled(files.map(file => {
      if (entry) return hostKeepsFiles ? deleteSharedAsset(entry, file.id, request) : null
      const own = typeof file.path === 'string' && file.path.startsWith(prefix) && !file.path.split('/').includes('..')
      return own ? storage.remove?.(file.path) : null
    }))
  }

  // What a shared edit's host saved: each part (`{ entries, activity }`) sent
  // `entries` and got back the card's `activity`, or nothing from a host that
  // predates saving activity with edits.
  function sharedActivity(cardId, ...parts) {
    const described = parts.filter(part => part?.entries?.length)
    if (!cardId || !described.length) return { cardId: cardId || null, entries: [], status: 'none' }
    const answered = described.filter(part => Array.isArray(part.activity))
    if (answered.length < described.length) {
      return { cardId, entries: described.flatMap(part => part.entries), status: 'unsupported' }
    }
    return { cardId, entries: mergeActivity(answered[0].activity, answered[1]?.activity), status: 'saved' }
  }

  // Saves `notes` as an edit of the text it started from: `from.version` is
  // that text's version and `from.text` the text itself (when known). The
  // host refuses any other version. When the current text is still the
  // starting text, only our own earlier saves moved the version on (a queued
  // edit that landed, or a save that finished while this edit was typed), so
  // the edit applies to the new version. Any other text is someone else's
  // change and comes back as `status: 'conflict'`.
  async function writeNotesEdit(entry, cardId, notes, from, activity = []) {
    let version = from.version
    for (let attempt = 0; attempt < 4; attempt++) {
      let result
      try {
        result = await writeSharedNotes(entry, cardId, notes, version, request, activity)
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
  //
  // Returns null when the host predates card details, else `{ changed,
  // activity }`: whether the text changed, and the card's activity as the host
  // saved it together with `entries` (absent from a host that does not).
  async function saveSharedNotesFor(entry, op, entries) {
    const based = op.type === 'update-card' && Number.isInteger(op.notesVersion)
    for (let attempt = 0; attempt < 4; attempt++) {
      let card
      try {
        card = await readSharedCard(entry, op.cardId, request)
      } catch (error) {
        if (olderHostRefused(error)) return null
        throw finalHostRefusal(error)
      }
      if (typeof card.notes !== 'string') throw boardError('Card no longer exists.', 'missing-card')
      if (op.type === 'update-card' && !based && card.external === true) {
        throw boardError('This description is stored beside the board and the edit does not say which version it changes, so it was not saved.', 'notes-version-required')
      }
      const next = op.type === 'complete-card'
        ? completeCardNotes(card.notes, { summary: op.summary, link: op.link ?? op.prUrl ?? '' })
        : String(op.patch.notes ?? '')
      const unchanged = { changed: false }
      if (next === card.notes) return unchanged
      // The host keeps a description from growing past its limit. A completion
      // that would is still recorded: the card moves and its activity says so.
      if (op.type === 'complete-card' && next.length > MAX_NOTES_CHARS) return unchanged
      if (based) {
        const result = await writeNotesEdit(entry, op.cardId, next, { version: op.notesVersion, text: op.notesBefore }, entries)
        if (result.status === 'conflict') throw boardError('Someone else changed this description first, so this edit was not saved.', 'notes-conflict')
        return result.status === 'unchanged' ? unchanged : { changed: true, activity: result.activity }
      }
      let result
      try {
        result = await writeSharedNotes(entry, op.cardId, next, card.notes_version, request, entries)
      } catch (error) {
        throw finalHostRefusal(error)
      }
      if (result.status !== 'conflict') return { changed: true, activity: result.activity }
    }
    throw boardError('The description kept changing while saving; try again.', 'notes-conflict')
  }

  // A private board's activity sits in app storage beside the board, so it is
  // written after the edit: a failure is reported in the result (the app
  // says so) and the edit stands. Cards the edit removed (a deleted card, or
  // every card of a deleted list) take their history with them.
  async function recordPrivateActivity(boardId, cardId, entries, removed) {
    // Cards the edit removed take their history and their comments with them.
    await Promise.all(removed.filter(validId).flatMap(id => [
      Promise.resolve(storage.remove?.(activityPath(boardId, id))).catch(() => {}),
      Promise.resolve(storage.remove?.(commentsPath(boardId, id))).catch(() => {}),
    ]))
    if (!cardId || !entries.length) return { cardId: cardId || null, entries: [], status: 'none' }
    try {
      return { cardId, entries: await appendPrivateActivity(boardId, cardId, entries), status: 'saved' }
    } catch {
      return { cardId, entries, status: 'failed' }
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
      const [{ value }, { value: saved }] = await Promise.all([
        storage.getWithVersion(activityPath(boardId, cardId)),
        storage.getWithVersion(commentsPath(boardId, cardId)),
      ])
      return { status: 'ok', notes: null, notesVersion: null,
        activity: mergeActivity(value?.entries, []), comments: mergeComments(saved?.comments, []) }
    }
    try {
      const card = await readSharedCard(entry, cardId, request)
      return { status: 'ok', notes: typeof card.notes === 'string' ? card.notes : null,
        notesVersion: Number.isInteger(card.notes_version) ? card.notes_version : 0,
        activity: mergeActivity(card.activity, []), comments: mergeComments(card.comments, []) }
    } catch (error) {
      if (olderHostRefused(error)) return { status: 'unsupported', notes: null, notesVersion: null, activity: [], comments: [] }
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
    const entries = createActivityEntries([{ type: 'notes' }], { via, makeId: uid })
    let result
    try {
      result = await writeNotesEdit(entry, cardId, notes, from, entries)
    } catch (error) {
      if (olderHostRefused(error)) return throughBoard()
      throw error
    }
    if (result.status === 'conflict') return { status: 'conflict', notes: result.notes, notesVersion: result.notes_version }
    const activity = sharedActivity(cardId, result.status === 'unchanged' ? null : { entries, activity: result.activity })
    return { status: 'saved', card: result.card, notesVersion: result.notes_version, version: result.version, activity }
  }
  // One comment, appended like an edit of the card's details. On a shared
  // board the host stamps the author and time, bumps the card's
  // `commentsCount`, and records the 'commented' activity with the comment in
  // one transaction; `{status: 'unsupported'}` means the board's host runs a
  // Kanban without comments. A private board's comments live in app storage
  // beside its activity.
  // `id` names this one composed comment: a retry after an uncertain failure
  // must send the same id, so a host that committed the first attempt answers
  // it again instead of saving a duplicate (collaboration/service.py
  // write_comment). Callers allocate it once per submission (newCommentId).
  async function addComment(boardId, cardId, text, { id = newCommentId() } = {}) {
    if (!validId(cardId)) throw boardError('Card id is invalid.', 'invalid-operation')
    if (!COMMENT_ID.test(String(id))) throw boardError('Comment id is invalid.', 'invalid-comment')
    const body = String(text ?? '').trim()
    if (!body) throw boardError('A comment must have text.', 'invalid-comment')
    if (body.length > MAX_COMMENT_CHARS) {
      throw boardError(`A comment can be at most ${MAX_COMMENT_CHARS.toLocaleString()} characters.`, 'comment-too-long')
    }
    const entry = await authority(boardId)
    const comment = { id, text: body }
    if (entry) {
      if (entry.role !== 'editor') throw boardError('This shared board is read-only.', 'read-only')
      let result
      try {
        result = await postSharedComment(entry, cardId, comment, request)
      } catch (error) {
        if (olderHostRefused(error)) return { status: 'unsupported' }
        throw finalHostRefusal(error)
      }
      return { status: 'saved', comments: mergeComments(result.comments, []),
        activity: Array.isArray(result.activity) ? mergeActivity(result.activity, []) : null,
        card: result.card, version: result.version }
    }
    const { value: doc } = await storage.getWithVersion(boardPath(boardId))
    if (!doc?.cards || !Object.hasOwn(doc.cards, cardId)) throw boardError('Card no longer exists.', 'missing-card')
    const stamped = { ...comment, at: new Date().toISOString(), ...(via === 'agent' ? { via: 'agent' } : {}) }
    const { comments, added } = await appendPrivateComment(boardId, cardId, stamped)
    // A replayed comment already has its activity line.
    if (!added) return { status: 'saved', comments, activity: null, activityStatus: 'saved' }
    const entries = createActivityEntries([{ type: 'commented', text: body }], { via, makeId: uid })
    let activity = null
    let activityStatus = 'saved'
    try {
      activity = await appendPrivateActivity(boardId, cardId, entries)
    } catch {
      activityStatus = 'failed'
    }
    return { status: 'saved', comments, activity, activityStatus }
  }

  // `{comments, added}`: `added` is false when a comment with this id was
  // already saved (a retry), which leaves the file unchanged.
  async function appendPrivateComment(boardId, cardId, comment) {
    const path = commentsPath(boardId, cardId)
    for (let attempt = 0; attempt < 6; attempt++) {
      const { value, version } = await storage.getWithVersion(path)
      const existing = mergeComments(value?.comments, [])
      if (existing.some(item => item.id === comment.id)) return { comments: existing, added: false }
      // Refuse at the cap (the host applies the same rule) rather than letting
      // the merge silently drop the oldest comment.
      if (existing.length >= MAX_COMMENTS_PER_CARD) {
        throw boardError(`A card can hold up to ${MAX_COMMENTS_PER_CARD} comments.`, 'comments-full')
      }
      const merged = mergeComments(existing, [comment])
      try {
        await storage.durableWrite(path, { v: 1, comments: merged }, version ? { ifMatch: version } : { ifNoneMatch: true })
        return { comments: merged, added: true }
      } catch (error) {
        if (error?.code !== 'conflict') throw error
      }
    }
    throw boardError('Could not save the comment after repeated conflicts.', 'comment-conflict')
  }

  return { list, read, mutate, readCard, saveNotes, addComment }
}

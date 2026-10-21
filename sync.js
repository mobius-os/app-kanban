// Shared-board sync over Kanban-owned instance-to-instance collaboration.
//
// A shared board's source of truth is its shared object (hosted on whichever
// instance created it). The local board file stays as an offline cache. All
// requests go to THIS instance, which authorizes with its board capability when the
// board lives elsewhere. Writes are op-based CAS, mirroring storage.js: apply
// the op to the freshest shared doc, write with expected_version, and on
// conflict re-apply the op to the returned doc and retry.

import { PUBLICATION, fencePublication, publicationPending } from './publication.js'
import { normalizeBoard, boardPath, getBoard } from './storage.js'

let API = null
const PROTOCOL = 'kanban/1'

function independent(entry) {
  if (entry?.transport !== PROTOCOL) {
    throw Object.assign(new Error('This board needs a new invitation from its host after the Kanban upgrade. Your last copy and pending edits are retained.'), { code: 'migration-required', retryable: false, discardable: false })
  }
}
const store = () => window.mobius?.storage

let _auth = null
let _appId = null
export function configureSync(token, appId) {
  // The frame supplies a decimal string; tests and direct callers may use a number.
  const id = typeof appId === 'string' && /^[1-9]\d*$/.test(appId) ? Number(appId) : appId
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Kanban app identity is required.')
  API = `/api/apps/${id}/service/boards`
  _auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  _appId = id
  confirmedCopies.clear()
  wholeBoardHosts.clear()
}

// A push to this deployment's owner that opens Kanban. Returns false when it
// could not be sent; a missed alert must never interrupt the board.
export async function notifyOwner({ title, body, tag }, request = fetch) {
  try {
    const response = await request('/api/notifications/send', {
      method: 'POST', headers: _auth,
      body: JSON.stringify({ title, body, tag, target: `/shell/?app=${_appId}` }),
    })
    return response.ok
  } catch {
    return false
  }
}

async function _json(res) {
  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    let code = 'service-unavailable'
    try {
      const body = await res.json()
      detail = body.detail || detail
      if (body.protocol === PROTOCOL && typeof body.code === 'string') code = body.code
    } catch { /* keep the transport failure, never infer deletion */ }
    const err = new Error(detail)
    err.status = res.status
    err.code = code
    if (['board-missing', 'membership-revoked'].includes(code)) {
      err.retryable = false
    }
    throw err
  }
  return res.json()
}

// ---- share map (app storage): { byBoard: { <boardId>: {oid, host, role} } }

export async function loadShareMap() {
  return normalizeShareMap(await store()?.get('shared.json'))
}

export function shareMapConflictDelay(attempt) {
  return Math.min(25 * 2 ** attempt, 400)
}

function normalizeShareMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { byBoard: {} }
  if (!value.byBoard || typeof value.byBoard !== 'object' || Array.isArray(value.byBoard)) {
    return { ...value, byBoard: {} }
  }
  return value
}

// Resolves true when the map was written, false when `op` left an existing map
// unchanged: rewriting identical sharing details is a needless durable write.
async function mutateShareMap(op, s = store()) {
  if (!s) throw new Error('App storage is unavailable.')
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, version } = await s.getWithVersion('shared.json')
    const current = normalizeShareMap(value)
    const next = structuredClone(current)
    op(next)
    if (version && JSON.stringify(next) === JSON.stringify(current)) return false
    try {
      await s.durableWrite('shared.json', next, version
        ? { ifMatch: version }
        : { ifNoneMatch: true })
      return true
    } catch (error) {
      if (error?.code === 'conflict') {
        await new Promise(resolve => setTimeout(resolve, shareMapConflictDelay(attempt)))
        continue
      }
      throw error
    }
  }
  throw new Error('Could not save sharing details after repeated conflicts.')
}

async function saveShareEntry(boardId, entry) {
  await mutateShareMap(map => { map.byBoard[boardId] = entry })
}

export async function removeShareEntry(boardId) {
  // Let any in-flight launch recovery finish first. Recovery reads the service
  // listing up front, so a removal that slipped in before its share-map write
  // would be undone by a re-attach of the entry we are removing.
  if (recoveryInFlight) await recoveryInFlight
  await mutateShareMap(map => { delete map.byBoard[boardId] })
}

// ---- owner actions

export async function shareBoard(boardId) {
  const previous = (await loadShareMap()).byBoard[boardId]
  if (previous) { independent(previous); if (!previous.publishing) return previous }
  const health = await _json(await fetch(API.replace(/boards$/, 'health'), { headers: _auth }))
  if (health.protocol !== PROTOCOL || typeof health.host !== 'string') throw new Error('Independent Kanban is unavailable.')
  let entry
  try {
    const fenced = await fencePublication(store(), boardId, previous || {
      oid: crypto.randomUUID().replaceAll('-', ''), host: health.host,
      role: 'editor', hosted: true, publishing: true, transport: PROTOCOL,
    })
    entry = fenced.entry
    independent(entry)
    // The map is discovery; the CAS-fenced private record already prevents
    // accidental private writes if this discovery write fails.
    await saveShareEntry(boardId, entry)
    const doc = { ...fenced.doc }; delete doc[PUBLICATION]
    const res = await _json(await fetch(API, {
      method: 'POST', headers: _auth,
      body: JSON.stringify({ id: entry.oid, local_id: boardId, app: 'kanban', kind: 'board', label: doc.title, doc }),
    }))
    if (res.id !== entry.oid || res.host !== entry.host) throw new Error('The host returned a different board authority.')
    entry = { ...entry, version: res.version }; delete entry.publishing
    await saveShareEntry(boardId, entry)
    return entry
  } catch(error) {
    if (entry) error.publication = entry
    throw error
  }
}

// Only the authenticated local service can establish a membership. Reuse
// matching aliases so re-invitations keep the original pending-operation queue.
function attachMembership(map, id, entry) {
  independent(entry)
  const aliases = Object.keys(map.byBoard).filter(key => {
    const prior = map.byBoard[key]
    return prior.host === entry.host && prior.oid === entry.oid
  })
  if (!aliases.length && map.byBoard[id]) return null
  const keys = aliases.length ? aliases : [id]
  for (const key of keys) map.byBoard[key] = entry
  return keys[0]
}

// A launch runs recovery in the background; a racing delete/leave waits on this
// so its removal lands after recovery instead of being re-attached (see
// removeShareEntry).
let recoveryInFlight = null

// Resolves true when recovery changed the saved sharing details, so a caller
// that already listed boards knows whether that listing needs refreshing. The
// share-map entry.version is deliberately left out: nothing reads it (pulls
// always ask from -1 and sync tracks its own state.version), while a hosted
// board's version bumps on every host edit — carrying it here would rewrite
// shared.json on the next launch of any board the owner actively hosts.
export function recoverMemberships(storage = store(), request = fetch) {
  const run = (async () => {
    await _json(await request(`${API}/resume-joins`, { method: 'POST', headers: _auth }))
    const listing = await _json(await request(API, { headers: _auth }))
    const additions = [...(listing.joined || []).map(m => ({ id:m.id, entry:{oid:m.id,host:m.host,role:m.role,member_id:m.member_id,transport:m.transport,label:m.label} })),
      ...(listing.hosted || []).filter(m=>m.local_id).map(m=>({id:m.local_id,entry:{oid:m.id,host:m.host,role:'editor',hosted:true,transport:m.transport,label:m.label}}))]
    if (!additions.length) return false
    return mutateShareMap(map => {
      for (const {id,entry} of additions) attachMembership(map, id, entry)
    }, storage)
  })()
  const settled = run.then(() => {}, () => {})
  recoveryInFlight = settled
  settled.finally(() => { if (recoveryInFlight === settled) recoveryInFlight = null })
  return run
}

export async function createInvite(oid, role, address) {
  const body = { role }
  if (typeof address === 'string' && address.trim()) body.address = address.trim()
  return _json(await fetch(`${API}/${oid}/invites`, {
    method: 'POST',
    headers: _auth,
    body: JSON.stringify(body),
  }))
}

export async function inviteByHandle(oid, address, role) {
  return createInvite(oid, role, address)
}

let invitationRequest = null
export function listInvitations() {
  // Visibility events, startup and the polling timer share one in-flight read.
  // Never accumulate refresh requests behind a slow federation operation.
  if (!invitationRequest) {
    invitationRequest = (async () => {
      const res = await _json(await fetch(`${API}/invitations`, { headers: _auth }))
      return res.invitations || []
    })().finally(() => { invitationRequest = null })
  }
  return invitationRequest
}

async function saveJoinedBoard(res) {
  const m = res.membership
  const doc = normalizeBoard(res.doc) || { v: 1, title: m.label || 'Shared board', columns: [], cards: {} }
  let boardId
  // Publish the authority before a replaceable cache. A cache-only success
  // must never make a joined shared board look privately writable.
  await mutateShareMap(map => {
    boardId = attachMembership(map, m.id, { oid: m.id, host: m.host, role: m.role, member_id: m.member_id, version: res.version, label: doc.title, transport: m.transport })
    if (!boardId) throw new Error('A different board already uses this local identity; your saved board was not replaced.')
  })
  try {
    await store().durableWrite(boardPath(boardId), doc)
  } catch (error) {
    // Membership is already durable; discovery includes that pointer and the
    // board can pull its authority even with no local copy. No rollback/delete.
    window.mobius?.signal?.('error', { source: 'joined-board-cache', message: String(error?.message || error) })
  }
  return { boardId, doc }
}

export async function acceptInvitation(inv) {
  const res = await _json(await fetch(`${API}/join`, {
    method: 'POST',
    headers: _auth,
    body: JSON.stringify({ app: 'kanban', host: inv.host, id: inv.id, label: inv.label }),
  }))
  return saveJoinedBoard(res)
}

export async function joinWithInvite(invite) {
  const res = await _json(await fetch(`${API}/join`, {
    method: 'POST',
    headers: _auth,
    body: JSON.stringify({ app: 'kanban', invite: String(invite || '').trim() }),
  }))
  return saveJoinedBoard(res)
}

export async function declineInvitation(inv) {
  return _json(await fetch(
    `${API}/invitations/${encodeURIComponent(inv.host)}/${inv.id}/decline`,
    { method: 'POST', headers: _auth },
  ))
}

export async function getMembers(oid) {
  return _json(await fetch(`${API}/${oid}/members`, { headers: _auth }))
}

// Older servers return one host; account-aware servers return per-deployment
// delivery results. Keep the result honest during independently timed upgrades.
export function inviteDeliveryNotice(result) {
  const deliveries = result.recipients || [{ host: result.host, delivery: result.delivery }]
  const delivered = deliveries.filter(item => item.delivery === 'delivered').length
  if (delivered === deliveries.length) {
    return { kind: 'ok', text: deliveries.length > 1
      ? `Invitation delivered to all ${deliveries.length} linked deployments.`
      : 'Invitation delivered — it is waiting on their Möbius.' }
  }
  return { kind: 'warn', text: delivered
    ? `Invitation delivered to ${delivered} of ${deliveries.length} deployments. Some could not be reached. Send again to retry delivery.`
    : 'Access is ready, but the invitation could not be delivered. Send again when their Möbius is reachable.' }
}

export function groupCollaborators(members) {
  const groups = new Map()
  for (const member of members) {
    // Never group by handle: unverified peers can use identical display names.
    const key = member.collaborator_id || member.member_id || member.host || member
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...member, hosts: [member.host], member_ids: member.member_id ? [member.member_id] : [] })
    } else {
      existing.hosts.push(member.host)
      if (member.member_id) existing.member_ids.push(member.member_id)
      existing.pending = existing.pending && member.pending
      existing.active = existing.active || member.active
      if (!existing.name && member.name) existing.name = member.name
      if (!existing.handle && member.handle) existing.handle = member.handle
    }
  }
  return [...groups.values()]
}

// "You" is established by the saved grant, never guessed from presence or
// a peer-supplied hostname. Groups retain every authorization identity.
export function selfCollaborator(members, share) {
  if (!share) return null
  return members.find(m => share.hosted ? m.host_owner === true
    : Boolean(share.member_id) && (m.member_id === share.member_id || m.member_ids?.includes(share.member_id))) || null
}

export function collaboratorForHost(members, host) {
  return members.find(member => member.host === host || member.hosts?.includes(host))
}

export async function revokeCollaborator(oid, member) {
  const scope = member.collaborator_id ? '?all_deployments=true' : ''
  return _json(await fetch(`${API}/${oid}/members/${encodeURIComponent(member.member_id)}${scope}`, {
    method: 'DELETE',
    headers: _auth,
  }))
}

export async function deleteSharedObject(oid) {
  const response = await fetch(`${API}/${oid}`, { method: 'DELETE', headers: _auth })
  try { return await _json(response) } catch (error) {
    if (error.code === 'board-missing') return { status: 'deleted' }
    throw error
  }
}

export async function leaveBoard(boardId, entry) {
  independent(entry)
  const response = await fetch(`${API}/${encodeURIComponent(entry.host)}/${entry.oid}/leave`, {
    method: 'POST',
    headers: _auth,
  })
  try { await _json(response) } catch (error) {
    if (!['board-missing', 'membership-revoked'].includes(error.code)) throw error
  }
  await removeShareEntry(boardId)
}

// ---- sync engine

// ---- board pieces
//
// A shared board's host stores it in pieces (collaboration/service.py, "Board
// pieces"): the lists, the other board settings ('meta') and each card. Saves
// send only the pieces an operation changed and polls receive only the pieces
// changed since the copy this instance last confirmed, so their size no longer
// grows with the board. Callers still see whole boards: the confirmed copy
// below turns changes back into one.

const BOARD_PIECES = new Set(['cards', 'columns'])
const boardMeta = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !BOARD_PIECES.has(key)))
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// What changed from `before` to `after`: {cards: {id: card or null}, columns?, meta?}.
export function changedPieces(before, after) {
  const cards = {}
  for (const [id, card] of Object.entries(after.cards)) if (!sameJson(before.cards[id], card)) cards[id] = card
  for (const id of Object.keys(before.cards)) if (!Object.hasOwn(after.cards, id)) cards[id] = null
  const pieces = { cards }
  if (!sameJson(before.columns, after.columns)) pieces.columns = after.columns
  const meta = boardMeta(after)
  if (!sameJson(boardMeta(before), meta)) pieces.meta = meta
  return pieces
}

export function applyBoardPieces(doc, pieces) {
  const cards = { ...doc.cards }
  for (const [id, card] of Object.entries(pieces.cards || {})) {
    if (card === null) delete cards[id]
    else cards[id] = card
  }
  return { ...(pieces.meta || boardMeta(doc)), columns: pieces.columns || doc.columns, cards }
}

const hasPieces = pieces => Object.keys(pieces.cards).length > 0 || 'columns' in pieces || 'meta' in pieces

// The host keeps a card's activity only when the save carries that card. A
// move changes only the lists, so the moved card travels unchanged with it.
function withDescribedCards(pieces, activity, doc) {
  const missing = Object.keys(activity || {}).filter(id => !Object.hasOwn(pieces.cards, id) && doc.cards[id])
  if (!missing.length) return pieces
  return { ...pieces, cards: { ...pieces.cards, ...Object.fromEntries(missing.map(id => [id, doc.cards[id]])) } }
}

// The newest board each host confirmed to this instance: {version, doc}. Only
// host replies update it; it is never the optimistic UI or an offline copy.
const confirmedCopies = new Map()
// Hosts that answered a piece save as an older Kanban; they get whole boards.
const wholeBoardHosts = new Set()
const copyKey = entry => `${entry.host}/${entry.oid}`

// Adopt a host reply: a whole board, or changes since `since` applied to the
// newest known copy that lies between `since` and the reply's version (the
// confirmed copy or `known`, the writer's own base). Returns the copy, or null
// when the changes cannot be placed and the next pull must ask for the whole board.
function adoptHostReply(entry, reply, known = null) {
  const key = copyKey(entry)
  const copy = confirmedCopies.get(key) || null
  if (!Number.isSafeInteger(reply?.version) || reply.version < 0) return copy
  if (copy && reply.version < copy.version) return copy
  let doc = null
  if (reply.doc && typeof reply.doc === 'object' && !Array.isArray(reply.doc)) {
    doc = reply.doc
  } else if (reply.changes && typeof reply.changes === 'object') {
    const from = [copy, known]
      .filter(candidate => candidate && candidate.version >= reply.since && candidate.version <= reply.version)
      .sort((a, b) => b.version - a.version)[0]
    if (from) doc = applyBoardPieces(from.doc, reply.changes)
  } else if (copy && reply.version === copy.version) {
    return copy
  }
  if (!doc) {
    confirmedCopies.delete(key)
    return null
  }
  const next = { version: reply.version, doc }
  confirmedCopies.set(key, next)
  return next
}

export async function pullShared(entry, sinceVersion, request = fetch) {
  independent(entry)
  const copy = confirmedCopies.get(copyKey(entry))
  const query = copy ? `since_version=${copy.version}&changes=1` : `since_version=${sinceVersion}`
  let res
  try { res = await _json(await request(
    `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/state?${query}`,
    { headers: _auth },
  )) } catch(error) {
    if (entry.publishing && error.code === 'board-missing') throw publicationPending()
    throw error
  }
  const current = adoptHostReply(entry, res)
  const { doc: _doc, changes, since: _since, ...answer } = res
  if (!current) {
    if (changes) throw invalidSharedPoll()
    return res
  }
  // Answer the caller's own question: the whole board unless it already holds this version.
  return current.version === sinceVersion
    ? { ...answer, version: current.version }
    : { ...answer, version: current.version, doc: structuredClone(current.doc) }
}

export async function putSharedAsset(entry, assetId, mime, data, request = fetch) {
  independent(entry)
  return _json(await request(
    `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/assets/${encodeURIComponent(assetId)}`,
    { method: 'PUT', headers: _auth, body: JSON.stringify({ mime, data }) },
  ))
}

export async function getSharedAsset(entry, assetId, request = fetch) {
  independent(entry)
  const result = await _json(await request(
    `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/assets/${encodeURIComponent(assetId)}`,
    { headers: _auth },
  ))
  return result.asset
}

export async function deleteSharedAsset(entry, assetId, request = fetch) {
  independent(entry)
  return _json(await request(
    `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/assets/${encodeURIComponent(assetId)}`,
    { method: 'DELETE', headers: _auth },
  ))
}

// Card details live beside the shared board on its host (collaboration/service.py): the
// full text of a long description, its version, and the card's activity. A
// host running an older Kanban rejects these requests; callers treat that as
// "not available on this board yet", never as a failed board edit.
const cardUrl = (entry, cardId) => `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/cards/${encodeURIComponent(cardId)}`

export async function readSharedCard(entry, cardId, request = fetch) {
  independent(entry)
  return _json(await request(cardUrl(entry, cardId), { headers: _auth }))
}

// `{status: 'ok', notes_version, version, card, activity}` or `{status: 'conflict', notes, notes_version}`.
// `activity` describes the edit; the host saves it with the text, in one
// transaction, and answers with the card's activity.
export async function writeSharedNotes(entry, cardId, notes, expectedVersion, request = fetch, activity = []) {
  independent(entry)
  return _json(await request(`${cardUrl(entry, cardId)}/notes`, {
    method: 'PUT', headers: _auth, body: JSON.stringify({ notes, expected_version: expectedVersion,
      ...(activity.length ? { activity } : {}) }),
  }))
}

// A host running an older Kanban answers a route or operation it lacks this way.
export function olderHostRefused(error) {
  return ['invalid-operation', 'route-missing'].includes(error?.code)
}

// A board the owner is actively using should feel collaborative; an idle one
// can relax to the former cadence without creating a permanent fast poll.
export function sharedBoardPollDelay(lastInteractionAt, now = Date.now()) {
  return now - lastInteractionAt < 15_000 ? 1000 : 3000
}

const TERMINAL_SHARED_POLL_ERRORS = new Set([
  'board-missing',
  'membership-revoked',
  'migration-required',
  'migration-staged',
  'authority-retired',
])

function invalidSharedPoll() {
  return Object.assign(new Error('The board host returned an invalid state.'), {
    code: 'authority-unavailable',
  })
}

// Poll responses may omit the document only when they confirm the version we
// already hold. A request is not a successful refresh until its authority and
// document have passed this boundary.
export function acceptSharedPoll(previous, entry, state) {
  if (!entry || !Number.isSafeInteger(state?.version) || state.version < 0) {
    throw invalidSharedPoll()
  }
  if ((state.host && state.host !== entry.host) || (state.oid && state.oid !== entry.oid)) {
    throw invalidSharedPoll()
  }
  const current = previous?.host === entry.host && previous?.oid === entry.oid ? previous : null
  if (current && state.version < current.version) return null
  const hasDocument = Object.hasOwn(state, 'doc')
  const document = hasDocument ? normalizeBoard(structuredClone(state.doc)) : null
  if (hasDocument && !document) throw invalidSharedPoll()
  if (!hasDocument) {
    if (!current || state.version !== current.version) throw invalidSharedPoll()
    return current
  }
  if (current && state.version === current.version) return current
  return { host: entry.host, oid: entry.oid, version: state.version, doc: document }
}

export function sharedPollAvailability(error, hasCachedBoard) {
  if (TERMINAL_SHARED_POLL_ERRORS.has(error?.code)) {
    const messages = {
      'board-missing': 'This shared board no longer exists. Your local copy and saved edits are unchanged.',
      'membership-revoked': 'You no longer have access to this shared board. Your local copy and saved edits are unchanged.',
      'migration-required': 'This board needs a new invitation from its host after the Kanban upgrade. Your local copy and saved edits are unchanged.',
      'migration-staged': 'This shared board is being moved to a new authority. Ask its host for a fresh invitation; your local copy and saved edits are unchanged.',
      'authority-retired': 'This shared board has moved to a new authority. Ask its host for a fresh invitation; your local copy and saved edits are unchanged.',
    }
    return { kind: 'terminal', message: messages[error.code], retryable: false }
  }
  return hasCachedBoard
    ? { kind: 'reconnecting', message: 'Reconnecting — showing your last copy', retryable: true }
    : { kind: 'unavailable', message: 'This shared board couldn’t be reached. Your saved edits are unchanged.', retryable: true }
}

// One lifecycle owns both visible availability and error-streak reporting. A
// fulfilled request does not reset the streak; only successful authoritative
// integration does.
export function createSharedRefreshLifecycle({ onSignal, onAvailability }) {
  let failureReported = false
  let continueAutomatically = true
  return {
    async refresh({ pull, integrate, hasCachedBoard }) {
      try {
        const state = await pull()
        const integrated = await integrate(state)
        if (integrated === false) return { status: 'superseded' }
        failureReported = false
        continueAutomatically = true
        const availability = { kind: 'ready', message: '', retryable: true }
        onAvailability(availability)
        return { status: 'ready', availability }
      } catch (error) {
        if (!failureReported) onSignal(error)
        failureReported = true
        const availability = sharedPollAvailability(error, hasCachedBoard())
        continueAutomatically = availability.retryable
        onAvailability(availability)
        return { status: 'failed', error, availability }
      }
    },
    shouldContinue() {
      return continueAutomatically
    },
  }
}

// A shared object's poll is its only authority. The app-storage document is an
// offline cache and its unversioned subscription must never replace a polled
// document while sharing is active.
export function cacheSubscriptionIsAuthoritative(shareEntry) {
  return !shareEntry
}

// Keep the last confirmed version and document together. An unchanged poll or
// late write reply must not lose a newer document deferred during local input.
export function rememberSharedState(previous, entry, state) {
  if (!entry) return null
  const current = previous?.host === entry.host && previous?.oid === entry.oid ? previous : null
  if ((state?.host && state.host !== entry.host) || (state?.oid && state.oid !== entry.oid)) return current
  if (!Number.isSafeInteger(state?.version) || state.version < 0 || !state.doc
    || typeof state.doc !== 'object' || Array.isArray(state.doc)) return current
  if (current && current.version >= state.version) return current
  return { host: entry.host, oid: entry.oid, version: state.version,
    doc: normalizeBoard(structuredClone(state.doc)) }
}

async function savePieces(entry, pieces, expectedVersion, request, activity) {
  return _json(await request(`${API}/${encodeURIComponent(entry.host)}/${entry.oid}/changes`, {
    method: 'POST', headers: _auth, body: JSON.stringify({ pieces, expected_version: expectedVersion,
      ...(activity ? { activity } : {}) }),
  }))
}

async function saveWholeBoard(entry, doc, expectedVersion, request) {
  return _json(await request(`${API}/${encodeURIComponent(entry.host)}/${entry.oid}/state`, {
    method: 'PUT', headers: _auth, body: JSON.stringify({ doc, expected_version: expectedVersion }),
  }))
}

// Apply `op` to the shared doc with CAS retry. Returns the doc that landed.
// Only the pieces `op` changed are sent; the host refuses them only when
// someone else changed one of the same pieces, and its reply brings this copy
// up to date either way.
//
// `describe()`, called after each attempt's `op`, returns that attempt's
// activity ({cardId: entries}) or null. It is sent with the pieces and the
// host commits both together; the landed result's `activity` is the host's
// answer ({cardId: card activity}), absent when no activity was saved.
export async function pushSharedOp(entry, op, onError, request = fetch, confirmed = null, describe = null) {
  try { independent(entry) } catch (error) { onError?.(error); return null }
  // This is a version-bound hint, never the optimistic UI or an offline copy.
  // The host still authorizes and CAS-checks every write.
  let state = confirmed?.host === entry.host && confirmed?.oid === entry.oid
    ? rememberSharedState(null, entry, confirmed) : null
  let hinted = Boolean(state)
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      state ||= await pullShared(entry, -1, request)
      const base = normalizeBoard(structuredClone(state.doc))
      if (!base) return null
      let next
      try {
        const draft = structuredClone(base)
        next = op(draft) || draft
      } catch (error) {
        // A cached version may predate a card's creation. Re-read before
        // treating a domain validation error as terminal and discarding intent.
        if (!hinted) throw error
        state = null
        hinted = false
        continue
      }
      hinted = false
      const pieces = changedPieces(base, next)
      if (!hasPieces(pieces)) return { doc: next, version: state.version, unchanged: true }
      const known = { version: state.version, doc: base }
      let res
      const activity = describe?.() || null
      if (!wholeBoardHosts.has(entry.host)) {
        try {
          res = await savePieces(entry, withDescribedCards(pieces, activity, next), state.version, request, activity)
        } catch (error) {
          if (!olderHostRefused(error)) throw error
          wholeBoardHosts.add(entry.host)
        }
      }
      if (!res) {
        res = await saveWholeBoard(entry, next, state.version, request)
        // A whole-board save is answered with the host's copy only when the host
        // changed it (it moves long descriptions out); otherwise ours is exact.
        if (res.status !== 'conflict' && !res.doc) res = { ...res, doc: next }
      }
      const adopted = adoptHostReply(entry, res, known)
      if (res.status === 'conflict') {
        // A conflict normally carries what changed since our version; without
        // that, read the board again rather than retry from a stale copy.
        state = adopted && adopted.version === res.version
          ? { host: entry.host, oid: entry.oid, version: adopted.version, doc: adopted.doc } : null
        continue
      }
      const landed = adopted || { version: res.version, doc: next }
      return { doc: normalizeBoard(structuredClone(landed.doc)), version: landed.version,
        ...(res.activity && typeof res.activity === 'object' ? { activity: res.activity } : {}) }
    } catch (e) {
      onError?.(e)
      return null
    }
  }
  onError?.(new Error('The board is changing too quickly — try again.'))
  return null
}

// Directory entries discover candidates; only the account registry confirms
// that a handle belongs to this exact deployment. This affects labels only.
export async function resolveMemberHandles(hosts, token, request = fetch, signal) {
  const verified = {}
  const pending = [...new Set(hosts)]
  const headers = { Authorization: `Bearer ${token}` }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length && !signal?.aborted) {
      const host = pending.shift()
      try {
        const url = `https://www.mobius.you/api/app-services/social/directory?q=${encodeURIComponent(host)}`
        const directory = await request(`/api/proxy?url=${encodeURIComponent(url)}`, { headers, signal })
        if (!directory.ok) continue
        const listing = await directory.json()
        const candidate = listing.users?.find(user => user.host === host && user.handle)
        if (!candidate) continue
        const handle = String(candidate.handle).trim().replace(/^@/u, '')
        const response = await request(`/api/identity/handles/${encodeURIComponent(handle)}`, { headers, signal })
        if (!response.ok) continue
        const identity = await response.json()
        if (identity.linked === true && identity.hosts?.includes(host)) verified[host] = handle
      } catch {
        // Optional profile discovery must not interrupt board sync or presence.
      }
    }
  }))
  return verified
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

// Photos are fetched once per member, never once per card. Identity-bearing
// hosts come from joined membership; a display name never chooses a photo.
export async function loadMemberAvatar(host, localHost, token, fetcher = fetch, signal) {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host || '')) return ''

  const url = host === localHost
    ? '/api/identity/avatar'
    : `/api/proxy?url=${encodeURIComponent(`https://${host}/api/app-services/social/avatar`)}`

  let reader
  try {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
    reader = response.body?.getReader()
    const contentType = response.headers.get('Content-Type') || ''
    const contentLength = Number(response.headers.get('Content-Length'))
    const isSupportedImage = /^image\/(png|jpeg|webp|gif)$/i.test(contentType)
    if (!response.ok || !reader || !isSupportedImage || contentLength > MAX_AVATAR_BYTES) {
      return ''
    }

    const chunks = []
    let bytesRead = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      bytesRead += value.byteLength
      if (bytesRead > MAX_AVATAR_BYTES) return ''
      chunks.push(value)
    }
    if (!bytesRead) return ''

    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
    let binary = ''
    // Small chunks keep large photos below the function-argument limit.
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    return `data:${contentType.toLowerCase()};base64,${btoa(binary)}`
  } catch {
    // Offline and unpublished profiles retain initials.
    return ''
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

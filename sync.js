// Shared-board sync over the platform's federated shared objects.
//
// A shared board's source of truth is its shared object (hosted on whichever
// instance created it). The local board file stays as an offline cache. All
// requests go to THIS instance, which signs and forwards to the host when the
// board lives elsewhere. Writes are op-based CAS, mirroring storage.js: apply
// the op to the freshest shared doc, write with expected_version, and on
// conflict re-apply the op to the returned doc and retry.

import { normalizeBoard, boardPath, getBoard } from './storage.js'

const API = '/api/common/objects'
const store = () => window.mobius?.storage

let _auth = null
export function configureSync(token) {
  _auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function _json(res) {
  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    try { detail = (await res.json()).detail || detail } catch { /* keep default */ }
    const err = new Error(detail)
    err.status = res.status
    throw err
  }
  return res.json()
}

// ---- share map (app storage): { byBoard: { <boardId>: {oid, host, role} } }

export async function loadShareMap() {
  return normalizeShareMap(await store()?.get('shared.json'))
}

function normalizeShareMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { byBoard: {} }
  if (!value.byBoard || typeof value.byBoard !== 'object' || Array.isArray(value.byBoard)) {
    return { ...value, byBoard: {} }
  }
  return value
}

async function mutateShareMap(op) {
  const s = store()
  if (!s) throw new Error('App storage is unavailable.')
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, version } = await s.getWithVersion('shared.json')
    const next = structuredClone(normalizeShareMap(value))
    op(next)
    try {
      await s.durableWrite('shared.json', next, version
        ? { ifMatch: version }
        : { ifNoneMatch: true })
      return next
    } catch (error) {
      if (error?.code === 'conflict') continue
      throw error
    }
  }
  throw new Error('Could not save sharing details after repeated conflicts.')
}

async function saveShareEntry(boardId, entry) {
  await mutateShareMap(map => { map.byBoard[boardId] = entry })
}

export async function removeShareEntry(boardId) {
  await mutateShareMap(map => { delete map.byBoard[boardId] })
}

// ---- owner actions

export async function shareBoard(boardId) {
  // Publishing establishes a new authority, so snapshot storage immediately
  // before the request rather than trusting a possibly optimistic render prop.
  const doc = await getBoard(boardId)
  if (!doc) throw new Error('The latest board could not be read for sharing.')
  const res = await _json(await fetch(API, {
    method: 'POST',
    headers: _auth,
    body: JSON.stringify({
      app: 'kanban', kind: 'board', label: doc.title || 'Board', doc,
    }),
  }))
  const entry = { oid: res.id, host: res.host, role: 'editor', hosted: true, version: res.version }
  await saveShareEntry(boardId, entry)
  return entry
}

export async function inviteByHandle(oid, address, role) {
  return _json(await fetch(`${API}/${oid}/invites`, {
    method: 'POST',
    headers: _auth,
    body: JSON.stringify({ role, address }),
  }))
}

export async function listInvitations() {
  const res = await _json(await fetch(`${API}/invitations`, { headers: _auth }))
  return res.invitations || []
}

export async function acceptInvitation(inv) {
  const res = await _json(await fetch(`${API}/join`, {
    method: 'POST',
    headers: _auth,
    body: JSON.stringify({ app: 'kanban', host: inv.host, id: inv.id, label: inv.label }),
  }))
  const m = res.membership
  const doc = normalizeBoard(res.doc) || { v: 1, title: m.label || 'Shared board', columns: [], cards: {} }
  const boardId = m.id
  await store().durableWrite(boardPath(boardId), doc)
  await saveShareEntry(boardId, { oid: m.id, host: m.host, role: m.role, version: 0 })
  return { boardId, doc }
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

export async function revokeMember(oid, host) {
  return _json(await fetch(`${API}/${oid}/members/${encodeURIComponent(host)}`, {
    method: 'DELETE',
    headers: _auth,
  }))
}

export async function deleteSharedObject(oid) {
  const response = await fetch(`${API}/${oid}`, { method: 'DELETE', headers: _auth })
  if (response.status === 404) return { status: 'deleted' }
  return _json(response)
}

export async function leaveBoard(boardId, entry) {
  const response = await fetch(`${API}/${encodeURIComponent(entry.host)}/${entry.oid}/leave`, {
    method: 'POST',
    headers: _auth,
  })
  if (response.status !== 404) await _json(response)
  await removeShareEntry(boardId)
}

// ---- sync engine

export async function pullShared(entry, sinceVersion) {
  const res = await _json(await fetch(
    `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/state?since_version=${sinceVersion}`,
    { headers: _auth },
  ))
  return res // {status, version, doc?, object?}
}

// A shared object's poll is its only authority. The app-storage document is an
// offline cache and its unversioned subscription must never replace a polled
// document while sharing is active.
export function cacheSubscriptionIsAuthoritative(shareEntry) {
  return !shareEntry
}

export function sharedCursorAfterWrite(landed) {
  return landed && Number.isFinite(landed.version) ? landed.version : -1
}

// Apply `op` to the shared doc with CAS retry. Returns the doc that landed.
export async function pushSharedOp(entry, op, onError) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const state = await pullShared(entry, -1)
      const base = normalizeBoard(state.doc)
      if (!base) return null
      const next = op(structuredClone(base)) || base
      const res = await _json(await fetch(
        `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/state`,
        {
          method: 'PUT',
          headers: _auth,
          body: JSON.stringify({ doc: next, expected_version: state.version }),
        },
      ))
      if (res.status === 'conflict') continue
      return { doc: next, version: res.version }
    } catch (e) {
      onError?.(e)
      return null
    }
  }
  onError?.(new Error('The board is changing too quickly — try again.'))
  return null
}

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
    throw Object.assign(new Error('This shared board needs a verified migration to independent Kanban. Your last copy and pending edits are retained.'), { code: 'migration-required', retryable: false, discardable: false })
  }
}
const store = () => window.mobius?.storage

let _auth = null
export function configureSync(token, appId) {
  if (!Number.isSafeInteger(appId) || appId < 1) throw new Error('Kanban app identity is required.')
  API = `/api/apps/${appId}/service/boards`
  _auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
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

async function mutateShareMap(op, s = store()) {
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

// Completed service membership is the recovery source when a browser's
// replaceable discovery pointer was not saved. Never overwrite an existing
// pointer to another authority, and never replace a legacy pointer silently.
export async function recoverMemberships(storage = store(), request = fetch) {
  await _json(await request(`${API}/resume-joins`, { method: 'POST', headers: _auth }))
  const listing = await _json(await request(API, { headers: _auth }))
  const additions = [...(listing.joined || []).map(m => ({ id:m.id, entry:{oid:m.id,host:m.host,role:m.role,member_id:m.member_id,transport:m.transport,label:m.label,handoff:m.handoff} })),
    ...(listing.hosted || []).filter(m=>m.local_id).map(m=>({id:m.local_id,entry:{oid:m.id,host:m.host,role:'editor',hosted:true,transport:m.transport,version:m.version,label:m.label,handoff:m.handoff}}))]
  if (!additions.length) return
  await mutateShareMap(map => {
    for (const {id,entry} of additions) {
      independent(entry)
      // Only a service-owned administrative handoff can adopt a legacy
      // pointer. Preserve its existing local ID so queued operations and
      // attachment references stay attached to the same board.
      const migrated=entry.handoff?.from==='common/0'
        && /^[a-f0-9]{32}$/.test(entry.handoff.transition)
        && /^[a-f0-9]{64}$/.test(entry.handoff.digest)
      const aliases=migrated ? Object.keys(map.byBoard).filter(key => {
        const prior=map.byBoard[key]
        return prior.host===entry.host && prior.oid===entry.oid
      }) : []
      for (const key of aliases.length ? aliases : [id]) {
        const prior=map.byBoard[key]
        if (!prior || ((prior.transport===PROTOCOL || migrated)
          && prior.host===entry.host && prior.oid===entry.oid)) map.byBoard[key]=entry
      }
    }
  }, storage)
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
  const boardId = m.id
  // Publish the authority before a replaceable cache. A cache-only success
  // must never make a joined shared board look privately writable.
  await saveShareEntry(boardId, { oid: m.id, host: m.host, role: m.role, member_id: m.member_id, version: res.version, label: doc.title, transport: m.transport })
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

export async function pullShared(entry, sinceVersion, request = fetch) {
  independent(entry)
  let res
  try { res = await _json(await request(
    `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/state?since_version=${sinceVersion}`,
    { headers: _auth },
  )) } catch(error) {
    if (entry.publishing && error.code === 'board-missing') throw publicationPending()
    throw error
  }
  return res // {status, version, doc?, object?}
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

// A board the owner is actively using should feel collaborative; an idle one
// can relax to the former cadence without creating a permanent fast poll.
export function sharedBoardPollDelay(lastInteractionAt, now = Date.now()) {
  return now - lastInteractionAt < 15_000 ? 1000 : 3000
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

// Apply `op` to the shared doc with CAS retry. Returns the doc that landed.
export async function pushSharedOp(entry, op, onError, request = fetch, confirmed = null) {
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
      try { next = op(base) || base } catch (error) {
        // A cached version may predate a card's creation. Re-read before
        // treating a domain validation error as terminal and discarding intent.
        if (!hinted) throw error
        state = null
        hinted = false
        continue
      }
      hinted = false
      const res = await _json(await request(
        `${API}/${encodeURIComponent(entry.host)}/${entry.oid}/state`,
        {
          method: 'PUT',
          headers: _auth,
          body: JSON.stringify({ doc: next, expected_version: state.version }),
        },
      ))
      if (res.status === 'conflict') {
        // A conflict already carries the latest authoritative document/version.
        state = rememberSharedState(null, entry, res)
        continue
      }
      return { doc: next, version: res.version }
    } catch (e) {
      onError?.(e)
      return null
    }
  }
  onError?.(new Error('The board is changing too quickly — try again.'))
  return null
}

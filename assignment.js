// Who a card belongs to, and how that changed.
//
// An assignment is `{ label, host }`. The host is the identity whenever it is
// present; the label is only a display fallback (private-board names such as
// "Me", or very old cards). History lives on the card so it travels with the
// board to every collaborator; each entry is written by the app that made the
// change. Changes that arrive without an entry (an older Kanban, or an agent
// edit) are noticed locally and kept beside the board, never in it.

export const BOARD_VIEWS = ['all', 'mine', 'changed', 'unassigned']
export const ASSIGNMENT_HISTORY_LIMIT = 20
export const OBSERVED_ASSIGNMENT_LIMIT = 200

const clean = value => typeof value === 'string' ? value.trim() : ''

export function assignmentRef(value) {
  return { label: clean(value?.label), host: clean(value?.host) }
}

export function cardAssignment(card) {
  return { label: clean(card?.assignee), host: clean(card?.assigneeHost) }
}

export function hasAssignment(ref) {
  return Boolean(ref?.label || ref?.host)
}

export function assignmentKey(ref) {
  const { label, host } = assignmentRef(ref)
  if (host) return `host:${host.toLocaleLowerCase()}`
  return label ? `label:${label.replace(/^@/u, '').toLocaleLowerCase()}` : ''
}

export const sameAssignment = (left, right) => assignmentKey(left) === assignmentKey(right)

export function normalizeBoardView(value) {
  return BOARD_VIEWS.includes(value) ? value : 'all'
}

// `me.hosts` are every hostname this owner is known by on the board; `me.names`
// are private-board names that mean the owner ("Me", their handle).
export function isAssignedToMe(card, me) {
  const { label, host } = cardAssignment(card)
  const hosts = new Set((me?.hosts || []).map(value => clean(value).toLocaleLowerCase()).filter(Boolean))
  // Some older cards stored the hostname itself as the visible assignee.
  const identity = (host || (label.includes('.') && !label.includes(' ') ? label : '')).toLocaleLowerCase()
  if (identity) return hosts.has(identity)
  const names = new Set((me?.names || []).map(value => clean(value).replace(/^@/u, '').toLocaleLowerCase()).filter(Boolean))
  return Boolean(label) && names.has(label.replace(/^@/u, '').toLocaleLowerCase())
}

// `changed` holds the ids of cards changed since this person last looked.
export function cardMatchesView(card, view, me, changed = new Set()) {
  switch (normalizeBoardView(view)) {
    case 'mine': return isAssignedToMe(card, me)
    case 'changed': return changed.has(card.id)
    case 'unassigned': return !hasAssignment(cardAssignment(card))
    default: return true
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !event.id) return null
  if (typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) return null
  const normalized = { id: event.id, at: event.at, from: assignmentRef(event.from), to: assignmentRef(event.to) }
  if (event.by && hasAssignment(assignmentRef(event.by))) normalized.by = assignmentRef(event.by)
  return normalized
}

export function assignmentHistory(card) {
  return (Array.isArray(card?.assignmentHistory) ? card.assignmentHistory : [])
    .map(normalizeEvent)
    .filter(Boolean)
}

export function createAssignmentEvent({ id, at = new Date().toISOString(), by, from, to }) {
  return normalizeEvent({ id, at, by, from, to })
}

// The board operation. Replaying it is idempotent: the same event id is never
// appended twice, so an offline replay cannot duplicate history.
export function applyAssignment(card, op) {
  if (!card || !op) return card
  const to = assignmentRef({ label: op.assignee, host: op.assigneeHost })
  card.assignee = to.label
  card.assigneeHost = to.host
  const event = normalizeEvent(op.event)
  if (event) {
    const history = assignmentHistory(card)
    if (!history.some(entry => entry.id === event.id)) history.push(event)
    card.assignmentHistory = history.slice(-ASSIGNMENT_HISTORY_LIMIT)
  }
  return card
}

export function describeAssignmentEvent(event, nameFor = ref => ref.label || ref.host) {
  const text = describe(event, nameFor)
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

function describe(event, nameFor) {
  const from = hasAssignment(event.from) ? nameFor(event.from) : ''
  const to = hasAssignment(event.to) ? nameFor(event.to) : ''
  if (!event.by) {
    if (!from) return `Assigned to ${to}`
    if (!to) return `${from} was removed`
    return `Reassigned from ${from} to ${to}`
  }
  const by = nameFor(event.by)
  const isActor = ref => hasAssignment(ref) && sameAssignment(ref, event.by)
  if (!from) return isActor(event.to) ? `${by} took this card` : `${by} assigned ${to}`
  if (!to) return isActor(event.from) ? `${by} stepped off this card` : `${by} removed ${from}`
  if (isActor(event.to)) return `${by} took this card from ${from}`
  return `${by} reassigned it from ${from} to ${to}`
}

// The newest entry that can bring someone back: it took a person off the card
// and that person is not on the card now.
export function restorableAssignment(event, card) {
  if (!hasAssignment(event?.from)) return null
  return sameAssignment(event.from, cardAssignment(card)) ? null : event.from
}

// Compare a board against the assignments this app last saw. A change with no
// matching history entry was made somewhere that does not record history, so
// it becomes an "author unknown" entry. Returns `changed: false` when the
// stored snapshot is already current.
export function observeAssignments(board, seen, { now = new Date().toISOString(), makeId } = {}) {
  const previous = seen && typeof seen === 'object' && seen.cards && typeof seen.cards === 'object' ? seen.cards : null
  const observed = Array.isArray(seen?.observed) ? seen.observed : []
  const cards = {}
  const events = []
  let changed = !previous
  for (const [cardId, card] of Object.entries(board?.cards || {})) {
    if (!card || typeof card !== 'object') continue
    const current = cardAssignment(card)
    const history = assignmentHistory(card)
    const lastEventId = history.at(-1)?.id || ''
    const before = previous?.[cardId]
    cards[cardId] = { ...current, lastEventId }
    if (!before) { if (previous) changed = true; continue }
    if (before.label !== current.label || before.host !== current.host || before.lastEventId !== lastEventId) changed = true
    if (sameAssignment(before, current)) continue
    const explained = lastEventId && lastEventId !== before.lastEventId && sameAssignment(history.at(-1).to, current)
    if (!explained) {
      events.push({ id: makeId(), cardId, at: now, from: assignmentRef(before), to: current })
    }
  }
  if (previous && Object.keys(previous).some(cardId => !cards[cardId])) changed = true
  const kept = observed.filter(event => cards[event?.cardId])
  if (kept.length !== observed.length) changed = true
  return {
    changed: changed || events.length > 0,
    events,
    seen: { v: 1, cards, observed: [...kept, ...events].slice(-OBSERVED_ASSIGNMENT_LIMIT) },
  }
}

// Only host-confirmed shared versions are observed, newest first-wins, so a
// stale offline copy can never be mistaken for somebody's change. Returns the
// next log, or undefined when the stored one is current.
export function nextAssignmentLog(log, confirmed, options) {
  if (!confirmed?.doc || !Number.isSafeInteger(confirmed.version)) return undefined
  const authority = `${confirmed.host}/${confirmed.oid}`
  const sameAuthority = log?.authority === authority
  if (sameAuthority && Number.isSafeInteger(log.version) && confirmed.version <= log.version) return undefined
  const result = observeAssignments(confirmed.doc, log, options)
  if (!result.changed && sameAuthority) return undefined
  return { ...result.seen, authority, version: confirmed.version }
}

// One timeline for the card sheet: synced history plus this device's notices.
export function cardAssignmentTimeline(card, observed = []) {
  const local = (Array.isArray(observed) ? observed : [])
    .filter(event => event?.cardId === card?.id)
    .map(normalizeEvent)
    .filter(Boolean)
    .map(event => ({ ...event, observed: true }))
  return [...assignmentHistory(card), ...local]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}

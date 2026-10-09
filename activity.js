// Card activity: what changed on a card, who changed it, and when.
//
// Activity deliberately lives outside the board document. A shared board's
// document is capped by its host (256 KB) and every edit resends it whole, so
// per-card history is kept beside the board: on the hosting Kanban service for
// shared boards (one record per card, author stamped by the host) and in app
// storage for private boards. Assignment history predates this and stays on
// the card; the card sheet shows both in one timeline.
//
// Entries are derived by comparing a card before and after an operation, so
// replaying an operation that already landed records nothing.
import { cardPullUrls } from './operations.js'

export const MAX_ACTIVITY_PER_CARD = 100
export const MAX_ACTIVITY_TEXT = 300
// A description saved beside a shared board may not grow past this length
// (the host enforces it too: MAX_NOTES_CHARS in collaboration/service.py). An
// older, longer description stays editable as long as it does not grow.
// Longer text belongs in an attachment.
export const MAX_NOTES_CHARS = 16000

// Keep in step with ACTIVITY_TYPES in collaboration/service.py: the host
// rejects types it does not know.
export const ACTIVITY_TYPES = [
  'created', 'completed', 'renamed', 'notes', 'moved', 'label', 'due',
  'checklist-added', 'checklist-removed', 'checklist-checked', 'checklist-unchecked', 'checklist-edited',
  'attachment-added', 'attachment-removed', 'pr-added', 'pr-removed', 'pr-changed',
]

const ID = /^[A-Za-z0-9_-]{1,64}$/u
const clip = value => typeof value === 'string' ? value.trim().slice(0, MAX_ACTIVITY_TEXT) : ''
const text = value => typeof value === 'string' ? value : ''

function byId(items) {
  const map = new Map()
  for (const item of Array.isArray(items) ? items : []) if (item && typeof item.id === 'string') map.set(item.id, item)
  return map
}

// `before` and `after` are `{ card, column }` snapshots (column is the list
// name) or null when the card did not exist on that side.
export function describeCardChange({ op, before, after }) {
  if (!after?.card) return []
  if (!before?.card) return [{ type: 'created', to: clip(after.column) }]
  if (op?.type === 'complete-card') return [{ type: 'completed', text: clip(op.summary) }]
  const a = before.card
  const b = after.card
  const drafts = []
  if (text(a.title).trim() !== text(b.title).trim()) drafts.push({ type: 'renamed', from: clip(a.title), to: clip(b.title) })
  if (text(a.notes) !== text(b.notes)) drafts.push({ type: 'notes' })
  if (before.column !== after.column) drafts.push({ type: 'moved', from: clip(before.column), to: clip(after.column) })
  const labelOf = card => (card.label && card.label !== 'none' ? card.label : '')
  if (labelOf(a) !== labelOf(b)) drafts.push({ type: 'label', from: labelOf(a), to: labelOf(b) })
  if (text(a.due) !== text(b.due)) drafts.push({ type: 'due', from: text(a.due), to: text(b.due) })

  const oldItems = byId(a.checklist)
  const newItems = byId(b.checklist)
  for (const [id, item] of newItems) {
    const old = oldItems.get(id)
    if (!old) { drafts.push({ type: 'checklist-added', text: clip(item.text) }); continue }
    if ((old.done === true) !== (item.done === true)) {
      drafts.push({ type: item.done === true ? 'checklist-checked' : 'checklist-unchecked', text: clip(item.text) })
    }
    if (text(old.text) !== text(item.text)) drafts.push({ type: 'checklist-edited', from: clip(old.text), to: clip(item.text) })
  }
  for (const [id, item] of oldItems) if (!newItems.has(id)) drafts.push({ type: 'checklist-removed', text: clip(item.text) })

  const oldFiles = byId(a.attachments)
  const newFiles = byId(b.attachments)
  for (const [id, file] of newFiles) if (!oldFiles.has(id)) drafts.push({ type: 'attachment-added', text: clip(file.name || 'Attachment') })
  for (const [id, file] of oldFiles) if (!newFiles.has(id)) drafts.push({ type: 'attachment-removed', text: clip(file.name || 'Attachment') })

  const oldUrls = cardPullUrls(a)
  const newUrls = cardPullUrls(b)
  const added = newUrls.filter(url => !oldUrls.includes(url))
  const removed = oldUrls.filter(url => !newUrls.includes(url))
  if (added.length === 1 && removed.length === 1) drafts.push({ type: 'pr-changed', from: clip(removed[0]), to: clip(added[0]) })
  else {
    for (const url of added) drafts.push({ type: 'pr-added', to: clip(url) })
    for (const url of removed) drafts.push({ type: 'pr-removed', from: clip(url) })
  }
  return drafts
}

// The card and list name an operation touches, captured before it applies.
export function cardSnapshot(doc, cardId) {
  const card = cardId ? doc?.cards?.[cardId] : null
  if (!card) return null
  const column = (doc.columns || []).find(item => Array.isArray(item.cardIds) && item.cardIds.includes(cardId))
  return { card: structuredClone(card), column: String(column?.name || '') }
}

export function operationCardId(op) {
  return op?.type === 'add-card' ? op.card?.id : op?.cardId
}

export function createActivityEntries(drafts, { at = new Date().toISOString(), via = '', makeId }) {
  return drafts.map(draft => normalizeActivityEntry({ ...draft, id: makeId(), at, ...(via ? { via } : {}) })).filter(Boolean)
}

export function normalizeActivityEntry(entry) {
  if (!entry || typeof entry !== 'object' || !ID.test(String(entry.id || ''))) return null
  if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) return null
  if (!ACTIVITY_TYPES.includes(entry.type)) return null
  const normalized = { id: entry.id, at: entry.at, type: entry.type }
  for (const key of ['from', 'to', 'text']) if (typeof entry[key] === 'string') normalized[key] = clip(entry[key])
  if (entry.via === 'agent') normalized.via = 'agent'
  if (entry.by && typeof entry.by === 'object') {
    const by = { host: clip(entry.by.host), name: clip(entry.by.name) }
    if (by.host || by.name) normalized.by = by
  }
  return normalized
}

// Union by id, oldest first, keeping the newest MAX_ACTIVITY_PER_CARD.
export function mergeActivity(existing, incoming, limit = MAX_ACTIVITY_PER_CARD) {
  const merged = new Map()
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const normalized = normalizeActivityEntry(entry)
    if (normalized && !merged.has(normalized.id)) merged.set(normalized.id, normalized)
  }
  return [...merged.values()]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id))
    .slice(-limit)
}

const quote = value => `“${value}”`
const capitalize = value => value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value

function shortDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso || '')
  if (!match) return iso
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))))
}

function pullLabel(url) {
  const match = /\/pull\/(\d+)/u.exec(url || '')
  return match ? `#${match[1]}` : url
}

// The sentence after the actor's name, e.g. `renamed the card from “A” to “B”`.
export function describeActivity(entry) {
  switch (entry.type) {
    case 'created': return entry.to ? `created this card in ${entry.to}` : 'created this card'
    case 'completed': return entry.text ? `marked this card done: ${entry.text}` : 'marked this card done'
    case 'renamed': return `renamed the card from ${quote(entry.from)} to ${quote(entry.to)}`
    case 'notes': return 'edited the description'
    case 'moved': return `moved this card from ${entry.from || 'another list'} to ${entry.to || 'another list'}`
    case 'label': return entry.to ? `set the label to ${capitalize(entry.to)}` : 'removed the label'
    case 'due': return entry.to ? `set the due date to ${shortDate(entry.to)}` : 'cleared the due date'
    case 'checklist-added': return `added ${quote(entry.text)} to the checklist`
    case 'checklist-removed': return `removed ${quote(entry.text)} from the checklist`
    case 'checklist-checked': return `checked ${quote(entry.text)}`
    case 'checklist-unchecked': return `unchecked ${quote(entry.text)}`
    case 'checklist-edited': return `changed a checklist item from ${quote(entry.from)} to ${quote(entry.to)}`
    case 'attachment-added': return `attached ${quote(entry.text)}`
    case 'attachment-removed': return `removed the attachment ${quote(entry.text)}`
    case 'pr-added': return `linked pull request ${pullLabel(entry.to)}`
    case 'pr-removed': return `removed pull request ${pullLabel(entry.from)}`
    case 'pr-changed': return `changed the pull request from ${pullLabel(entry.from)} to ${pullLabel(entry.to)}`
    default: return 'changed this card'
  }
}

export const activityPath = (boardId, cardId) =>
  `activity/${encodeURIComponent(String(boardId))}/${encodeURIComponent(String(cardId))}.json`

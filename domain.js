export function boardAccess(share, online) {
  if (!share) {
    return {
      canWrite: true,
      status: online ? '' : 'Offline — changes will wait to sync',
    }
  }
  if (!online) {
    return {
      canWrite: false,
      status: 'Reconnecting — shared board is read-only',
    }
  }
  if (share.role === 'viewer') {
    return {
      canWrite: false,
      status: 'View only',
    }
  }
  return { canWrite: true, status: '' }
}

export const invitationKey = invitation => `${invitation.host}:${invitation.id}`

export const COLUMN_COLOR_KEYS = ['red', 'amber', 'green', 'blue', 'purple', 'pink']

// A board can name its label colours ("red" = "Urgent"). Names live on the
// board, so everyone sharing it reads the same meaning; a colour without a
// name still works as a plain colour.
export const MAX_LABEL_NAME_CHARS = 24

export function normalizeLabelNames(value) {
  const names = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return names
  for (const color of COLUMN_COLOR_KEYS) {
    const name = typeof value[color] === 'string' ? value[color].trim().slice(0, MAX_LABEL_NAME_CHARS) : ''
    if (name) names[color] = name
  }
  return names
}

// What a label is called in menus and filters: its board name, else its colour.
export function labelDisplayName(color, labelNames) {
  const name = normalizeLabelNames(labelNames)[color]
  return name || (color ? color.charAt(0).toLocaleUpperCase() + color.slice(1) : '')
}

export function defaultColumnColor(index) {
  if (index === 0) return null
  if (index === 1) return 'blue'
  if (index === 2) return 'green'
  return ['amber', 'purple', 'pink'][Math.max(0, index - 3) % 3]
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isIsoDate(value) {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

function localIsoDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isoDateNumber(value) {
  if (!isIsoDate(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

// ISO dates sort chronologically, so no timezone conversion is needed.
export function dueDateStatus(due, today = new Date()) {
  if (!isIsoDate(due)) return null
  const current = typeof today === 'string' ? today : localIsoDate(today)
  if (!isIsoDate(current)) return null
  if (due < current) return 'overdue'
  if (due === current) return 'today'
  return 'upcoming'
}

// A short, readable name for a link: the site plus the last part of the
// address ("abseil.io/…/ch19.html"), or "repo#123" for GitHub pull requests
// and issues. The full address stays in the link and its tooltip.
export function shortLinkText(href) {
  let url
  try { url = new URL(href) } catch { return href }
  const host = url.hostname.replace(/^www\./u, '')
  const segments = url.pathname.split('/').filter(Boolean)
  if (host === 'github.com' && ['pull', 'issues'].includes(segments[2]) && /^\d+$/u.test(segments[3] || '')) {
    return `${segments[1]}#${segments[3]}`
  }
  if (!segments.length) return host
  let last = segments[segments.length - 1]
  try { last = decodeURIComponent(last) } catch { /* keep the raw segment */ }
  if (last.length > 28) last = `${last.slice(0, 27)}…`
  return segments.length === 1 ? `${host}/${last}` : `${host}/…/${last}`
}

// Cards use compact, date-only copy. Working in UTC after validating the ISO
// parts keeps the result independent of the browser's timezone and DST.
export function formatDueDate(due, today = new Date(), locale) {
  if (!isIsoDate(due)) return ''
  const current = typeof today === 'string' ? today : localIsoDate(today)
  if (!isIsoDate(current)) return ''
  if (due === current) return 'Today'
  if (due < current) {
    const days = Math.round((isoDateNumber(current) - isoDateNumber(due)) / 86400000)
    return `${days}d over`
  }
  const [year, month, day] = due.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function assigneeInitials(name) {
  const words = String(name || '').trim().replace(/^@/u, '').split(/\s+/u).filter(Boolean)
  if (!words.length) return ''
  const first = Array.from(words[0])
  const chars = words.length === 1
    ? first.slice(0, 2)
    : [first[0], Array.from(words[words.length - 1])[0]]
  return chars.filter(Boolean).join('').toLocaleUpperCase()
}

export function assigneeHue(name) {
  let hash = 2166136261
  for (const char of String(name || '').trim().toLocaleLowerCase()) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 360
}

// A high-lightness pastel paired with this fixed ink has comfortably more
// than 4.5:1 contrast for every hue, in both app themes.
export function assigneeAvatar(name) {
  const hue = assigneeHue(name)
  return {
    initials: assigneeInitials(name),
    hue,
    background: `hsl(${hue} 70% 82%)`,
    color: '#172033',
  }
}

const safeChecklist = checklist => Array.isArray(checklist) ? checklist : []

// The list named "Done" holds finished work: completing a card moves it there
// (operations.js complete-card), and it starts folded for each person until
// they open it.
export function isDoneColumn(column) {
  return String(column?.name || '').trim().toLocaleLowerCase() === 'done'
}

// `folded` are lists this person folded; `opened` are lists they opened that
// would otherwise start folded. Both are personal, never shared.
export function listIsFolded(column, { folded, opened }) {
  return folded.has(column.id) || (isDoneColumn(column) && !opened.has(column.id))
}

// "Changed since you looked": each card is reduced to a short fingerprint of
// what a person sees on it (its list, title, description, label, due date,
// person, checklist, pull requests and attachments). A card whose fingerprint
// differs from the one remembered when you last saw it has changed.
function fingerprintHash(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function cardFingerprint(card, columnId) {
  return fingerprintHash(JSON.stringify([
    columnId || '', card?.title || '', card?.notes || '', card?.notesLength ?? null, card?.notesVersion ?? null,
    card?.label || 'none', card?.due || '', card?.assignee || '', card?.assigneeHost || '',
    (card?.checklist || []).map(item => [item?.id, item?.text, item?.done === true]),
    card?.pullRequestUrls || [], (card?.attachments || []).map(item => item?.id),
  ]))
}

// Fingerprints of every card on the board, keyed by card id.
export function boardFingerprints(board) {
  const prints = {}
  for (const column of board?.columns || []) {
    for (const id of column.cardIds || []) {
      if (board.cards?.[id]) prints[id] = cardFingerprint(board.cards[id], column.id)
    }
  }
  return prints
}

// Cards that are new or different since `seen` was remembered. Without a
// remembered state nothing counts as changed: the first visit is the baseline.
export function changedCardIds(board, seen) {
  if (!seen || typeof seen !== 'object') return new Set()
  const prints = boardFingerprints(board)
  return new Set(Object.keys(prints).filter(id => seen[id] !== prints[id]))
}

export function checklistProgress(checklist) {
  const items = safeChecklist(checklist)
  const total = items.length
  const done = items.reduce((count, item) => count + (item?.done === true ? 1 : 0), 0)
  return { done, total, percent: total ? (done / total) * 100 : 0 }
}

export function addChecklistItem(checklist, item) {
  const text = typeof item?.text === 'string' ? item.text.trim() : ''
  if (!text || typeof item?.id !== 'string' || !item.id) return safeChecklist(checklist).slice()
  return [...safeChecklist(checklist), { ...item, text, done: item.done === true }]
}

export function toggleChecklistItem(checklist, itemId) {
  return safeChecklist(checklist).map(item =>
    item && item.id === itemId ? { ...item, done: item.done !== true } : item,
  )
}

export function deleteChecklistItem(checklist, itemId) {
  return safeChecklist(checklist).filter(item => !item || item.id !== itemId)
}

// `assigneeLabel` is the name the board shows for the card's owner (for example
// a verified @handle), so text search finds people the way they appear.
export function cardMatchesFilters(card, text = '', labels = [], assigneeLabel = '') {
  if (!card || typeof card !== 'object') return false
  const query = String(text || '').trim().toLocaleLowerCase()
  if (query) {
    const haystack = [card.title, card.notes, card.assignee, assigneeLabel]
      .filter(value => typeof value === 'string' && value)
      .join('\n')
      .toLocaleLowerCase()
    if (!haystack.includes(query)) return false
  }
  const activeLabels = Array.isArray(labels) ? labels : []
  if (activeLabels.length && !activeLabels.includes(card.label || 'none')) return false
  return true
}

// Translate a drop position among rendered cards to an insertion position in
// the complete list. The returned index is relative to the list after the
// moving card has been removed, matching move-card operation semantics.
export function visibleToFullIndex(fullCardIds, visibleCardIds, visibleIndex, movingCardId) {
  const full = (Array.isArray(fullCardIds) ? fullCardIds : []).filter(id => id !== movingCardId)
  const visible = (Array.isArray(visibleCardIds) ? visibleCardIds : [])
    .filter(id => id !== movingCardId && full.includes(id))
  const index = Math.max(0, Math.min(Number.isFinite(visibleIndex) ? visibleIndex : visible.length, visible.length))
  if (!visible.length) return full.length
  if (index < visible.length) return full.indexOf(visible[index])
  return full.indexOf(visible[visible.length - 1]) + 1
}

export function swapColumns(columns, columnId, offset) {
  const next = Array.isArray(columns) ? columns.slice() : []
  const from = next.findIndex(column => column?.id === columnId)
  const to = from + (offset < 0 ? -1 : offset > 0 ? 1 : 0)
  if (from < 0 || to < 0 || to >= next.length || to === from) return next
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

// Assignment identity comes from a host, never a shared display name.
// A stale hostname-only member must not erase a handle saved on the card.
export function cardAssigneeLabel(card, members = []) {
  const saved = String(card?.assignee || '').trim()
  const host = String(card?.assigneeHost || '').trim() || saved
  const member = members.find(item => item.host === host || item.hosts?.includes(host))
  const handle = String(member?.handle || '').trim().replace(/^@/u, '')
  if (handle) return `@${handle}`
  const name = String(member?.name || '').trim()
  if (name.startsWith('@')) return name
  if (saved.startsWith('@')) return saved
  return name || saved
}

// A shared board's host refuses a document larger than this (MAX_DOC in
// collaboration/service.py), and every edit resends the whole document.
export const SHARED_BOARD_LIMIT_BYTES = 256 * 1024
// From this share of the limit the board warns that it is nearly full.
export const BOARD_NEARLY_FULL_SHARE = 0.95

// The size the host measures: Python's json.dumps defaults, i.e. ", " and
// ": " separators and every non-ASCII character escaped as \uXXXX (two
// escapes for characters outside the Basic Multilingual Plane).
export function hostDocumentBytes(value) {
  if (value === null || value === undefined) return 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4
  if (typeof value === 'string') {
    let bytes = 2
    for (const char of value) {
      const code = char.codePointAt(0)
      if (code > 0xffff) bytes += 12
      else if (code > 0x7e) bytes += 6
      else if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) bytes += 2
      else if (code < 0x20) bytes += 6
      else bytes += 1
    }
    return bytes
  }
  if (Array.isArray(value)) {
    if (!value.length) return 2
    return 2 + value.reduce((sum, item) => sum + hostDocumentBytes(item), 0) + (value.length - 1) * 2
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  if (!entries.length) return 2
  return 2 + entries.reduce((sum, [key, item]) => sum + hostDocumentBytes(key) + 2 + hostDocumentBytes(item), 0) + (entries.length - 1) * 2
}

// A shared board's host also stores at most this many attachment files, and
// this many bytes of them (collaboration/service.py, asset-write).
export const SHARED_BOARD_FILE_LIMIT = 100
export const SHARED_BOARD_FILE_BYTES = 100 * 1024 * 1024

// Text and files fill up separately; whichever is closer to its limit decides.
export function boardCapacity(doc) {
  const bytes = hostDocumentBytes(doc)
  const files = Object.values(doc?.cards || {}).flatMap(card => (Array.isArray(card?.attachments) ? card.attachments : []))
  const fileBytes = files.reduce((sum, file) => sum + (Number.isFinite(file?.size) ? file.size : 0), 0)
  const share = bytes / SHARED_BOARD_LIMIT_BYTES
  const fileShare = Math.max(files.length / SHARED_BOARD_FILE_LIMIT, fileBytes / SHARED_BOARD_FILE_BYTES)
  return {
    bytes, limit: SHARED_BOARD_LIMIT_BYTES, share, nearlyFull: share >= BOARD_NEARLY_FULL_SHARE,
    files: files.length, fileLimit: SHARED_BOARD_FILE_LIMIT, fileBytes, fileShare,
    filesNearlyFull: fileShare >= BOARD_NEARLY_FULL_SHARE,
  }
}

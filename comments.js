// Card comments: what people said about a card, who said it, and when.
//
// Comments are handled like a long description (activity.js): they live
// beside the board, never on the capped board document — on the hosting
// Kanban service for shared boards (in the same card record as the
// description and activity, collaboration/service.py) and in app storage for
// private boards. The board card only carries `commentsCount`, so a new
// comment moves the board version on and every member's poll notices the
// card changed.
//
// On a shared board the writer sends only its comment id and text; the host
// stamps the author, the time and `via`, and records the matching
// 'commented' activity in the same transaction. Keep the limits here in step
// with collaboration/service.py.

export const MAX_COMMENT_CHARS = 2000
export const MAX_COMMENTS_PER_CARD = 200

const ID = /^[A-Za-z0-9_-]{1,64}$/u
const clip = value => typeof value === 'string' ? value.trim() : ''

export function normalizeComment(comment) {
  if (!comment || typeof comment !== 'object' || !ID.test(String(comment.id || ''))) return null
  if (typeof comment.at !== 'string' || Number.isNaN(Date.parse(comment.at))) return null
  const text = clip(comment.text)
  if (!text) return null
  const normalized = { id: comment.id, at: comment.at, text: text.slice(0, MAX_COMMENT_CHARS) }
  if (comment.via === 'agent') normalized.via = 'agent'
  // A private board's comments carry no author: they are the owner's.
  if (comment.by && typeof comment.by === 'object') {
    const by = { host: clip(comment.by.host), name: clip(comment.by.name) }
    if (by.host || by.name) normalized.by = by
  }
  return normalized
}

// Union by id, oldest first, keeping the newest MAX_COMMENTS_PER_CARD.
export function mergeComments(existing, incoming, limit = MAX_COMMENTS_PER_CARD) {
  const merged = new Map()
  for (const comment of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const normalized = normalizeComment(comment)
    if (normalized && !merged.has(normalized.id)) merged.set(normalized.id, normalized)
  }
  return [...merged.values()]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(-limit)
}

export const commentsPrefix = boardId => `comments/${encodeURIComponent(String(boardId))}/`
export const commentsPath = (boardId, cardId) => `${commentsPrefix(boardId)}${encodeURIComponent(String(cardId))}.json`

// ---- @mentions ----

// The @ being typed at the caret: `{start, query}` (start is the @'s index,
// query the text after it), or null when the caret is not completing one. An
// @ inside a word (an email address) never starts a mention, and a query stops
// being one at a newline or a second @ — a member picker should close then.
export function mentionQuery(text, caret) {
  const upto = String(text || '').slice(0, Math.max(0, caret))
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/u.test(upto[at - 1])) return null
  const query = upto.slice(at + 1)
  if (query.length > 60 || /[\n@]/u.test(query)) return null
  return { start: at, query }
}

// Split a comment into plain text and `{mention}` parts. A mention is an @ at
// the start of a word: a known member label matches first (longest first, so
// names with spaces work), any other @word still reads as a mention.
export function mentionParts(text, labels = []) {
  const source = String(text || '')
  const known = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length)
  const parts = []
  let plain = ''
  let i = 0
  while (i < source.length) {
    if (source[i] === '@' && (i === 0 || /\s/u.test(source[i - 1]))) {
      const rest = source.slice(i + 1)
      const label = known.find(candidate => rest.toLowerCase().startsWith(candidate.toLowerCase()))
        || (rest.match(/^[\p{L}\p{N}._-]+/u) || [])[0]
      if (label) {
        if (plain) { parts.push({ text: plain }); plain = '' }
        parts.push({ mention: `@${rest.slice(0, label.length)}` })
        i += 1 + label.length
        continue
      }
    }
    plain += source[i]
    i += 1
  }
  if (plain) parts.push({ text: plain })
  return parts
}

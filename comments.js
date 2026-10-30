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

export const COMMENT_ID = /^[A-Za-z0-9_-]{1,64}$/u
const clip = value => typeof value === 'string' ? value.trim() : ''

// One id per composed comment, allocated before the first attempt and kept
// through retries until a save is confirmed (boardRepository.addComment).
export const newCommentId = () =>
  `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export function normalizeComment(comment) {
  if (!comment || typeof comment !== 'object' || !COMMENT_ID.test(String(comment.id || ''))) return null
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

// A private board's comments for the cards in `doc`, as `{cardId: [comment]}`,
// for the publication handoff: sharing moves them onto the host together
// with the board (sync.js shareBoard), so the thread survives the switch.
export async function privateBoardComments(storage, boardId, doc) {
  const items = await storage.list(commentsPrefix(boardId))
  const byCard = {}
  await Promise.all((Array.isArray(items) ? items : []).map(async item => {
    if (!item?.name?.endsWith('.json')) return
    const cardId = decodeURIComponent(item.name.slice(0, -5))
    if (!Object.hasOwn(doc.cards || {}, cardId)) return
    const { value } = await storage.getWithVersion(commentsPath(boardId, cardId))
    const comments = mergeComments(value?.comments, [])
    if (comments.length) byCard[cardId] = comments
  }))
  return byCard
}

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
// A known label is a mention only as a whole token: "@sam" is not inside
// "@samuel" or "@sam-team", though punctuation may end it ("@sam." / "@sam,").
const TOKEN_CONTINUES = /^(?:[\p{L}\p{N}_-]|\.[\p{L}\p{N}])/u

export function mentionParts(text, labels = []) {
  const source = String(text || '')
  const known = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length)
  const parts = []
  let plain = ''
  let i = 0
  while (i < source.length) {
    if (source[i] === '@' && (i === 0 || /\s/u.test(source[i - 1]))) {
      const rest = source.slice(i + 1)
      const label = known.find(candidate => rest.toLowerCase().startsWith(candidate.toLowerCase())
        && !TOKEN_CONTINUES.test(rest.slice(candidate.length)))
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

// The board members a comment names, by member id, for the host to notify:
// each `@label` of a known member counts once, whatever its case, and a person
// linked through several deployments is notified on every one (`memberIds`),
// so one offline deployment never hides the mention from the others. The host
// accepts at most MAX_MENTIONS and checks every id against the board itself.
export const MAX_MENTIONS = 20
export function mentionedMemberIds(text, mentionables = []) {
  const named = new Set(mentionParts(text, mentionables.map(member => member.label))
    .filter(part => part.mention).map(part => part.mention.slice(1).toLowerCase()))
  const ids = mentionables.filter(member => named.has(String(member.label).toLowerCase()))
    .flatMap(member => member.memberIds || [])
  return [...new Set(ids)].slice(0, MAX_MENTIONS)
}

// Whether a mention token (`@label`) names this person.
export const mentionNames = (mention, label) => Boolean(label) && mention.slice(1).toLowerCase() === String(label).replace(/^@/u, '').toLowerCase()

// A mention notification's app intent, `mention:<board oid>:<card id>`.
const MENTION_INTENT = /^mention:([a-f0-9]{32}):([A-Za-z0-9_-]{1,80})$/u
export function parseMentionIntent(intent) {
  const match = MENTION_INTENT.exec(String(intent || ''))
  return match ? { oid: match[1], cardId: match[2] } : null
}

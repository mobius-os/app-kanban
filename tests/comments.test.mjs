// Card comments: stored beside the board like a long description, recorded in
// the card's activity, shown in the card's own Comments tab.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createBoardRepository } from '../boardRepository.js'
import { configureSync, shareBoard } from '../sync.js'
import { MAX_COMMENT_CHARS, MAX_COMMENTS_PER_CARD, commentsPath, mentionParts, mentionQuery, mergeComments, newCommentId, normalizeComment } from '../comments.js'
import { describeActivity, formatActivityDay, formatActivityTime, groupByDay } from '../activity.js'

const comment = (id, at, text = 'Hello', extra = {}) => ({ id, at, text, ...extra })

test('normalizeComment keeps the author and agent mark, drops empty or malformed comments', () => {
  const kept = normalizeComment(comment('c1', '2026-10-09T08:00:00Z', ' Hi ', { by: { host: 'a.example', name: 'A' }, via: 'agent' }))
  assert.deepEqual(kept, { id: 'c1', at: '2026-10-09T08:00:00Z', text: 'Hi', via: 'agent', by: { host: 'a.example', name: 'A' } })
  // A private board's comments carry no author: they are the owner's.
  assert.equal(normalizeComment(comment('c2', '2026-10-09T08:00:00Z')).by, undefined)
  assert.equal(normalizeComment(comment('c3', '2026-10-09T08:00:00Z', '   ')), null)
  assert.equal(normalizeComment(comment('bad id!', '2026-10-09T08:00:00Z')), null)
  assert.equal(normalizeComment(comment('c4', 'not a time')), null)
})

test('mergeComments unions by id, oldest first, keeping the newest at the cap', () => {
  const merged = mergeComments(
    [comment('b', '2026-10-09T09:00:00Z'), comment('a', '2026-10-09T08:00:00Z')],
    [comment('b', '2026-10-09T09:00:00Z', 'duplicate is ignored'), comment('c', '2026-10-09T10:00:00Z')],
  )
  assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'c'])
  assert.equal(merged[1].text, 'Hello')
  const over = mergeComments([], Array.from({ length: 5 }, (_, i) => comment(`c${i}`, `2026-10-09T0${i + 1}:00:00Z`)), 3)
  assert.deepEqual(over.map(item => item.id), ['c2', 'c3', 'c4'])
})

test('a commented activity entry reads as the comment', () => {
  assert.equal(describeActivity({ type: 'commented', text: 'Looks good' }), 'commented: “Looks good”')
  assert.equal(describeActivity({ type: 'commented' }), 'commented')
})

// ---- @mentions ----

test('an @ completes a mention only at the start of a word, and stops at a newline or second @', () => {
  assert.deepEqual(mentionQuery('hi @ha', 6), { start: 3, query: 'ha' })
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
  // The query ends at the caret: text after it never filters the picker.
  assert.deepEqual(mentionQuery('@ha later', 3), { start: 0, query: 'ha' })
  assert.equal(mentionQuery('mail me a@b.example', 10), null, 'an email @ is not a mention')
  assert.equal(mentionQuery('@ha\nnew line', 8), null)
  assert.equal(mentionQuery('no at here', 5), null)
})

test('mention text highlights known labels first, longest first, so names with spaces stay whole', () => {
  const labels = ['Hamza', 'Hamza Dva']
  assert.deepEqual(mentionParts('ping @Hamza Dva and @hamza now', labels), [
    { text: 'ping ' }, { mention: '@Hamza Dva' }, { text: ' and ' }, { mention: '@hamza' }, { text: ' now' },
  ])
  // Any other @word still reads as a mention; an email address does not.
  assert.deepEqual(mentionParts('cc @edin at a@b.example', []), [
    { text: 'cc ' }, { mention: '@edin' }, { text: ' at a@b.example' },
  ])
})

// ---- private boards: comments live in app storage beside the activity ----

function privateFixture() {
  const docs = new Map()
  docs.set('boards/b.json', { v: 1, title: 'Board', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }],
    cards: { c1: { id: 'c1', title: 'Card' } } })
  let versions = 0
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      const value = docs.get(path)
      return { value: value ? structuredClone(value) : null, version: value ? `v${versions}` : null }
    },
    async durableWrite(path, doc) { docs.set(path, structuredClone(doc)); versions++ },
    async set(path, doc) { docs.set(path, structuredClone(doc)) },
    async remove(path) { docs.delete(path) },
    async list() { return [{ name: 'b.json' }] },
  }
  return { storage, docs }
}

test('a private comment is saved beside the board and recorded in the card activity', async () => {
  const f = privateFixture()
  const repo = createBoardRepository(f)
  const result = await repo.addComment('b', 'c1', '  First thought  ')
  assert.equal(result.status, 'saved')
  assert.equal(result.comments.length, 1)
  assert.equal(result.comments[0].text, 'First thought')
  assert.equal(result.comments[0].by, undefined)
  assert.ok(!Number.isNaN(Date.parse(result.comments[0].at)))
  assert.equal(result.activity.at(-1).type, 'commented')
  assert.equal(result.activity.at(-1).text, 'First thought')
  const details = await repo.readCard('b', 'c1')
  assert.equal(details.comments.length, 1)
  assert.equal(details.activity.at(-1).type, 'commented')
})

test('an agent comment on a private board is marked as the agent’s', async () => {
  const f = privateFixture()
  const repo = createBoardRepository({ ...f, via: 'agent' })
  const result = await repo.addComment('b', 'c1', 'From the helper')
  assert.equal(result.comments[0].via, 'agent')
  assert.equal(result.activity.at(-1).via, 'agent')
})

test('a comment needs text, a saved card, and room under the cap', async () => {
  const f = privateFixture()
  const repo = createBoardRepository(f)
  await assert.rejects(repo.addComment('b', 'c1', '   '), error => error.code === 'invalid-comment')
  await assert.rejects(repo.addComment('b', 'c1', 'x'.repeat(MAX_COMMENT_CHARS + 1)), error => error.code === 'comment-too-long')
  await assert.rejects(repo.addComment('b', 'gone', 'Hi'), error => error.code === 'missing-card')
  f.docs.set(commentsPath('b', 'c1'), { v: 1,
    comments: Array.from({ length: MAX_COMMENTS_PER_CARD }, (_, i) => comment(`c${i}`, '2026-10-09T08:00:00Z')) })
  await assert.rejects(repo.addComment('b', 'c1', 'One too many'), error => error.code === 'comments-full')
})

test('deleting a private card takes its comments with it', async () => {
  const f = privateFixture()
  const repo = createBoardRepository(f)
  await repo.addComment('b', 'c1', 'Soon gone')
  assert.ok(f.docs.has(commentsPath('b', 'c1')))
  await repo.mutate('b', { type: 'delete-card', cardId: 'c1' })
  assert.ok(!f.docs.has(commentsPath('b', 'c1')))
})

// ---- shared boards: the host owns stamping, counting, and the activity ----

test('a shared comment posts to the host and adopts its stamped copy and count', async () => {
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'object', role: 'editor' }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: { b: entry } }, version: 'map' }
      return { value: null, version: null }
    },
    async set() {}, async durableWrite() {}, async list() { return [] },
  }
  const posts = []
  const request = async (path, options = {}) => {
    posts.push({ path, body: options.body ? JSON.parse(options.body) : null })
    const stamped = { id: posts.at(-1).body.id, at: '2026-10-09T08:00:00.000Z', text: posts.at(-1).body.text,
      by: { host: 'b.example', name: 'B' } }
    return Response.json({ status: 'ok', comment: stamped, comments: [stamped], version: 7,
      card: { id: 'c1', title: 'Card', commentsCount: 1 },
      activity: [{ id: 'a1', at: stamped.at, type: 'commented', text: stamped.text, by: stamped.by }] })
  }
  const repo = createBoardRepository({ storage, request })
  const result = await repo.addComment('b', 'c1', 'Over the wire')
  assert.match(posts[0].path, /\/cards\/c1\/comments$/)
  assert.equal(posts[0].body.text, 'Over the wire')
  assert.equal(result.status, 'saved')
  assert.equal(result.comments[0].by.host, 'b.example')
  assert.equal(result.card.commentsCount, 1)
  assert.equal(result.activity.at(-1).type, 'commented')
})

// The review's reproduction: the host commits, the reply is lost, the person
// presses Comment again. The retry carries the same id, so it is answered
// from the first save instead of becoming a second comment — even when the
// repository is created afresh for the retry, as the card sheet does.
test('retrying a comment whose reply was lost saves it once', async () => {
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'object', role: 'editor' }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: { b: entry } }, version: 'map' }
      return { value: null, version: null }
    },
    async set() {}, async durableWrite() {}, async list() { return [] },
  }
  const thread = []
  let loseReply = true
  const request = async (path, options = {}) => {
    const { id, text } = JSON.parse(options.body)
    if (!thread.some(comment => comment.id === id)) {
      thread.push({ id, text, at: new Date(Date.UTC(2026, 9, 9, 8, thread.length)).toISOString(), by: { host: 'b.example', name: 'B' } })
    }
    if (loseReply) { loseReply = false; throw new TypeError('network connection lost') }
    return Response.json({ status: 'ok', comments: thread, version: 2, card: { id: 'c1', commentsCount: thread.length } })
  }
  const id = newCommentId()
  await assert.rejects(createBoardRepository({ storage, request }).addComment('b', 'c1', 'Once only', { id }))
  const retried = await createBoardRepository({ storage, request }).addComment('b', 'c1', 'Once only', { id })
  assert.equal(thread.length, 1)
  assert.equal(retried.comments.length, 1)
  assert.equal(retried.card.commentsCount, 1)
})

test('a retried private comment keeps one comment and one activity line', async () => {
  const f = privateFixture()
  const repo = createBoardRepository(f)
  const id = newCommentId()
  await repo.addComment('b', 'c1', 'Once only', { id })
  const again = await repo.addComment('b', 'c1', 'Once only', { id })
  assert.equal(again.comments.length, 1)
  const details = await repo.readCard('b', 'c1')
  assert.equal(details.comments.length, 1)
  assert.equal(details.activity.filter(entry => entry.type === 'commented').length, 1)
})

test('the composer keeps one id per composed comment until the save is confirmed', async () => {
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const section = parts.slice(parts.indexOf('export function CardComments'), parts.indexOf('// ---- activity ----'))
  assert.match(section, /if \(submissionRef\.current\?\.text !== text\) submissionRef\.current = \{ id: newCommentId\(\), text \}/,
    'the same text retries with the same id; an edited draft is a new comment')
  assert.ok(section.indexOf('if (saved === false) return') < section.indexOf('submissionRef.current = null'),
    'a failed attempt keeps the id for the retry')
})

// The review's second reproduction: comments written while a board was
// private must reach the host when it is shared, not stay behind locally.
test('sharing a private board sends its comments with the board', async () => {
  configureSync('test-token', 1)
  const files = {
    'boards/local.json': { v: 1, title: 'Fixture', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: { id: 'c1', title: 'Card' } } },
    [commentsPath('local', 'c1')]: { v: 1, comments: [comment('k1', '2026-10-09T08:00:00Z', 'Written while private')] },
    // A card no longer on the board brings nothing.
    [commentsPath('local', 'gone')]: { v: 1, comments: [comment('k2', '2026-10-09T08:00:00Z', 'Orphan')] },
  }
  globalThis.window = { mobius: { storage: {
    async get(path) { return structuredClone(files[path] || null) },
    async getWithVersion(path) { return { value: structuredClone(files[path] || null), version: files[path] ? 'v1' : null } },
    async durableWrite(path, value) { files[path] = structuredClone(value) },
    async list(prefix) { return Object.keys(files).filter(path => path.startsWith(prefix)).map(path => ({ name: path.slice(prefix.length) })) },
  } } }
  let published = null
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/health')) return Response.json({ protocol: 'kanban/1', host: 'me.example' })
    published = JSON.parse(options.body)
    return Response.json({ id: published.id, host: 'me.example', version: 1 })
  }
  try {
    await shareBoard('local')
  } finally {
    delete globalThis.window
    delete globalThis.fetch
  }
  assert.deepEqual(Object.keys(published.comments), ['c1'])
  assert.deepEqual(published.comments.c1.map(item => [item.id, item.text]), [['k1', 'Written while private']])
})

test('a host without comments reads as unsupported, never as a failed save', async () => {
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'object', role: 'editor' }
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: { b: entry } }, version: 'map' }
      return { value: null, version: null }
    },
    async set() {}, async durableWrite() {}, async list() { return [] },
  }
  const request = async () => Response.json({ protocol: 'kanban/1', code: 'invalid-operation', detail: 'Unsupported board operation.' }, { status: 400 })
  const repo = createBoardRepository({ storage, request })
  assert.equal((await repo.addComment('b', 'c1', 'Hi')).status, 'unsupported')
})

// ---- the card sheet: Home | Comments | Activity tabs; one save control ----

test('a saved card has Home, Comments and Activity tabs; Comments fill the tab, Enter posts, Shift+Enter breaks lines', async () => {
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const theme = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(parts, /const CARD_TABS = \[\['home', 'Home'\], \['comments', 'Comments'\], \['activity', 'Activity'\]\]/)
  assert.match(parts, /role="tablist"[\s\S]{0,400}role="tab"[\s\S]{0,200}aria-selected=\{tab === id\}/, 'a real tab list')
  assert.match(board, /\{!isDraftCard && <CardTabs tab=\{cardTab\}/, 'a card still being created has no tabs')
  assert.match(board, /setCardTab\('home'\) \}, \[openCardId\]\)/, 'every card opens on Home, even from a notification')
  assert.match(board, /hidden: cardTab !== id/, 'hidden panels stay mounted, so a draft comment survives a tab switch')
  assert.match(board, /active=\{cardTab === 'comments'\}/, 'the newest comment is scrolled into view when the tab opens')
  const section = parts.slice(parts.indexOf('export function CardComments'), parts.indexOf('function CommentRow'))
  assert.doesNotMatch(section, /FoldingSection/, 'comments no longer fold')
  assert.match(section, /if \(active && scroller\) scroller\.scrollTop = scroller\.scrollHeight/)
  assert.match(section, /event\.key !== 'Enter' \|\| event\.shiftKey/, 'Enter posts; Shift+Enter makes a new line')
  assert.match(theme, /\.kb-card-sheet\.is-tabbed \{ height: [^;]+; overflow: hidden;/, 'one fixed height, so switching tabs never resizes the card')
  assert.match(theme, /\.kb-comments-window \{ flex: 1 1 auto;[^}]*overflow-y: auto/, 'the conversation fills the tab and scrolls')
  assert.match(theme, /\.kb-card-sheet\.is-tabbed > \.kb-card-panel\[hidden\] \{ display: none; \}/, 'a flex panel still hides')
  assert.doesNotMatch(theme, /\.kb-comments-window[^\n]*scrollbar/, 'the app-wide rule already hides the scrollbar')
  // The presence stack's overlap margin must not pull comment or picker
  // avatars outside their (clipping) scroll containers.
  assert.match(theme, /\.kb-comment > \.kb-member-avatar-small \{ margin: 2px 0 0; \}/)
  assert.match(theme, /\.kb-mention-option > \.kb-member-avatar-small \{ margin-left: 0; \}/)
  // Another member's comment bumps the card's count, which re-reads the open card.
  assert.match(board, /openCardNotesKey[\s\S]{0,400}commentsCount/)
})

test('comments and activity are grouped by day, each entry showing only its time', () => {
  const now = new Date(2026, 9, 28, 17, 0)
  const at = (day, hour) => new Date(2026, 9, day, hour, 5).toISOString()
  assert.equal(formatActivityDay(at(28, 9), now), 'Today')
  assert.equal(formatActivityDay(at(27, 23), now), 'Yesterday')
  assert.match(formatActivityDay(at(26, 9), now), /26/)
  assert.equal(formatActivityDay('not a date', now), '')
  assert.match(formatActivityTime(at(28, 9), now), /^Today, /, 'the full time stays available as a tooltip')
  const items = [at(26, 9), at(26, 10), at(28, 9), at(28, 11)].map(time => ({ time }))
  const groups = groupByDay(items, item => item.time, now)
  assert.deepEqual(groups.map(group => [group.day.replace(/.*26.*/, 'Oct 26'), group.items.length]), [['Oct 26', 2], ['Today', 2]])
  assert.deepEqual(groupByDay([], item => item.time, now), [], 'nothing to show is no groups')
})

test('typing @ lists board members above the composer; Enter then picks instead of posting', async () => {
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const section = parts.slice(parts.indexOf('export function CardComments'), parts.indexOf('// ---- activity ----'))
  assert.match(section, /mentionQuery\(target\.value, target\.selectionStart\)/, 'the picker follows the caret')
  assert.match(section, /kb-mention-menu/, 'members list in a popover above the field')
  assert.match(section, /<MemberAvatar member=\{member\} small/, 'the same avatars as the assignee picker')
  assert.ok(section.indexOf("if (picker)") < section.indexOf("if (event.key !== 'Enter' || event.shiftKey) return"),
    'picker keys are handled before Enter posts')
  assert.match(section, /chooseMention\(candidates\[mentionIndex\]/)
  // The card sheet's modal handles Escape in the capture phase, before React;
  // only the inline-editor marker makes Escape close the picker, not the card.
  assert.match(section, /className="kb-comment-field" data-modal-inline-editor=\{picker \? '' : undefined\}/)
  const modal = await readFile(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  assert.match(modal, /closest\?\.\('\[data-modal-inline-editor\]'\)\) return/)
  // Escape's dismissal survives the key-up caret re-read (onSelect) but not a
  // real edit or a posted comment, so the next @ always opens the picker again.
  assert.match(section, /onChange=\{event => \{ setDraft\(event\.target\.value\); setDismissedMention\(null\);/)
  assert.doesNotMatch(section, /onSelect=\{[^}]*setDismissedMention/)
  assert.match(section.slice(section.indexOf('const post = async'), section.indexOf('const query =')), /setDismissedMention\(null\)/)
  // A deployment address is not a name: "@m" must not list someone on mobius-….
  assert.doesNotMatch(section.slice(section.indexOf('const candidates'), section.indexOf('const picker')), /member\.host/)
  assert.match(section, /CommentText text=\{comment\.text\}/, 'bubbles highlight mentions')
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /memberLabel\(member\)\.replace\(\/\^@\/u, ''\)/, 'a handle keeps a single @ when inserted')
})

test('one save control: Save appears for unsaved text, Enter commits by leaving the field', async () => {
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  assert.match(board, /<SaveControl state=\{cardSaveState\} tick=\{savedTick\} \/>/)
  assert.ok(board.indexOf('<SaveControl') < board.indexOf('kb-card-close'), 'the control sits left of the close button')
  assert.doesNotMatch(board, /SavedIndicator/, 'the separate saved flash is absorbed by the control')
  const editor = parts.slice(parts.indexOf('export function InlineCardText'), parts.indexOf('// ---- small shared pieces ----'))
  assert.match(editor, /event\.key === 'Enter' && !event\.shiftKey/, 'Enter saves; Shift+Enter makes a new line')
  assert.match(editor, /event\.currentTarget\.blur\(\)/, 'Enter leaves the field and the blur commits')
  const control = parts.slice(parts.indexOf('export function SaveControl'), parts.indexOf('export function ShowMore'))
  assert.match(control, /state === 'dirty'/)
  assert.match(control, /state === 'saving'/)
  assert.match(control, /Saved/)
})

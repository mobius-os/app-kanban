// Card comments: stored beside the board like a long description, recorded in
// the card's activity, shown folded above Activity with a bounded window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createBoardRepository } from '../boardRepository.js'
import { MAX_COMMENT_CHARS, MAX_COMMENTS_PER_CARD, commentsPath, mergeComments, normalizeComment } from '../comments.js'
import { describeActivity } from '../activity.js'

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

// ---- the card sheet: comments fold above Activity; one save control ----

test('comments fold above Activity with a bounded window, Enter posts, Shift+Enter breaks lines', async () => {
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const theme = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  assert.ok(board.indexOf('<CardComments') < board.indexOf('<CardActivity'), 'comments sit directly above Activity')
  const section = parts.slice(parts.indexOf('export function CardComments'), parts.indexOf('// ---- activity ----'))
  assert.match(section, /<FoldingSection title="Comments"/, 'folded to one line like Activity')
  assert.match(section, /Last comment \$\{lowerFirst\(formatActivityTime\(latest\.at\)\)\} by /)
  assert.match(section, /event\.key !== 'Enter' \|\| event\.shiftKey/, 'Enter posts; Shift+Enter makes a new line')
  assert.match(theme, /\.kb-comments-window \{ max-height: \d+px;[^}]*overflow-y: auto/, 'the window is bounded and scrolls')
  assert.doesNotMatch(theme, /\.kb-comments-window[^\n]*scrollbar/, 'the app-wide rule already hides the scrollbar')
  // Another member's comment bumps the card's count, which re-reads the open card.
  assert.match(board, /openCardNotesKey[\s\S]{0,400}commentsCount/)
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

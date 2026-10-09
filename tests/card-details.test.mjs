import test from 'node:test'
import assert from 'node:assert/strict'
import { configureSync, pushSharedOp } from '../sync.js'
import { createBoardRepository } from '../boardRepository.js'
import { applyBoardOp } from '../operations.js'
import { readFile } from 'node:fs/promises'
import {
  MAX_ACTIVITY_PER_CARD, MAX_NOTES_CHARS, activityPath, describeActivity, describeCardChange, mergeActivity,
} from '../activity.js'

configureSync('fixture', 1)

const card = (extra = {}) => ({ id: 'c1', title: 'Fix login', notes: '', label: 'none', due: '', checklist: [], attachments: [], ...extra })
const snap = (c, column = 'To do') => ({ card: c, column })

test('a card edit is described field by field, from the reader’s point of view', () => {
  const before = card({ checklist: [{ id: 'i1', text: 'Write test', done: false }] })
  const after = card({ title: 'Fix sign-in', notes: 'More detail', label: 'blue', due: '2026-10-14',
    checklist: [{ id: 'i1', text: 'Write test', done: true }, { id: 'i2', text: 'Ship', done: false }],
    attachments: [{ id: 'a1', name: 'trace.png' }], pullRequestUrls: ['https://github.com/o/r/pull/7'] })
  const drafts = describeCardChange({ op: { type: 'update-card' }, before: snap(before), after: snap(after, 'Done') })
  const sentences = drafts.map(describeActivity)
  assert.deepEqual(sentences, [
    'renamed the card from “Fix login” to “Fix sign-in”',
    'edited the description',
    'moved this card from To do to Done',
    'set the label to Blue',
    sentences[4],
    'checked “Write test”',
    'added “Ship” to the checklist',
    'attached “trace.png”',
    'linked pull request #7',
  ])
  assert.match(sentences[4], /^set the due date to /)
})

test('replaying an operation that already landed records no activity', () => {
  const doc = { columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card({ checklist: [{ id: 'i1', text: 'A', done: true }] }) } }
  const before = structuredClone(doc.cards.c1)
  applyBoardOp(doc, { type: 'set-checklist-item', cardId: 'c1', itemId: 'i1', done: true })
  assert.deepEqual(describeCardChange({ op: {}, before: snap(before), after: snap(doc.cards.c1) }), [])
})

test('completing a card is one “marked done” entry, not a list of field changes', () => {
  const drafts = describeCardChange({ op: { type: 'complete-card', summary: 'Shipped' }, before: snap(card()), after: snap(card({ notes: '✅ Done — Shipped' }), 'Done') })
  assert.deepEqual(drafts, [{ type: 'completed', text: 'Shipped' }])
})

test('card activity keeps the newest entries once, oldest first', () => {
  const entry = (id, minute) => ({ id, at: `2026-10-09T08:${String(minute).padStart(2, '0')}:00Z`, type: 'notes' })
  const many = Array.from({ length: MAX_ACTIVITY_PER_CARD + 5 }, (_, i) => entry(`e${i}`, i % 60))
  const merged = mergeActivity(many.slice(0, 50), [...many.slice(40), entry('e0', 0)])
  assert.equal(merged.length, MAX_ACTIVITY_PER_CARD)
  assert.equal(new Set(merged.map(item => item.id)).size, MAX_ACTIVITY_PER_CARD)
  assert.ok(merged.every((item, i) => i === 0 || Date.parse(merged[i - 1].at) <= Date.parse(item.at)))
})

function privateFixture() {
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card() } }
  const files = {}
  const storage = {
    async getWithVersion(path) {
      if (path === 'shared.json') return { value: { byBoard: {} }, version: 'map' }
      if (path.startsWith('activity/')) return { value: files[path] ?? null, version: files[path] ? 'v' : null }
      return { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite(path, value) { if (path.startsWith('activity/')) files[path] = structuredClone(value); else doc = structuredClone(value) },
    async set() {},
    async list() { return [{ name: 'b.json' }] },
  }
  return { storage, files, doc: () => doc }
}

test('a private board keeps each card’s activity beside the board, never inside it', async () => {
  const f = privateFixture()
  const repo = createBoardRepository({ storage: f.storage, via: 'agent' })
  const saved = await repo.mutate('b', { type: 'update-card', cardId: 'c1', patch: { title: 'Renamed' } })
  assert.equal(saved.activity.status, 'saved')
  assert.equal(f.doc().cards.c1.activity, undefined)
  const [entry] = f.files[activityPath('b', 'c1')].entries
  assert.equal(entry.type, 'renamed')
  assert.equal(entry.via, 'agent')
  assert.equal((await repo.readCard('b', 'c1')).activity[0].to, 'Renamed')
})

function sharedFixture({ older = false, notesRefusal = null } = {}) {
  let version = 1
  let doc = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }], cards: { c1: card({ notes: 'Preview…', notesLength: 900 }) } }
  let notes = 'Full description'.repeat(60)
  let notesVersion = 3
  const activity = []
  const calls = []
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }
  const storage = {
    async getWithVersion(path) {
      return path === 'shared.json' ? { value: { byBoard: { b: entry } }, version: 'map' } : { value: structuredClone(doc), version: 'local' }
    },
    async durableWrite() { throw new Error('A shared board must not write its cache as authority.') },
    async set() {},
    async list() { return [{ name: 'b.json' }] },
  }
  const request = async (url, options = {}) => {
    const method = options.method || 'GET'
    calls.push(`${method} ${url.replace('/api/apps/1/service/boards/peer.example/obj', '')}`)
    if (url.includes('/cards/') && older) {
      return Response.json({ protocol: 'kanban/1', code: 'invalid-operation', detail: 'Unsupported board operation.' }, { status: 400 })
    }
    if (url.endsWith('/cards/c1/notes')) {
      if (notesRefusal) return Response.json({ protocol: 'kanban/1', ...notesRefusal.body }, { status: notesRefusal.status })
      const body = JSON.parse(options.body)
      if (body.expected_version !== notesVersion) return Response.json({ status: 'conflict', notes, notes_version: notesVersion })
      notes = body.notes; notesVersion++; version++
      doc.cards.c1 = { ...doc.cards.c1, notes: notes.slice(0, 10) + '…', notesLength: notes.length }
      return Response.json({ status: 'ok', notes_version: notesVersion, version, card: doc.cards.c1 })
    }
    if (url.endsWith('/cards/c1/activity')) {
      activity.push(...JSON.parse(options.body).entries)
      return Response.json({ status: 'ok', activity })
    }
    if (url.endsWith('/cards/c1')) {
      return Response.json({ status: 'ok', notes, notes_version: notesVersion, external: Number.isInteger(doc.cards.c1?.notesLength), activity })
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body)
      if (body.expected_version !== version) return Response.json({ status: 'conflict', doc, version })
      doc = body.doc; version++
      return Response.json({ status: 'ok', version })
    }
    return Response.json({ doc, version })
  }
  return { storage, request, calls, activity, notes: () => notes, doc: () => doc, setNotes: text => { notes = text } }
}

test('opening a shared card reads its full description and activity in one request', async () => {
  const f = sharedFixture()
  const details = await createBoardRepository(f).readCard('b', 'c1')
  assert.equal(details.notes, f.notes())
  assert.equal(details.notesVersion, 3)
  assert.deepEqual(f.calls, ['GET /cards/c1'])
})

test('a shared description save never resends the board and records one activity line', async () => {
  const f = sharedFixture()
  const saved = await createBoardRepository(f).saveNotes('b', 'c1', 'New text', { version: 3, text: f.notes() })
  assert.equal(saved.status, 'saved')
  assert.equal(f.notes(), 'New text')
  assert.ok(!f.calls.some(call => call.startsWith('PUT /state')))
  assert.deepEqual(f.activity.map(item => item.type), ['notes'])
})

test('a description changed by someone else comes back as a conflict, not an overwrite', async () => {
  const f = sharedFixture()
  const before = f.notes()
  const result = await createBoardRepository(f).saveNotes('b', 'c1', 'Mine', { version: 2, text: 'The text I started from' })
  assert.deepEqual(result, { status: 'conflict', notes: before, notesVersion: 3 })
  assert.equal(f.notes(), before)
})

test('an agent completing a shared card appends to the full description, not the preview', async () => {
  const f = sharedFixture()
  f.doc().columns.push({ id: 'done', name: 'Done', cardIds: [] })
  await createBoardRepository(f).mutate('b', { type: 'complete-card', cardId: 'c1', expectedTitle: 'Fix login', summary: 'Shipped', link: '' })
  assert.match(f.notes(), /^Full description[\s\S]*\n\n✅ Done — Shipped$/u)
  assert.deepEqual(f.doc().columns.find(column => column.id === 'done').cardIds, ['c1'])
  assert.deepEqual(f.activity.map(item => item.type), ['completed'])
})

test('a host on an older Kanban still saves descriptions through the board', async () => {
  const f = sharedFixture({ older: true })
  f.doc().cards.c1 = card({ notes: 'Old inline note' })
  const repo = createBoardRepository(f)
  assert.equal((await repo.readCard('b', 'c1')).status, 'unsupported')
  const saved = await repo.saveNotes('b', 'c1', 'Edited inline', { version: 0, text: 'Old inline note' })
  assert.equal(saved.status, 'saved')
  assert.equal(f.doc().cards.c1.notes, 'Edited inline')
  assert.equal(saved.activity.status, 'unsupported')
})

test('an edit made from a preview cannot replace a moved-out description', async () => {
  const f = sharedFixture()
  const before = f.notes()
  await assert.rejects(
    createBoardRepository(f).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Preview… plus a line' } }),
    error => error.code === 'notes-version-required' && error.retryable === false && error.discardable === true,
  )
  assert.equal(f.notes(), before)
  assert.ok(!f.calls.some(call => call.startsWith('PUT /cards/c1/notes')))
})

test('a queued description edit that names an older version goes to recovery, not over newer text', async () => {
  const f = sharedFixture()
  const before = f.notes()
  await assert.rejects(
    createBoardRepository(f).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Mine' }, notesVersion: 2 }),
    error => error.code === 'notes-conflict' && error.discardable === true,
  )
  assert.equal(f.notes(), before)
})

test('a description edit that names the current version replaces the full text', async () => {
  const f = sharedFixture()
  await createBoardRepository(f).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Rewritten' }, notesVersion: 3 })
  assert.equal(f.notes(), 'Rewritten')
})

test('completing a card whose title changed leaves its description untouched', async () => {
  const f = sharedFixture()
  f.doc().columns.push({ id: 'done', name: 'Done', cardIds: [] })
  const before = f.notes()
  await assert.rejects(
    createBoardRepository(f).mutate('b', { type: 'complete-card', cardId: 'c1', expectedTitle: 'Old title', summary: 'Shipped', link: '' }),
    error => error.code === 'card-title-changed',
  )
  assert.equal(f.notes(), before)
  assert.ok(!f.calls.some(call => call.startsWith('PUT /cards/c1/notes')))
})

test('a writer adopts the host copy when the host moves a long description out', async () => {
  const entry = { transport: 'kanban/1', host: 'peer.example', oid: 'obj', role: 'editor' }
  const long = 'x'.repeat(500)
  const settled = { v: 1, title: 'B', columns: [{ id: 'todo', name: 'To do', cardIds: ['c1'] }],
    cards: { c1: card({ notes: `${'x'.repeat(399)}…`, notesLength: 500 }) } }
  const request = async (url, options = {}) => (options.method === 'PUT'
    ? Response.json({ status: 'ok', version: 2, doc: settled })
    : Response.json({ doc: { ...settled, cards: { c1: card({ notes: '' }) } }, version: 1 }))
  const landed = await pushSharedOp(entry, doc => { doc.cards.c1.notes = long; return doc }, null, request)
  assert.equal(landed.version, 2)
  assert.equal(landed.doc.cards.c1.notesLength, 500)
  assert.equal(landed.doc.cards.c1.notes.length, 400)
})

test('a description edit still lands when only our own earlier save moved its version on', async () => {
  const f = sharedFixture()
  const startedFrom = f.notes()
  // Version 2 is stale, but the text is still the text this edit started from.
  const saved = await createBoardRepository(f).saveNotes('b', 'c1', 'Second edit', { version: 2, text: startedFrom })
  assert.equal(saved.status, 'saved')
  assert.equal(f.notes(), 'Second edit')
})

test('a description edit queued while the host was unreachable lands on the text it started from', async () => {
  const f = sharedFixture()
  const startedFrom = f.notes()
  await createBoardRepository(f).mutate('b', {
    type: 'update-card', cardId: 'c1', patch: { notes: 'Written while offline' }, notesVersion: 2, notesBefore: startedFrom,
  })
  assert.equal(f.notes(), 'Written while offline')
})

test('a queued description edit whose starting text was changed by someone else goes to recovery', async () => {
  const f = sharedFixture()
  f.setNotes('Someone else rewrote this')
  await assert.rejects(
    createBoardRepository(f).mutate('b', {
      type: 'update-card', cardId: 'c1', patch: { notes: 'Mine' }, notesVersion: 2, notesBefore: 'The text I started from',
    }),
    error => error.code === 'notes-conflict' && error.discardable === true,
  )
  assert.equal(f.notes(), 'Someone else rewrote this')
})

test('a description save refused for good becomes a final error, while an unreachable host stays retryable', async () => {
  const refused = sharedFixture({ notesRefusal: { status: 403, body: { code: 'read-only', detail: 'This board member is a viewer.' } } })
  await assert.rejects(
    createBoardRepository(refused).mutate('b', { type: 'update-card', cardId: 'c1', patch: { notes: 'Mine' }, notesVersion: 3 }),
    error => error.code === 'read-only' && error.retryable === false && error.discardable === true,
  )
  const unreachable = sharedFixture({ notesRefusal: { status: 502, body: { code: 'authority-unavailable', detail: 'Unreachable.' } } })
  await assert.rejects(
    createBoardRepository(unreachable).saveNotes('b', 'c1', 'Mine', { version: 3, text: unreachable.notes() }),
    error => error.code === 'authority-unavailable' && error.retryable !== false,
  )
})

test('completing a card whose description is at the shared limit moves it without growing the text', async () => {
  const f = sharedFixture()
  f.setNotes('z'.repeat(MAX_NOTES_CHARS + 50))
  f.doc().columns.push({ id: 'done', name: 'Done', cardIds: [] })
  await createBoardRepository(f).mutate('b', { type: 'complete-card', cardId: 'c1', expectedTitle: 'Fix login', summary: 'Shipped', link: '' })
  assert.equal(f.notes().length, MAX_NOTES_CHARS + 50)
  assert.ok(!f.calls.some(call => call.startsWith('PUT /cards/c1/notes')))
  assert.deepEqual(f.doc().columns.find(column => column.id === 'done').cardIds, ['c1'])
  assert.deepEqual(f.activity.map(item => item.type), ['completed'])
})

test('the card sheet keeps a description it could not send and never clears a conflict on a board refresh', async () => {
  const source = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  // An unreachable host queues the edit like any other change instead of dropping it.
  assert.match(source, /if \(isRetryableBoardError\(error\)\) return await keepForLater\(\)/)
  // Only opening another card (or choosing) ends a conflict; the details loader keeps it.
  assert.match(source, /useEffect\(\(\) => \{\s*setNotesConflict\(null\)\s*setNotesError\(''\)\s*\}, \[boardId, openCardId\]\)/)
  assert.equal(source.match(/setNotesConflict\(null\)/g).length, 3)
})

test('the description editor keeps full link text, so a shortened link is never saved back', async () => {
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const editor = parts.slice(parts.indexOf('export function InlineCardText'), parts.indexOf('// ---- small shared pieces ----'))
  assert.ok(editor.includes('innerText'), 'the editor saves the text it shows')
  assert.doesNotMatch(editor, /compactLinks|shortLinkText/)
  const description = parts.slice(parts.indexOf('export function DescriptionSection'), parts.indexOf('// ---- checklist ----'))
  assert.doesNotMatch(description, /compactLinks/)
})

test('on touch screens a checklist bin shows only while that item is being edited', async () => {
  const theme = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const rule = theme.indexOf('.kb-check-item:not(.is-editing) .kb-check-delete { display: none; }')
  assert.ok(rule > 0 && theme.lastIndexOf('@media (hover: none) {', rule) > rule - 120, 'the rule lives in the touch-screen block')
  assert.match(parts, /kb-check-item\$\{editingItem\?\.id === item\.id \? ' is-editing' : ''\}/)
  // Pressing the bin must not blur the item editor first (that would close the edit and hide the bin).
  assert.match(parts, /kb-check-delete"[^>]*onMouseDown=\{event => event\.preventDefault\(\)\}/s)
})

test('an opened picture closes on a tap anywhere outside it, and Escape closes the picture, not the card under it', async () => {
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /const lightboxRef = useModalFocus\(Boolean\(previewAttachment\), \(\) => setPreviewAttachment\(null\)\)/)
  const viewer = board.slice(board.indexOf('className="kb-lightbox"') - 80, board.indexOf('className="kb-lightbox-caption"'))
  assert.match(viewer, /ref=\{lightboxRef\}/)
  assert.match(viewer, /onClick=\{event => \{ if \(!event\.target\.closest\('\.kb-lightbox-image'\)\) setPreviewAttachment\(null\) \}\}/)
})

test('attachments show their first row of files and Show N more like the checklist, and a new file past the row expands the list', async () => {
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const board = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const section = parts.slice(parts.indexOf('export function AttachmentsSection('), parts.indexOf('// ---- activity ----'))
  assert.match(parts, /export const ATTACHMENT_PREVIEW_ITEMS = 3/, 'one row of the three-column grid')
  assert.match(section, /<CardSection title="Attachments"[^>]*meta=\{<span className="kb-section-count">\{count\}<\/span>\}/)
  assert.doesNotMatch(section, /FoldingSection/, 'attachments no longer fold; Activity still does')
  assert.match(section, /attachments\.slice\(0, ATTACHMENT_PREVIEW_ITEMS\)/)
  assert.match(section, /<ShowMore expanded=\{expanded\}[^]*?more=\{`Show \$\{hidden\} more`\} less="Show fewer" \/>/, 'the same control and words as the checklist')
  assert.match(section, /if \(count > shownCount\.current && count > ATTACHMENT_PREVIEW_ITEMS\) setExpanded\(true\)/, 'a file added past the first row is shown, not hidden')
  assert.match(section, /if \(!count\) return <section[^]*kb-section-line[^]*Add attachment/, 'with no files the heading line offers the add action')
  assert.match(board, /<AttachmentsSection\s+key=\{openCard_\.id\}/, 'each card starts with the first row only')
  assert.match(parts, /return <FoldingSection title="Activity"/)
})

test('board cards show the full title, two lines of description, and only their first picture or file', async () => {
  const theme = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const rule = selector => theme.slice(theme.indexOf(`  ${selector} {`), theme.indexOf('}', theme.indexOf(`  ${selector} {`)))
  assert.doesNotMatch(rule('.kb-card-title'), /line-clamp|min-height/, 'a title is never cut or padded to two lines')
  assert.match(rule('.kb-card-notes'), /-webkit-line-clamp: 2/)
  assert.match(rule('.kb-card-picture'), /height: 120px;[^]*object-position: top center/, 'screenshots keep their top')
  const tileAttachment = parts.slice(parts.indexOf('export function CardTileAttachment('), parts.indexOf('export const ATTACHMENT_PREVIEW_ITEMS'))
  assert.match(tileAttachment, /const attachment = attachments\.find\(isPreviewImage\) \|\| attachments\[0\]/, 'the first picture, else the first file')
  assert.match(tileAttachment, /if \(!attachment\) return null/, 'a card without files shows nothing extra')
  assert.equal(tileAttachment.match(/<AttachmentImage/g).length, 1, 'never more than one attachment on the board')
})

test('the pull request heading holds refresh and add, and every button in the section is one size', async () => {
  const theme = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  const parts = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  const section = parts.slice(parts.indexOf('export function PullRequestSection('), parts.indexOf('// ---- attachments ----'))
  const heading = section.slice(section.indexOf('const headingActions'), section.indexOf('return <CardSection'))
  assert.match(heading, /aria-label="Refresh pull request statuses"/)
  assert.match(heading, /aria-label="Add pull request"[^>]*aria-expanded=\{adding\}/)
  assert.doesNotMatch(section, /kb-detail-chip|kb-quiet-action[^>]*>[^<]*<Plus/, 'no separate add row or chip')
  assert.equal(section.match(/className="kb-iconbtn kb-section-icon/g).length, 3, 'refresh, add, and edit share one button class')
  assert.ok(section.indexOf('{adding && form(\'Add\')}') < section.indexOf('{visible.map('), 'the add form opens under the heading')
  assert.match(theme, /\.kb-iconbtn\.kb-section-icon \{[^}]*width: 32px; height: 32px;/)
  assert.match(theme, /\.kb-pr-editor \.kb-input \{[^}]*height: 40px; min-height: 40px;[^}]*border-radius: 10px;/, 'the shared 44px field minimum must not make the link field taller than its buttons')
  assert.match(theme, /\.kb-pr-editor \.kb-btn \{[^}]*height: 40px;[^}]*border-radius: 10px;/)
})

test('Kanban hides scrollbars like the Möbius shell and never styles a scrollbar track', async () => {
  const theme = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(theme, /\* \{ scrollbar-width: none; \}\n\s*\*::-webkit-scrollbar \{ display: none; \}/)
  assert.equal(theme.match(/scrollbar-width/g).length, 1, 'one rule for the whole app')
  assert.doesNotMatch(theme, /scrollbar-color|scrollbar-thumb|scrollbar-track/, 'a styled bar turns into a permanent track on Android')
})

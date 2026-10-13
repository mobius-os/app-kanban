import { configureSync as configureFixture } from '../sync.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { boardAccess } from '../domain.js'
import { applyBoardOp, cardMoveAnchor, hasCardCompletion } from '../operations.js'
import {
  applyPendingBoardOps,
  enqueuePendingBoardOp,
  readPendingBoardOps,
  readRecoveredBoardOps,
  replayPendingBoardOps,
} from '../pendingOps.js'
import { casMutate } from '../storage.js'
import { acceptSharedPoll, cacheSubscriptionIsAuthoritative, rememberSharedState } from '../sync.js'
import { createBoardRepository, replayOutcomeForBoardError } from '../boardRepository.js'

function memoryStorage() {
  const values = new Map()
  return {
    async list(prefix) {
      return [...values.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, content]) => ({ path, name: path.split('/').at(-1), content: structuredClone(content) }))
    },
    async set(path, value) { values.set(path, structuredClone(value)) },
    async durableWrite(path, value) { values.set(path, structuredClone(value)) },
    async remove(path) { values.delete(path) },
  }
}

const boardDoc = () => ({
  v: 1,
  id: 'board',
  title: 'Board',
  createdAt: '2026-01-01T00:00:00.000Z',
  columns: [{ id: 'todo', name: 'To do', color: null, cardIds: ['a'] }],
  cards: {
    a: { id: 'a', title: 'A', notes: '', label: 'none', due: '', checklist: [], assignee: '' },
  },
})

test('a shared snapshot received during a canceled drag renders after the next version-only poll', async () => {
  // Exercise the Board effect itself, with only its IO and timers substituted.
  const source = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const start = source.indexOf('  // Shared boards: poll')
  const end = '}, [share, boardId, loadAttempt, publishAvailability])'
  const effect = source.slice(start, source.indexOf(end, start) + end.length)
  const polls = [
    { version: 1, doc: boardDoc() },
    { version: 2, doc: { ...boardDoc(), title: 'Collaborator edit' } },
    { version: 2 },
  ]
  const timers = []
  const rendered = []
  const share = { host: 'peer.example', oid: 'board', transport: 'kanban/1' }
  const boardRef = { current: null }
  const dragRef = { current: null }
  let cleanup
  const values = {
    useEffect: callback => { cleanup = callback() }, share, boardId: 'board', loadAttempt: 0,
    publishAvailability() {}, lastInteractionAtRef: { current: 0 },
    confirmedSharedRef: { current: null }, pollRenderedRef: { current: null },
    pendingEntriesRef: { current: [] }, pendingRef: { current: 0 },
    replayingRef: { current: false }, dragRef, boardRef,
    window: { mobius: { storage: { set: async () => {} } } },
    boardPath: () => 'boards/board.json',
    appVisible: () => true, onAppVisibilityChange: () => () => {},
    pullShared: async () => polls.shift(), acceptSharedPoll, applyPendingBoardOps,
    createSharedRefreshLifecycle: () => ({
      shouldContinue: () => true,
      refresh: async ({ pull, integrate }) => integrate(await pull()),
    }),
    sharedBoardPollDelay: () => 1,
    setTimeout: callback => { timers.push(callback); return timers.length },
    clearTimeout: () => {},
    setBoard: value => { boardRef.current = value; rendered.push(value.title) },
    setMembers: () => {}, setSyncNote: () => {}, memberRecords: () => null,
  }
  Function(...Object.keys(values), effect)(...Object.values(values))
  const nextPoll = async () => {
    await new Promise(resolve => setImmediate(resolve))
    const timer = timers.shift()
    assert.ok(timer, 'poll scheduled')
    timer()
    await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rendered, ['Board'])
  dragRef.current = { cardId: 'a' }
  await nextPoll()
  assert.deepEqual(rendered, ['Board'], 'drag suppresses rendering without losing confirmation')
  dragRef.current = null // pointer canceled or dropped outside: no board mutation
  await nextPoll()
  assert.deepEqual(rendered, ['Board', 'Collaborator edit'])
  cleanup?.()
})

test.afterEach(() => { delete globalThis.window })

test('the former browser queue migrates into per-operation app storage without losing intent', async () => {
  const appStorage = memoryStorage()
  const legacyValues = new Map([[
    'kanban:pending-board-ops:v1:board',
    JSON.stringify([{ id: 'legacy-1', op: { type: 'rename-board', title: 'Recovered' } }]),
  ]])
  globalThis.window = {
    localStorage: {
      getItem: key => legacyValues.get(key) ?? null,
      removeItem: key => legacyValues.delete(key),
    },
  }

  const migrated = await readPendingBoardOps('board', appStorage)
  assert.deepEqual(migrated, [
    { id: 'legacy-1', op: { type: 'rename-board', title: 'Recovered' } },
  ])
  assert.equal(legacyValues.has('kanban:pending-board-ops:v1:board'), false)
})

test('checklist text edits apply and trim through the shared operation', () => {
  const doc = boardDoc()
  doc.cards.a.checklist = [{ id: 'item', text: 'Old text', done: false }]
  applyBoardOp(doc, { type: 'update-checklist-item', cardId: 'a', itemId: 'item', text: '  New text  ' })
  assert.equal(doc.cards.a.checklist[0].text, 'New text')
})

test('card completion accepts any link, or none, without duplicating notes', () => {
  const doc = boardDoc()
  doc.columns.push({ id: 'done', name: 'Done', color: null, cardIds: [] })
  doc.cards.b = { id: 'b', title: 'B', notes: '', label: 'none', due: '', checklist: [], assignee: '' }
  doc.columns[0].cardIds.push('b')
  const booking = { type: 'complete-card', cardId: 'a', summary: 'Booked the table', link: 'https://example.com/booking/42' }
  applyBoardOp(doc, booking)
  applyBoardOp(doc, booking)
  assert.equal(doc.cards.a.notes.match(/^Link: https:\/\/example\.com\/booking\/42$/gmu).length, 1)
  assert.doesNotMatch(doc.cards.a.notes, /^PR:/mu)
  assert.equal(hasCardCompletion(doc.cards.a.notes, booking.link), true)

  const plain = { type: 'complete-card', cardId: 'b', summary: 'Sent the invitations' }
  applyBoardOp(doc, plain)
  applyBoardOp(doc, plain)
  assert.equal(doc.cards.b.notes, '✅ Done — Sent the invitations')
  assert.equal(hasCardCompletion(doc.cards.b.notes, '', plain.summary), true)
  assert.equal(hasCardCompletion(doc.cards.b.notes, '', 'Something else'), false)
  assert.deepEqual(doc.columns.at(-1).cardIds, ['a', 'b'])
})

test('card completion preserves fresh notes, uses an exact marker, and moves atomically', () => {
  const doc = boardDoc()
  doc.columns.push({ id: 'done', name: 'Done', color: null, cardIds: [] })
  doc.cards.a.notes = [
    'Collaborator note added after discovery',
    'Reference: https://github.com/mobius-os/app-kanban/pull/19',
    '✅ Done — A different change\nPR: https://github.com/mobius-os/app-kanban/pull/190',
  ].join('\n\n')

  const op = {
    type: 'complete-card', cardId: 'a', summary: 'Shipped the exact task',
    prUrl: 'https://github.com/mobius-os/app-kanban/pull/19',
  }
  applyBoardOp(doc, op)
  doc.cards.later = { id: 'later', title: 'Later' }
  doc.columns[1].cardIds.push('later')
  applyBoardOp(doc, op)

  assert.match(doc.cards.a.notes, /Collaborator note added after discovery/)
  assert.equal(doc.cards.a.notes.match(/PR: https:\/\/github\.com\/mobius-os\/app-kanban\/pull\/19$/gmu).length, 1)
  assert.equal(hasCardCompletion(doc.cards.a.notes, op.prUrl), true)
  assert.deepEqual(doc.columns[0].cardIds, [])
  assert.deepEqual(doc.columns[1].cardIds, ['a', 'later'])
})

test('offline reconnect conflict rebases every queued operation or retains an explicit failure', async () => {
  const uiStorage = memoryStorage()
  await enqueuePendingBoardOp('board', {
    type: 'add-card',
    columnId: 'todo',
    card: { id: 'b', title: 'B', notes: '', label: 'none', due: '', checklist: [], assignee: '' },
  }, uiStorage)
  await enqueuePendingBoardOp('board', {
    type: 'update-card', cardId: 'a', patch: { title: 'A edited offline' },
  }, uiStorage)

  let server = boardDoc()
  let version = 1
  let firstWrite = true
  globalThis.window = { mobius: { storage: {
    async getWithVersion() {
      return { value: structuredClone(server), version: `v${version}` }
    },
    async durableWrite(_path, value, options) {
      assert.equal(options.ifMatch, `v${version}`)
      if (firstWrite) {
        firstWrite = false
        server.cards.concurrent = { id: 'concurrent', title: 'Concurrent', due: '', checklist: [], assignee: '' }
        server.columns[0].cardIds.unshift('concurrent')
        version += 1
        throw Object.assign(new Error('conflict'), { code: 'conflict' })
      }
      server = structuredClone(value)
      version += 1
      return { synced: true }
    },
  } } }

  const result = await replayPendingBoardOps(
    'board',
    async op => ({ status: 'landed', doc: await casMutate('board', doc => applyBoardOp(doc, op)) }),
    { storage: uiStorage },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(await readPendingBoardOps('board', uiStorage), [])
  assert.equal(server.cards.a.title, 'A edited offline')
  assert.equal(server.cards.b.title, 'B')
  assert.equal(server.cards.concurrent.title, 'Concurrent')
  assert.deepEqual(server.columns[0].cardIds, ['concurrent', 'a', 'b'])
})

test('terminal queued operations are archived without blocking later changes', async () => {
  const uiStorage = memoryStorage()
  await enqueuePendingBoardOp('board', { type: 'update-card', cardId: 'gone', patch: { title: 'Gone' } }, uiStorage)
  await enqueuePendingBoardOp('board', { type: 'update-card', cardId: 'a', patch: { title: 'Landed' } }, uiStorage)
  const discarded = []
  const result = await replayPendingBoardOps('board', async op => {
    if (op.cardId === 'gone') return { status: 'discarded', error: new Error('Card no longer exists.') }
    const doc = boardDoc()
    applyBoardOp(doc, op)
    return { status: 'landed', doc }
  }, { storage: uiStorage, onDiscarded: error => discarded.push(error.message) })
  assert.equal(result.ok, true)
  assert.equal(result.discarded, 1)
  assert.equal((await readRecoveredBoardOps('board', uiStorage))[0].op.patch.title, 'Gone')
  assert.deepEqual(discarded, ['Card no longer exists.'])
  assert.equal(result.doc.cards.a.title, 'Landed')
  assert.deepEqual(await readPendingBoardOps('board', uiStorage), [])
})

test('malformed authority metadata retains durable queued intent for repair', async () => {
  const queueStorage = memoryStorage()
  const op = { type: 'update-card', cardId: 'a', patch: { title: 'Keep me' } }
  await enqueuePendingBoardOp('board', op, queueStorage)
  const repository = createBoardRepository({ storage: {
    async getWithVersion() { return { value: { byBoard: [] }, version: 'bad-map' } },
  } })
  const result = await replayPendingBoardOps('board', async pending => {
    try {
      return { status: 'landed', doc: (await repository.mutate('board', pending)).doc }
    } catch (error) {
      return replayOutcomeForBoardError(error)
    }
  }, { storage: queueStorage })
  assert.equal(result.ok, false)
  assert.equal(result.pending, 1)
  assert.deepEqual((await readPendingBoardOps('board', queueStorage))[0].op, op)
})

test('shared poll/write/subscription race keeps the versioned poll as sole authority', () => {
  const share = { oid: 'shared', transport: 'kanban/1', host: 'peer.example', role: 'editor' }
  const before = { title: 'Before' }
  const optimistic = { title: 'Optimistic' }
  const newest = { title: 'Authoritative v10' }
  let rendered = optimistic
  let cursor = 9
  let pending = 1

  // A newer poll resolves during the optimistic write. Its cursor advances even
  // though rendering is suppressed until the write settles.
  cursor = 10
  if (pending === 0) rendered = newest
  assert.equal(rendered, optimistic)

  // The shared write fails. The cursor must force a full re-pull, and an older
  // unversioned cache notification is not allowed to replace either authority.
  cursor = rememberSharedState(null, share, null)?.version ?? -1
  rendered = before
  assert.equal(cursor, -1)
  if (cacheSubscriptionIsAuthoritative(share)) rendered = { title: 'Old cache' }
  assert.equal(rendered, before)

  pending = 0
  if (pending === 0) rendered = newest
  assert.deepEqual(rendered, newest)
  assert.equal(cacheSubscriptionIsAuthoritative(null), true)
})

test('component-level viewer and keyboard contract gates writes, reorders, and manages modal focus', async () => {
  const mutationEntries = [
    'add-card', 'update-card', 'add-checklist-item', 'set-checklist-item',
    'delete-checklist-item', 'delete-card', 'move-card', 'add-column',
    'rename-column', 'delete-column', 'move-column', 'rename-board',
  ]
  let writes = 0
  for (const operation of mutationEntries) {
    if (boardAccess({ role: 'viewer' }, true).canWrite) writes += 1
    assert.equal(boardAccess({ role: 'viewer' }, true).canWrite, false, operation)
  }
  assert.equal(writes, 0)

  const doc = boardDoc()
  doc.cards.b = { id: 'b', title: 'B' }
  doc.cards.c = { id: 'c', title: 'C' }
  doc.columns[0].cardIds = ['a', 'b', 'c']
  const upAnchor = cardMoveAnchor(doc.columns[0].cardIds, 'b', -1)
  applyBoardOp(doc, { type: 'move-card', cardId: 'b', toColumnId: 'todo', beforeCardId: upAnchor })
  assert.deepEqual(doc.columns[0].cardIds, ['b', 'a', 'c'])
  applyBoardOp(doc, { type: 'move-card', cardId: 'b', toColumnId: 'todo', beforeCardId: 'vanished' })
  assert.deepEqual(doc.columns[0].cardIds, ['a', 'c', 'b'])

  const boardSource = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const appSource = await readFile(new URL('../index.jsx', import.meta.url), 'utf8')
  const focusSource = await readFile(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  const themeSource = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  const partsSource = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  assert.match(boardSource, /if \(!boardAccess\(entry, onlineRef\.current\)\.canWrite\) return false/)
  const sheetSource = boardSource.slice(boardSource.indexOf('className="kb-card-toolbar"'))
  const inOrder = markers => markers.every((marker, index) => {
    const at = sheetSource.indexOf(marker)
    return at >= 0 && (index === 0 || sheetSource.indexOf(markers[index - 1]) < at)
  })
  const heading = sheetSource.slice(0, sheetSource.indexOf('<CardTitleEditor'))
  assert.match(heading, /isDraftCard \|\| !openCardColumn\s*\? <span className="kb-card-toolbar-title">New card<\/span>/,
    'only a card that is still being created is headed New card')
  assert.match(heading, /<StatusPill columns=\{board\.columns\} columnId=\{openCardColumn\.id\}/,
    'a saved card is headed by a status control showing the list it sits in')
  assert.equal(heading.match(/>New card</g).length, 1, 'New card is never the unconditional heading')
  assert.ok(inOrder(['<StatusPill', 'kb-card-close', '<CardTitleEditor', '<AssigneePicker', '<LabelChip', '<DueChip']),
    'the card header reads status then close; the details row reads assignee, label, then due date')
  assert.ok(inOrder(['<DescriptionSection', '<AttachmentsSection', '<ChecklistSection', '<PullRequestSection', '<CardActivity', 'kb-card-danger-zone']),
    'card sections read description, attachments, checklist, pull request, activity, then delete')
  assert.equal(sheetSource.match(/<AssigneePicker/g).length, 1, 'one assignee control for every screen size')
  assert.equal(sheetSource.match(/<DueChip/g).length, 1, 'one due-date control for every screen size')
  assert.equal(sheetSource.match(/<StatusPill/g).length, 1, 'one status control for every screen size')
  assert.match(boardSource, /className="kb-card-danger-zone"/)
  assert.match(boardSource, /className="kb-title-display kb-editable-field"/)
  assert.match(partsSource, /<LinkifiedText text=\{text\} \/>/)
  assert.match(partsSource, /contentEditable="plaintext-only"/)
  assert.match(partsSource, /role="textbox"[\s\S]*tabIndex=\{0\}/)
  assert.match(partsSource, /document\.activeElement === editorRef\.current[\s\S]*if \(!isFocused && !dirtyRef\.current\) renderText\(savedText\)/)
  assert.match(partsSource, /label="Card description"[\s\S]*links/)
  assert.match(boardSource, /className="kb-card-open"[^\n]*aria-label=/)
  assert.match(partsSource, /event\.key !== 'Escape'[\s\S]*onCancel\?\.\(\)/)
  assert.match(themeSource, /\.kb-notes-display \{[^}]*flex: 0 0 auto;[^}]*max-height: none/)
  assert.match(partsSource, /data-modal-inline-editor/)
  assert.match(boardSource, /setDraftCard\(\{ boardId, columnId: colId, card \}\)/)
  assert.match(boardSource, /if \(!isDraftCard\) return updateCard/)
  assert.doesNotMatch(boardSource, /onCancel=\{\(\) => \{ mutate\(\{ type: 'delete-card'/)
  assert.match(boardSource, /className="kb-btn kb-delete-card"/)
  assert.match(boardSource, /className="kb-iconbtn kb-card-close" aria-label="Close card"/)
  assert.doesNotMatch(heading, />Done</, 'closing a card is not labelled like the Done list')
  assert.doesNotMatch(boardSource, /kb-card-more-heading/)
  assert.doesNotMatch(boardSource, /<h3>Position<\/h3>/, 'cards reorder by drag and drop, not a Position section')
  assert.match(partsSource, /role="menuitemradio"\s*aria-checked=\{column\.id === columnId\}/)
  assert.match(boardSource, /function AssigneePicker/)
  assert.match(boardSource, />Assign to me</)
  assert.match(boardSource, /placeholder=\{share \? 'Search people…' : 'Search or enter a name…'\}/)
  assert.doesNotMatch(boardSource, /<select/)
  assert.match(boardSource, /<BoardPresence members=\{displayMembers\}/)
  assert.match(boardSource, /await onRefreshMembers\?\.\(\)/)
  // Board cards read like the open card: title, the start of the description, one attachment, then details.
  const tile = boardSource.slice(boardSource.indexOf('function Card('), boardSource.indexOf('function memberRecords('))
  assert.ok(['className="kb-card-title"', 'className="kb-card-notes"', '<CardTileAttachment', 'className="kb-card-meta"']
    .every((marker, index, markers) => tile.indexOf(marker) > (index ? tile.indexOf(markers[index - 1]) : -1)),
    'a board card reads title, description, attachment, then the details row')
  assert.match(partsSource, /Add attachment/)
  assert.match(boardSource, /onPaste=\{attachFromPaste\}/)
  assert.match(boardSource, /consumeAttachmentPaste/)
  assert.match(boardSource, /MAX_CARD_ATTACHMENTS/)
  assert.match(boardSource, /loadCardAttachment/)
  assert.match(themeSource, /\.kb-col-status \{[^}]*margin-right: 4px;/s)
  assert.match(appSource, /const INVITATION_POLL_MS = 30_000/)
  assert.match(appSource, /if \(!homeShown \|\| !visible \|\| !online\) return undefined/, 'invitations poll only on a visible, online home view')
  assert.match(focusSource, /event\.key === 'Escape'/)
  assert.match(focusSource, /closest\?\.\('\[data-modal-inline-editor\]'\)/)
  assert.match(focusSource, /event\.key !== 'Tab'/)
  assert.match(focusSource, /if \(!isTopmost\(\)\) return/)
  assert.match(focusSource, /opener\.focus\(\)/)
  assert.match(focusSource, /if \(!dialog\?\.contains\(document\.activeElement\)\) \{/, 'preserve autofocus in new-card editor instead of blurring it to mobile Done')
  assert.match(themeSource, /\.kb-status-pill \{[^}]*min-height: 44px/s)
  assert.match(themeSource, /\.kb-menu-trigger \{ width: 44px; height: 44px; \}/, 'the list menu keeps a 44px touch target on phones')
  assert.match(themeSource, /\.kb-input, \.kb-col-name \{ font-size: 16px; \}/)
  assert.match(themeSource, /\.kb-swatches \{ flex-wrap: nowrap; gap: 4px; overflow-x: auto;/)
  assert.match(themeSource, /\.kb-sheet \{[^}]*top: max\(8px, env\(safe-area-inset-top\)\)/s)
})

test.beforeEach(() => configureFixture('fixture', 1))

test('card-title links open directly and pull-request status stays informational', async () => {
  const boardSource = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const themeSource = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  const storageSource = await readFile(new URL('../storage.js', import.meta.url), 'utf8')
  // The title area may start with the "changed" dot; the title itself stays a linkified title.
  assert.match(boardSource, /className="kb-card-title">[^]{0,200}?<LinkifiedText text=\{card\.title\}/)
  assert.match(boardSource, /if \(!e\.target\.closest\('a'\)\) onDragStart/)
  assert.match(boardSource, /pullRequestStatus\(response\.status/)
  const partsSource = await readFile(new URL('../ui/CardParts.jsx', import.meta.url), 'utf8')
  assert.match(partsSource, /kb-pr-status/)
  assert.match(boardSource, /setPullStatusRefresh/)
  assert.match(partsSource, /function PullRequestSection/)
  assert.match(boardSource, /type: 'edit-pull-request'/)
  assert.match(partsSource, /Add pull request/)
  assert.match(storageSource, /pullRequestUrls/)
  assert.doesNotMatch(boardSource, /moveCard\(card\.id, done\.id, null\)/)
  assert.match(themeSource, /\.kb-pr-line/)
})

test('new cards expose details before a title and keep draft edits in the eventual add', async () => {
  const source = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const sheet = source.slice(source.indexOf('className="kb-card-toolbar"'))
  const draftGate = sheet.indexOf('{!isDraftCard && <>')
  for (const field of ['<DueChip', '<DescriptionSection', '<ChecklistSection', '<PullRequestSection', '<AttachmentsSection']) {
    assert.ok(sheet.indexOf(field) < draftGate, field + ' is visible for drafts')
  }
  assert.match(source, /applyBoardOp\(doc, operation\)/)
  assert.match(source, /card: \{ \.\.\.draftCard.card, title \}/)
  const draft = { columns: [], cards: { draft: { id: 'draft', title: '', checklist: [] } } }
  for (const op of [
    { type: 'update-card', patch: { notes: 'Details first', due: '2026-10-01' } },
    { type: 'add-checklist-item', item: { id: 'item', text: 'First step', done: false } },
    { type: 'set-checklist-item', itemId: 'item', done: true },
    { type: 'edit-pull-request', previousUrl: null, nextUrl: 'https://github.com/example/repo/pull/1' },
  ]) applyBoardOp(draft, { ...op, cardId: 'draft' })
  const board = { columns: [{ id: 'todo', cardIds: [] }], cards: {} }
  applyBoardOp(board, { type: 'add-card', columnId: 'todo', card: { ...draft.cards.draft, title: 'Title last' } })
  assert.equal(board.cards.draft.notes, 'Details first')
  assert.equal(board.cards.draft.due, '2026-10-01')
  assert.equal(board.cards.draft.checklist[0].done, true)
  assert.equal(board.cards.draft.pullRequestUrls.length, 1)
})

test('checklist text editors are not given checkbox dimensions', async () => {
  const source = await readFile(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(source, /\.kb-check-toggle input\[type="checkbox"\] \{ width: 20px/)
  assert.doesNotMatch(source, /\.kb-check-toggle input\s*\{/)
})

test('existing card saves propagate acceptance to native editors', async () => {
  const source = await readFile(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(source, /const updateCard = \(cardId, patch\) => \{\s*return mutateCard\(/)
})

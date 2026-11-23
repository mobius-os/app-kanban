// One frame for every card, a Done button while creating, files on a new card,
// picture-only cards, and the layout fixes that came with them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { canBeUntitled, cardDisplayName, cardMatchesFilters } from '../domain.js'
import { applyBoardOp } from '../operations.js'
import { uploadFilesToCard } from '../attachments.js'
import { CSS } from '../theme.js'

const source = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')
const picture = { id: 'f1', name: 'whiteboard.png', mime: 'image/webp', size: 1200 }

// ---- a card may be only a picture ----

test('a card may go without a title only when a file says what it is', () => {
  assert.equal(canBeUntitled({ title: '', attachments: [picture] }), true)
  assert.equal(canBeUntitled({ title: '', attachments: [] }), false)
  assert.equal(canBeUntitled({ title: '' }), false, 'a card with neither stays refused')
  assert.equal(canBeUntitled(null), false)
})

test('an untitled card goes by its first file, and a card with neither by a plain placeholder', () => {
  assert.equal(cardDisplayName({ title: ' Venue ', attachments: [picture] }), 'Venue', 'a title always wins')
  assert.equal(cardDisplayName({ title: '', attachments: [picture, { name: 'second.png' }] }), 'whiteboard.png')
  assert.equal(cardDisplayName({ title: '   ', attachments: [{ name: '' }] }), 'Untitled card')
  assert.equal(cardDisplayName(undefined), 'Untitled card')
})

test('search finds an untitled card by the name it goes by', () => {
  const card = { title: '', notes: '', attachments: [picture] }
  assert.equal(cardMatchesFilters(card, 'whiteboard'), true)
  assert.equal(cardMatchesFilters(card, 'invoice'), false)
  assert.equal(cardMatchesFilters({ title: 'Venue', attachments: [picture] }, 'whiteboard'), false,
    'a titled card is still found by its title, not by its files')
})

test('a card created by its first file is an ordinary board record', () => {
  const board = { columns: [{ id: 'todo', cardIds: [] }], cards: {} }
  applyBoardOp(board, { type: 'add-card', columnId: 'todo', card: { id: 'c1', title: '', notes: 'chosen first', attachments: [] } })
  applyBoardOp(board, { type: 'attach-file', cardId: 'c1', attachment: picture })
  assert.deepEqual(board.columns[0].cardIds, ['c1'])
  assert.equal(board.cards.c1.title, '')
  assert.equal(board.cards.c1.notes, 'chosen first', 'what was filled in before the file travels with the card')
  assert.equal(board.cards.c1.attachments[0].name, 'whiteboard.png')
})

// A small board with Add card's draft beside it, joined by the real reducer.
// The fake createDraft creates whichever draft is open, without checking which
// one it is, so these tests show that the upload itself re-checks its card.
const uploadBench = () => {
  const board = { columns: [{ id: 'todo', cardIds: [] }], cards: {} }
  const bench = { board, draft: null, discarded: [], created: 0 }
  bench.open = id => { bench.draft = { id, title: '', notes: '', attachments: [] } }
  bench.handlers = cardId => ({
    cardId,
    isSaved: id => Boolean(board.cards[id]),
    isDraft: id => bench.draft?.id === id,
    createDraft: () => {
      if (!bench.draft) return false
      applyBoardOp(board, { type: 'add-card', columnId: 'todo', card: bench.draft })
      bench.draft = null
      bench.created += 1
      return true
    },
    attach: (id, attachment) => Boolean(board.cards[id]) && applyBoardOp(board, { type: 'attach-file', cardId: id, attachment }) !== false,
    discard: async attachment => { bench.discarded.push(attachment.name) },
  })
  return bench
}
const deferredUpload = () => {
  const pending = []
  const upload = file => new Promise(resolve => pending.push(() => resolve({ ...picture, id: file, name: `${file}.png` })))
  return { upload, finish: () => pending.shift()(), started: () => pending.length }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('a new card is created by its file only after the upload, from the draft as it is then', async () => {
  const bench = uploadBench()
  const uploads = deferredUpload()
  bench.open('a')
  const run = uploadFilesToCard({ ...bench.handlers('a'), files: ['first', 'second'], upload: uploads.upload })
  await settle()
  assert.equal(bench.created, 0, 'nothing is on the board while the file uploads, so a refused file leaves no card')
  bench.draft.notes = 'typed during the upload'
  uploads.finish(); await settle()
  uploads.finish()
  assert.deepEqual(await run, { added: ['first.png', 'second.png'], closed: false })
  assert.equal(bench.created, 1, 'two files create one card')
  assert.deepEqual(bench.board.columns[0].cardIds, ['a'])
  assert.equal(bench.board.cards.a.notes, 'typed during the upload', 'edits made while the file uploaded are kept')
  assert.deepEqual(bench.board.cards.a.attachments.map(file => file.name), ['first.png', 'second.png'])
})

test('closing a new card and opening another while its file uploads creates neither and removes the file', async () => {
  const bench = uploadBench()
  const uploads = deferredUpload()
  bench.open('a')
  const run = uploadFilesToCard({ ...bench.handlers('a'), files: ['first', 'second'], upload: uploads.upload })
  await settle()
  bench.draft = null // X on card A
  bench.open('b') // Add card again
  uploads.finish()
  assert.deepEqual(await run, { added: [], closed: true })
  assert.equal(bench.created, 0, 'the empty draft B is not saved in place of A')
  assert.deepEqual(bench.board.cards, {})
  assert.equal(bench.draft.id, 'b', 'the new draft stays open and unsaved')
  assert.deepEqual(bench.discarded, ['first.png'], 'the upload that lost its card is removed')
  assert.equal(uploads.started(), 0, 'the remaining files are not uploaded for a card that is gone')
})

test('a refused card edit removes the uploaded file and says so', async () => {
  const bench = uploadBench()
  bench.open('a')
  const handlers = { ...bench.handlers('a'), createDraft: () => false }
  await assert.rejects(uploadFilesToCard({ ...handlers, files: ['first'], upload: async file => ({ ...picture, name: `${file}.png` }) }),
    /This card cannot be changed right now\./)
  assert.deepEqual(bench.discarded, ['first.png'])
  assert.deepEqual(bench.board.cards, {})
})

test('the open card passes its own id to draft creation, which refuses any other draft', async () => {
  const board = await source('ui/Board.jsx')
  const attach = board.slice(board.indexOf('const attachFiles = async'), board.indexOf('const attachFromInput'))
  assert.match(attach, /uploadFilesToCard\(\{\s*cardId,/)
  assert.match(attach, /createDraft: createDraftCard,/)
  assert.match(attach, /discard: attachment => deleteCardAttachment\(\{ share: shareRef\.current, attachment \}\)/, 'an upload that never joined a card is removed')
  const create = board.slice(board.indexOf('const createDraftCard'), board.indexOf('const mutateCard'))
  assert.match(create, /const createDraftCard = \(cardId, fields = \{\}\) =>/)
  assert.match(create, /draft\.card\.id !== cardId\) return false/, 'a draft that replaced the one being saved is never created by it')
  assert.match(create, /const draft = draftCardRef\.current/, 'the draft is read as it is when it is created')
  assert.match(create, /draftCardRef\.current = null/, 'two files pasted together create one card')
})

test('a blank title is kept only on a card with a file, and a picture card does not grab focus when opened', async () => {
  const board = await source('ui/Board.jsx')
  assert.match(board, /if \(!title && !canBeUntitled\(card\)\) return card\.title \|\| ''/)
  assert.match(board, /autoFocus=\{isNewCard && !openCard_\.title\}/,
    'only a card being created focuses its title; reopening a picture card must not raise the phone keyboard')
  assert.match(board, /aria-label=\{`Open card details: \$\{cardDisplayName\(card\)\}`\}/)
  assert.match(board, /const shownTitle = card\.title \|\| \(attachments\.length \? '' : cardDisplayName\(card\)\)/,
    'a card with a file and no title is shown by its picture alone')
})

// ---- one frame from the moment a card opens, and a way to finish ----

test('a card being created has the saved card’s frame, so saving it moves nothing', async () => {
  const board = await source('ui/Board.jsx')
  const sheet = board.slice(board.indexOf('className="kb-card-toolbar"'))
  assert.doesNotMatch(board, /is-tabbed/, 'there is one card frame, not a tabbed one and a draft one')
  assert.match(board, /\(isDraftCard \? column\.id === draftCard\.columnId : column\.cardIds\.includes\(openCard_\.id\)\)/,
    'a new card shows the list whose Add card was pressed')
  assert.match(board, /isDraftCard\s*\? setDraftCard\(current => \(\{ \.\.\.current, columnId \}\)\)\s*: moveCard\(openCard_\.id, columnId, null\)/,
    'choosing another list on a new card changes where it will be created')
  assert.match(sheet, /status=\{openDetailsStatus\}[\s\S]*canWrite=\{access\.canWrite && !isDraftCard\}/, 'nobody can comment on a card that is not on the board yet')
  assert.match(board, /const openDetailsStatus = isDraftCard \? 'ok' :/, 'a card not yet saved has nothing to load')
})

test('Done shows only while a card is being created and takes the place of the created date', async () => {
  const board = await source('ui/Board.jsx')
  const parts = await source('ui/CardParts.jsx')
  assert.match(board, /onDone=\{isNewCard \? closeCard : null\}/)
  assert.match(board, /setNewCardId\(id => \(id === openCardId \? id : null\)\)/, 'opening the same card later is not “creating” it')
  assert.match(board, /created=\{isDraftCard \? '' : createdLabel\}/)
  const footer = parts.slice(parts.indexOf('export function CardFooter'), parts.indexOf('// ---- comments ----'))
  assert.match(footer, /onDone\s*\? <button type="button" className="kb-btn kb-btn-primary kb-card-done" onClick=\{onDone\}>Done<\/button>\s*: created && /)
  assert.match(footer, /if \(!onDelete && !created && !onDone\) return null/, 'a read-only viewer of an undated card gets no empty row')
})

// ---- pasting ----

test('a file added from Comments or Activity is confirmed on that tab', async () => {
  const board = await source('ui/Board.jsx')
  const parts = await source('ui/CardParts.jsx')
  assert.match(board, /setAttachNotice\(\{ cardId, names: added \}\)/)
  assert.match(board, /onView=\{\(\) => \{ setCardTab\('home'\); setAttachNotice\(null\) \}\}/)
  assert.match(board, /const attachedNotice = attachNotice && attachNotice\.cardId === openCard_\?\.id/, 'never shown on another card')
  assert.match(board, /setTimeout\(\(\) => setAttachNotice\(null\), 6000\)/)
  assert.match(parts, /className="kb-attach-notice" role="status"/, 'announced politely, not as an alert')
  const comments = parts.slice(parts.indexOf('export function CardComments'), parts.indexOf('function CommentRow'))
  assert.ok(comments.indexOf('{notice}') < comments.indexOf('className="kb-comment-composer"'), 'it sits above the comment box, where the paste happened')
})

test('the paste hint is written out, and a new card can take files', async () => {
  const board = await source('ui/Board.jsx')
  const parts = await source('ui/CardParts.jsx')
  const section = parts.slice(parts.indexOf('export function AttachmentsSection'), parts.indexOf('export function AttachedNotice'))
  assert.match(section, /className="kb-attach-hint">Paste <span className="kb-attach-hint-drop">or drop <\/span>files here</)
  assert.doesNotMatch(section, /isDraft/, 'attachments are not locked until a title exists')
  assert.doesNotMatch(board, /disabled=\{isDraftCard \|\| attachmentBusy\}/)
  const touch = CSS.slice(CSS.indexOf('@media (hover: none) {'))
  assert.ok(touch.slice(0, touch.indexOf('\n  }')).includes('.kb-attach-hint-drop { display: none; }'), 'a touch screen cannot drop a file')
})

// ---- layout ----

test('the title’s focus ring clears the chips under it', () => {
  assert.match(CSS, /\.kb-editable-field:focus \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/, 'the ring reaches 4px outside the title')
  assert.match(CSS, /\.kb-detail-chips \{[^}]*padding: 10px 0 16px; \}/)
})

test('a short card ends where its content ends, within the old limits', () => {
  const frame = CSS.slice(CSS.indexOf('---- Card tabs: Home'), CSS.indexOf('.kb-card-comments, .kb-card-activity'))
  assert.match(frame, /\.kb-card-sheet \{[^}]*height: auto;[^}]*min-height: min\(440px, var\(--kb-card-room\)\);[^}]*max-height: min\(var\(--kb-card-room\), 820px\);/)
  assert.match(frame, /--kb-card-room: calc\(100dvh - clamp\(72px, 11dvh, 120px\)\);/, 'the same room a card had before')
})

test('the board header folds its views into one control before they can cover the board name', () => {
  assert.match(CSS, /\.kb-board-header \{ container: kb-header \/ inline-size; \}/, 'it measures itself, so a narrow pane in a wide window is handled too')
  const rule = CSS.slice(CSS.indexOf('@container kb-header (max-width: 920px)'))
  assert.match(rule, /^@container kb-header \(max-width: 920px\) \{\s*\.kb-view-switch \{ display: none; \}\s*\.kb-show-chip \{ display: inline-flex; \}\s*\.kb-presence-label \{ display: none; \}\s*\}/)
  assert.match(CSS, /\.kb-switcher-wrap \{ position: relative; min-width: 96px; flex: 0 1 auto; \}/)
  assert.match(CSS, /max-width: min\(100%, 52vw, 440px\);/, 'the name shortens with its box instead of being drawn under its neighbours')
})

test('on a phone the paste hint drops under the heading instead of crowding the Add attachment button', () => {
  assert.match(CSS, /@media \(max-width: 640px\) \{[^@]*\.kb-section-line \{ flex-wrap: wrap; \}\s*\.kb-attach-hint \{ order: 1; flex-basis: 100%;/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'
const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
test('long lists scroll instead of compressing card content', () => {
  assert.match(CSS, /\.kb-board \{[^}]*min-height: 0/s)
  assert.match(CSS, /\.kb-card \{[^}]*flex-shrink: 0/s)
  assert.match(CSS, /\.kb-cards \{[^}]*overflow-y: auto/s)
})
test('horizontal board movement stays free instead of snapping to lists', () => {
  assert.doesNotMatch(CSS, /scroll-snap-(?:type|align)/)
})
test('mobile list navigation changes the viewport, not the board data', () => {
  const nav = board.slice(board.indexOf('<nav className="kb-list-nav"'), board.indexOf('</nav>') + 6)
  assert.match(nav, /scrollIntoView/)
  assert.doesNotMatch(nav, /reorderColumn|moveCard|renameColumn/)
})
test('on a phone the tab of the list in view is its header, and the list menu sits beside the tabs, not in them', () => {
  const nav = board.slice(board.indexOf('<nav className="kb-list-nav"'), board.indexOf('</nav>') + 6)
  assert.match(nav, /aria-current=\{column\.id === activeColumn\?\.id \? 'true' : undefined\}/)
  assert.doesNotMatch(nav, /listMenu\(/, 'tapping a tab only navigates; list actions stay in the menu beside the tabs')
  const afterNav = board.slice(board.indexOf('</nav>'), board.indexOf('</nav>') + 500)
  assert.match(afterNav, /<button className="kb-iconbtn kb-list-bar-add" aria-label=\{`Add card to \$\{activeColumn\.name\}`\} onClick=\{\(\) => addCard\(activeColumn\.id\)\}>/, 'adding a card sits beside the tabs and adds to the list in view')
  assert.match(afterNav, /\{access\.canWrite && activeColumn && <div className="kb-list-bar-menu">\{listMenu\(activeColumn, activeColumnIndex\)\}<\/div>\}/)
  assert.match(CSS, /\.kb-col:not\(\.is-renaming\) > \.kb-col-head \{ display: none; \}/, 'the repeated list header is hidden except while renaming')
  assert.match(board, /onClick=\{\(\) => startRenameList\(col\.id\)\}>Rename list</)
  assert.equal(board.match(/<MenuButton key=\{col\.id\} label=\{`List options for/g).length, 1, 'one list menu definition')
})

const phoneRules = CSS.slice(CSS.indexOf('/* Phones: one header row'), CSS.indexOf('@media (min-width: 1024px)'))

test('sync messages stay visible on a phone, on their own line under the header', () => {
  assert.doesNotMatch(CSS, /\.kb-offline \{ display: none; \}/, 'a phone must show reconnecting and pending changes')
  assert.match(phoneRules, /\.kb-board-header \.kb-status-live:not\(:empty\) \{ order: 20; flex: 1 0 100%;/)
})

test('a phone header is one row: the board menu reaches all boards and one Show chip replaces the view switch and filter button', () => {
  assert.match(phoneRules, /\.kb-board-header \.kb-homebtn,\s*\.kb-board-header \.kb-view-switch,\s*\.kb-board-header \.kb-filter-toggle,\s*\.kb-board-header \.kb-presence ~ \.kb-share-btn \{ display: none; \}/,
    'the share button hides only while avatars are showing, so sharing is always reachable')
  assert.match(phoneRules, /\.kb-switcher-row\.kb-switcher-all \{ display: flex; \}/)
  assert.match(board, /className="kb-switcher-row kb-switcher-all" onClick=\{\(\) => \{ onOpenChange\(false\); onAllBoards\(\) \}\}/)
  assert.match(board, /<BoardPresence members=\{displayMembers\} onOpen=\{\(\) => setShareOpen\(true\)\} \/>\}[^]*?kb-iconbtn kb-filter-toggle[^]*?className="kb-iconbtn kb-share-btn"/, 'avatars come before the share button they replace')
  const sheetAt = board.indexOf('className="kb-sheet kb-show-sheet"')
  const sheet = board.slice(sheetAt, board.indexOf('<div className="kb-divider" />', sheetAt))
  assert.match(sheet, /<BoardViewSwitch view=\{boardView\} counts=\{viewCounts\} onChange=\{chooseBoardView\} \/>\s*\{filterControls\}/)
  assert.equal(board.match(/\{filterControls\}/g).length, 2, 'the desktop filter bar and the phone sheet share one set of filter controls')
  assert.match(CSS, /\.kb-show-sheet \.kb-filter-labels \{ flex-wrap: wrap;/, 'label filters wrap in the sheet instead of running off the screen')
})

test('every board with lists gets the phone list bar, so a single list still has its name, add button and menu', () => {
  assert.match(board, /\{board\.columns\.length > 0 && <div className="kb-list-bar">/)
  assert.match(phoneRules, /\.kb-addcard, \.kb-board-edge \{ display: none; \}/)
  assert.match(phoneRules, /\.kb-list-bar \.kb-list-nav \{[^}]*mask-image: linear-gradient/, 'a fade shows that more tabs scroll into view')
  assert.match(phoneRules, /\.kb-list-bar-menu \.kb-col-menu \{ margin: 0; \}/, 'the tab row never runs wider than the screen, or jumping to a list shifts the whole app sideways')
})

test('on a phone a person who is the card’s only detail sits beside the title', () => {
  const card = board.slice(board.indexOf('function Card('), board.indexOf('function memberRecords('))
  assert.match(card, /const personOnly = Boolean\(assignee\) && !\(labelled \|\| dueStatus \|\| progress\.total \|\| pullCount \|\| attachments\.length\)/)
  assert.match(phoneRules, /\.kb-card\.is-person-only \.kb-card-meta \{ position: absolute;/)
  assert.match(phoneRules, /\.kb-col \{ flex: 0 0 auto; width: calc\(100vw - 32px\); max-width: none;/, 'one list fills the screen, without the next one peeking in')
})

test('quiet arrows appear at the board edges only while lists lie beyond them, and move the board by one list', () => {
  assert.match(board, /const after = scroller\.scrollLeft \+ scroller\.clientWidth < scroller\.scrollWidth - 4/)
  assert.match(board, /new ResizeObserver\(onScroll\)/, 'folding a list or resizing the window updates the arrows')
  assert.match(board, /\{boardEdges\.after && <button type="button" className="kb-board-edge is-after" aria-label="Show more lists"[^>]*onClick=\{\(\) => scrollLists\(1\)\}>/)
  assert.match(board, /\{boardEdges\.before && <button type="button" className="kb-board-edge is-before" aria-label="Show earlier lists"[^>]*onClick=\{\(\) => scrollLists\(-1\)\}>/)
  assert.match(board, /scroller\.scrollBy\(\{ left: direction \* step, behavior: instant \? 'auto' : 'smooth' \}\)/, 'reduced motion jumps instead of gliding')
})

test('lists grow into spare width on wide screens, up to 400px each', () => {
  assert.match(CSS, /\.kb-col \{ flex: 1 0 336px; width: 336px; max-width: 400px;/)
})

test('on a phone an empty list offers Add a card in place, and choice sheets rise from the bottom', () => {
  assert.match(board, /\{!allCards\.length && !showGap && access\.canWrite && <button className="kb-empty-add" onClick=\{\(\) => addCard\(col\.id\)\}>/, 'only a truly empty list, so a new card never vanishes behind a filter')
  assert.match(CSS, /\.kb-empty-add \{ display: none;/, 'desktop keeps its Add card bar instead')
  assert.match(phoneRules, /\.kb-empty-add \{ display: inline-flex; \}/)
  assert.match(phoneRules, /\.kb-sheet\.kb-switcher-panel, \.kb-sheet\.kb-show-sheet \{ top: auto; bottom: max\(8px, env\(safe-area-inset-bottom\)\); \}/)
})

test('sheets close with Close, never with the name of the Done list', () => {
  const show = board.slice(board.indexOf('className="kb-sheet kb-show-sheet"'), board.indexOf('{filterControls}', board.indexOf('className="kb-sheet kb-show-sheet"')))
  assert.match(show, />Close<\/button>/)
  assert.doesNotMatch(show, />Done</)
  const assignee = board.slice(board.indexOf('<div className="kb-assignee-mobile-head">'), board.indexOf('<div className="kb-assignee-mobile-head">') + 300)
  assert.match(assignee, />Close<\/button>/)
  assert.doesNotMatch(assignee, />Done</)
})

// Serializable, idempotent board operations. Keeping the user's intent as data
// lets local-offline edits survive a reload and be replayed against a fresh CAS
// base instead of trusting the runtime's blind offline write queue.

function insertBefore(ids, itemId, beforeId) {
  const next = (Array.isArray(ids) ? ids : []).filter(id => id !== itemId)
  const anchor = beforeId == null ? -1 : next.indexOf(beforeId)
  next.splice(anchor < 0 ? next.length : anchor, 0, itemId)
  return next
}

// A completion note is `✅ Done — <summary>` plus an optional link line. GitHub
// pull requests keep the historical `PR:` label; any other link uses `Link:`.
function completionLinkLine(link) {
  let pull = false
  try {
    const url = new URL(link)
    pull = url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/u.test(url.pathname)
  } catch {}
  return `${pull ? 'PR' : 'Link'}: ${link}`
}

export function hasCardCompletion(notes, link, summary = '') {
  const markers = link ? [`PR: ${link}`, `Link: ${link}`] : []
  return String(notes || '').split(/\n{2,}/u).some(block => {
    const lines = block.split('\n')
    if (!lines[0]?.startsWith('✅ Done — ')) return false
    return link ? markers.some(marker => lines.includes(marker)) : lines[0] === `✅ Done — ${summary}`
  })
}

export function cardPullUrls(card) {
  const urls = Array.isArray(card?.pullRequestUrls) ? card.pullRequestUrls : []
  return [...new Set([...urls, card?.pullRequestUrl]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim()))]
}

export function applyBoardOp(board, op) {
  if (!board || !op || typeof op !== 'object') return board
  switch (op.type) {
    case 'add-card': {
      const column = board.columns.find(item => item.id === op.columnId)
      if (!column || !op.card?.id) return board
      // Seeing the minted id means this add already landed. Do not drag a card
      // back if a collaborator moved it before an idempotent replay.
      if (board.cards[op.card.id]) return board
      board.cards[op.card.id] = structuredClone(op.card)
      column.cardIds.push(op.card.id)
      return board
    }
    case 'update-card': {
      const card = board.cards[op.cardId]
      if (card && op.patch && typeof op.patch === 'object') {
        const previousUrls = cardPullUrls(card)
        Object.assign(card, op.patch)
        if (Array.isArray(op.patch.pullRequestUrls)) {
          card.pullRequestUrls = cardPullUrls({ pullRequestUrls: op.patch.pullRequestUrls })
          card.pullRequestUrl = card.pullRequestUrls[0] || ''
        } else if (typeof op.patch.pullRequestUrl === 'string') {
          card.pullRequestUrls = cardPullUrls({ pullRequestUrls: [op.patch.pullRequestUrl, ...previousUrls.slice(1)] })
          card.pullRequestUrl = card.pullRequestUrls[0] || ''
        }
      }
      return board
    }
    case 'edit-pull-request': {
      const card = board.cards[op.cardId]
      if (!card || typeof op.nextUrl !== 'string') return board
      const urls = cardPullUrls(card)
      if (op.previousUrl === null) {
        if (op.nextUrl.trim()) urls.push(op.nextUrl.trim())
      } else {
        const index = urls.indexOf(op.previousUrl)
        if (index < 0) return board
        if (op.nextUrl.trim()) urls.splice(index, 1, op.nextUrl.trim())
        else urls.splice(index, 1)
      }
      card.pullRequestUrls = [...new Set(urls)]
      card.pullRequestUrl = card.pullRequestUrls[0] || ''
      return board
    }
    case 'add-checklist-item': {
      const card = board.cards[op.cardId]
      if (!card || !op.item?.id) return board
      if (!Array.isArray(card.checklist)) card.checklist = []
      if (!card.checklist.some(item => item?.id === op.item.id)) card.checklist.push(structuredClone(op.item))
      return board
    }
    case 'set-checklist-item': {
      const item = board.cards[op.cardId]?.checklist?.find(candidate => candidate?.id === op.itemId)
      if (item) item.done = op.done === true
      return board
    }
    case 'update-checklist-item': {
      const item = board.cards[op.cardId]?.checklist?.find(candidate => candidate?.id === op.itemId)
      if (item && typeof op.text === 'string' && op.text.trim()) item.text = op.text.trim()
      return board
    }
    case 'delete-checklist-item': {
      const card = board.cards[op.cardId]
      if (card) card.checklist = (Array.isArray(card.checklist) ? card.checklist : []).filter(item => item?.id !== op.itemId)
      return board
    }
    case 'delete-card': {
      delete board.cards[op.cardId]
      board.columns.forEach(column => { column.cardIds = column.cardIds.filter(id => id !== op.cardId) })
      return board
    }
    case 'move-card': {
      const target = board.columns.find(column => column.id === op.toColumnId)
      if (!target || !board.cards[op.cardId]) return board
      board.columns.forEach(column => { column.cardIds = column.cardIds.filter(id => id !== op.cardId) })
      target.cardIds = insertBefore(target.cardIds, op.cardId, op.beforeCardId)
      return board
    }
    case 'complete-card': {
      const card = board.cards[op.cardId]
      // `link` is optional; `prUrl` is the same field under its original name.
      const link = op.link ?? op.prUrl ?? ''
      if (!card || typeof op.summary !== 'string' || !op.summary || typeof link !== 'string') return board
      if (!hasCardCompletion(card.notes, link, op.summary)) {
        const completion = [`✅ Done — ${op.summary}`, ...(link ? [completionLinkLine(link)] : [])].join('\n')
        card.notes = [String(card.notes || '').trim(), completion].filter(Boolean).join('\n\n')
      }
      const done = board.columns.find(column => String(column.name || '').trim().toLocaleLowerCase() === 'done')
      if (done && !done.cardIds.includes(op.cardId)) {
        board.columns.forEach(column => { column.cardIds = column.cardIds.filter(id => id !== op.cardId) })
        done.cardIds.push(op.cardId)
      }
      return board
    }
    case 'add-column': {
      if (op.column?.id && !board.columns.some(column => column.id === op.column.id)) {
        board.columns.push(structuredClone(op.column))
      }
      return board
    }
    case 'rename-column': {
      const column = board.columns.find(item => item.id === op.columnId)
      if (column && op.name) column.name = op.name
      return board
    }
    case 'delete-column': {
      const column = board.columns.find(item => item.id === op.columnId)
      if (!column) return board
      column.cardIds.forEach(id => delete board.cards[id])
      board.columns = board.columns.filter(item => item.id !== op.columnId)
      return board
    }
    case 'move-column': {
      const column = board.columns.find(item => item.id === op.columnId)
      if (!column) return board
      board.columns = insertBefore(board.columns.map(item => item.id), op.columnId, op.beforeColumnId)
        .map(id => id === column.id ? column : board.columns.find(item => item.id === id))
        .filter(Boolean)
      return board
    }
    case 'rename-board':
      if (op.title) board.title = op.title
      return board
    default:
      return board
  }
}

export function cardMoveAnchor(cardIds, cardId, offset) {
  const ids = Array.isArray(cardIds) ? cardIds : []
  const from = ids.indexOf(cardId)
  if (from < 0) return undefined
  const to = Math.max(0, Math.min(from + offset, ids.length - 1))
  if (to === from) return undefined
  const without = ids.filter(id => id !== cardId)
  return without[to] ?? null
}

export function columnMoveAnchor(columns, columnId, offset) {
  const ids = (Array.isArray(columns) ? columns : []).map(column => column?.id).filter(Boolean)
  return cardMoveAnchor(ids, columnId, offset)
}

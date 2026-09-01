// Serializable, idempotent board operations. Keeping the user's intent as data
// lets local-offline edits survive a reload and be replayed against a fresh CAS
// base instead of trusting the runtime's blind offline write queue.

function insertBefore(ids, itemId, beforeId) {
  const next = (Array.isArray(ids) ? ids : []).filter(id => id !== itemId)
  const anchor = beforeId == null ? -1 : next.indexOf(beforeId)
  next.splice(anchor < 0 ? next.length : anchor, 0, itemId)
  return next
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
      if (card && op.patch && typeof op.patch === 'object') Object.assign(card, op.patch)
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

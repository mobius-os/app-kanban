// A shared board's in-app warning shows only while someone looks at it, so
// Kanban also tells its owner once when a board passes BOARD_NEARLY_FULL_SHARE
// of a host limit (domain.js boardCapacity). It tells them again only after the
// board dropped back below that share and filled up a second time. Each
// member's Kanban tells its own owner.

export const CAPACITY_ALERTS_PATH = 'capacity-alerts.json'

const KINDS = ['board', 'files']

export function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1).replace(/\.0$/u, '')} MB`
}

const percent = share => `${Math.min(100, Math.floor(share * 100))}%`

export function capacityAlertMessage(kind, boardTitle, capacity) {
  const name = `“${boardTitle || 'Kanban board'}”`
  return kind === 'board'
    ? {
      title: `${name} is ${percent(capacity.share)} full`,
      body: `${formatBytes(capacity.bytes)} of ${formatBytes(capacity.limit)} used. When it’s full, no one can save changes to it. Make room by deleting finished cards or moving them to another board, or by moving long descriptions into attachments.`,
    }
    : {
      title: `${name}: attachment space is ${percent(capacity.fileShare)} used`,
      body: `${capacity.files} of ${capacity.fileLimit} files, ${formatBytes(capacity.fileBytes)} of ${formatBytes(capacity.fileByteLimit)}. New files can’t be added once it’s full. Remove attachments you no longer need.`,
    }
}

// `notify` resolves to whether the push was sent; one that failed stays due
// and is tried again the next time the board is looked at.
export async function alertCapacity({ storage, notify, boardId, boardTitle, capacity }) {
  const saved = (await storage.get(CAPACITY_ALERTS_PATH).catch(() => null)) || {}
  const previous = saved[boardId] || {}
  const full = { board: Boolean(capacity.nearlyFull), files: Boolean(capacity.filesNearlyFull) }
  const sent = []
  for (const kind of KINDS) {
    if (!full[kind] || previous[kind]) continue
    const message = capacityAlertMessage(kind, boardTitle, capacity)
    if (await notify({ ...message, tag: `kanban-capacity:${boardId}:${kind}` })) sent.push(kind)
  }
  const recorded = Object.fromEntries(KINDS.map(kind => [kind, full[kind] && (Boolean(previous[kind]) || sent.includes(kind))]))
  if (KINDS.some(kind => recorded[kind] !== Boolean(previous[kind]))) {
    await storage.set(CAPACITY_ALERTS_PATH, { ...saved, [boardId]: recorded }).catch(() => {})
  }
  return sent
}

export async function forgetCapacityAlerts(storage, boardId) {
  const saved = await storage.get(CAPACITY_ALERTS_PATH)
  if (!saved || !Object.hasOwn(saved, boardId)) return
  const { [boardId]: _, ...rest } = saved
  await storage.set(CAPACITY_ALERTS_PATH, rest)
}

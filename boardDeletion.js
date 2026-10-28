// Deleting a board deletes everything this Möbius kept about it: the board,
// its attachment files and its cards' activity (private boards), edits still
// queued for it or kept for recovery, the assignment changes it noticed, its
// capacity alerts, and the personal view choices remembered for it. A shared
// board's own records live on its host, which deletes them
// (collaboration/service.py). Keep this list in step with every per-board
// path the app writes.
import { boardPath, assignmentLogPath, forgetBoardViews } from './storage.js'
import { activityPrefix } from './activity.js'
import { commentsPrefix } from './comments.js'
import { attachmentPrefix } from './attachments.js'
import { boardQueuePrefixes, forgetLegacyQueue } from './pendingOps.js'
import { forgetCapacityAlerts } from './capacityAlerts.js'

export const boardDataPrefixes = boardId => [activityPrefix(boardId), commentsPrefix(boardId), attachmentPrefix(boardId), ...boardQueuePrefixes(boardId)]

async function removePrefix(storage, prefix) {
  const items = await storage.list(prefix)
  await Promise.all((Array.isArray(items) ? items : []).map(item => storage.remove(`${prefix}${item.name}`)))
}

// The board goes first; every cleanup is attempted, and any that failed is
// reported as an error (deleting the board again retries what remains).
export async function deleteBoard(id, storage = globalThis.window?.mobius?.storage) {
  await storage.remove(boardPath(id))
  forgetLegacyQueue(id)
  const results = await Promise.allSettled([
    ...boardDataPrefixes(id).map(prefix => removePrefix(storage, prefix)),
    storage.remove(assignmentLogPath(id)),
    forgetCapacityAlerts(storage, id),
    forgetBoardViews(id, storage),
  ])
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw new Error(`The board was deleted, but some of what was kept about it could not be: ${failed.reason?.message || failed.reason}`)
}

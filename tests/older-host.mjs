// A board host running Kanban from before boards were stored in pieces. It
// refuses piece saves the way an older host does, so the app falls back to
// saving whole boards (sync.js pushSharedOp). Tests of the whole-board save
// path wrap their stand-in host with this.
export function asOlderHost(request) {
  return async (url, options = {}) => String(url).endsWith('/changes')
    ? Response.json({ protocol: 'kanban/1', code: 'invalid-operation', detail: 'Unsupported board operation.' }, { status: 400 })
    : request(url, options)
}

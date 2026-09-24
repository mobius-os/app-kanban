// Board-directory requests share one latest-result guard. A reconnect that
// happens during startup is queued so it cannot cancel startup-only work such
// as migration, membership recovery, or restoring the saved destination.
export function createBoardLoadCoordinator() {
  let latest = 0
  let startupPending = false
  let refreshQueued = false

  const begin = () => {
    const request = ++latest
    return () => request === latest
  }

  return {
    beginStartup() {
      startupPending = true
      return begin()
    },
    beginRefresh() {
      if (startupPending) {
        refreshQueued = true
        return null
      }
      return begin()
    },
    finishStartup() {
      startupPending = false
      const queued = refreshQueued
      refreshQueued = false
      return queued
    },
  }
}

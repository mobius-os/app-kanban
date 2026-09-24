// One guard is shared by every board-directory read. Starting a newer read
// makes every older result ineligible to update the visible directory.
export function createLatestRequestGuard() {
  let latest = 0
  return {
    begin() {
      const request = ++latest
      return () => request === latest
    },
  }
}

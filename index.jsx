import { useEffect, useRef, useState, useCallback } from 'react'
import { CSS } from './theme.js'
import { listBoards, listBoardsWithStatus, includeSharedBoards, createBoard, deleteBoard, loadUi, migrateLegacy, saveLastBoardId, seedFirstBoard } from './storage.js'
import { configureSync, recoverMemberships, loadShareMap, listInvitations, acceptInvitation, joinWithInvite, declineInvitation, leaveBoard, deleteSharedObject, removeShareEntry } from './sync.js'
import { sharingFromBoards } from './publication.js'
import { createBoardLoadCoordinator } from './request-guard.js'
import Home from './ui/Home.jsx'
import Board from './ui/Board.jsx'

function LoadingBoards() {
  return (
    <div className="kb-loading" role="status" aria-live="polite">
      <span className="kb-loading-spinner" aria-hidden="true" />
      <span>Loading boards…</span>
    </div>
  )
}

export default function App({ appId, token }) {
  const [boards, setBoards] = useState(null)
  const [shareMap, setShareMap] = useState({ byBoard: {} })
  const [invitations, setInvitations] = useState([])
  const [openId, setOpenId] = useState(null)
  const [resolved, setResolved] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [directoryUnavailable, setDirectoryUnavailable] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [online, setOnline] = useState(() => window.mobius?.online !== false)
  const navRef = useRef(null)
  // The current history entry owns its board destination independently from
  // the visible route. Back can show the gallery without destroying the
  // destination that Forward must restore; switching boards updates that same
  // entry in place.
  const boardEntryDestinationRef = useRef(null)
  const navigationIntentRef = useRef(0)
  const readySignalled = useRef(false)
  const boardLoadCoordinatorRef = useRef(null)
  if (!boardLoadCoordinatorRef.current) boardLoadCoordinatorRef.current = createBoardLoadCoordinator()

  configureSync(token, appId)

  const refreshInvitations = useCallback(async () => {
    try {
      const next = await listInvitations()
      setInvitations(next)
      return next
    } catch {
      // Invitations are additive UI: a temporary federation failure must not
      // disturb local boards or erase an invitation already on screen.
      return null
    }
  }, [])

  const refresh = useCallback(async () => {
    const isCurrent = boardLoadCoordinatorRef.current.beginRefresh()
    if (!isCurrent) return null
    try {
      const [listing, loadedMap] = await Promise.all([listBoardsWithStatus(), loadShareMap()])
      if (!isCurrent()) return null
      if (!listing.complete) {
        setDirectoryUnavailable(listing.boards.length === 0)
        setResolved(true)
        return null
      }
      const cached = listing.boards
      const map = sharingFromBoards(cached, loadedMap)
      const b = includeSharedBoards(cached, map)
      setBoards(b)
      setLoadError(false)
      setDirectoryUnavailable(false)
      setShareMap(map)
      setResolved(true)
      refreshInvitations()
      if (!readySignalled.current) {
        readySignalled.current = true
        window.mobius?.signal?.('app_ready', { item_count: b.length })
      }
      return b
    } catch (e) {
      if (!isCurrent()) return null
      setLoadError(true)
      setResolved(true)
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'list' })
      return null
    }
  }, [refreshInvitations])

  useEffect(() => {
    const isCurrent = boardLoadCoordinatorRef.current.beginStartup()
    ;(async () => {
      try {
        await migrateLegacy()
        if (!isCurrent()) return
        try { await recoverMemberships() } catch(error) {
          window.mobius?.signal?.('error', {source:'membership-recovery',message:String(error?.message || error)})
        }
        let [boardListing, map, ui] = await Promise.all([listBoardsWithStatus(), loadShareMap(), loadUi()])
        if (!isCurrent()) return
        let b = boardListing.boards
        map = sharingFromBoards(b, map)
        b = includeSharedBoards(b, map)
        setDirectoryUnavailable(!boardListing.complete && b.length === 0)
        // Seed only after a current server-authoritative empty listing. A cold
        // or cached offline empty result may be missing boards created elsewhere.
        if (b.length === 0 && boardListing.complete && boardListing.source === 'server') {
          await seedFirstBoard()
          if (!isCurrent()) return
          b = await listBoards()
          if (!isCurrent()) return
        }
        setBoards(b)
        setLoadError(false)
        setShareMap(map)
        if (ui.lastBoardId && b.some(board => board.id === ui.lastBoardId)) {
          // This is intentionally plain state, not nav.open: system Back from
          // the launch board must leave the app rather than reveal home.
          setOpenId(ui.lastBoardId)
          boardEntryDestinationRef.current = ui.lastBoardId
          saveLastBoardId(ui.lastBoardId).catch(() => {})
        }
        refreshInvitations()
        if (!readySignalled.current) {
          readySignalled.current = true
          window.mobius?.signal?.('app_ready', { item_count: b.length })
        }
      } catch (e) {
        if (!isCurrent()) return
        setLoadError(true)
        setDirectoryUnavailable(window.mobius?.online === false && boards === null)
        window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'initial-load' })
      } finally {
        // The loading root remains the only rendered view until the launch
        // destination has been decided, preventing a home-gallery flash.
        if (isCurrent()) {
          setResolved(true)
          if (boardLoadCoordinatorRef.current.finishStartup()) void refresh()
        }
      }
    })()
    let wasOnline = window.mobius?.online !== false
    const updateOnlineStatus = (next) => {
      setOnline(next)
      if (next && !wasOnline) refresh()
      wasOnline = next
    }
    const unsubscribeOnline = typeof window.mobius?.onOnlineChange === 'function'
      ? window.mobius.onOnlineChange(updateOnlineStatus)
      : null
    let t = null
    if (!unsubscribeOnline) {
      t = setInterval(() => {
        const next = window.mobius?.online !== false
        updateOnlineStatus(next)
      }, 3000)
    }
    return () => {
      try { unsubscribeOnline?.() } catch {}
      if (t) clearInterval(t)
    }
  }, [refresh, refreshInvitations, loadAttempt])

  useEffect(() => {
    const check = () => {
      if (!document.hidden && window.mobius?.online !== false) refreshInvitations()
    }
    const timer = setInterval(check, 3000)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [refreshInvitations])

  const showBoard = useCallback(id => {
    navigationIntentRef.current += 1
    boardEntryDestinationRef.current = id
    setOpenId(id)
    saveLastBoardId(id).catch(e => {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'save-ui' })
    })
  }, [])

  const showHome = useCallback(async () => {
    const intent = ++navigationIntentRef.current
    try {
      await saveLastBoardId(null)
    } catch (e) {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'save-ui' })
    }
    // A slow preference write must not visually rewind a newer Back/Forward
    // decision. saveLastBoardId serializes the durable choices separately;
    // this guard owns only which destination is still current in this frame.
    if (navigationIntentRef.current !== intent) return false
    setOpenId(null)
    refresh()
    return true
  }, [refresh])

  const closeBoard = useCallback(async () => {
    if (navRef.current) {
      // This board was entered from home; closing its sentinel reveals that
      // same home entry without adding another history item.
      navRef.current.close()
      navRef.current = null
      await showHome()
      return
    }

    const previousId = openId
    const nav = window.mobius?.nav
    if (!previousId || !nav?.open) {
      await showHome()
      return
    }

    // Home entered from a direct launch board gets its own sentinel, so Back
    // can return to that board while system Back on the launch board itself
    // still leaves the app normally.
    let handle = null
    handle = nav.open('kanban-home', {
      onBack: () => { navRef.current = null; showBoard(previousId) },
      onForward: () => { navRef.current = handle; void showHome() },
    })
    navRef.current = handle
    const { status } = await handle.outcome
    if (navRef.current !== handle) { handle.close(); return }
    if (status !== 'owned') { navRef.current = null; return }
    await showHome()
  }, [openId, showBoard, showHome])

  const openBoard = useCallback(async id => {
    const nav = window.mobius?.nav
    if (!nav?.open) { showBoard(id); return } // degraded/legacy mount: plain state nav
    navRef.current?.close()
    let handle = null
    handle = nav.open('kanban-board', {
      onBack: () => { navRef.current = null; void showHome() },
      onForward: () => {
        navRef.current = handle
        if (boardEntryDestinationRef.current) showBoard(boardEntryDestinationRef.current)
      },
    })
    navRef.current = handle
    const { status } = await handle.outcome
    if (navRef.current !== handle) { handle.close(); return }
    if (status !== 'owned') { navRef.current = null; return }
    showBoard(id)
  }, [showBoard, showHome])

  // Switching within the board surface deliberately keeps the current nav
  // handle. A board entered from home still has exactly one Back sentinel;
  // a board selected from the launch board still has none.
  const switchBoard = useCallback(id => { showBoard(id) }, [showBoard])

  const onCreate = useCallback(async () => {
    try {
      const id = await createBoard('New board')
      window.mobius?.signal?.('item_created', { type: 'board' })
      await refresh()
      openBoard(id)
    } catch (e) {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'create-board' })
    }
  }, [refresh, openBoard])

  const onCreateInBoard = useCallback(async () => {
    try {
      const id = await createBoard('New board')
      window.mobius?.signal?.('item_created', { type: 'board' })
      await refresh()
      switchBoard(id)
    } catch (e) {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'create-board' })
    }
  }, [refresh, switchBoard])

  const onDelete = useCallback(async id => {
    try {
      const entry = sharingFromBoards(await listBoards(), await loadShareMap()).byBoard[id]
      if (entry?.hosted) {
        await deleteSharedObject(entry.oid)
        await removeShareEntry(id)
      } else if (entry) {
        await leaveBoard(id, entry)
      }
      await deleteBoard(id)
      window.mobius?.signal?.('item_deleted')
    } catch (e) {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'delete-board' })
    }
    refresh()
  }, [refresh])

  const onAccept = useCallback(async inv => {
    const { boardId } = await acceptInvitation(inv)
    window.mobius?.signal?.('item_created', { type: 'joined-board' })
    await refresh()
    openBoard(boardId)
  }, [refresh, openBoard])

  const onDecline = useCallback(async inv => {
    await declineInvitation(inv)
    setInvitations(list => list.filter(i => !(i.id === inv.id && i.host === inv.host)))
  }, [])

  const onJoin = useCallback(async invite => {
    const { boardId } = await joinWithInvite(invite)
    window.mobius?.signal?.('item_created', { type: 'joined-board' })
    await refresh()
    openBoard(boardId)
  }, [refresh, openBoard])

  return (
    <div className="kb-root">
      <style>{CSS}</style>
      {resolved && directoryUnavailable && !online && <section className="kb-load-error" role="status">
        <h2>No boards are available offline yet</h2>
        <p>Reconnect to load your boards.</p>
      </section>}
      {resolved && loadError && !(directoryUnavailable && !online) && <section className="kb-load-error" role="alert">
        <h2>Boards couldn’t be loaded</h2>
        <p>{boards ? 'Your last loaded boards are still here. Try refreshing the list.' : 'We couldn’t read your boards. Try again to load them.'}</p>
        <button className="kb-btn kb-btn-primary" onClick={() => {
          setLoadError(false)
          if (boards === null) { setResolved(false); setLoadAttempt(attempt => attempt + 1) }
          else refresh()
        }}>Try again</button>
      </section>}
      {!resolved ? <LoadingBoards /> : openId ? (
        <Board
          key={openId}
          token={token}
          boardId={openId}
          boards={boards || []}
          shareMap={shareMap.byBoard}
          onAllBoards={closeBoard}
          onSwitchBoard={switchBoard}
          onCreateBoard={onCreateInBoard}
          onBoardRenamed={(id, title) => setBoards(list => list?.map(board => board.id === id ? { ...board, title } : board))}
          online={online}
          share={shareMap.byBoard[openId] || null}
          onShared={entry => setShareMap(m => ({ byBoard: { ...m.byBoard, [openId]: entry } }))}
        />
      ) : boards ? (
        <Home
          boards={boards}
          shareMap={shareMap.byBoard}
          invitations={invitations}
          online={online}
          onOpen={openBoard}
          onCreate={onCreate}
          onDelete={onDelete}
          onAccept={onAccept}
          onDecline={onDecline}
          onJoin={onJoin}
        />
      ) : null}
    </div>
  )
}

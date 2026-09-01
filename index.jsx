import { useEffect, useRef, useState, useCallback } from 'react'
import { CSS } from './theme.js'
import { listBoards, createBoard, deleteBoard, loadUi, migrateLegacy, saveLastBoardId, seedFirstBoard } from './storage.js'
import { configureSync, loadShareMap, listInvitations, acceptInvitation, declineInvitation, leaveBoard, deleteSharedObject, removeShareEntry } from './sync.js'
import Home from './ui/Home.jsx'
import Board from './ui/Board.jsx'

export default function App({ appId, token }) {
  const [boards, setBoards] = useState(null)
  const [shareMap, setShareMap] = useState({ byBoard: {} })
  const [invitations, setInvitations] = useState([])
  const [openId, setOpenId] = useState(null)
  const [resolved, setResolved] = useState(false)
  const [online, setOnline] = useState(() => window.mobius?.online !== false)
  const navRef = useRef(null)
  const openBoardIdRef = useRef(null)
  const readySignalled = useRef(false)

  configureSync(token)

  const refresh = useCallback(async () => {
    try {
      const [b, map] = await Promise.all([listBoards(), loadShareMap()])
      setBoards(b)
      setShareMap(map)
      // Invitations are additive UI: their fetch failing must not blank boards.
      listInvitations().then(setInvitations).catch(() => {})
      if (!readySignalled.current) {
        readySignalled.current = true
        window.mobius?.signal?.('app_ready', { item_count: b.length })
      }
      return b
    } catch (e) {
      setBoards([])
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'list' })
      return null
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      await migrateLegacy()
      try {
        let [b, map, ui] = await Promise.all([listBoards(), loadShareMap(), loadUi()])
        // First run: seed one board so the app is immediately useful.
        if (b.length === 0) {
          await seedFirstBoard()
          b = await listBoards()
        }
        setBoards(b)
        setShareMap(map)
        if (ui.lastBoardId && b.some(board => board.id === ui.lastBoardId)) {
          // This is intentionally plain state, not nav.open: system Back from
          // the launch board must leave the app rather than reveal home.
          setOpenId(ui.lastBoardId)
          openBoardIdRef.current = ui.lastBoardId
          saveLastBoardId(ui.lastBoardId).catch(() => {})
        }
        listInvitations().then(setInvitations).catch(() => {})
        if (!readySignalled.current) {
          readySignalled.current = true
          window.mobius?.signal?.('app_ready', { item_count: b.length })
        }
      } catch (e) {
        setBoards([])
        window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'initial-load' })
      } finally {
        // The loading root remains the only rendered view until the launch
        // destination has been decided, preventing a home-gallery flash.
        setResolved(true)
      }
    })()
    const t = setInterval(() => setOnline(window.mobius?.online !== false), 3000)
    return () => clearInterval(t)
  }, [refresh])

  const showBoard = useCallback(id => {
    openBoardIdRef.current = id
    setOpenId(id)
    saveLastBoardId(id).catch(e => {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'save-ui' })
    })
  }, [])

  const closeBoard = useCallback(async () => {
    if (navRef.current) {
      // This board was entered from home; closing its sentinel reveals that
      // same home entry without adding another history item.
      navRef.current.close()
      navRef.current = null
      setOpenId(null)
      refresh()
      return
    }

    const previousId = openId
    const nav = window.mobius?.nav
    if (!previousId || !nav?.open) {
      setOpenId(null)
      refresh()
      return
    }

    // Home entered from a direct launch board gets its own sentinel, so Back
    // can return to that board while system Back on the launch board itself
    // still leaves the app normally.
    let handle = null
    handle = nav.open('kanban-home', {
      onBack: () => { navRef.current = null; showBoard(previousId) },
      onForward: () => { navRef.current = handle; setOpenId(null); refresh() },
    })
    navRef.current = handle
    const { status } = await handle.outcome
    if (navRef.current !== handle) { handle.close(); return }
    if (status !== 'owned') { navRef.current = null; return }
    setOpenId(null)
    refresh()
  }, [openId, refresh, showBoard])

  const openBoard = useCallback(async id => {
    const nav = window.mobius?.nav
    if (!nav?.open) { showBoard(id); return } // degraded/legacy mount: plain state nav
    navRef.current?.close()
    let handle = null
    handle = nav.open('kanban-board', {
      onBack: () => { navRef.current = null; setOpenId(null); refresh() },
      onForward: () => {
        navRef.current = handle
        if (openBoardIdRef.current) showBoard(openBoardIdRef.current)
      },
    })
    navRef.current = handle
    const { status } = await handle.outcome
    if (navRef.current !== handle) { handle.close(); return }
    if (status !== 'owned') { navRef.current = null; return }
    showBoard(id)
  }, [refresh, showBoard])

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
      const entry = (await loadShareMap()).byBoard[id]
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

  return (
    <div className="kb-root">
      <style>{CSS}</style>
      {!resolved ? null : openId ? (
        <Board
          key={openId}
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
        />
      ) : null}
    </div>
  )
}

import { useEffect, useRef, useState, useCallback } from 'react'
import { Check, ChevronDown, ChevronLeft, Filter, Grid, Plus, Share, Trash } from '@openai/apps-sdk-ui/components/Icon'
import { uid, subscribeBoard, getBoard, casMutate, boardPath, normalizeBoard } from '../storage.js'
import { pullShared, pushSharedOp, createInvite, inviteByHandle, getMembers, revokeMember, shareBoard, cacheSubscriptionIsAuthoritative, sharedCursorAfterWrite } from '../sync.js'
import { applyBoardOp, cardMoveAnchor, columnMoveAnchor } from '../operations.js'
import { applyPendingBoardOps, enqueuePendingBoardOp, readPendingBoardOps, replayPendingBoardOps } from '../pendingOps.js'
import { useModalFocus } from './modalFocus.js'
import {
  assigneeAvatar,
  boardAccess,
  cardMatchesFilters,
  checklistProgress,
  defaultColumnColor,
  dueDateStatus,
  formatDueDate,
  visibleToFullIndex,
} from '../domain.js'

export const LABELS = {
  none: 'transparent',
  red: 'var(--kb-label-red, #ef4444)',
  amber: 'var(--kb-label-amber, #f59e0b)',
  green: 'var(--kb-label-green, #10b981)',
  blue: 'var(--kb-label-blue, #3b82f6)',
  purple: 'var(--kb-label-purple, #8b5cf6)',
  pink: 'var(--kb-label-pink, #ec4899)',
}

function Card({ card, lifted, onOpen, onDragStart, canWrite }) {
  const dueStatus = dueDateStatus(card.due)
  const progress = checklistProgress(card.checklist)
  const assignee = card.assignee?.trim()
  const avatar = assignee ? assigneeAvatar(assignee) : null
  return (
    <div
      className={`kb-card${lifted ? ' kb-lifted' : ''}${canWrite ? '' : ' kb-readonly'}`}
      data-card-id={card.id}
      role="button"
      tabIndex={0}
      onClick={event => { event.currentTarget.focus(); onOpen(card.id) }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card.id) } }}
      onPointerDown={canWrite ? e => onDragStart(e, card.id) : undefined}
    >
      {card.label && card.label !== 'none' && (
        <div
          className="kb-label"
          style={{ background: LABELS[card.label] || LABELS.none }}
          role="img"
          aria-label={`${card.label} label`}
        />
      )}
      <div className="kb-card-title">{card.title}</div>
      {(dueStatus || progress.total > 0 || avatar) && <div className="kb-card-meta">
        {dueStatus && <span className={`kb-due kb-due-${dueStatus}`}>{formatDueDate(card.due)}</span>}
        {progress.total > 0 && <div className="kb-check-progress">
          <span>{progress.done}/{progress.total}</span>
          <span
            className="kb-progress-track"
            role="progressbar"
            aria-label={`${progress.done} of ${progress.total} checklist items complete`}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <span className="kb-progress-fill" style={{ width: `${progress.percent}%` }} />
          </span>
        </div>}
        <span className="kb-card-meta-spacer" />
        {avatar && <span
          className="kb-avatar"
          style={{ background: avatar.background, color: avatar.color }}
          title={assignee}
          role="img"
          aria-label={`Assigned to ${assignee}`}
        >{avatar.initials}</span>}
      </div>}
    </div>
  )
}

function memberRecords(metadata) {
  const members = metadata?.members
    ?? metadata?.metadata?.members
    ?? metadata?.member_names
    ?? metadata?.metadata?.member_names
  if (members === undefined || members === null) return null
  const entries = Array.isArray(members)
    ? members.map((member, index) => [String(index), member, true])
    : members && typeof members === 'object'
      ? Object.entries(members).map(([host, member]) => [host, member, false])
      : []
  return entries.map(([key, member, fromArray]) => {
    if (typeof member === 'string') {
      return { host: fromArray ? '' : key, handle: '', name: member.trim(), role: '', pending: false }
    }
    const value = member && typeof member === 'object' ? member : {}
    return {
      host: String(value.host || value.host_key || value.member_host || (fromArray ? '' : key) || '').trim(),
      handle: String(value.handle || '').trim(),
      name: String(value.name || value.displayName || value.display_name || '').trim(),
      role: String(value.role || '').trim(),
      pending: value.pending === true,
    }
  })
}

function memberLabel(member) {
  const handle = String(member?.handle || '').trim().replace(/^@/u, '')
  if (handle) return `@${handle}`
  return String(member?.name || member?.host || '').trim()
}

function BoardSwitcher({ board, boardId, boards, shareMap, canWrite, open, onOpenChange, onRename, onSelect, onCreate }) {
  const panelRef = useModalFocus(open, () => onOpenChange(false))

  const cardCount = Object.keys(board.cards).length
  const commitTitle = target => {
    const title = target.value.trim()
    if (title && title !== board.title) onRename(title)
    else target.value = board.title
  }

  return (
    <div className="kb-switcher-wrap">
      <button
        className="kb-switcher-button"
        aria-label={`Switch board, current board ${board.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{board.title}</span>
        <ChevronDown />
      </button>
      {open && <>
        <div className="kb-scrim kb-switcher-scrim" onClick={() => onOpenChange(false)} />
        <div ref={panelRef} tabIndex={-1} className="kb-sheet kb-switcher-panel" role="dialog" aria-modal="true" aria-label="Switch boards">
          <div className="kb-sheet-grab" />
          <input
            className="kb-input kb-switcher-title"
            defaultValue={board.title}
            key={`switch-title-${board.title}`}
            aria-label="Current board name"
            readOnly={!canWrite}
            onBlur={event => commitTitle(event.currentTarget)}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
          <div className="kb-switcher-rows">
            {boards.map(item => {
              const current = item.id === boardId
              const title = current ? board.title : item.title
              const count = current ? cardCount : item.cardCount
              return <button
                key={item.id}
                className={`kb-switcher-row${current ? ' kb-current' : ''}`}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  if (!current) onSelect(item.id)
                  onOpenChange(false)
                }}
              >
                <span className="kb-switcher-row-main">
                  <span className="kb-switcher-row-title">{title}</span>
                  <span className="kb-switcher-row-meta">
                    {count === 1 ? '1 card' : `${count} cards`}
                    {shareMap[item.id] && <span className="kb-shared-tag">shared</span>}
                  </span>
                </span>
                {current && <Check />}
              </button>
            })}
            <button className="kb-switcher-row kb-switcher-new" onClick={() => { onOpenChange(false); onCreate() }}>
              <Plus />
              <span className="kb-switcher-row-title">New board</span>
            </button>
          </div>
        </div>
      </>}
    </div>
  )
}

function AssigneeEditor({ card, canWrite, onUpdate }) {
  const [value, setValue] = useState(card.assignee || '')
  useEffect(() => { setValue(card.assignee || '') }, [card.id, card.assignee])
  const commit = nextValue => {
    const next = String(nextValue).trim()
    setValue(next)
    if (next !== (card.assignee || '')) onUpdate(next)
  }
  return (
    <div className="kb-assignee-editor">
      <input
        className="kb-input"
        value={value}
        placeholder="Display name…"
        aria-label="Card assignee"
        readOnly={!canWrite}
        onChange={event => setValue(event.target.value)}
        onBlur={() => commit(value)}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </div>
  )
}

function MemberAssigneeEditor({ card, canWrite, members, onUpdate }) {
  const joined = (members || []).filter(member => !member.pending && member.host)
  return (
    <div className="kb-chips kb-assignee-picker" aria-label="Board members">
      <button
        className={`kb-chip${!card.assigneeHost && !card.assignee ? ' kb-on' : ''}`}
        type="button"
        disabled={!canWrite}
        aria-pressed={!card.assigneeHost && !card.assignee}
        onClick={() => canWrite && onUpdate({ assignee: '', assigneeHost: '' })}
      >Unassigned</button>
      {joined.map(member => {
        const label = memberLabel(member)
        const selected = card.assigneeHost
          ? card.assigneeHost === member.host
          : card.assignee === label
        return <button
          key={member.host}
          className={`kb-chip${selected ? ' kb-on' : ''}`}
          type="button"
          disabled={!canWrite}
          aria-pressed={selected}
          onClick={() => canWrite && onUpdate({ assignee: label, assigneeHost: member.host })}
        >{label}</button>
      })}
    </div>
  )
}

function ChecklistEditor({ checklist, canWrite, onAdd, onToggle, onDelete }) {
  const [text, setText] = useState('')
  const submit = () => {
    const value = text.trim()
    if (!value || !canWrite) return
    onAdd(value)
    setText('')
  }
  return (
    <div className="kb-checklist">
      {checklist.map(item => (
        <div className="kb-check-item" key={item.id}>
          <label className="kb-check-toggle">
            <input
              type="checkbox"
              checked={item.done}
              disabled={!canWrite}
              onChange={() => onToggle(item.id)}
            />
            <span className={item.done ? 'kb-check-done' : ''}>{item.text}</span>
          </label>
          {canWrite && <button
            className="kb-iconbtn"
            aria-label={`Delete checklist item ${item.text}`}
            onClick={() => onDelete(item.id)}
          >
            <Trash />
          </button>}
        </div>
      ))}
      {canWrite && <div className="kb-check-add">
        <input
          className="kb-input"
          value={text}
          placeholder="Add checklist item…"
          aria-label="New checklist item"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
        />
        <button className="kb-btn kb-btn-primary" disabled={!text.trim()} onClick={submit}>Add</button>
      </div>}
      {!checklist.length && !canWrite && <div className="kb-empty">No checklist items</div>}
    </div>
  )
}

function ShareSheet({ boardId, share, members, onMembersChange, onShared, onClose, beforeShare }) {
  const [handle, setHandle] = useState('')
  const [role, setRole] = useState('editor')
  const [inviteLink, setInviteLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null) // {kind: 'ok'|'warn'|'error', text}
  const hosted = !!share?.hosted
  const sheetRef = useModalFocus(true, onClose)

  const start = async () => {
    setBusy(true); setNotice(null)
    try {
      await beforeShare?.()
      const entry = await shareBoard(boardId)
      onShared({ ...entry, hosted: true })
    } catch (e) {
      setNotice({ kind: 'error', text: String(e?.message || e) })
    }
    setBusy(false)
  }

  const invite = async () => {
    const who = handle.trim()
    if (!who || busy) return
    setBusy(true); setNotice(null)
    try {
      const res = await inviteByHandle(share.oid, who, role)
      onMembersChange(ms => [
        ...(ms || []).filter(member => member.host !== res.host),
        { host: res.host || '', handle: res.handle || '', name: who, role: res.role, pending: true },
      ])
      setHandle('')
      setNotice(res.delivery === 'delivered'
        ? { kind: 'ok', text: `Invited — it's waiting on their Möbius.` }
        : { kind: 'warn', text: `Invited, but their Möbius couldn't be reached right now. They'll be let in automatically when their app connects.` })
    } catch (e) {
      setNotice({ kind: 'error', text: String(e?.message || e) })
    }
    setBusy(false)
  }

  const makeInviteLink = async () => {
    if (busy) return
    setBusy(true); setNotice(null)
    try {
      const res = await createInvite(share.oid, role)
      setInviteLink(res.invite || '')
      if (!res.invite) throw new Error('The invite link could not be created.')
    } catch (e) {
      setNotice({ kind: 'error', text: String(e?.message || e) })
    }
    setBusy(false)
  }

  const copyInviteLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) return
      await navigator.clipboard.writeText(inviteLink)
      setNotice({ kind: 'ok', text: 'Invite link copied.' })
    } catch { /* the read-only field remains selectable for manual copy */ }
  }

  return (
    <>
      <div className="kb-scrim" onClick={onClose} />
      <div ref={sheetRef} tabIndex={-1} className="kb-sheet" role="dialog" aria-modal="true" aria-label="Share board">
        <div className="kb-sheet-grab" />
        {!share && (
          <>
            <h3>Share this board</h3>
            <div className="kb-empty kb-empty-left">
              Sharing keeps the board on your Möbius and lets people you invite
              edit it live from their own Möbius.
            </div>
            <button className="kb-btn kb-btn-primary" disabled={busy} onClick={start}>
              Turn on sharing
            </button>
          </>
        )}
        {share && hosted && (
          <>
            <div>
              <h3>Invite someone</h3>
              <input
                className="kb-input kb-field-spaced"
                placeholder="@handle or handle@their-mobius-host"
                value={handle}
                onChange={e => setHandle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') invite() }}
                aria-label="Invite handle"
              />
              <div className="kb-chips kb-field-spaced" role="radiogroup" aria-label="Invitation role">
                <button role="radio" aria-checked={role === 'editor'} className={`kb-chip${role === 'editor' ? ' kb-on' : ''}`} onClick={() => setRole('editor')}>Can edit</button>
                <button role="radio" aria-checked={role === 'viewer'} className={`kb-chip${role === 'viewer' ? ' kb-on' : ''}`} onClick={() => setRole('viewer')}>View only</button>
              </div>
              <button className="kb-btn kb-btn-primary kb-field-spaced" disabled={busy || !handle.trim()} onClick={invite}>Invite</button>
            </div>
            <div>
              <h3>Share an invite</h3>
              <button className="kb-btn kb-btn-quiet kb-field-spaced" disabled={busy} onClick={makeInviteLink}>
                Create invite link
              </button>
              {inviteLink && <>
                <div className="kb-inline-field kb-field-spaced">
                  <input className="kb-input" readOnly value={inviteLink} aria-label="Invite link" />
                  <button className="kb-btn kb-btn-quiet" onClick={copyInviteLink}>Copy</button>
                </div>
                <div className="kb-sub kb-field-spaced">Send this to any Möbius user — they paste it in Kanban to join.</div>
              </>}
            </div>
            <div>
              <h3>People</h3>
              <div className="kb-people-list">
                {members === null && <div className="kb-empty">Loading…</div>}
                {members && members.map((m, index) => (
                  <div key={`${m.host || memberLabel(m)}-${index}`} className="kb-sheet-row kb-sheet-row-between">
                    <span className="kb-person-name">
                      {memberLabel(m)}{' '}
                      <span className="kb-sub">
                        · {m.host === share.host ? 'you' : m.pending ? `invited · ${m.role}` : m.role}
                      </span>
                    </span>
                    {m.host !== share.host && (
                      <button className="kb-btn kb-btn-quiet kb-danger" onClick={async () => {
                        try { await revokeMember(share.oid, m.host); onMembersChange(ms => (ms || []).filter(member => member.host !== m.host)) } catch (e) { setNotice({ kind: 'error', text: String(e?.message || e) }) }
                      }}>{m.pending ? 'Cancel invite' : 'Remove'}</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {share && !hosted && (
          <div>
            <h3>Shared board</h3>
            <div className="kb-empty kb-empty-left">
              This board lives on {share.host}. You joined as {share.role === 'viewer' ? 'a viewer' : 'an editor'}.
            </div>
          </div>
        )}
        {notice && (
          <div className={`kb-notice kb-${notice.kind}`}>
            {notice.text}
          </div>
        )}
        <button className="kb-btn kb-btn-primary" onClick={onClose}>Done</button>
      </div>
    </>
  )
}

function Composer({ onAdd, onClose }) {
  const [text, setText] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  const submit = () => {
    const t = text.trim()
    if (t) onAdd(t)
    setText('')
    if (!t) onClose()
  }
  return (
    <div className="kb-composer">
      <textarea
        ref={ref}
        className="kb-input"
        rows={2}
        placeholder="Card title…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          if (e.key === 'Escape') onClose()
        }}
      />
      <div className="kb-composer-row">
        <button className="kb-btn kb-btn-primary" onClick={submit}>Add card</button>
        <button className="kb-btn kb-btn-quiet" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

export default function Board({
  boardId,
  boards,
  shareMap,
  onAllBoards,
  onSwitchBoard,
  onCreateBoard,
  onBoardRenamed,
  online,
  share,
  onShared,
}) {
  const [board, setBoard] = useState(null)
  const [composerCol, setComposerCol] = useState(null)
  const [openCardId, setOpenCardId] = useState(null)
  const [confirmDeleteCol, setConfirmDeleteCol] = useState(null)
  const [drag, setDrag] = useState(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [syncNote, setSyncNote] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [filterLabels, setFilterLabels] = useState([])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [members, setMembers] = useState(null)
  const [animateColumns, setAnimateColumns] = useState(true)
  const [queuedCount, setQueuedCount] = useState(0)

  const boardRef = useRef(null)
  const boardScrollRef = useRef(null)
  const pendingRef = useRef(0)
  const writeChain = useRef(Promise.resolve())
  const dragRef = useRef(null)
  const rectsRef = useRef(null)
  const versionRef = useRef(-1)
  const shareRef = useRef(share)
  const onlineRef = useRef(online)
  const filtersRef = useRef({ text: filterText, labels: filterLabels })
  const replayingRef = useRef(false)
  const cardSheetRef = useModalFocus(Boolean(openCardId), () => setOpenCardId(null))
  const columnConfirmRef = useModalFocus(Boolean(confirmDeleteCol), () => setConfirmDeleteCol(null))
  boardRef.current = board
  shareRef.current = share
  onlineRef.current = online
  filtersRef.current = { text: filterText, labels: filterLabels }

  useEffect(() => {
    if (!board || !animateColumns) return undefined
    if (board.columns.length === 0) {
      setAnimateColumns(false)
      return undefined
    }
    const timer = setTimeout(() => setAnimateColumns(false), 185 + board.columns.length * 25)
    return () => clearTimeout(timer)
  }, [!!board, animateColumns])

  useEffect(() => {
    let alive = true
    setMembers(null)
    if (share?.hosted) {
      getMembers(share.oid).then(result => {
        const next = memberRecords(result)
        if (alive) setMembers(next || [])
      }).catch(() => {})
    }
    return () => { alive = false }
  }, [share?.hosted, share?.oid])

  useEffect(() => {
    if (!shareOpen || !share?.hosted) return undefined
    let alive = true
    getMembers(share.oid).then(result => {
      const next = memberRecords(result)
      if (alive) setMembers(next || [])
    }).catch(() => {})
    return () => { alive = false }
  }, [shareOpen, share?.hosted, share?.oid])

  useEffect(() => {
    let unsub = null
    let alive = true
    getBoard(boardId).then(doc => {
      if (!alive) return
      if (doc) {
        const initial = shareRef.current ? doc : applyPendingBoardOps(doc, boardId)
        boardRef.current = initial
        setBoard(initial)
      }
      setQueuedCount(readPendingBoardOps(boardId).length)
      unsub = subscribeBoard(boardId, v => {
        if (!v) return
        if (!cacheSubscriptionIsAuthoritative(shareRef.current)) return
        if (pendingRef.current > 0) return
        if (dragRef.current) return
        const next = applyPendingBoardOps(v, boardId)
        boardRef.current = next
        setBoard(next)
      })
    }).catch(err => {
      window.mobius?.signal?.('error', { message: String(err?.message || err), source: 'board-load' })
    })
    return () => { alive = false; unsub?.() }
  }, [boardId])

  // Shared boards: poll the shared object and fold newer documents in.
  useEffect(() => {
    if (!share) return undefined
    let alive = true
    let pulling = false
    versionRef.current = -1
    const tick = async () => {
      if (!alive || pulling || document.hidden) return
      pulling = true
      try {
        const state = await pullShared(share, versionRef.current)
        if (!alive) return
        if (state.version < versionRef.current) return
        versionRef.current = state.version
        if (state.doc) {
          const normalized = normalizeBoard(state.doc)
          window.mobius?.storage?.set(boardPath(boardId), normalized).catch(() => {})
          if (pendingRef.current === 0 && !dragRef.current) {
            boardRef.current = normalized
            setBoard(normalized)
          }
        }
        if (state.object) {
          const nextMembers = memberRecords(state.object)
          if (nextMembers) setMembers(nextMembers)
        }
        setSyncNote('')
      } catch (e) {
        setSyncNote('Reconnecting — showing your last copy')
      } finally {
        pulling = false
      }
    }
    tick()
    const t = setInterval(tick, 3000)
    const onVis = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [share, boardId])

  const mutate = useCallback((operation, onCommit) => {
    const entry = shareRef.current
    if (!boardAccess(entry, onlineRef.current).canWrite) return false
    const current = boardRef.current
    if (!current) return false
    const before = structuredClone(current)
    const apply = base => applyBoardOp(base, operation)
    const optimistic = apply(structuredClone(current)) || current

    // Local-offline intent belongs to the app. Persist it synchronously before
    // rendering it; if UI storage rejects the queue, report failure and leave
    // the rendered board untouched.
    const runtimeOnline = onlineRef.current && window.mobius?.online !== false
    const alreadyQueued = !entry && readPendingBoardOps(boardId).length > 0
    if (!entry && (!runtimeOnline || alreadyQueued)) {
      try {
        enqueuePendingBoardOp(boardId, operation)
      } catch (error) {
        window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-queue' })
        setSyncNote('Offline change was not saved')
        return false
      }
      boardRef.current = optimistic
      setBoard(optimistic)
      const count = readPendingBoardOps(boardId).length
      setQueuedCount(count)
      setSyncNote(`${count} change${count === 1 ? '' : 's'} waiting to reconnect`)
      return true
    }

    boardRef.current = optimistic
    setBoard(optimistic)
    pendingRef.current += 1
    const onErr = e => {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'save' })
      if (entry) setSyncNote('Reconnecting — retrying the latest shared board')
    }
    let settled = null
    writeChain.current = writeChain.current.catch(() => {}).then(async () => {
      if (entry) {
        const landed = await pushSharedOp(entry, apply, onErr)
        if (landed) {
          versionRef.current = sharedCursorAfterWrite(landed)
          await window.mobius?.storage?.set(boardPath(boardId), landed.doc).catch(() => {})
          settled = landed.doc
          onCommit?.()
        } else {
          // A poll may have advanced while the optimistic write hid its doc.
          // Resetting forces the next tick to fetch the full authority again.
          versionRef.current = -1
          settled = before
        }
        return
      }
      const landed = await casMutate(boardId, apply, onErr)
      if (landed) {
        settled = landed
        onCommit?.()
        return
      }
      // The connection can disappear after the click but before durableWrite.
      // Convert that unconfirmed attempt into our own replayable queue.
      try {
        enqueuePendingBoardOp(boardId, operation)
        setQueuedCount(readPendingBoardOps(boardId).length)
        setSyncNote('Change saved locally — reconnecting')
      } catch (error) {
        settled = before
        window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-queue' })
      }
    }).finally(() => {
      pendingRef.current -= 1
      if (pendingRef.current === 0) {
        if (entry) {
          if (settled && !dragRef.current) {
            boardRef.current = settled
            setBoard(settled)
          }
        } else {
          getBoard(boardId).then(v => {
            if (v && pendingRef.current === 0 && !dragRef.current) {
              const rendered = applyPendingBoardOps(v, boardId)
              boardRef.current = rendered
              setBoard(rendered)
            }
          }).catch(() => {})
        }
      }
    })
    return true
  }, [boardId])

  // Reconnect replay is serialized with ordinary writes and retains an op until
  // CAS confirms it landed. The interval also retries transient reconnects
  // without requiring another online/offline transition.
  useEffect(() => {
    if (share || !online) return undefined
    let alive = true
    const flush = () => {
      if (!alive || replayingRef.current || readPendingBoardOps(boardId).length === 0) return
      replayingRef.current = true
      writeChain.current = writeChain.current.catch(() => {}).then(async () => {
        const result = await replayPendingBoardOps(
          boardId,
          op => casMutate(boardId, base => applyBoardOp(base, op), error => {
            window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-replay' })
          }),
          {
            onLanded: (landed, remaining) => {
              if (!alive || dragRef.current) return
              const rendered = remaining.reduce(
                (doc, entry) => applyBoardOp(doc, entry.op) || doc,
                structuredClone(landed),
              )
              boardRef.current = rendered
              setBoard(rendered)
            },
          },
        )
        if (!alive) return
        setQueuedCount(result.pending)
        setSyncNote(result.ok ? '' : `${result.pending} change${result.pending === 1 ? '' : 's'} could not sync — retrying`)
      }).finally(() => { replayingRef.current = false })
    }
    flush()
    const timer = setInterval(flush, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [boardId, online, share, queuedCount])

  const addCard = (colId, title) => {
    const id = uid()
    const createdAt = new Date().toISOString()
    mutate({
      type: 'add-card',
      columnId: colId,
      card: { id, title, notes: '', label: 'none', due: '', checklist: [], assignee: '', assigneeHost: '', createdAt },
    }, () => window.mobius?.signal?.('item_created', { type: 'card' }))
  }

  const updateCard = (cardId, patch) => {
    mutate({ type: 'update-card', cardId, patch })
  }

  const addCheckItem = (cardId, text) => {
    const item = { id: uid(), text, done: false }
    mutate({ type: 'add-checklist-item', cardId, item })
  }

  const toggleCheckItem = (cardId, itemId) => {
    const item = boardRef.current?.cards[cardId]?.checklist?.find(candidate => candidate.id === itemId)
    if (item) mutate({ type: 'set-checklist-item', cardId, itemId, done: item.done !== true })
  }

  const removeCheckItem = (cardId, itemId) => {
    mutate({ type: 'delete-checklist-item', cardId, itemId })
  }

  const deleteCard = cardId => {
    setOpenCardId(null)
    mutate(
      { type: 'delete-card', cardId },
      () => window.mobius?.signal?.('item_deleted'),
    )
  }

  const moveCard = (cardId, toColId, beforeCardId = null) => {
    mutate({ type: 'move-card', cardId, toColumnId: toColId, beforeCardId })
  }

  const reorderCard = (cardId, offset) => {
    const column = boardRef.current?.columns.find(item => item.cardIds.includes(cardId))
    if (!column) return
    const beforeCardId = cardMoveAnchor(column.cardIds, cardId, offset)
    if (beforeCardId !== undefined) moveCard(cardId, column.id, beforeCardId)
  }

  const addColumn = () => {
    const id = uid()
    mutate({
      type: 'add-column',
      column: { id, name: 'New list', color: defaultColumnColor(boardRef.current?.columns.length || 0), cardIds: [] },
    })
  }

  const renameColumn = (colId, name) => {
    mutate({ type: 'rename-column', columnId: colId, name })
  }

  const deleteColumn = colId => {
    setConfirmDeleteCol(null)
    mutate({ type: 'delete-column', columnId: colId })
  }

  const reorderColumn = (colId, offset) => {
    const beforeColumnId = columnMoveAnchor(boardRef.current?.columns, colId, offset)
    if (beforeColumnId !== undefined) mutate({ type: 'move-column', columnId: colId, beforeColumnId })
  }

  const renameBoard = title => {
    const next = title.trim()
    if (!next || next === boardRef.current?.title) return
    if (mutate({ type: 'rename-board', title: next })) onBoardRenamed(boardId, next)
  }

  // ---- drag & drop (pointer events; long-press on touch) ----
  const startDrag = (e, cardId) => {
    if (e.button != null && e.button !== 0) return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const isTouch = e.pointerType === 'touch'
    const start = { x: e.clientX, y: e.clientY }
    let active = false
    let holdTimer = null
    let scrollFrame = null
    let pointer = { ...start }

    const measure = () => {
      const root = boardScrollRef.current
      rectsRef.current = Array.from(root?.querySelectorAll('[data-col-id]') || []).map(c => ({
        id: c.dataset.colId,
        rect: c.getBoundingClientRect(),
        cardEls: Array.from(c.querySelectorAll('[data-card-id]')).map(cc => ({
          id: cc.dataset.cardId,
          rect: cc.getBoundingClientRect(),
        })),
      }))
    }

    const begin = () => {
      active = true
      measure()
      const b = boardRef.current
      const fromCol = b.columns.find(c => c.cardIds.includes(cardId))?.id
      const d = {
        cardId, fromCol,
        w: rect.width, h: rect.height,
        dx: start.x - rect.left, dy: start.y - rect.top,
        x: e.clientX, y: e.clientY,
        overCol: fromCol,
        overIndex: null,
        moved: false,
      }
      dragRef.current = d
      setDrag({ ...d })
      scrollFrame = requestAnimationFrame(autoScroll)
      navigator.vibrate?.(10)
    }

    const locate = (x, y) => {
      const cols = rectsRef.current || []
      let over = null
      for (const c of cols) {
        const r = c.rect
        if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 20 && y <= r.bottom + 20) { over = c; break }
      }
      if (!over) return { overCol: null, overIndex: null }
      let idx = 0
      for (const cc of over.cardEls) {
        if (cc.id === cardId) continue
        if (y > cc.rect.top + cc.rect.height / 2) idx++
      }
      return { overCol: over.id, overIndex: idx }
    }

    const updatePosition = (x, y) => {
      const { overCol, overIndex } = locate(x, y)
      const d = dragRef.current
      if (!d) return
      Object.assign(d, { x, y, overCol, overIndex, moved: true })
      setDrag({ ...d })
    }

    function autoScroll() {
      const scroller = boardScrollRef.current
      const d = dragRef.current
      if (!active || !scroller || !d) return
      if (d.moved) {
        const bounds = scroller.getBoundingClientRect()
        const edge = 48
        let delta = 0
        if (pointer.x < bounds.left + edge) {
          delta = -Math.ceil((bounds.left + edge - pointer.x) / 4)
        } else if (pointer.x > bounds.right - edge) {
          delta = Math.ceil((pointer.x - (bounds.right - edge)) / 4)
        }
        if (delta) {
          const before = scroller.scrollLeft
          scroller.scrollLeft += delta
          if (scroller.scrollLeft !== before) {
            measure()
            updatePosition(pointer.x, pointer.y)
          }
        }
      }
      scrollFrame = requestAnimationFrame(autoScroll)
    }

    const onMove = ev => {
      pointer = { x: ev.clientX, y: ev.clientY }
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y
      if (!active) {
        if (isTouch) {
          if (Math.hypot(dx, dy) > 10) cleanup() // user is scrolling
        } else if (Math.hypot(dx, dy) > 5) begin()
        if (!active) return
      }
      ev.preventDefault()
      updatePosition(ev.clientX, ev.clientY)
    }

    const onUp = () => {
      const d = dragRef.current
      let beforeCardId = null
      if (d && active && d.moved && d.overCol) {
        const current = boardRef.current
        const column = current?.columns.find(c => c.id === d.overCol)
        const filters = filtersRef.current
        const visibleIds = column?.cardIds.filter(id =>
          cardMatchesFilters(current.cards[id], filters.text, filters.labels),
        ) || []
        const fullIndex = visibleToFullIndex(column?.cardIds, visibleIds, d.overIndex, cardId)
        // Capture intent as an anchor on the rendered drop base. The op resolves
        // that id again on its fresh CAS base and falls back to end-of-list if a
        // collaborator removed it.
        const withoutMoving = (column?.cardIds || []).filter(id => id !== cardId)
        beforeCardId = withoutMoving[fullIndex] ?? null
      }
      cleanup()
      if (d && active && d.moved && d.overCol) {
        moveCard(cardId, d.overCol, beforeCardId)
      }
    }

    const cleanup = () => {
      clearTimeout(holdTimer)
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cleanup)
      dragRef.current = null
      setDrag(null)
    }

    if (isTouch) holdTimer = setTimeout(begin, 320)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cleanup)
  }

  const suppressClick = useRef(false)
  useEffect(() => {
    if (drag?.moved) suppressClick.current = true
    else if (!drag) setTimeout(() => { suppressClick.current = false }, 80)
  }, [drag])
  const openCard = id => { if (!suppressClick.current) setOpenCardId(id) }

  if (!board) return <div className="kb-board" />

  const openCard_ = openCardId ? board.cards[openCardId] : null
  const openCardColumn = openCard_ ? board.columns.find(column => column.cardIds.includes(openCard_.id)) : null
  const openCardIndex = openCardColumn ? openCardColumn.cardIds.indexOf(openCard_.id) : -1
  const access = boardAccess(share, online)
  const hasFilters = !!filterText.trim() || filterLabels.length > 0

  return (
    <>
      <div className="kb-header kb-board-header">
        <button className="kb-iconbtn kb-homebtn" aria-label="All boards" onClick={onAllBoards}>
          <Grid />
        </button>
        <BoardSwitcher
          board={board}
          boardId={boardId}
          boards={boards}
          shareMap={shareMap}
          canWrite={access.canWrite}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          onRename={renameBoard}
          onSelect={onSwitchBoard}
          onCreate={onCreateBoard}
        />
        <div className="kb-header-spacer" />
        {(queuedCount > 0 || access.status) && <span className="kb-offline">
          {queuedCount > 0 ? `${queuedCount} change${queuedCount === 1 ? '' : 's'} pending` : access.status}
        </span>}
        {syncNote && <span className="kb-offline">{syncNote}</span>}
        <button
          className={`kb-iconbtn${hasFilters ? ' kb-filter-active' : ''}`}
          aria-label="Filter cards"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(open => !open)}
        >
          <Filter />
        </button>
        <button className="kb-iconbtn" aria-label="Share board" onClick={() => setShareOpen(true)}>
          <Share />
        </button>
      </div>
      <div className="kb-divider" />
      {filtersOpen && <div className="kb-filterbar" aria-label="Card filters">
        <input
          className="kb-input kb-filter-input"
          type="search"
          placeholder="Filter title or notes…"
          aria-label="Filter cards by title or notes"
          value={filterText}
          onChange={event => setFilterText(event.target.value)}
        />
        <div className="kb-filter-labels" aria-label="Filter by label">
          {Object.entries(LABELS).map(([name, color]) => {
            const active = filterLabels.includes(name)
            return <button
              key={name}
              className={`kb-filter-dot-btn${active ? ' kb-on' : ''}`}
              aria-label={name === 'none' ? 'Filter unlabeled cards' : `Filter ${name} cards`}
              aria-pressed={active}
              onClick={() => setFilterLabels(labels =>
                labels.includes(name) ? labels.filter(label => label !== name) : [...labels, name],
              )}
            >
              <span
                className={`kb-filter-dot${name === 'none' ? ' kb-none' : ''}`}
                style={name === 'none' ? undefined : { background: color }}
              />
            </button>
          })}
        </div>
      </div>}
      <div className={`kb-board${animateColumns ? ' kb-board-enter' : ''}${board.columns.length === 0 ? ' kb-board-empty' : ''}`} ref={boardScrollRef}>
        {board.columns.length === 0 && <div className="kb-empty-board-state">
          <div className="kb-empty-board-title">No lists yet</div>
          <div className="kb-empty">Add a list to start organizing this board.</div>
          <button className="kb-btn kb-btn-primary" disabled={!access.canWrite} onClick={addColumn}>
            <Plus /> Add list
          </button>
        </div>}
        {board.columns.map((col, columnIndex) => {
          const showGap = drag && drag.moved && drag.overCol === col.id
          const allCards = col.cardIds.map(id => board.cards[id]).filter(Boolean)
          const cards = allCards.filter(card => cardMatchesFilters(card, filterText, filterLabels))
          const cardNodes = []
          let dropPosition = 0
          for (const card of cards) {
            if (showGap && card.id !== drag.cardId && drag.overIndex === dropPosition) {
              cardNodes.push(<div key={`gap-${dropPosition}`} className="kb-gap" style={{ height: drag.h }} />)
            }
            cardNodes.push(<Card
              key={card.id}
              card={card}
              lifted={drag?.cardId === card.id && drag.moved}
              onOpen={openCard}
              onDragStart={startDrag}
              canWrite={access.canWrite}
            />)
            if (card.id !== drag?.cardId) dropPosition += 1
          }
          if (showGap && drag.overIndex >= dropPosition) {
            cardNodes.push(<div key={`gap-${dropPosition}`} className="kb-gap" style={{ height: drag.h }} />)
          }
          return (
            <section
              key={col.id}
              data-col-id={col.id}
              className={`kb-col${showGap ? ' kb-drop' : ''}`}
              style={{ '--kb-col-index': columnIndex }}
              aria-label={col.name}
            >
              <div className="kb-col-head">
                <span
                  className="kb-col-status"
                  style={{ background: col.color ? (LABELS[col.color] || 'var(--muted)') : 'var(--muted)' }}
                  aria-hidden="true"
                />
                <input
                  className="kb-col-name"
                  defaultValue={col.name}
                  key={`c-${col.id}-${col.name}`}
                  aria-label="List name"
                  readOnly={!access.canWrite}
                  onBlur={e => { if (e.target.value.trim() && e.target.value !== col.name) renameColumn(col.id, e.target.value.trim()) }}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
                <span className="kb-count">{hasFilters ? `${cards.length}/${allCards.length}` : allCards.length}</span>
                <div className="kb-col-actions">
                  <div className="kb-col-reorder" aria-label={`Reorder list ${col.name}`}>
                  <button
                    className="kb-iconbtn kb-col-action"
                    aria-label={`Move list ${col.name} left`}
                    disabled={!access.canWrite || columnIndex === 0}
                    onClick={() => reorderColumn(col.id, -1)}
                  >
                    <ChevronLeft />
                  </button>
                  <button
                    className="kb-iconbtn kb-col-action kb-chevron-right"
                    aria-label={`Move list ${col.name} right`}
                    disabled={!access.canWrite || columnIndex === board.columns.length - 1}
                    onClick={() => reorderColumn(col.id, 1)}
                  >
                    <ChevronLeft />
                  </button>
                  </div>
                  <button
                  className="kb-iconbtn kb-col-action"
                  aria-label={`Delete list ${col.name}`}
                  disabled={!access.canWrite}
                  onClick={() => (allCards.length ? setConfirmDeleteCol(col.id) : deleteColumn(col.id))}
                >
                  <Trash />
                  </button>
                </div>
              </div>
              {access.canWrite && confirmDeleteCol === col.id && (
                <div ref={columnConfirmRef} tabIndex={-1} className="kb-composer" role="alertdialog" aria-modal="true" aria-label="Confirm delete">
                  <div className="kb-empty">Delete “{col.name}” and its {allCards.length} card{allCards.length === 1 ? '' : 's'}?</div>
                  <div className="kb-composer-row">
                    <button className="kb-btn kb-btn-danger" onClick={() => deleteColumn(col.id)}>Delete</button>
                    <button className="kb-btn kb-btn-quiet" onClick={() => setConfirmDeleteCol(null)}>Cancel</button>
                  </div>
                </div>
              )}
              <div className="kb-cards">
                {cardNodes}
                {cards.length === 0 && !showGap && composerCol !== col.id && (
                  <div className="kb-empty">{hasFilters && allCards.length ? 'No matching cards' : 'Nothing here yet'}</div>
                )}
              </div>
              {access.canWrite && (composerCol === col.id ? (
                <Composer onAdd={t => addCard(col.id, t)} onClose={() => setComposerCol(null)} />
              ) : (
                <button className="kb-addcard" onClick={() => setComposerCol(col.id)}>
                  <Plus /> Add card
                </button>
              ))}
            </section>
          )
        })}
        {access.canWrite && board.columns.length > 0 && <button className="kb-addcol" onClick={addColumn}><Plus /> Add list</button>}
      </div>

      {drag?.moved && (
        <div
          className="kb-card kb-ghost"
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w }}
        >
          {board.cards[drag.cardId]?.label !== 'none' && (
            <div className="kb-label" style={{ background: LABELS[board.cards[drag.cardId]?.label] }} />
          )}
          <div className="kb-card-title">{board.cards[drag.cardId]?.title}</div>
        </div>
      )}

      {openCard_ && (
        <>
          <div className="kb-scrim" onClick={() => setOpenCardId(null)} />
          <div ref={cardSheetRef} tabIndex={-1} className="kb-sheet" role="dialog" aria-modal="true" aria-label="Card details">
            <div className="kb-sheet-grab" />
            <textarea
              className="kb-input"
              rows={2}
              defaultValue={openCard_.title}
              key={`st-${openCard_.id}`}
              aria-label="Card title"
              readOnly={!access.canWrite}
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== openCard_.title) updateCard(openCard_.id, { title: v }) }}
            />
            <textarea
              className="kb-input"
              rows={3}
              placeholder="Notes…"
              defaultValue={openCard_.notes}
              key={`sn-${openCard_.id}`}
              aria-label="Card notes"
              readOnly={!access.canWrite}
              onBlur={e => { if (e.target.value !== openCard_.notes) updateCard(openCard_.id, { notes: e.target.value }) }}
            />
            <div>
              <h3>Due date</h3>
              <input
                className="kb-input kb-date-input kb-field-spaced"
                type="date"
                value={openCard_.due || ''}
                aria-label="Card due date"
                readOnly={!access.canWrite}
                onChange={event => updateCard(openCard_.id, { due: event.target.value })}
              />
            </div>
            <div>
              <h3>Checklist</h3>
              <ChecklistEditor
                checklist={Array.isArray(openCard_.checklist) ? openCard_.checklist : []}
                canWrite={access.canWrite}
                onAdd={text => addCheckItem(openCard_.id, text)}
                onToggle={itemId => toggleCheckItem(openCard_.id, itemId)}
                onDelete={itemId => removeCheckItem(openCard_.id, itemId)}
              />
            </div>
            {access.canWrite && <div>
              <h3>Label</h3>
              <div className="kb-swatches kb-field-spaced">
                {Object.entries(LABELS).map(([name, color]) => (
                  <button
                    key={name}
                    className={`kb-swatch${name === 'none' ? ' kb-none' : ''}${(openCard_.label || 'none') === name ? ' kb-on' : ''}`}
                    style={name === 'none' ? undefined : { background: color }}
                    aria-label={`Label ${name}`}
                    onClick={() => updateCard(openCard_.id, { label: name })}
                  />
                ))}
              </div>
            </div>}
            <div>
              <h3>Assignee</h3>
              {share ? <MemberAssigneeEditor
                  card={openCard_}
                  canWrite={access.canWrite}
                  members={members}
                  onUpdate={patch => updateCard(openCard_.id, patch)}
                /> : <AssigneeEditor
                  card={openCard_}
                  canWrite={access.canWrite}
                  onUpdate={assignee => updateCard(openCard_.id, { assignee })}
                />}
            </div>
            {access.canWrite && openCardColumn && <div>
              <h3>Position</h3>
              <div className="kb-position-actions kb-field-spaced">
                <button
                  className="kb-btn kb-btn-quiet"
                  disabled={openCardIndex <= 0}
                  onClick={() => reorderCard(openCard_.id, -1)}
                >
                  <span className="kb-position-up" aria-hidden="true"><ChevronDown /></span>
                  Move up
                </button>
                <button
                  className="kb-btn kb-btn-quiet"
                  disabled={openCardIndex < 0 || openCardIndex >= openCardColumn.cardIds.length - 1}
                  onClick={() => reorderCard(openCard_.id, 1)}
                >
                  <ChevronDown aria-hidden="true" />
                  Move down
                </button>
              </div>
            </div>}
            {access.canWrite && <div>
              <h3>Move to</h3>
              <div className="kb-chips kb-field-spaced">
                {board.columns.map(c => {
                  const here = c.cardIds.includes(openCard_.id)
                  return (
                    <button
                      key={c.id}
                      className={`kb-chip${here ? ' kb-on' : ''}`}
                      disabled={here}
                      onClick={() => { moveCard(openCard_.id, c.id, null); setOpenCardId(null) }}
                    >
                      {c.name}
                    </button>
                  )
                })}
              </div>
            </div>}
            <div className="kb-sheet-row kb-sheet-row-between">
              {access.canWrite && <button className="kb-btn kb-btn-quiet kb-danger" onClick={() => deleteCard(openCard_.id)}>
                Delete card
              </button>}
              <button className="kb-btn kb-btn-primary" onClick={() => setOpenCardId(null)}>Done</button>
            </div>
          </div>
        </>
      )}

      {shareOpen && (
        <ShareSheet
          boardId={boardId}
          share={share}
          members={members}
          onMembersChange={setMembers}
          onShared={onShared}
          beforeShare={async () => {
            await writeChain.current.catch(() => {})
            const pending = readPendingBoardOps(boardId).length
            if (pending) throw new Error(`Reconnect before sharing so ${pending} pending change${pending === 1 ? '' : 's'} can sync.`)
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  )
}

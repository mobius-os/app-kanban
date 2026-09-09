import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, Filter, Grid, MagnifyingGlassSearch, Plus, Share, Trash, User } from '@openai/apps-sdk-ui/components/Icon'
import { uid, subscribeBoard, getBoard, boardPath, normalizeBoard } from '../storage.js'
import { pullShared, createInvite, inviteByHandle, getMembers, revokeCollaborator, groupCollaborators, collaboratorForHost, inviteDeliveryNotice, shareBoard, cacheSubscriptionIsAuthoritative, sharedCursorAfterWrite, sharedBoardPollDelay } from '../sync.js'
import { applyBoardOp, cardMoveAnchor, columnMoveAnchor } from '../operations.js'
import { applyPendingBoardOps, enqueuePendingBoardOp, readPendingBoardOps, replayPendingBoardOps } from '../pendingOps.js'
import { createBoardRepository, isRetryableBoardError, replayOutcomeForBoardError } from '../boardRepository.js'
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
  const notePreview = String(card.notes || '').trim()
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
      {notePreview && <div className="kb-card-notes">{notePreview}</div>}
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
  return groupCollaborators(entries.map(([key, member, fromArray]) => {
    if (typeof member === 'string') {
      return { host: fromArray ? '' : key, handle: '', name: member.trim(), role: '', pending: false }
    }
    const value = member && typeof member === 'object' ? member : {}
    return {
      host: String(value.host || value.host_key || value.member_host || (fromArray ? '' : key) || '').trim(),
      handle: String(value.handle || '').trim(),
      name: String(value.name || value.displayName || value.display_name || '').trim(),
      role: String(value.role || '').trim(),
      collaborator_id: value.collaborator_id || null,
      pending: value.pending === true,
      active: value.active === true,
    }
  }))
}

function memberLabel(member) {
  const handle = String(member?.handle || '').trim().replace(/^@/u, '')
  if (handle) return `@${handle}`
  return String(member?.name || member?.host || '').trim()
}

function MemberAvatar({ member, small = false }) {
  const label = memberLabel(member) || 'Board member'
  const avatar = assigneeAvatar(label)
  return <span
    className={`kb-member-avatar${small ? ' kb-member-avatar-small' : ''}`}
    style={{ background: avatar.background, color: avatar.color }}
    title={label}
    aria-label={label}
  >
    {avatar.initials}
    {member.active && <span className="kb-presence-dot" aria-label="Active now" />}
  </span>
}

function BoardPresence({ members, onOpen }) {
  const active = (members || []).filter(member => member.active && !member.pending)
  if (!active.length) return null
  const visible = active.slice(0, 3)
  const remainder = active.length - visible.length
  const summary = active.length === 1 ? `${memberLabel(active[0])} is active` : `${active.length} people are active`
  return <button className="kb-presence" type="button" onClick={onOpen} aria-label={`${summary}. Open sharing.`}>
    <span className="kb-presence-stack" aria-hidden="true">
      {visible.map(member => <MemberAvatar key={member.host || memberLabel(member)} member={member} small />)}
      {remainder > 0 && <span className="kb-presence-more">+{remainder}</span>}
    </span>
    <span className="kb-presence-label">{active.length === 1 ? '1 active' : `${active.length} active`}</span>
  </button>
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
          <div className="kb-sheet-row kb-sheet-row-between">
            <h3>Switch boards</h3>
            <button className="kb-btn kb-btn-quiet" onClick={() => onOpenChange(false)}>Close</button>
          </div>
          <label className="kb-field-label" htmlFor="kb-current-board-name">Board name</label>
          <input id="kb-current-board-name"
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

function AssigneePicker({ card, canWrite, members, share, onUpdate }) {
  const rootRef = useRef(null)
  const searchRef = useRef(null)
  const [open, setOpen] = useState(false)
  const menuRef = useModalFocus(open, () => setOpen(false))
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState(undefined)
  const joined = (members || []).filter(member => !member.pending && member.host)
  const selectedMember = card.assigneeHost
    ? collaboratorForHost(joined, card.assigneeHost)
    : joined.find(member => memberLabel(member) === card.assignee)
  const selectedLabel = selectedMember ? memberLabel(selectedMember) : String(card.assignee || '').trim()
  const selectedAvatar = selectedLabel ? assigneeAvatar(selectedLabel) : null
  const localCandidates = share && !share.hosted
    ? joined.filter(member => member.host !== share.host && member.active)
    : []
  const selfMember = share?.hosted
    ? collaboratorForHost(joined, share.host)
    : localCandidates.length === 1 ? localCandidates[0] : null
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleMembers = joined.filter(member => {
    if (!normalizedQuery) return true
    return [memberLabel(member), member.name, member.handle, member.host]
      .some(value => String(value || '').toLocaleLowerCase().includes(normalizedQuery))
  })
  const privateName = !share ? query.trim() : ''

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnResize = () => setOpen(false)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    window.addEventListener('resize', closeOnResize)
    requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      window.removeEventListener('resize', closeOnResize)
    }
  }, [open])

  const choose = patch => {
    onUpdate(patch)
    setQuery('')
    setOpen(false)
  }
  const chooseMember = member => choose({ assignee: memberLabel(member), assigneeHost: member.host })
  const chooseMe = () => {
    if (selfMember) chooseMember(selfMember)
    else if (!share) choose({ assignee: 'Me', assigneeHost: '' })
  }
  const togglePicker = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = rootRef.current?.getBoundingClientRect()
    const mobile = window.matchMedia('(max-width: 640px)').matches
    const menuHeight = Math.min(420, window.innerHeight * 0.58)
    setMenuStyle(!mobile && rect ? {
      top: `${Math.max(16, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 16))}px`,
      left: `${Math.max(16, Math.min(rect.right - 320, window.innerWidth - 336))}px`,
    } : undefined)
    setOpen(true)
  }

  return (
    <div className="kb-assignee-picker" ref={rootRef}>
      <button
        type="button"
        className="kb-assignee-trigger"
        aria-label={selectedLabel ? `Assignee: ${selectedLabel}` : 'Choose assignee'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!canWrite}
        onClick={() => canWrite && togglePicker()}
      >
        {selectedAvatar
          ? <span className="kb-assignee-avatar" style={{ background: selectedAvatar.background, color: selectedAvatar.color }}>{selectedAvatar.initials}</span>
          : <span className="kb-assignee-avatar kb-assignee-avatar-empty"><User aria-hidden="true" /></span>}
        <span className={`kb-assignee-trigger-label${selectedLabel ? '' : ' is-empty'}`}>{selectedLabel || 'Unassigned'}</span>
        {canWrite && <ChevronDown aria-hidden="true" />}
      </button>
      {open && createPortal(<>
        <div className="kb-assignee-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
        <div ref={menuRef} className="kb-assignee-menu" style={menuStyle} role="dialog" aria-modal="true" aria-label="Assign card">
          <div className="kb-assignee-mobile-head">
            <strong>Assign card</strong>
            <button type="button" className="kb-btn kb-btn-quiet" onClick={() => setOpen(false)}>Done</button>
          </div>
          <label className="kb-assignee-search">
            <MagnifyingGlassSearch aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              aria-label={share ? 'Search board members' : 'Search or enter a name'}
              placeholder={share ? 'Search people…' : 'Search or enter a name…'}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && privateName) {
                  event.preventDefault()
                  choose({ assignee: privateName, assigneeHost: '' })
                }
              }}
            />
          </label>
          <div className="kb-assignee-options" role="group" aria-label="Assignee options">
            {(!share || selfMember) && <button type="button" className="kb-assignee-option kb-assignee-me" onClick={chooseMe}>
              <span className="kb-assignee-option-icon"><User aria-hidden="true" /></span>
              <span className="kb-assignee-option-copy"><strong>Assign to me</strong><small>{selfMember ? memberLabel(selfMember) : 'Me'}</small></span>
              {selectedLabel === (selfMember ? memberLabel(selfMember) : 'Me') && <Check aria-hidden="true" />}
            </button>}
            <button type="button" className="kb-assignee-option" aria-pressed={!selectedLabel} onClick={() => choose({ assignee: '', assigneeHost: '' })}>
              <span className="kb-assignee-avatar kb-assignee-avatar-empty"><User aria-hidden="true" /></span>
              <span className="kb-assignee-option-copy"><strong>Unassigned</strong></span>
              {!selectedLabel && <Check aria-hidden="true" />}
            </button>
            {visibleMembers.map(member => {
              const label = memberLabel(member)
              const selected = selectedMember?.host === member.host
              return <button key={member.host} type="button" className="kb-assignee-option" aria-pressed={selected} onClick={() => chooseMember(member)}>
                <MemberAvatar member={member} small />
                <span className="kb-assignee-option-copy"><strong>{label}</strong>{member.name && member.name !== label && <small>{member.name}</small>}</span>
                {selected && <Check aria-hidden="true" />}
              </button>
            })}
            {privateName && privateName.toLocaleLowerCase() !== selectedLabel.toLocaleLowerCase() && <button type="button" className="kb-assignee-option" aria-pressed="false" onClick={() => choose({ assignee: privateName, assigneeHost: '' })}>
              <span className="kb-assignee-avatar" style={{ background: assigneeAvatar(privateName).background, color: assigneeAvatar(privateName).color }}>{assigneeAvatar(privateName).initials}</span>
              <span className="kb-assignee-option-copy"><strong>Assign “{privateName}”</strong><small>Use this name</small></span>
            </button>}
            {share && visibleMembers.length === 0 && <div className="kb-assignee-empty">No matching people</div>}
          </div>
        </div>
      </>, document.body)}
    </div>
  )
}

function AutoGrowTextarea({ valueKey, onCommit, expandOnFocus = false, ...props }) {
  const textareaRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const resize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const contentHeight = textarea.scrollHeight
    const compactHeight = expandOnFocus ? Math.min(contentHeight, 144) : contentHeight
    const writingHeight = Math.min(Math.max(contentHeight, window.innerHeight * 0.42), 520)
    textarea.style.height = `${expandOnFocus && focused ? writingHeight : compactHeight}px`
  }, [expandOnFocus, focused])
  useEffect(resize, [resize, valueKey])
  return <textarea
    {...props}
    ref={textareaRef}
    onInput={resize}
    onFocus={() => setFocused(true)}
    onBlur={event => {
      setFocused(false)
      onCommit?.(event.target.value)
    }}
  />
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

function ShareSheet({ boardId, share, members, onMembersChange, onRefreshMembers, onShared, onClose, beforeShare }) {
  const [handle, setHandle] = useState('')
  const [role, setRole] = useState('editor')
  const [inviteLink, setInviteLink] = useState('')
  const [busyAction, setBusyAction] = useState(null)
  const [notice, setNotice] = useState(null) // {kind: 'ok'|'warn'|'error', text}
  const [inviteNotice, setInviteNotice] = useState(null)
  const busy = busyAction !== null
  const hosted = !!share?.hosted
  const sheetRef = useModalFocus(true, onClose)

  const start = async () => {
    setBusyAction('sharing'); setNotice(null)
    try {
      await beforeShare?.()
      const entry = await shareBoard(boardId)
      onShared({ ...entry, hosted: true })
    } catch (e) {
      setNotice({ kind: 'error', text: String(e?.message || e) })
    }
    setBusyAction(null)
  }

  const invite = async () => {
    const who = handle.trim()
    if (!who || busy) return
    setBusyAction('inviting'); setInviteNotice(null)
    try {
      const res = await inviteByHandle(share.oid, who, role)
      if (res.members) onMembersChange(memberRecords(res))
      else onMembersChange(ms => [
        ...(ms || []).filter(member => member.host !== res.host),
        { host: res.host, handle: '', name: who, role: res.role, pending: true },
      ])
      const deliveryNotice = inviteDeliveryNotice(res)
      if (deliveryNotice.kind === 'ok') setHandle('')
      setInviteNotice(deliveryNotice)
      await onRefreshMembers?.().catch(() => {})
    } catch (e) {
      setInviteNotice({ kind: 'error', text: String(e?.message || e) })
    }
    setBusyAction(null)
  }

  const makeInviteLink = async () => {
    if (busy) return
    setBusyAction('link'); setNotice(null)
    try {
      const res = await createInvite(share.oid, role)
      setInviteLink(res.invite || '')
      if (!res.invite) throw new Error('The invite link could not be created.')
    } catch (e) {
      setNotice({ kind: 'error', text: String(e?.message || e) })
    }
    setBusyAction(null)
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
              {busyAction === 'sharing' ? 'Turning on sharing…' : 'Turn on sharing'}
            </button>
          </>
        )}
        {share && hosted && (
          <>
            <div>
              <h3>Invite someone</h3>
              <div className="kb-sub kb-field-spaced">Use their Möbius account handle to invite every currently linked deployment. A full address invites just that deployment.</div>
              <input
                className="kb-input kb-field-spaced"
                placeholder="@handle or handle@their-mobius-host"
                value={handle}
                onChange={e => { setHandle(e.target.value); setInviteNotice(null) }}
                onKeyDown={e => { if (e.key === 'Enter') invite() }}
                aria-label="Invite handle"
              />
              <div className="kb-chips kb-field-spaced" role="radiogroup" aria-label="Invitation role">
                <button role="radio" aria-checked={role === 'editor'} disabled={busy} className={`kb-chip${role === 'editor' ? ' kb-on' : ''}`} onClick={() => setRole('editor')}>Can edit</button>
                <button role="radio" aria-checked={role === 'viewer'} disabled={busy} className={`kb-chip${role === 'viewer' ? ' kb-on' : ''}`} onClick={() => setRole('viewer')}>View only</button>
              </div>
              <button className="kb-btn kb-btn-primary kb-field-spaced" disabled={busy || !handle.trim()} onClick={invite}>
                {busyAction === 'inviting' ? 'Sending invite…' : 'Send invite'}
              </button>
              {inviteNotice && <div className={`kb-notice kb-invite-notice kb-${inviteNotice.kind}`} role={inviteNotice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
                {inviteNotice.text}
              </div>}
            </div>
            <div>
              <h3>Share an invite</h3>
              <button className="kb-btn kb-btn-quiet kb-field-spaced" disabled={busy} onClick={makeInviteLink}>
                {busyAction === 'link' ? 'Creating invite link…' : 'Create invite link'}
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
                {members === null && <div className="kb-empty">Loading people…</div>}
                {members && members.map((m, index) => (
                  <div key={`${m.host || memberLabel(m)}-${index}`} className="kb-person-row">
                    <MemberAvatar member={m} />
                    <span className="kb-person-copy">
                      <span className="kb-person-name">{memberLabel(m)}</span>
                      <span className="kb-person-meta">
                        {m.host === share.host ? 'You' : m.pending ? 'Invite pending' : m.active ? 'Active now' : 'Not active'}
                        <span aria-hidden="true"> · </span>{m.role === 'viewer' ? 'Can view' : 'Can edit'}
                        {m.hosts?.length > 1 && <> · {m.hosts.length} deployments</>}
                      </span>
                    </span>
                    {m.host !== share.host && (
                      <button className="kb-btn kb-btn-quiet kb-danger" title={m.collaborator_id ? 'Remove access from all invited deployments' : 'Remove access'} onClick={async () => {
                        try { await revokeCollaborator(share.oid, m); onMembersChange(ms => (ms || []).filter(member => member.host !== m.host)) } catch (e) { setNotice({ kind: 'error', text: String(e?.message || e) }) }
                      }}>{m.hosts?.length > 1 ? (m.pending ? 'Cancel all' : 'Remove from all') : (m.pending ? 'Cancel invite' : 'Remove')}</button>
                    )}
                  </div>
                ))}
                {members && members.length === 0 && <div className="kb-empty kb-empty-left">No one has joined this board yet.</div>}
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
  const pendingEntriesRef = useRef([])
  const lastInteractionAtRef = useRef(Date.now())
  const cardSheetRef = useModalFocus(Boolean(openCardId), () => setOpenCardId(null))
  const columnConfirmRef = useModalFocus(Boolean(confirmDeleteCol), () => setConfirmDeleteCol(null))
  boardRef.current = board
  shareRef.current = share
  onlineRef.current = online
  filtersRef.current = { text: filterText, labels: filterLabels }

  const refreshMembers = useCallback(async () => {
    if (!share?.hosted) return []
    const result = await getMembers(share.oid)
    const next = memberRecords(result) || []
    setMembers(next)
    return next
  }, [share?.hosted, share?.oid])

  useEffect(() => {
    if (!share) return undefined
    const markInteraction = () => { lastInteractionAtRef.current = Date.now() }
    window.addEventListener('pointerdown', markInteraction, { passive: true })
    window.addEventListener('keydown', markInteraction)
    return () => {
      window.removeEventListener('pointerdown', markInteraction)
      window.removeEventListener('keydown', markInteraction)
    }
  }, [Boolean(share)])

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
    setMembers(null)
    if (share?.hosted) {
      refreshMembers().catch(() => {})
    }
    return undefined
  }, [share?.hosted, share?.oid, refreshMembers])

  useEffect(() => {
    if (!shareOpen || !share?.hosted) return undefined
    refreshMembers().catch(() => {})
    return undefined
  }, [shareOpen, share?.hosted, share?.oid, refreshMembers])

  useEffect(() => {
    let unsub = null
    let alive = true
    Promise.all([getBoard(boardId), readPendingBoardOps(boardId)]).then(([doc, pendingEntries]) => {
      if (!alive) return
      pendingEntriesRef.current = pendingEntries
      if (doc) {
        const initial = applyPendingBoardOps(doc, pendingEntries)
        boardRef.current = initial
        setBoard(initial)
      }
      setQueuedCount(pendingEntries.length)
      unsub = subscribeBoard(boardId, async v => {
        if (!v) return
        if (!cacheSubscriptionIsAuthoritative(shareRef.current)) return
        if (pendingRef.current > 0) return
        if (dragRef.current) return
        const queued = await readPendingBoardOps(boardId)
        if (!alive) return
        pendingEntriesRef.current = queued
        setQueuedCount(queued.length)
        const next = applyPendingBoardOps(v, queued)
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
    let timer = null
    versionRef.current = -1
    lastInteractionAtRef.current = Date.now()
    const schedule = () => {
      if (!alive) return
      clearTimeout(timer)
      timer = setTimeout(tick, sharedBoardPollDelay(lastInteractionAtRef.current))
    }
    const tick = async () => {
      if (!alive) return
      if (document.hidden) return
      if (pulling) {
        schedule()
        return
      }
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
            const rendered = applyPendingBoardOps(normalized, pendingEntriesRef.current)
            boardRef.current = rendered
            setBoard(rendered)
          }
        }
        if (state.object) {
          const nextMembers = memberRecords(state.object)
          if (nextMembers) setMembers(nextMembers)
        }
        if (pendingEntriesRef.current.length === 0) setSyncNote('')
      } catch (e) {
        setSyncNote('Reconnecting — showing your last copy')
      } finally {
        pulling = false
        schedule()
      }
    }
    tick()
    const onVis = () => {
      if (document.hidden) return
      lastInteractionAtRef.current = Date.now()
      clearTimeout(timer)
      tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [share, boardId])

  const mutate = useCallback((operation, onCommit) => {
    const entry = shareRef.current
    if (!boardAccess(entry, onlineRef.current).canWrite) return false
    const current = boardRef.current
    if (!current) return false
    const before = structuredClone(current)
    const apply = base => applyBoardOp(base, operation)
    const optimistic = apply(structuredClone(current)) || current

    // Offline intent belongs to the app. Each operation gets its own app-
    // storage document, avoiding the browser-only queue that could become
    // stranded or be overwritten by another frame.
    const runtimeOnline = onlineRef.current && window.mobius?.online !== false
    const alreadyQueued = pendingEntriesRef.current.length > 0
    if (alreadyQueued || (!entry && !runtimeOnline)) {
      boardRef.current = optimistic
      setBoard(optimistic)
      pendingRef.current += 1
      writeChain.current = writeChain.current.catch(() => {}).then(async () => {
        const queued = await enqueuePendingBoardOp(boardId, operation)
        pendingEntriesRef.current = [...pendingEntriesRef.current, queued]
          .sort((left, right) => left.id.localeCompare(right.id))
        const count = pendingEntriesRef.current.length
        setQueuedCount(count)
        setSyncNote(`${count} change${count === 1 ? '' : 's'} waiting to sync`)
      }).catch(error => {
        boardRef.current = before
        setBoard(before)
        setSyncNote('Offline change was not saved')
        window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-queue' })
      }).finally(() => { pendingRef.current -= 1 })
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
      try {
        const landed = await createBoardRepository({ storage: window.mobius.storage }).mutate(boardId, operation)
        if (landed.authority === 'shared') versionRef.current = sharedCursorAfterWrite(landed)
        settled = landed.doc
        onCommit?.()
        return
      } catch (error) {
        const retryable = isRetryableBoardError(error)
        if (entry) versionRef.current = -1
        if (!retryable) {
          window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'save' })
          settled = before
          setSyncNote(String(error?.message || 'Change could not be applied'))
          return
        }
        onErr(error)
      }
      // The connection can disappear after the click but before durableWrite.
      // Convert that unconfirmed attempt into our own replayable queue.
      try {
        const queued = await enqueuePendingBoardOp(boardId, operation)
        pendingEntriesRef.current = [...pendingEntriesRef.current, queued]
          .sort((left, right) => left.id.localeCompare(right.id))
        setQueuedCount(pendingEntriesRef.current.length)
        setSyncNote('Change saved locally — reconnecting')
        settled = optimistic
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
              const rendered = applyPendingBoardOps(v, pendingEntriesRef.current)
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
  // the local or shared authority confirms it landed. The interval also retries
  // transient reconnects without requiring another online/offline transition.
  useEffect(() => {
    if (!online) return undefined
    let alive = true
    const flush = () => {
      if (!alive || replayingRef.current || pendingEntriesRef.current.length === 0) return
      replayingRef.current = true
      writeChain.current = writeChain.current.catch(() => {}).then(async () => {
        const result = await replayPendingBoardOps(
          boardId,
          async op => {
            try {
              const landed = await createBoardRepository({ storage: window.mobius.storage }).mutate(boardId, op)
              if (landed.authority === 'shared') versionRef.current = sharedCursorAfterWrite(landed)
              return { status: 'landed', doc: landed.doc }
            } catch (error) {
              window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-replay' })
              return replayOutcomeForBoardError(error)
            }
          },
          {
            onLanded: (landed, remaining) => {
              pendingEntriesRef.current = remaining
              if (!alive || dragRef.current) return
              const rendered = remaining.reduce(
                (doc, entry) => applyBoardOp(doc, entry.op) || doc,
                structuredClone(landed),
              )
              boardRef.current = rendered
              setBoard(rendered)
            },
            onDiscarded: error => {
              setSyncNote(String(error?.message || 'An outdated change could not be applied'))
            },
          },
        )
        if (!alive) return
        pendingEntriesRef.current = result.entries
        setQueuedCount(result.pending)
        if (result.discarded) {
          try {
            const fresh = await createBoardRepository({ storage: window.mobius.storage }).read(boardId)
            const rendered = applyPendingBoardOps(fresh.doc, result.entries)
            boardRef.current = rendered
            setBoard(rendered)
            setSyncNote(`${result.discarded} outdated change${result.discarded === 1 ? '' : 's'} skipped`)
          } catch (error) {
            versionRef.current = -1
            setSyncNote('An outdated change was skipped — refreshing the board')
            window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-refresh' })
          }
        } else {
          setSyncNote(result.ok ? '' : `${result.pending} change${result.pending === 1 ? '' : 's'} could not sync — retrying`)
        }
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
        {share && <BoardPresence members={members} onOpen={() => setShareOpen(true)} />}
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
      {board.columns.length > 1 && <nav className="kb-list-nav" aria-label="Jump to list">
        {board.columns.map(column => <button
          key={column.id}
          className="kb-list-jump"
          aria-label={`Go to list ${column.name}`}
          onClick={() => {
            const lane = Array.from(boardScrollRef.current?.children || [])
              .find(element => element.dataset.colId === column.id)
            lane?.scrollIntoView({ block: 'nearest', inline: 'start', behavior: 'auto' })
          }}
        >
          <span className="kb-col-status" aria-hidden="true" style={{ background: LABELS[column.color] || 'var(--muted)' }} />
          <span className="kb-list-jump-name">{column.name}</span>
          <span className="kb-list-jump-count">{column.cardIds.length}</span>
        </button>)}
      </nav>}
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
              className={`kb-filter-label-btn${active ? ' kb-on' : ''}`}
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
              <span>{name === 'none' ? 'Unlabeled' : name}</span>
            </button>
          })}
        </div>
        {hasFilters && <button className="kb-btn kb-btn-quiet kb-clear-filters" onClick={() => { setFilterText(''); setFilterLabels([]) }}>Clear filters</button>}
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
          <div ref={cardSheetRef} tabIndex={-1} className="kb-sheet kb-card-sheet" role="dialog" aria-modal="true" aria-label="Card details">
            <div className="kb-card-toolbar kb-mobile-only">
              <span className="kb-card-toolbar-title">Card details</span>
              <button className="kb-btn kb-btn-primary kb-card-toolbar-done" type="button" onClick={() => setOpenCardId(null)}>Done</button>
            </div>
            <div className="kb-sheet-grab kb-desktop-only" />
            <AutoGrowTextarea
              className="kb-input kb-title-input"
              rows={1}
              defaultValue={openCard_.title}
              key={`st-${openCard_.id}`}
              valueKey={`${openCard_.id}:${openCard_.title}`}
              aria-label="Card title"
              readOnly={!access.canWrite}
              onCommit={value => { const next = value.trim(); if (next && next !== openCard_.title) updateCard(openCard_.id, { title: next }) }}
            />
            <AutoGrowTextarea
              className="kb-input kb-notes-input"
              rows={2}
              expandOnFocus
              placeholder="Notes…"
              defaultValue={openCard_.notes}
              key={`sn-${openCard_.id}`}
              valueKey={`${openCard_.id}:${openCard_.notes}`}
              aria-label="Card notes"
              readOnly={!access.canWrite}
              onCommit={value => { if (value !== openCard_.notes) updateCard(openCard_.id, { notes: value }) }}
            />

            <div>
              <div className="kb-section-heading">
                <h3>Checklist</h3>
                {Array.isArray(openCard_.checklist) && openCard_.checklist.length > 0 && <span>
                  {openCard_.checklist.filter(item => item.done).length}/{openCard_.checklist.length}
                </span>}
              </div>
              <ChecklistEditor
                checklist={Array.isArray(openCard_.checklist) ? openCard_.checklist : []}
                canWrite={access.canWrite}
                onAdd={text => addCheckItem(openCard_.id, text)}
                onToggle={itemId => toggleCheckItem(openCard_.id, itemId)}
                onDelete={itemId => removeCheckItem(openCard_.id, itemId)}
              />
            </div>

            <div className="kb-property-list kb-mobile-only">
              <div className="kb-property-row">
                <span className="kb-property-label">Due date</span>
                <input
                  className="kb-property-control kb-date-input"
                  type="date"
                  value={openCard_.due || ''}
                  aria-label="Card due date"
                  readOnly={!access.canWrite}
                  onChange={event => updateCard(openCard_.id, { due: event.target.value })}
                />
              </div>
              <div className="kb-property-row">
                <span className="kb-property-label">Assignee</span>
                <AssigneePicker
                  card={openCard_}
                  canWrite={access.canWrite}
                  members={members}
                  share={share}
                  onUpdate={patch => updateCard(openCard_.id, patch)}
                />
              </div>
              {access.canWrite && <details className="kb-property-details">
                <summary className="kb-property-row">
                  <span className="kb-property-label">Label</span>
                  <span className="kb-property-value">
                    {(openCard_.label || 'none') === 'none'
                      ? 'None'
                      : <><span className="kb-property-dot" style={{ background: LABELS[openCard_.label] }} />{openCard_.label}</>}
                    <ChevronDown aria-hidden="true" />
                  </span>
                </summary>
                <div className="kb-swatches kb-property-options">
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
              </details>}
            </div>

            {openCardColumn && <div className="kb-status-block kb-mobile-only">
              <h3>Status</h3>
              {access.canWrite ? <div className="kb-status-seg" role="radiogroup" aria-label="Card status">
                {board.columns.map(column => {
                  const here = column.cardIds.includes(openCard_.id)
                  return <button
                    key={column.id}
                    type="button"
                    role="radio"
                    aria-checked={here}
                    className={here ? 'is-active' : ''}
                    onClick={() => { if (!here) { moveCard(openCard_.id, column.id, null); setOpenCardId(null) } }}
                  >{column.name}</button>
                })}
              </div> : <div className="kb-property-row kb-status-readonly">
                <span className="kb-property-label">Status</span>
                <span className="kb-property-value">{openCardColumn.name}</span>
              </div>}
            </div>}

            <div className="kb-card-meta-grid kb-desktop-only">
              <div className="kb-card-field">
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
              <div className="kb-card-field">
                <h3>Assignee</h3>
                <AssigneePicker
                  card={openCard_}
                  canWrite={access.canWrite}
                  members={members}
                  share={share}
                  onUpdate={patch => updateCard(openCard_.id, patch)}
                />
              </div>
            </div>
            {access.canWrite && <div className="kb-desktop-only">
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
            {access.canWrite && openCardColumn && <div className="kb-desktop-only">
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
            {access.canWrite && <div className="kb-desktop-only">
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
            {access.canWrite && <div className="kb-card-danger-zone kb-mobile-only">
              <button className="kb-btn kb-btn-danger kb-delete-card" onClick={() => deleteCard(openCard_.id)}>
                <Trash aria-hidden="true" />
                Delete card
              </button>
            </div>}

            <div className="kb-sheet-row kb-sheet-row-between kb-card-actions kb-desktop-only">
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
          onRefreshMembers={refreshMembers}
          onShared={onShared}
          beforeShare={async () => {
            await writeChain.current.catch(() => {})
            const pending = (await readPendingBoardOps(boardId)).length
            if (pending) throw new Error(`Reconnect before sharing so ${pending} pending change${pending === 1 ? '' : 's'} can sync.`)
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  )
}

import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, Filter, Grid, MagnifyingGlassSearch, Paperclip, Plus, PullRequestOpen, Share, SquareCheckCheckboxChecked, Trash, User, X } from '@openai/apps-sdk-ui/components/Icon'
import { uid, subscribeBoard, getBoard, boardPath, normalizeBoard, loadUi, saveBoardView, saveListFolds, saveSeenCards, loadAssignmentLog, subscribeAssignmentLog, updateAssignmentLog } from '../storage.js'
import {
  assignmentRef,
  cardAssignment,
  cardAssignmentTimeline,
  cardMatchesView,
  createAssignmentEvent,
  hasAssignment,
  isAssignedToMe,
  nextAssignmentLog,
  normalizeBoardView,
  sameAssignment,
} from '../assignment.js'
import { loadMemberAvatar, resolveMemberHandles, pullShared, createInvite, inviteByHandle, getMembers, revokeCollaborator, groupCollaborators, collaboratorForHost, selfCollaborator, inviteDeliveryNotice, shareBoard, cacheSubscriptionIsAuthoritative, rememberSharedState, sharedBoardPollDelay, acceptSharedPoll, createSharedRefreshLifecycle } from '../sync.js'
import { applyBoardOp, columnMoveAnchor, cardPullUrls, hasExternalNotes } from '../operations.js'
import { mergeActivity, MAX_NOTES_CHARS } from '../activity.js'
import { parsePullRequestUrl, pullRequestStatus } from '../prMatching.js'
import { acknowledgeRecoveredBoardOps, applyPendingBoardOps, enqueuePendingBoardOp, readPendingBoardOps, readRecoveredBoardOps, exportUnsyncedBoardOps, replayPendingBoardOps, hasRecoverableBoardOps } from '../pendingOps.js'
import { createBoardRepository, isRetryableBoardError, replayOutcomeForBoardError } from '../boardRepository.js'
import {
  deleteCardAttachment,
  consumeAttachmentPaste,
  loadCardAttachment,
  MAX_CARD_ATTACHMENTS,
  saveCardAttachment,
} from '../attachments.js'
import { useModalFocus } from './modalFocus.js'
import { appVisible, onAppVisibilityChange } from '../visibility.js'
import {
  AttachmentImage, AttachmentsSection, CardActivity, cardTimeline, CardTileAttachment, ChecklistSection, DescriptionSection, DueChip, dueTone,
  InlineCardText, LabelChip, LinkifiedText, MenuButton, PullRequestSection, SavedIndicator, StatusPill,
} from './CardParts.jsx'
import {
  assigneeAvatar,
  cardAssigneeLabel,
  boardAccess,
  boardCapacity,
  boardFingerprints,
  cardFingerprint,
  changedCardIds,
  COLUMN_COLOR_KEYS,
  cardMatchesFilters,
  checklistProgress,
  defaultColumnColor,
  dueDateStatus,
  formatDueDate,
  labelDisplayName,
  listIsFolded,
  visibleToFullIndex,
} from '../domain.js'

// A list's colour: none (grey) or one of the label colours.
const LIST_COLOURS = [[null, 'No colour'], ...COLUMN_COLOR_KEYS.map(key => [key, key.charAt(0).toUpperCase() + key.slice(1)])]

export const LABELS = {
  none: 'transparent',
  red: 'var(--kb-label-red, #ef4444)',
  amber: 'var(--kb-label-amber, #f59e0b)',
  green: 'var(--kb-label-green, #10b981)',
  blue: 'var(--kb-label-blue, #3b82f6)',
  purple: 'var(--kb-label-purple, #8b5cf6)',
  pink: 'var(--kb-label-pink, #ec4899)',
}

// A card on the board reads top to bottom like the open card: the full title,
// the start of the description, one attachment, then a details row (label,
// due date, checklist, pull requests, attachment count, person) when any of
// those are set.
function Card({ boardId, share, card, labelNames, mine, changed, assigneeLabel, assigneeMember, lifted, onOpen, onDragStart, canWrite }) {
  const dueStatus = dueDateStatus(card.due)
  const progress = checklistProgress(card.checklist)
  const assignee = (assigneeLabel ?? card.assignee)?.trim()
  const notePreview = String(card.notes || '').trim()
  const attachments = card.attachments || []
  const pullCount = cardPullUrls(card).length
  const labelled = card.label && card.label !== 'none' && LABELS[card.label]
  const hasDetails = Boolean(labelled || dueStatus || progress.total || pullCount || attachments.length || assignee)
  // On a phone a person who is the card's only detail sits beside the title instead of on a row of their own.
  const personOnly = Boolean(assignee) && !(labelled || dueStatus || progress.total || pullCount || attachments.length)
  return (
    <div
      className={`kb-card${mine ? ' is-mine' : ''}${personOnly ? ' is-person-only' : ''}${lifted ? ' kb-lifted' : ''}${canWrite ? '' : ' kb-readonly'}`}
      data-card-id={card.id}
      onPointerDown={canWrite ? e => { if (!e.target.closest('a')) onDragStart(e, card.id) } : undefined}
    >
      <button type="button" className="kb-card-open" aria-label={`Open card details: ${card.title}`} onClick={() => onOpen(card.id)} />
      <div className="kb-card-title">
        {changed && <span className="kb-card-new" role="img" aria-label="Changed since you last looked" />}
        <LinkifiedText text={card.title} compactLinks />
      </div>
      {notePreview && <div className="kb-card-notes">{notePreview}</div>}
      <CardTileAttachment boardId={boardId} share={share} attachments={attachments} />
      {hasDetails && <div className="kb-card-meta">
        {labelled && <span className="kb-card-label" style={{ '--kb-lc': LABELS[card.label] }} title={labelDisplayName(card.label, labelNames)}
          aria-label={`Label: ${labelDisplayName(card.label, labelNames)}`}>{labelNames?.[card.label] || ''}</span>}
        {dueStatus && <span className={`kb-due kb-due-${dueStatus} kb-due-tone-${dueTone(card.due)}`}>{formatDueDate(card.due)}</span>}
        {progress.total > 0 && <span className={`kb-card-count${progress.done === progress.total ? ' is-complete' : ''}`} aria-label={`Checklist: ${progress.done} of ${progress.total} done`}>
          <SquareCheckCheckboxChecked aria-hidden="true" />{progress.done}/{progress.total}
        </span>}
        {pullCount > 0 && <span className="kb-card-count" aria-label={`${pullCount} pull request${pullCount === 1 ? '' : 's'}`}>
          <PullRequestOpen aria-hidden="true" />{pullCount}
        </span>}
        {attachments.length > 0 && <span className="kb-card-count" aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}>
          <Paperclip aria-hidden="true" />{attachments.length}
        </span>}
        <span className="kb-card-meta-spacer" />
        {assignee && <MemberAvatar member={assigneeMember || { name: assignee }} className="kb-avatar" presence={false} />}
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
      member_id: value.member_id || key,
      host: String(value.host || value.host_key || value.member_host || (fromArray ? '' : key) || '').trim(),
      handle: String(value.handle || '').trim(),
      name: String(value.name || value.displayName || value.display_name || '').trim(),
      role: String(value.role || '').trim(),
      collaborator_id: value.collaborator_id || null,
      host_owner: value.host_owner === true,
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

function MemberAvatar({ member, small = false, className = '', presence = true }) {
  const label = memberLabel(member) || 'Board member'
  const avatar = assigneeAvatar(label)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [member.avatar])

  const showPhoto = member.avatar && !failed
  return <span
    className={`kb-member-avatar${small ? ' kb-member-avatar-small' : ''} ${className}`}
    style={{
      background: showPhoto ? 'transparent' : avatar.background,
      color: avatar.color,
    }}
    title={label}
    role="img"
    aria-label={label}
  >
    {showPhoto ? (
      <img
        className="kb-avatar-photo"
        src={member.avatar}
        alt=""
        onError={() => setFailed(true)}
      />
    ) : avatar.initials}
    {presence && member.active && <span className="kb-presence-dot" aria-label="Active now" />}
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

function BoardSwitcher({ board, boardId, boards, shareMap, canWrite, open, onOpenChange, onRename, onSelect, onCreate, onAllBoards }) {
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
            {/* Phones have no grid button in the header, so all boards are reached from here. */}
            <button className="kb-switcher-row kb-switcher-all" onClick={() => { onOpenChange(false); onAllBoards() }}>
              <Grid />
              <span className="kb-switcher-row-title">All boards</span>
            </button>
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

// `chip` is the card sheet's details row; the default is the labelled picker.
function AssigneePicker({ card, canWrite, members, share, onUpdate, chip = false }) {
  const rootRef = useRef(null)
  const searchRef = useRef(null)
  const [open, setOpen] = useState(false)
  const menuRef = useModalFocus(open, () => setOpen(false))
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState(undefined)
  const joined = (members || []).filter(member => !member.pending && member.host)
  const selectedMember = collaboratorForHost(joined, card.assigneeHost)
  const selectedLabel = cardAssigneeLabel(card, joined)
  const selfMember = selfCollaborator(joined, share)
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
    const prevWidth = window.innerWidth
    const closeOnResize = () => { if (window.innerWidth !== prevWidth) setOpen(false) }
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
      left: `${Math.max(16, Math.min(chip ? rect.left : rect.right - 320, window.innerWidth - 336))}px`,
    } : undefined)
    setOpen(true)
  }

  // A viewer has nothing to choose, so an empty chip would only look actionable.
  if (chip && !canWrite && !selectedLabel) return null
  return (
    <div className={chip ? 'kb-chip-wrap kb-assignee-picker' : 'kb-assignee-picker'} ref={rootRef}>
      {chip ? <button
        type="button"
        className={`kb-detail-chip${selectedLabel ? ' kb-assignee-chip' : ' is-empty'}`}
        aria-label={selectedLabel ? `Assignee: ${selectedLabel}. Change assignee` : 'Add assignee'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!canWrite}
        onClick={() => canWrite && togglePicker()}
      >
        {selectedLabel
          ? <><MemberAvatar member={selectedMember || { name: selectedLabel }} className="kb-chip-avatar" presence={false} />{selectedLabel}</>
          : <><Plus aria-hidden="true" />Add assignee</>}
      </button> : <button
        type="button"
        className="kb-assignee-trigger"
        aria-label={selectedLabel ? `Assignee: ${selectedLabel}` : 'Choose assignee'}
        title={selectedLabel || 'Unassigned'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!canWrite}
        onClick={() => canWrite && togglePicker()}
      >
        {selectedLabel
          ? <MemberAvatar member={selectedMember || { name: selectedLabel }} className="kb-assignee-avatar" presence={false} />
          : <span className="kb-assignee-avatar kb-assignee-avatar-empty"><User aria-hidden="true" /></span>}
        <span className={`kb-assignee-trigger-label${selectedLabel ? '' : ' is-empty'}`}>{selectedLabel || 'Unassigned'}</span>
        {canWrite && <ChevronDown aria-hidden="true" />}
      </button>}
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
              {selfMember ? <MemberAvatar member={selfMember} small presence={false} /> : <span className="kb-assignee-option-icon"><User aria-hidden="true" /></span>}
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
              <MemberAvatar member={{ name: privateName }} className="kb-assignee-avatar" presence={false} />
              <span className="kb-assignee-option-copy"><strong>Assign “{privateName}”</strong><small>Use this name</small></span>
            </button>}
            {share && visibleMembers.length === 0 && <div className="kb-assignee-empty">No matching people</div>}
          </div>
        </div>
      </>, document.body)}
    </div>
  )
}

const BOARD_VIEW_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'changed', label: 'Changed' },
  { id: 'unassigned', label: 'Unassigned' },
]

// Phones show one chip instead of the view switch and filter button: it names
// the cards being shown and opens both in one sheet. A purple dot means cards
// changed since you last looked.
function ShowCardsChip({ view, counts, filtered, open, onOpen }) {
  const label = BOARD_VIEW_OPTIONS.find(option => option.id === view)?.label || 'All'
  const changedElsewhere = view !== 'changed' && counts.changed > 0
  return (
    <button
      type="button"
      className={`kb-show-chip${filtered ? ' is-filtered' : ''}${view === 'mine' || view === 'changed' ? ' is-you' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Showing ${label.toLocaleLowerCase()} cards, ${counts[view]}${filtered ? ', filtered' : ''}${changedElsewhere ? `, ${counts.changed} changed since you last looked` : ''}. Change what is shown.`}
      onClick={onOpen}
    >
      <span>{label}</span>
      <span className="kb-show-count" aria-hidden="true">{counts[view]}</span>
      {filtered && <Filter aria-hidden="true" />}
      <ChevronDown aria-hidden="true" />
      {changedElsewhere && <span className="kb-show-dot" aria-hidden="true" />}
    </button>
  )
}

function BoardViewSwitch({ view, counts, onChange }) {
  return (
    <div className="kb-view-switch" role="group" aria-label="Show cards">
      {BOARD_VIEW_OPTIONS.map(option => (
        <button
          key={option.id}
          type="button"
          // Purple marks what is about you: your cards, and what changed since you looked.
          className={`kb-view-option${(option.id === 'mine' || option.id === 'changed') && counts[option.id] > 0 ? ' is-you' : ''}`}
          aria-pressed={view === option.id}
          aria-label={`${option.id === 'mine' ? 'My cards' : option.id === 'changed' ? 'Cards changed since you last looked' : `${option.label} cards`}, ${counts[option.id]}`}
          onClick={() => onChange(option.id)}
        >
          <span>{option.label}</span>
          <span className="kb-view-count" aria-hidden="true">{counts[option.id]}</span>
        </button>
      ))}
    </div>
  )
}

function CardTitleEditor({ card, canWrite, onCommit, onCancel }) {
  const commitTitle = value => {
    const title = value.trim()
    // Blank existing titles are rejected; untitled drafts remain unpersisted.
    if (!title) return card.title || ''
    if (title !== card.title && onCommit(title) === false) return false
    return title
  }

  return (
    <div className="kb-detail-field kb-title-field">
      {canWrite ? (
        <InlineCardText
          key={card.id}
          className="kb-title-display kb-editable-field"
          value={card.title}
          autoFocus={!card.title}
          placeholder="Card title…"
          label="Card title"
          onCommit={commitTitle}
          onCancel={() => {
            if (!card.title) onCancel?.()
          }}
        />
      ) : (
        <div className="kb-title-display">{card.title}</div>
      )}
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
      if (e.publication) onShared(e.publication)
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
      const copied = await window.mobius?.clipboard?.writeText(inviteLink)
      if (!copied) { setNotice({kind:'warn',text:'Select the invite link below to copy it.'}); return }
      setNotice({ kind: 'ok', text: 'Invite link copied.' })
    } catch { /* the read-only field remains selectable for manual copy */ }
  }

  return (
    <>
      <div className="kb-scrim" onClick={onClose} />
      <div ref={sheetRef} tabIndex={-1} className="kb-sheet" role="dialog" aria-modal="true" aria-label="Share board">
        <div className="kb-sheet-grab" />
        {(!share || share.publishing) && (
          <>
            <h3>Share this board</h3>
            <div className="kb-empty kb-empty-left">
              Sharing keeps the board on your Möbius and lets people you invite
              edit it live from their own Möbius.
            </div>
            <button className="kb-btn kb-btn-primary" disabled={busy} onClick={start}>
              {busyAction === 'sharing' ? 'Turning on sharing…' : share?.publishing ? 'Finish sharing' : 'Turn on sharing'}
            </button>
          </>
        )}
        {share && hosted && !share.publishing && (
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
                        {m.host_owner ? 'You' : m.pending ? 'Invite pending' : m.active ? 'Active now' : 'Not active'}
                        <span aria-hidden="true"> · </span>{m.role === 'viewer' ? 'Can view' : 'Can edit'}
                        {m.hosts?.length > 1 && <> · {m.hosts.length} deployments</>}
                      </span>
                    </span>
                    {!m.host_owner && (
                      <button className="kb-btn kb-btn-quiet kb-danger" title={m.collaborator_id ? 'Remove access from all invited deployments' : 'Remove access'} onClick={async () => {
                        try { await revokeCollaborator(share.oid, m); onMembersChange(ms => (ms || []).filter(member => member.member_id !== m.member_id)) } catch (e) { setNotice({ kind: 'error', text: String(e?.message || e) }) }
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

function sameMembers(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

// Memoized: App re-renders on its own state (invitations, online, share map)
// and a full board render is expensive.
export default memo(function Board({
  token,
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
  const [openCardId, setOpenCardId] = useState(null)
  const [draftCard, setDraftCard] = useState(null)
  const [previewAttachment, setPreviewAttachment] = useState(null)
  // The picture viewer is the foremost dialog while open, so Escape closes the
  // picture rather than the card underneath it.
  const lightboxRef = useModalFocus(Boolean(previewAttachment), () => setPreviewAttachment(null))
  const [confirmDeleteCol, setConfirmDeleteCol] = useState(null)
  const [confirmDeleteCard, setConfirmDeleteCard] = useState(false)
  const [drag, setDrag] = useState(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [syncNote, setSyncNote] = useState('')
  const [availability, setAvailability] = useState({ kind: 'loading', message: '' })
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [filtersOpen, setFiltersOpen] = useState(false)
  // On a phone the view switch and the filters share one sheet behind the Show chip.
  const [showOpen, setShowOpen] = useState(false)
  const showSheetRef = useModalFocus(showOpen, () => setShowOpen(false))
  const [filterText, setFilterText] = useState('')
  const [filterLabels, setFilterLabels] = useState([])
  const [boardView, setBoardView] = useState('all')
  // On a phone one list fills the screen: the tab for the list in view is
  // highlighted and carries that list's menu. A list's own header shows only
  // while it is being renamed.
  const [activeColumnId, setActiveColumnId] = useState(null)
  const [renamingColumnId, setRenamingColumnId] = useState(null)
  const listNavRef = useRef(null)
  // What this person last saw on each card (fingerprints), or null until the
  // first visit sets the baseline. `seenReady` turns true once it has loaded.
  const [seenCards, setSeenCards] = useState(null)
  const [seenReady, setSeenReady] = useState(false)
  const seenRef = useRef(null)
  const seenSaveRef = useRef(null)
  const markSeenRef = useRef(() => {})
  const [assignmentLog, setAssignmentLog] = useState(null)
  const [assignmentUndo, setAssignmentUndo] = useState(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [members, setMembers] = useState(null)
  const [identity, setIdentity] = useState(null)
  const [verifiedHandles, setVerifiedHandles] = useState({})
  const [memberAvatars, setMemberAvatars] = useState({})
  const [animateColumns, setAnimateColumns] = useState(true)
  const [queuedCount, setQueuedCount] = useState(0)
  const [recoveredCount, setRecoveredCount] = useState(0)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const [attachmentDropActive, setAttachmentDropActive] = useState(false)
  const [pullStatuses, setPullStatuses] = useState({})
  const [pullStatusRefresh, setPullStatusRefresh] = useState(0)
  // What the board document does not carry for the open card: a long shared
  // description's full text and the card's activity (boardRepository.readCard).
  // The ref is the source of truth for chained saves; state drives rendering.
  const [cardDetails, setCardDetails] = useState(null)
  const cardDetailsRef = useRef(null)
  const detailsCacheRef = useRef(new Map())
  const [savedTick, setSavedTick] = useState(0)
  // Personal fold choices on this board. Done starts folded until opened.
  const [listFolds, setListFolds] = useState(() => ({ folded: new Set(), opened: new Set() }))
  const [columnDrag, setColumnDrag] = useState(null) // { columnId, dx, overIndex }
  // A description conflict waits for the owner's choice: a board refresh
  // never clears it (only opening another card or choosing does). The ref
  // lets the details loader see it without reloading on every change.
  const [notesConflict, setNotesConflictState] = useState(null)
  const notesConflictRef = useRef(null)
  const setNotesConflict = conflict => {
    notesConflictRef.current = conflict
    setNotesConflictState(conflict)
  }
  const [notesError, setNotesError] = useState('')
  // The description text and version the open editor started from (see saveCardNotes).
  const notesEditBaseRef = useRef(null)

  const boardRef = useRef(null)
  const boardScrollRef = useRef(null)
  const pendingRef = useRef(0)
  const writeChain = useRef(Promise.resolve())
  const dragRef = useRef(null)
  const rectsRef = useRef(null)
  const confirmedSharedRef = useRef(null)
  // The confirmed snapshot and board object last rendered by polling. A newer
  // confirmation may arrive while a drag suppresses rendering.
  const pollRenderedRef = useRef(null)
  const availabilityRef = useRef(availability)
  const shareRef = useRef(share)
  const onlineRef = useRef(online)
  const cardVisibleRef = useRef(() => true)
  const replayingRef = useRef(false)
  const pendingEntriesRef = useRef([])
  const lastInteractionAtRef = useRef(Date.now())
  const fileInputRef = useRef(null)
  const cardSheetRef = useModalFocus(Boolean(openCardId), () => { setOpenCardId(null); setDraftCard(null) })
  useEffect(() => { setConfirmDeleteCard(false) }, [openCardId])

  const showDetails = details => {
    cardDetailsRef.current = details
    setCardDetails(details)
    if (details?.cardId && details.status !== 'loading') detailsCacheRef.current.set(details.cardId, details)
  }
  const updateDetails = (cardId, change) => {
    const current = cardDetailsRef.current
    if (current?.cardId === cardId) showDetails(change(current))
    else if (detailsCacheRef.current.has(cardId)) detailsCacheRef.current.set(cardId, change(detailsCacheRef.current.get(cardId)))
  }
  // A committed edit's activity joins the open card's timeline without a re-read.
  const noteActivity = result => {
    if (result?.status === 'saved' && result.cardId && result.entries?.length) {
      updateDetails(result.cardId, details => ({ ...details, activity: mergeActivity(details.activity, result.entries) }))
    } else if (result?.status === 'unsupported' && result.cardId) {
      updateDetails(result.cardId, details => ({ ...details, status: 'unsupported' }))
    }
  }

  useEffect(() => {
    detailsCacheRef.current = new Map()
    notesEditBaseRef.current = null
  }, [boardId])

  useEffect(() => {
    setNotesConflict(null)
    setNotesError('')
  }, [boardId, openCardId])

  // The newest description edit for a card still waiting in the queue.
  const queuedNotesFor = cardId => pendingEntriesRef.current.findLast(({ op }) => op?.type === 'update-card'
    && op.cardId === cardId && typeof op.patch?.notes === 'string')?.op.patch.notes

  // Loads on open and again when the card's description changes on the board
  // (someone else saved it) or a queued edit of it lands; a cached copy shows
  // at once in the meantime. While a conflict waits for a choice, the sheet
  // keeps showing the owner's text and the newest saved text becomes "theirs"
  // for that choice.
  const openCardSaved = Boolean(openCardId && board?.cards?.[openCardId])
  const openCardNotesKey = openCardSaved
    ? `${board.cards[openCardId].notes}\u0000${board.cards[openCardId].notesLength ?? ''}\u0000${queuedNotesFor(openCardId) ?? ''}`
    : ''
  useEffect(() => {
    if (!openCardSaved) { showDetails(null); return undefined }
    let alive = true
    const cardId = openCardId
    const cached = detailsCacheRef.current.get(cardId)
    if (cardDetailsRef.current?.cardId !== cardId) showDetails(cached || { cardId, status: 'loading', notes: null, notesVersion: null, activity: [] })
    createBoardRepository({ storage: window.mobius.storage }).readCard(boardId, cardId)
      .then(details => {
        if (!alive) return
        const conflict = notesConflictRef.current
        if (conflict?.cardId === cardId && typeof details.notes === 'string') {
          setNotesConflict({ ...conflict, theirs: details.notes, notesVersion: details.notesVersion })
          updateDetails(cardId, current => ({ ...current, activity: details.activity }))
          return
        }
        showDetails({ cardId, ...details })
      })
      .catch(() => {
        if (alive && cardDetailsRef.current?.cardId === cardId && cardDetailsRef.current.status === 'loading') {
          showDetails({ cardId, status: 'error', notes: null, notesVersion: null, activity: [] })
        }
      })
    return () => { alive = false }
  }, [boardId, openCardId, openCardSaved, openCardNotesKey])
  const columnConfirmRef = useModalFocus(confirmDeleteCol, () => setConfirmDeleteCol(null))
  const deleteCardButtonRef = useRef(null)
  const closeDeleteCardConfirm = () => {
    setConfirmDeleteCard(false)
    requestAnimationFrame(() => deleteCardButtonRef.current?.focus())
  }
  const cardDeleteConfirmRef = useModalFocus(confirmDeleteCard, closeDeleteCardConfirm)
  boardRef.current = board
  shareRef.current = share
  onlineRef.current = online
  const publishAvailability = useCallback(next => {
    availabilityRef.current = next
    setAvailability(next)
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/identity', { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (active) setIdentity(value) })
      .catch(() => { if (active) setIdentity(null) })
    return () => { active = false }
  }, [token])

  const localDeploymentHost = (() => {
    const deployments = Array.isArray(identity?.deployments) ? identity.deployments : []
    const current = deployments.find(item => item?.current === true) || deployments[0]
    try { return current?.url ? new URL(current.url).hostname : window.location.hostname } catch { return window.location.hostname }
  })()
  const profile = identity?.profile || {}
  const profileHandle = String(profile.handle || '').trim().replace(/^@/u, '')
  const profileName = String(profile.display_name || '').trim()
  const profileHostsKey = JSON.stringify([...new Set((members || [])
    .filter(member => !member.handle && !String(member.name || '').startsWith('@'))
    .flatMap(member => member.hosts || [member.host])
    .filter(host => host && host !== localDeploymentHost))].sort())

  useEffect(() => {
    const controller = new AbortController()
    resolveMemberHandles(JSON.parse(profileHostsKey), token, fetch, controller.signal)
      .then(handles => { if (!controller.signal.aborted) setVerifiedHandles(handles) })
    return () => controller.abort()
  }, [profileHostsKey, token])

  const avatarHostsKey = JSON.stringify((members || [])
    .filter(member => !member.pending && member.host)
    .map(member => {
      const isLocalAccount = (member.hosts || [member.host]).includes(localDeploymentHost)
      const avatarHost = isLocalAccount ? localDeploymentHost : member.host
      return [member.host, avatarHost]
    })
    .sort(([a], [b]) => a.localeCompare(b)))
  useEffect(() => {
    const controller = new AbortController()
    const hosts = JSON.parse(avatarHostsKey)
    // Bound concurrent optional image reads; publish each as it arrives.
    let cursor = 0
    const worker = async () => {
      while (cursor < hosts.length && !controller.signal.aborted) {
        const [host, avatarHost] = hosts[cursor++]
        const avatar = await loadMemberAvatar(
          avatarHost, localDeploymentHost, token, fetch, controller.signal,
        )
        if (!controller.signal.aborted) {
          setMemberAvatars(previous => ({ ...previous, [host]: avatar }))
        }
      }
    }
    Promise.all(Array.from({ length: Math.min(4, hosts.length) }, worker))
    return () => controller.abort()
  }, [avatarHostsKey, localDeploymentHost, token, profile.avatar_url])

  const displayMembers = (members || []).map(record => {
    const member = { ...record, avatar: memberAvatars[record.host] || '' }
    if (localDeploymentHost && (member.hosts || [member.host]).includes(localDeploymentHost)) {
      return { ...member, handle: profileHandle || member.handle, name: profileHandle ? '' : (profileName || member.name) }
    }
    const handle = (member.hosts || [member.host]).map(host => verifiedHandles[host]).find(Boolean)
    return handle ? { ...member, handle, name: member.name === member.host ? '' : member.name } : member
  })

  const assigneeLabelForCard = card => {
    const raw = String(card?.assignee || '').trim()
    if (!raw) return raw
    const host = String(card?.assigneeHost || '').trim()
    const localMatch = (host && host === localDeploymentHost) || raw === localDeploymentHost
    if (localMatch && (profileHandle || profileName)) return profileHandle ? `@${profileHandle}` : profileName
    return cardAssigneeLabel(card, displayMembers)
  }

  // "Me" is an identity, not a name: every deployment linked to this account,
  // plus the member record this board knows us by.
  const selfMember = selfCollaborator(displayMembers, share)
  const myHosts = [...new Set([
    localDeploymentHost,
    ...(Array.isArray(identity?.deployments) ? identity.deployments : []).map(item => {
      try { return item?.url ? new URL(item.url).hostname : '' } catch { return '' }
    }),
    ...(selfMember ? (selfMember.hosts || [selfMember.host]) : []),
  ].filter(Boolean))]
  const me = { hosts: myHosts, names: [...(share ? [] : ['Me']), profileHandle].filter(Boolean) }
  const myLabel = profileHandle ? `@${profileHandle}` : selfMember ? memberLabel(selfMember) : (profileName || 'Me')
  const actorRef = share
    ? assignmentRef({ label: myLabel, host: selfMember?.host || localDeploymentHost })
    : assignmentRef({ label: 'Me' })
  const isMe = ref => hasAssignment(ref) && isAssignedToMe({ assignee: ref.label, assigneeHost: ref.host }, me)
  const nameForRef = ref => {
    if (isMe(ref)) return 'you'
    return assigneeLabelForCard({ assignee: ref.label || ref.host, assigneeHost: ref.host }) || ref.label || ref.host
  }
  const cardVisible = card => cardMatchesView(card, boardView, me, changedIds)
    && cardMatchesFilters(card, filterText, filterLabels, assigneeLabelForCard(card))
  cardVisibleRef.current = cardVisible

  useEffect(() => {
    let active = true
    setBoardView('all')
    setListFolds({ folded: new Set(), opened: new Set() })
    seenRef.current = null
    setSeenCards(null)
    setSeenReady(false)
    loadUi().then(ui => {
      if (!active) return
      setBoardView(normalizeBoardView(ui?.boardViews?.[boardId]))
      const ids = value => new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : [])
      setListFolds({ folded: ids(ui?.collapsedLists?.[boardId]), opened: ids(ui?.openedLists?.[boardId]) })
      const seen = ui?.seenCards?.[boardId]
      seenRef.current = seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : null
      setSeenCards(seenRef.current)
      setSeenReady(true)
    }).catch(() => {})
    return () => {
      active = false
      // Leaving the board saves what was seen right away instead of waiting.
      if (seenSaveRef.current) {
        clearTimeout(seenSaveRef.current.timer)
        seenSaveRef.current.save()
        seenSaveRef.current = null
      }
    }
  }, [boardId])

  // Seen fingerprints are saved shortly after they change, so opening several
  // cards in a row is one write. Cards no longer on the board are dropped.
  const rememberSeen = next => {
    seenRef.current = next
    setSeenCards(next)
    if (seenSaveRef.current) clearTimeout(seenSaveRef.current.timer)
    const forBoard = boardId
    const save = () => saveSeenCards(forBoard, next).catch(error => {
      window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'seen-cards' })
    })
    seenSaveRef.current = { save, timer: setTimeout(() => { seenSaveRef.current = null; save() }, 800) }
  }

  // The cards you open or change yourself count as seen.
  markSeenRef.current = (cardIds, source = boardRef.current) => {
    const current = seenRef.current
    if (!current || !source || !cardIds.length) return
    const prints = boardFingerprints(source)
    if (!cardIds.some(id => prints[id] && current[id] !== prints[id])) return
    const next = {}
    for (const [id, print] of Object.entries(prints)) {
      const seen = cardIds.includes(id) ? print : current[id]
      if (seen !== undefined) next[id] = seen
    }
    rememberSeen(next)
  }

  const boardLoaded = Boolean(board)
  const columnCount = board?.columns?.length || 0
  useEffect(() => {
    const scroller = boardScrollRef.current
    if (!scroller) return undefined
    let frame = 0
    const update = () => {
      frame = 0
      const origin = scroller.getBoundingClientRect().left + parseFloat(getComputedStyle(scroller).paddingLeft || '0')
      let nearest = null
      let distance = Infinity
      for (const lane of scroller.children) {
        if (!lane.dataset?.colId) continue
        const gap = Math.abs(lane.getBoundingClientRect().left - origin)
        if (gap < distance) { distance = gap; nearest = lane.dataset.colId }
      }
      setActiveColumnId(nearest)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => { scroller.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [boardId, boardLoaded, columnCount])

  // Keep the highlighted tab visible as you swipe between lists.
  useEffect(() => {
    if (!activeColumnId) return
    listNavRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
  }, [activeColumnId])

  // The first visit to a board is the baseline: nothing counts as changed yet.
  useEffect(() => {
    if (seenReady && board && !seenRef.current) rememberSeen(boardFingerprints(board))
  }, [seenReady, board])

  const changedIds = useMemo(() => changedCardIds(board, seenCards), [board, seenCards])
  // An open card stays seen, including changes made while it is open.
  const openCardPrint = openCardId && board?.cards?.[openCardId]
    ? cardFingerprint(board.cards[openCardId], board.columns.find(column => column.cardIds.includes(openCardId))?.id)
    : ''
  useEffect(() => {
    if (openCardPrint) markSeenRef.current([openCardId])
  }, [openCardId, openCardPrint, seenReady])

  const setListFolded = (columnId, fold) => {
    setListFolds(current => {
      const folded = new Set(current.folded)
      const opened = new Set(current.opened)
      if (fold) { folded.add(columnId); opened.delete(columnId) } else { folded.delete(columnId); opened.add(columnId) }
      saveListFolds(boardId, { folded: [...folded], opened: [...opened] }).catch(error => {
        window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'collapsed-lists' })
      })
      return { folded, opened }
    })
  }

  const chooseBoardView = view => {
    setBoardView(view)
    saveBoardView(boardId, view).catch(error => {
      window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'board-view' })
    })
  }

  // Changes that reach this board without a history entry are noticed here and
  // kept on this Möbius only. Private boards have no other editors.
  useEffect(() => {
    setAssignmentLog(null)
    setAssignmentUndo(null)
    if (!share) return undefined
    let active = true
    loadAssignmentLog(boardId).then(log => { if (active) setAssignmentLog(log) }).catch(() => {})
    const unsubscribe = subscribeAssignmentLog(boardId, log => { if (active) setAssignmentLog(log) })
    return () => { active = false; unsubscribe() }
  }, [boardId, share?.host, share?.oid])

  useEffect(() => {
    if (!share || !board) return undefined
    const timer = setTimeout(() => {
      const confirmed = confirmedSharedRef.current
      if (!confirmed) return
      updateAssignmentLog(boardId, log => nextAssignmentLog(log, confirmed, { makeId: uid }))
        .then(log => { if (log) setAssignmentLog(log) })
        .catch(error => window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'assignment-log' }))
    }, 800)
    return () => clearTimeout(timer)
  }, [board, boardId, share?.host, share?.oid])

  useEffect(() => {
    if (!assignmentUndo) return undefined
    const timer = setTimeout(() => setAssignmentUndo(null), 8000)
    return () => clearTimeout(timer)
  }, [assignmentUndo])

  useEffect(() => { setAttachmentError('') }, [openCardId])


  useEffect(() => {
    let active = true
    setRecoveredCount(0)
    readRecoveredBoardOps(boardId).then(entries => {
      if (active) setRecoveredCount(entries.length)
    }).catch(() => { if (active) setSyncNote('Saved edits could not be checked — your data is unchanged.') })
    return () => { active = false }
  }, [boardId, queuedCount])

  const downloadUnsyncedEdits = async () => {
    let recovery
    try {
      recovery = await exportUnsyncedBoardOps(boardId)
      const link = document.createElement('a')
      link.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(recovery, null, 2))}`
      link.download = 'kanban-unsynced-edits.json'
      link.click()
    } catch {
      setSyncNote('Your saved edits could not be downloaded. They have not been removed.')
      return
    }
    if (recoveredCount > 0) {
      try {
        await acknowledgeRecoveredBoardOps(boardId, recovery.recovered.map(entry => entry.id))
        setRecoveredCount((await readRecoveredBoardOps(boardId)).length)
      } catch {
        setSyncNote('The recovery copy downloaded, but the reminder could not be dismissed.')
      }
    }
  }
  // A failed refresh is not unsynced work. Only saved pending/rejected edits
  // justify the recovery affordance.
  const recoveryButton = hasRecoverableBoardOps(queuedCount, recoveredCount) && <button
    className="kb-btn" onClick={downloadUnsyncedEdits}
    title="Download pending and rejected edits as a recovery file. Saved copies are kept here."
  >Download recovery copy</button>

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
    const loading = { kind: 'loading', message: '' }
    publishAvailability(loading)
    Promise.all([getBoard(boardId), readPendingBoardOps(boardId)]).then(([doc, pendingEntries]) => {
      if (!alive) return
      pendingEntriesRef.current = pendingEntries
      if (doc) {
        const initial = applyPendingBoardOps(doc, pendingEntries)
        boardRef.current = initial
        setBoard(initial)
        if (!shareRef.current) {
          const ready = { kind: 'ready', message: '' }
          publishAvailability(ready)
        } else if (availabilityRef.current.kind === 'unavailable') {
          const reconnecting = { kind: 'reconnecting', message: 'Reconnecting — showing your last copy' }
          publishAvailability(reconnecting)
        }
      } else if (!shareRef.current) {
        const unavailable = { kind: 'unavailable', message: 'This board couldn’t be loaded. Your saved data is unchanged.' }
        publishAvailability(unavailable)
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
      if (!alive) return
      if (availabilityRef.current.kind !== 'terminal') {
        const unavailable = { kind: 'unavailable', message: 'This board couldn’t be loaded. Your saved data is unchanged.' }
        publishAvailability(unavailable)
      }
      window.mobius?.signal?.('error', { message: String(err?.message || err), source: 'board-load' })
    })
    return () => { alive = false; unsub?.() }
  }, [boardId, loadAttempt, publishAvailability])

  // Shared boards: poll the shared object and fold newer documents in.
  useEffect(() => {
    if (!share) return undefined
    let alive = true
    let pulling = false
    let timer = null
    confirmedSharedRef.current = null
    lastInteractionAtRef.current = Date.now()
    const refresh = createSharedRefreshLifecycle({
      onSignal: error => window.mobius?.signal?.('error', {
        message: String(error?.message || error),
        source: 'shared-board-poll',
      }),
      onAvailability: next => {
        if (!alive) return
        publishAvailability(next)
      },
    })
    const schedule = () => {
      if (!alive || !refresh.shouldContinue()) return
      clearTimeout(timer)
      timer = setTimeout(tick, sharedBoardPollDelay(lastInteractionAtRef.current))
    }
    const tick = async () => {
      if (!alive) return
      if (!appVisible()) return
      if (pulling) {
        schedule()
        return
      }
      pulling = true
      try {
        await refresh.refresh({
          pull: () => pullShared(share, confirmedSharedRef.current?.version ?? -1),
          hasCachedBoard: () => Boolean(boardRef.current),
          integrate: async state => {
            if (!alive) return false
            const previous = confirmedSharedRef.current
            const confirmed = acceptSharedPoll(previous, share, state)
            if (!confirmed) return false
            confirmedSharedRef.current = confirmed
            if (confirmed !== previous) {
              window.mobius?.storage?.set(boardPath(boardId), confirmed.doc).catch(() => {})
            }
            // A version-only response is safe to skip only if this confirmed
            // snapshot, not merely the old board object, reached the screen.
            const unchanged = confirmed === pollRenderedRef.current?.confirmed
              && pendingEntriesRef.current.length === 0
              && boardRef.current === pollRenderedRef.current.board
            if (!unchanged && pendingRef.current === 0 && !replayingRef.current && !dragRef.current) {
              const rendered = applyPendingBoardOps(confirmed.doc, pendingEntriesRef.current)
              boardRef.current = rendered
              pollRenderedRef.current = { confirmed, board: rendered }
              setBoard(rendered)
            }
            if (state.object) {
              const nextMembers = memberRecords(state.object)
              if (nextMembers) setMembers(current => sameMembers(current, nextMembers) ? current : nextMembers)
            }
            if (pendingEntriesRef.current.length === 0) setSyncNote('')
            return true
          },
        })
      } finally {
        pulling = false
        schedule()
      }
    }
    tick()
    // Hidden ticks stop the loop (see tick); becoming visible restarts it at
    // the fast cadence. This covers the shell hiding the frame as well as tab
    // visibility.
    const stopVisibility = onAppVisibilityChange(visible => {
      if (!visible || !refresh.shouldContinue()) return
      lastInteractionAtRef.current = Date.now()
      clearTimeout(timer)
      tick()
    })
    return () => { alive = false; clearTimeout(timer); stopVisibility() }
  }, [share, boardId, loadAttempt, publishAvailability])

  // Keeps an operation in this board's durable queue; the replay below sends
  // it once the board's authority answers again. Returns the queue length.
  const queueOperation = useCallback(async operation => {
    const queued = await enqueuePendingBoardOp(boardId, operation)
    pendingEntriesRef.current = [...pendingEntriesRef.current, queued]
      .sort((left, right) => left.id.localeCompare(right.id))
    setQueuedCount(pendingEntriesRef.current.length)
    return pendingEntriesRef.current.length
  }, [boardId])

  const mutate = useCallback((operation, onCommit) => {
    const entry = shareRef.current
    if (availabilityRef.current.kind === 'terminal') return false
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
      markSeenRef.current([operation.cardId || operation.card?.id].filter(Boolean), optimistic)
      pendingRef.current += 1
      writeChain.current = writeChain.current.catch(() => {}).then(async () => {
        const count = await queueOperation(operation)
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
    const ownCardIds = [operation.cardId || operation.card?.id].filter(Boolean)
    markSeenRef.current(ownCardIds, optimistic)
    pendingRef.current += 1
    const onErr = e => {
      window.mobius?.signal?.('error', { message: String(e?.message || e), source: 'save' })
      if (entry) setSyncNote('Reconnecting — retrying the latest shared board')
    }
    let settled = null
    writeChain.current = writeChain.current.catch(() => {}).then(async () => {
      try {
        const landed = await createBoardRepository({ storage: window.mobius.storage }).mutate(boardId, operation, { sharedState: confirmedSharedRef.current })
        if (landed.authority === 'shared') confirmedSharedRef.current = rememberSharedState(confirmedSharedRef.current, shareRef.current, landed)
        settled = landed.doc
        markSeenRef.current(ownCardIds, landed.doc)
        noteActivity(landed.activity)
        setSavedTick(tick => tick + 1)
        onCommit?.()
        return
      } catch (error) {
        const retryable = isRetryableBoardError(error)
        if (entry) confirmedSharedRef.current = null
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
        await queueOperation(operation)
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
            const base = confirmedSharedRef.current?.doc || settled
            const rendered = applyPendingBoardOps(base, pendingEntriesRef.current)
            boardRef.current = rendered
            setBoard(rendered)
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
  }, [boardId, queueOperation])

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
              const landed = await createBoardRepository({ storage: window.mobius.storage }).mutate(boardId, op, { sharedState: confirmedSharedRef.current })
              if (landed.authority === 'shared') confirmedSharedRef.current = rememberSharedState(confirmedSharedRef.current, shareRef.current, landed)
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
                structuredClone(confirmedSharedRef.current?.doc || landed),
              )
              boardRef.current = rendered
              setBoard(rendered)
            },
            onDiscarded: error => {
              setRecoveredCount(count => count + 1)
              setSyncNote(`${String(error?.message || 'A change could not be applied')} — saved for recovery.`)
            },
          },
        )
        if (!alive) return
        pendingEntriesRef.current = result.entries
        setQueuedCount(result.pending)
        if (result.discarded) {
          try {
            const fresh = await createBoardRepository({ storage: window.mobius.storage }).read(boardId)
            if (fresh.authority === 'shared') confirmedSharedRef.current = rememberSharedState(confirmedSharedRef.current, shareRef.current, fresh)
            const rendered = applyPendingBoardOps(confirmedSharedRef.current?.doc || fresh.doc, result.entries)
            boardRef.current = rendered
            setBoard(rendered)
            setSyncNote(`${result.discarded} rejected change${result.discarded === 1 ? '' : 's'} saved for recovery`)
          } catch (error) {
            confirmedSharedRef.current = null
            setSyncNote('Rejected edits saved for recovery — refreshing the board')
            window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-refresh' })
          }
        } else {
          setSyncNote(result.error || (result.ok ? '' : `${result.pending} change${result.pending === 1 ? '' : 's'} could not sync — retrying`))
        }
      }).finally(() => { replayingRef.current = false })
    }
    flush()
    const timer = setInterval(flush, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [boardId, online, share, queuedCount])

  const addCard = colId => {
    const card = { id: uid(), title: '', notes: '', pullRequestUrl: '', pullRequestUrls: [], label: 'none', due: '', checklist: [], attachments: [], assignee: '', assigneeHost: '', createdAt: new Date().toISOString() }
    setDraftCard({ boardId, columnId: colId, card })
    setOpenCardId(card.id)
  }

  // Draft edits use the same operations as saved cards, without creating
  // an empty board record. All fields travel together when the title commits.
  const mutateCard = operation => {
    if (draftCard?.boardId === boardId && draftCard.card.id === operation.cardId) {
      setDraftCard(current => {
        if (!current || current.card.id !== operation.cardId) return current
        const doc = { columns: [], cards: { [current.card.id]: structuredClone(current.card) } }
        applyBoardOp(doc, operation)
        return { ...current, card: doc.cards[current.card.id] }
      })
      return true
    }
    return mutate(operation)
  }

  const updateCard = (cardId, patch) => {
    return mutateCard({ type: 'update-card', cardId, patch })
  }

  // A shared card's description is saved beside the board as an edit of the
  // text its editor started from, so a concurrent edit becomes a visible
  // choice instead of a silent overwrite. The start is captured on focus: the
  // board refreshes while someone types and reloads the details, so the
  // newest known version would accept any stale text. When the host cannot be
  // reached the edit joins the board's queue, carrying that same start, like
  // any other change. Drafts, private boards and hosts without card details
  // save through the board as before.
  // The sheet shows the owner's newest intent: a description edit still
  // waiting in the queue, else the saved text. A later edit starts from it.
  const shownNotes = (details, card) => queuedNotesFor(card?.id)
    ?? (details && typeof details.notes === 'string' ? details.notes : card?.notes || '')
  const beginNotesEdit = cardId => {
    const details = cardDetailsRef.current?.cardId === cardId ? cardDetailsRef.current : null
    notesEditBaseRef.current = { cardId, version: details?.notesVersion ?? null,
      text: shownNotes(details, boardRef.current?.cards?.[cardId]) }
  }
  const notesEditBase = cardId => (notesEditBaseRef.current?.cardId === cardId ? notesEditBaseRef.current : null)

  const saveCardNotes = (cardId, notes, from) => {
    const entry = shareRef.current
    const details = cardDetailsRef.current?.cardId === cardId ? cardDetailsRef.current : null
    if (!entry || !boardRef.current?.cards?.[cardId] || details?.status !== 'ok' || !Number.isInteger(from?.version)) {
      return updateCard(cardId, { notes })
    }
    if (!boardAccess(entry, onlineRef.current).canWrite) return false
    setNotesError('')
    setNotesConflict(null)
    const savedText = details.notes
    updateDetails(cardId, current => ({ ...current, notes }))
    const operation = { type: 'update-card', cardId, patch: { notes }, notesVersion: from.version, notesBefore: from.text }
    const keepForLater = async () => {
      await queueOperation(operation)
      const queuedBoard = applyBoardOp(structuredClone(boardRef.current), operation) || boardRef.current
      boardRef.current = queuedBoard
      setBoard(queuedBoard)
      setSyncNote('Change saved locally — reconnecting')
    }
    const refuse = message => {
      updateDetails(cardId, current => (current.notes === notes ? { ...current, notes: savedText } : current))
      setNotesError(message)
    }
    writeChain.current = writeChain.current.catch(() => {}).then(async () => {
      let result
      try {
        // Behind queued changes, the description waits its turn like any edit.
        if (pendingEntriesRef.current.length) return await keepForLater()
        try {
          result = await createBoardRepository({ storage: window.mobius.storage }).saveNotes(boardId, cardId, notes, from)
        } catch (error) {
          window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'save-description' })
          if (isRetryableBoardError(error)) return await keepForLater()
          // Too long: the text stays in the editor so it can be shortened and saved.
          if (error?.code === 'notes-too-long') {
            return setNotesError(`A description can be at most ${MAX_NOTES_CHARS.toLocaleString()} characters. Put longer text in an attachment.`)
          }
          return refuse(String(error?.message || 'The description could not be saved.'))
        }
      } catch (error) {
        window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'offline-queue' })
        return refuse(`The description wasn’t saved: ${String(error?.message || error)}`)
      }
      if (result.status === 'conflict') {
        setNotesConflict({ cardId, mine: notes, theirs: result.notes, notesVersion: result.notesVersion })
        return
      }
      if (Number.isInteger(result.notesVersion)) updateDetails(cardId, current => ({ ...current, notesVersion: result.notesVersion }))
      noteActivity(result.activity)
      const card = boardRef.current?.cards?.[cardId]
      if (result.card && card) {
        const next = structuredClone(boardRef.current)
        const { notesLength, ...rest } = next.cards[cardId]
        next.cards[cardId] = { ...rest, notes: result.card.notes, ...(Number.isInteger(result.card.notesLength) ? { notesLength: result.card.notesLength } : {}) }
        boardRef.current = next
        setBoard(next)
      }
      setSavedTick(tick => tick + 1)
    })
    return notes
  }

  const resolveNotesConflict = keepMine => {
    const conflict = notesConflictRef.current
    if (!conflict) return
    setNotesConflict(null)
    updateDetails(conflict.cardId, current => ({ ...current, notes: conflict.theirs, notesVersion: conflict.notesVersion }))
    // Keep mine deliberately replaces the newest text the conflict knows of.
    if (keepMine) saveCardNotes(conflict.cardId, conflict.mine, { version: conflict.notesVersion, text: conflict.theirs })
  }

  // Every assignment change on a saved card records who made it. Taking a
  // person off a card also offers an immediate Undo.
  const assignCard = (cardId, target, { offerUndo = true } = {}) => {
    const card = boardRef.current?.cards?.[cardId]
    if (!card) return false
    const from = cardAssignment(card)
    const to = assignmentRef(target)
    if (sameAssignment(from, to) && from.label === to.label) return true
    const event = sameAssignment(from, to) ? null : createAssignmentEvent({ id: uid(), by: actorRef, from, to })
    const saved = mutate({ type: 'assign-card', cardId, assignee: to.label, assigneeHost: to.host, ...(event ? { event } : {}) })
    if (saved && event && offerUndo && hasAssignment(from)) {
      setAssignmentUndo({ id: event.id, cardId, from, to })
    } else if (saved && event) setAssignmentUndo(null)
    return saved
  }

  const undoAssignment = () => {
    const undo = assignmentUndo
    setAssignmentUndo(null)
    const card = undo && boardRef.current?.cards?.[undo.cardId]
    // Someone may have changed it again since; never overwrite their newer choice.
    if (card && sameAssignment(cardAssignment(card), undo.to)) assignCard(undo.cardId, undo.from, { offerUndo: false })
  }

  const addCheckItem = (cardId, text) => {
    const item = { id: uid(), text, done: false }
    mutateCard({ type: 'add-checklist-item', cardId, item })
  }

  const editCheckItem = (cardId, itemId, text) => {
    mutateCard({ type: 'update-checklist-item', cardId, itemId, text })
  }

  const toggleCheckItem = (cardId, itemId) => {
    const item = (draftCard?.card.id === cardId ? draftCard.card : boardRef.current?.cards[cardId])?.checklist?.find(candidate => candidate.id === itemId)
    if (item) mutateCard({ type: 'set-checklist-item', cardId, itemId, done: item.done !== true })
  }

  const removeCheckItem = (cardId, itemId) => {
    mutateCard({ type: 'delete-checklist-item', cardId, itemId })
  }

  const deleteCard = cardId => {
    const attachments = [...(boardRef.current?.cards[cardId]?.attachments || [])]
    setOpenCardId(null)
    mutate(
      { type: 'delete-card', cardId },
      () => {
        window.mobius?.signal?.('item_deleted')
        Promise.allSettled(attachments.map(attachment => deleteCardAttachment({ share: shareRef.current, attachment })))
      },
    )
  }

  const attachFiles = async filesInput => {
    const files = [...(filesInput || [])]
    const cardId = openCardId
    // An untitled draft has no card to attach to yet; saving the file first
    // would leave an orphaned upload.
    if (!cardId || !boardRef.current?.cards[cardId] || files.length === 0 || attachmentBusy) return
    const existing = boardRef.current?.cards[cardId]?.attachments || []
    if (existing.length + files.length > MAX_CARD_ATTACHMENTS) {
      setAttachmentError(`A card can hold up to ${MAX_CARD_ATTACHMENTS} attachments.`)
      return
    }
    setAttachmentBusy(true); setAttachmentError('')
    try {
      for (const file of files) {
        const attachment = await saveCardAttachment({
          boardId,
          share: shareRef.current,
          id: uid(),
          file,
        })
        const current = boardRef.current?.cards[cardId]?.attachments || []
        if (!mutate({ type: 'update-card', cardId, patch: { attachments: [...current, attachment] } })) {
          await deleteCardAttachment({ share: shareRef.current, attachment }).catch(() => {})
          throw new Error('This card cannot be changed right now.')
        }
      }
      window.mobius?.signal?.('item_created', { type: 'card-attachment' })
    } catch (error) {
      setAttachmentError(String(error?.message || 'The file could not be attached.'))
      window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'attach-file' })
    } finally {
      setAttachmentBusy(false)
    }
  }

  const attachFromInput = event => {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    attachFiles(files)
  }

  const attachFromPaste = event => {
    const files = consumeAttachmentPaste(event, access.canWrite)
    if (!files.length) return
    attachFiles(files)
  }

  const removeAttachment = (cardId, attachment) => {
    const attachments = (boardRef.current?.cards[cardId]?.attachments || []).filter(item => item.id !== attachment.id)
    mutate(
      { type: 'update-card', cardId, patch: { attachments } },
      () => deleteCardAttachment({ share: shareRef.current, attachment }).catch(error => {
        window.mobius?.signal?.('error', { message: String(error?.message || error), source: 'delete-attachment' })
      }),
    )
  }

  const downloadAttachment = async attachment => {
    setAttachmentError('')
    try {
      const url = await loadCardAttachment({ boardId, share: shareRef.current, attachment })
      const link = document.createElement('a')
      link.href = url
      link.download = attachment.name || 'attachment'
      link.click()
    } catch (error) {
      setAttachmentError(String(error?.message || 'The attachment could not be downloaded.'))
    }
  }

  const moveCard = (cardId, toColId, beforeCardId = null) => {
    mutate({ type: 'move-card', cardId, toColumnId: toColId, beforeCardId })
  }

  const addColumn = () => {
    const id = uid()
    mutate({
      type: 'add-column',
      column: { id, name: 'New list', color: defaultColumnColor(boardRef.current?.columns.length || 0), cardIds: [] },
    })
  }

  const recolorColumn = (colId, color) => {
    mutate({ type: 'recolor-column', columnId: colId, color })
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

  // A list moves by dragging its header with a mouse. Touch keeps Move left /
  // Move right in the list menu, because a sideways touch drag scrolls the board.
  const startColumnDrag = (event, columnId) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !access.canWrite) return
    if (event.target.closest('button, .kb-col-confirm')) return
    const sections = [...(boardScrollRef.current?.querySelectorAll(':scope > [data-col-id]') || [])]
    const others = sections.filter(section => section.dataset.colId !== columnId)
      .map(section => ({ id: section.dataset.colId, rect: section.getBoundingClientRect() }))
    const startX = event.clientX
    let latest = null
    const move = moveEvent => {
      const dx = moveEvent.clientX - startX
      if (!latest && Math.abs(dx) < 6) return
      if (!latest) document.activeElement?.blur?.()
      moveEvent.preventDefault()
      const overIndex = others.filter(item => moveEvent.clientX > item.rect.left + item.rect.width / 2).length
      latest = { columnId, dx, overIndex }
      setColumnDrag(latest)
    }
    const finish = commit => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', drop)
      window.removeEventListener('pointercancel', cancel)
      setColumnDrag(null)
      if (!commit || !latest) return
      const ids = (boardRef.current?.columns || []).map(column => column.id)
      const from = ids.indexOf(columnId)
      if (from < 0 || latest.overIndex === from) return
      mutate({ type: 'move-column', columnId, beforeColumnId: others[latest.overIndex]?.id ?? null })
    }
    const drop = () => finish(true)
    const cancel = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', drop)
    window.addEventListener('pointercancel', cancel)
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
        const visibleIds = column?.cardIds.filter(id => cardVisibleRef.current(current.cards[id])) || []
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
  const openCard = id => { if (!suppressClick.current) { setDraftCard(null); setOpenCardId(id) } }

  const access = boardAccess(share, online && availability.kind !== 'terminal')
  const accessStatus = availability.kind === 'terminal' ? '' : access.status
  // Only a shared board has a size limit that matters (private boards can grow to ~50 MB).
  const capacity = share ? boardCapacity(board) : null
  const hasFilters = !!filterText.trim() || filterLabels.length > 0
  const narrowed = hasFilters || boardView !== 'all'
  const linkedCard = board?.cards?.[openCardId]
  const linkedPullsKey = linkedCard ? cardPullUrls(linkedCard).filter(parsePullRequestUrl).join('\n') : ''

  useEffect(() => {
    if (!online || !linkedPullsKey) return undefined
    let active = true
    Promise.all(linkedPullsKey.split('\n').map(async url => {
      const { owner, repo, number } = parsePullRequestUrl(url)
      try {
        const response = await fetch(`/api/github/api/repos/${owner}/${repo}/pulls/${number}`, { headers: { Authorization: `Bearer ${token}` } })
        return [url, pullRequestStatus(response.status, response.ok ? await response.json() : null)]
      } catch {
        return [url, pullRequestStatus(0)]
      }
    })).then(results => { if (active) setPullStatuses(Object.fromEntries(results)) })
    return () => { active = false }
  }, [linkedPullsKey, online, token, pullStatusRefresh])


  if (!board) {
    const summary = boards.find(candidate => candidate.id === boardId)
    const skeletonColumns = Math.max(1, Math.min(summary?.columnCount || 3, 6))
    const loading = availability.kind === 'loading'
    return <>
      {loading ? <>
        <div className="kb-header kb-board-header kb-board-skeleton-header" aria-hidden="true">
          <span className="kb-board-skeleton-icon" />
          <span className="kb-board-skeleton-header-title" />
          <div className="kb-header-spacer" />
          <span className="kb-board-skeleton-icon" />
          <span className="kb-board-skeleton-icon" />
        </div>
        <div className="kb-divider" />
        {skeletonColumns > 1 && <div className="kb-list-nav kb-board-skeleton-nav" aria-hidden="true">
          {Array.from({ length: Math.min(skeletonColumns, 3) }, (_, column) => (
            <span className="kb-board-skeleton-nav-pill" key={column} />
          ))}
        </div>}
      </> : <div className="kb-header">
        <button className="kb-btn" onClick={onAllBoards}><ChevronLeft /> All boards</button>
        {recoveryButton}
      </div>}
      {loading ? (
        <div className="kb-board kb-board-skeleton" role="status" aria-busy="true">
          <span className="kb-visually-hidden">Loading board…</span>
          {Array.from({ length: skeletonColumns }, (_, column) => (
            <div className="kb-board-skeleton-col" aria-hidden="true" key={column}>
              <div className="kb-col-head kb-board-skeleton-col-head">
                <span className="kb-board-skeleton-dot" />
                <span className="kb-board-skeleton-line kb-board-skeleton-line-title" />
                <span className="kb-board-skeleton-count" />
                <span className="kb-board-skeleton-actions" />
              </div>
              <div className="kb-cards kb-board-skeleton-cards">
                <span className="kb-board-skeleton-card" />
                <span className="kb-board-skeleton-card" />
                <span className="kb-board-skeleton-card kb-board-skeleton-card-short" />
              </div>
              <span className="kb-board-skeleton-add" />
            </div>
          ))}
        </div>
      ) : (
        <div className="kb-board kb-board-empty"><div className="kb-empty-board-state" role="alert">
          <p>{availability.message}</p>
          {availability.kind !== 'terminal' && <button className="kb-btn kb-btn-primary" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Try again</button>}
        </div></div>
      )}
    </>
  }

  // One list menu, shown in each list's header and, on a phone, at the end of
  // the list tabs for the list in view (the phone hides the list header).
  const startRenameList = columnId => {
    setRenamingColumnId(columnId)
    requestAnimationFrame(() => boardScrollRef.current?.querySelector(`[data-col-id="${CSS.escape(columnId)}"] .kb-col-name`)?.select())
  }
  const listMenu = (col, columnIndex) => <MenuButton key={col.id} label={`List options for ${col.name}`} className="kb-col-menu">{({ page, setPage }) => page === 'colour' ? <>
    <button type="button" className="kb-menu-back" data-keep-open onClick={() => setPage('main')}><ChevronLeft aria-hidden="true" />Back</button>
    <div className="kb-menu-heading">List colour</div>
    {LIST_COLOURS.map(([key, name]) => <button key={name} type="button" role="menuitemradio" aria-checked={(col.color || null) === key}
      onClick={() => recolorColumn(col.id, key)}>
      <span className="kb-chip-swatch" style={{ background: columnColor({ color: key }) }} aria-hidden="true" />
      <span className="kb-menu-label">{name}</span>
      {(col.color || null) === key && <Check aria-hidden="true" />}
    </button>)}
                </> : <>
    <button type="button" role="menuitem" onClick={() => startRenameList(col.id)}>Rename list</button>
    <button type="button" role="menuitem" data-keep-open aria-haspopup="menu" onClick={() => setPage('colour')}>
      <span className="kb-menu-label">Change colour</span>
      <span className="kb-chip-swatch" style={{ background: columnColor(col) }} aria-hidden="true" />
    </button>
    <button type="button" role="menuitem" onClick={() => setListFolded(col.id, true)}>Fold list</button>
    <div className="kb-menu-separator" />
    <button type="button" role="menuitem" disabled={columnIndex === 0} onClick={() => reorderColumn(col.id, -1)}>Move left</button>
    <button type="button" role="menuitem" disabled={columnIndex === board.columns.length - 1} onClick={() => reorderColumn(col.id, 1)}>Move right</button>
    <div className="kb-menu-separator" />
    <button type="button" role="menuitem" className="kb-menu-danger"
      aria-label={`Delete list ${col.name}`}
      onClick={() => setConfirmDeleteCol(col.id)}
    >Delete list…</button>
                </>}</MenuButton>
  const activeColumnIndex = Math.max(0, board.columns.findIndex(column => column.id === activeColumnId))
  const activeColumn = board.columns[activeColumnIndex]

  const boardCards = board.columns.flatMap(column => column.cardIds.map(id => board.cards[id]).filter(Boolean))
  const viewCounts = {
    all: boardCards.length,
    mine: boardCards.filter(card => cardMatchesView(card, 'mine', me)).length,
    changed: boardCards.filter(card => changedIds.has(card.id)).length,
    unassigned: boardCards.filter(card => cardMatchesView(card, 'unassigned', me)).length,
  }
  const isDraftCard = draftCard?.boardId === boardId && draftCard.card.id === openCardId
  const openCard_ = openCardId ? board.cards[openCardId] || (isDraftCard ? draftCard.card : null) : null
  // Header choices on an untitled draft ride along into its add-card.
  const patchOpenCard = patch => isDraftCard
    ? setDraftCard(current => ({ ...current, card: { ...current.card, ...patch } }))
    : updateCard(openCard_.id, patch)
  const openCardColumn = openCard_ ? board.columns.find(column => column.cardIds.includes(openCard_.id)) : null
  const closeCard = () => { setOpenCardId(null); setDraftCard(null) }
  const columnColor = column => column?.color ? (LABELS[column.color] || 'var(--muted)') : 'var(--muted)'
  const openDetails = openCard_ && cardDetails?.cardId === openCard_.id ? cardDetails : null
  // Activity by someone on a shared board names them as the board shows them;
  // on a private board every entry is this owner's (or their agent's).
  const activityActor = entry => {
    const name = entry.by ? nameForRef(assignmentRef({ label: entry.by.name, host: entry.by.host })) : 'you'
    const who = name === 'you' ? 'You' : name
    if (entry.via !== 'agent') return who
    return who === 'You' ? 'Your agent' : `${who}’s agent`
  }
  const openTimeline = openCard_ && !isDraftCard ? cardTimeline({
    card: openCard_,
    activity: openDetails?.activity || [],
    assignmentTimeline: cardAssignmentTimeline(openCard_, assignmentLog?.observed),
    actorName: activityActor,
  }) : []
  const createdLabel = openCard_?.createdAt && !Number.isNaN(Date.parse(openCard_.createdAt))
    ? `Created ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: new Date(openCard_.createdAt).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(new Date(openCard_.createdAt))}`
    : ''
  const filterControls = <>
    <input
      className="kb-input kb-filter-input"
      type="search"
      placeholder="Filter title, notes, or person…"
      aria-label="Filter cards by title, notes, or person"
      value={filterText}
      onChange={event => setFilterText(event.target.value)}
    />
    <div className="kb-filter-labels" aria-label="Filter by label">
      {Object.entries(LABELS).map(([name, color]) => {
        const active = filterLabels.includes(name)
        return <button
          key={name}
          className={`kb-filter-label-btn${active ? ' kb-on' : ''}`}
          aria-label={name === 'none' ? 'Filter unlabeled cards' : `Filter ${labelDisplayName(name, board.labelNames)} cards`}
          aria-pressed={active}
          onClick={() => setFilterLabels(labels =>
            labels.includes(name) ? labels.filter(label => label !== name) : [...labels, name],
          )}
        >
          <span
            className={`kb-filter-dot${name === 'none' ? ' kb-none' : ''}`}
            style={name === 'none' ? undefined : { background: color }}
          />
          <span>{name === 'none' ? 'Unlabeled' : labelDisplayName(name, board.labelNames)}</span>
        </button>
      })}
    </div>
    {hasFilters && <button className="kb-btn kb-btn-quiet kb-clear-filters" onClick={() => { setFilterText(''); setFilterLabels([]) }}>Clear filters</button>}
  </>
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
          onAllBoards={onAllBoards}
        />
        <div className="kb-header-spacer" />
        <span className="kb-status-live" role="status" aria-live="polite">
          {(queuedCount > 0 || accessStatus) && <span className="kb-offline">
            {queuedCount > 0 ? `${queuedCount} change${queuedCount === 1 ? '' : 's'} pending` : accessStatus}
          </span>}
          {availability.kind === 'reconnecting' && <span className="kb-offline">{availability.message}</span>}
          {syncNote && <span className="kb-offline">{syncNote}</span>}
        </span>
        <BoardViewSwitch view={boardView} counts={viewCounts} onChange={chooseBoardView} />
        <ShowCardsChip view={boardView} counts={viewCounts} filtered={hasFilters} open={showOpen} onOpen={() => setShowOpen(true)} />
        {share && <BoardPresence members={displayMembers} onOpen={() => setShareOpen(true)} />}
        <button
          className={`kb-iconbtn kb-filter-toggle${hasFilters ? ' kb-filter-active' : ''}`}
          aria-label="Filter cards"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(open => !open)}
        >
          <Filter />
        </button>
        {/* When avatars show, they already open sharing; phones then drop this duplicate. */}
        <button className="kb-iconbtn kb-share-btn" aria-label="Share board" onClick={() => setShareOpen(true)}>
          <Share />
        </button>
      </div>
      {showOpen && <>
        <div className="kb-scrim" onClick={() => setShowOpen(false)} />
        <div ref={showSheetRef} tabIndex={-1} className="kb-sheet kb-show-sheet" role="dialog" aria-modal="true" aria-label="Show cards">
          <div className="kb-sheet-grab" />
          <div className="kb-sheet-row kb-sheet-row-between">
            <h3>Show</h3>
            <button className="kb-btn kb-btn-quiet" onClick={() => setShowOpen(false)}>Done</button>
          </div>
          <BoardViewSwitch view={boardView} counts={viewCounts} onChange={chooseBoardView} />
          {filterControls}
        </div>
      </>}
      <div className="kb-divider" />
      {boardView === 'changed' && changedIds.size > 0 && <div className="kb-view-note" role="status">
        <span>{changedIds.size === 1 ? '1 card changed' : `${changedIds.size} cards changed`} since you last looked. Opening a card marks it as seen.</span>
        <button type="button" className="kb-quiet-action" onClick={() => markSeenRef.current([...changedIds])}><Check aria-hidden="true" />Mark all as seen</button>
      </div>}
      {availability.kind === 'terminal' && <div className="kb-recovery" role="alert">
        <span>{availability.message}</span>
      </div>}
      {capacity?.nearlyFull && <div className="kb-capacity-warning" role="status">
        <strong>This board is almost full: {Math.round(capacity.bytes / 1024)} KB of {Math.round(capacity.limit / 1024)} KB.</strong>
        <span> When it’s full, no one can save changes to it. To make room, move long descriptions into attachments, delete finished cards or move them to another board, or split this board in two.</span>
      </div>}
      {capacity?.filesNearlyFull && <div className="kb-capacity-warning" role="status">
        <strong>This board’s attachment space is almost used up: {capacity.files} of {capacity.fileLimit} files, {Math.round(capacity.fileBytes / 1048576)} MB of 100 MB.</strong>
        <span> New files can’t be added once it’s full. Remove attachments you no longer need, or keep new files on another board.</span>
      </div>}
      {recoveryButton && <div className="kb-recovery" role="status">
        <span>{recoveredCount > 0 ? 'A recovery copy is ready to download.' : 'Unsynced edits are kept on this instance.'}</span>{recoveryButton}
      </div>}
      {board.columns.length > 0 && <div className="kb-list-bar">
        <nav className="kb-list-nav" aria-label="Jump to list" ref={listNavRef}>
          {board.columns.map(column => <button
            key={column.id}
            className="kb-list-jump"
            aria-current={column.id === activeColumn?.id ? 'true' : undefined}
            aria-label={`Go to list ${column.name}`}
            onClick={() => {
              // Going to a folded list opens it: a phone shows one list at a time.
              if (listIsFolded(column, listFolds)) setListFolded(column.id, false)
              setActiveColumnId(column.id)
              requestAnimationFrame(() => {
                const lane = Array.from(boardScrollRef.current?.children || [])
                  .find(element => element.dataset.colId === column.id)
                lane?.scrollIntoView({ block: 'nearest', inline: 'start', behavior: 'auto' })
              })
            }}
          >
            <span className="kb-col-status" aria-hidden="true" style={{ background: LABELS[column.color] || 'var(--muted)' }} />
            <span className="kb-list-jump-name">{column.name}</span>
            <span className="kb-list-jump-count">{column.cardIds.length}</span>
          </button>)}
        </nav>
        {access.canWrite && activeColumn && <button className="kb-iconbtn kb-list-bar-add" aria-label={`Add card to ${activeColumn.name}`} onClick={() => addCard(activeColumn.id)}><Plus /></button>}
        {access.canWrite && activeColumn && <div className="kb-list-bar-menu">{listMenu(activeColumn, activeColumnIndex)}</div>}
      </div>}
      {filtersOpen && <div className="kb-filterbar" aria-label="Card filters">
        {filterControls}
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
          const cards = allCards.filter(cardVisible)
          const dragOthers = columnDrag ? board.columns.filter(column => column.id !== columnDrag.columnId) : []
          const columnDragClass = !columnDrag ? ''
            : columnDrag.columnId === col.id ? ' kb-col-dragging'
              : dragOthers[columnDrag.overIndex]?.id === col.id ? ' kb-col-drop-before'
                : columnDrag.overIndex >= dragOthers.length && dragOthers.at(-1)?.id === col.id ? ' kb-col-drop-after' : ''
          const columnDragStyle = columnDrag?.columnId === col.id ? { transform: `translateX(${columnDrag.dx}px) rotate(0.6deg)` } : null
          if (listIsFolded(col, listFolds)) return (
            <section
              key={col.id}
              data-col-id={col.id}
              className={`kb-col kb-col-folded${showGap ? ' kb-drop' : ''}${columnDragClass}`}
              style={{ '--kb-col-index': columnIndex, ...columnDragStyle }}
              aria-label={`${col.name}, folded`}
              onPointerDown={event => startColumnDrag(event, col.id)}
            >
              <button type="button" className="kb-col-unfold" aria-label={`Open list ${col.name}, ${allCards.length} card${allCards.length === 1 ? '' : 's'}`}
                title={`Open ${col.name}`} onClick={() => setListFolded(col.id, false)}>
                <span className="kb-col-status" aria-hidden="true" style={{ background: col.color ? (LABELS[col.color] || 'var(--muted)') : 'var(--muted)' }} />
                <span className="kb-col-folded-name">{col.name}</span>
                <span className="kb-count">{narrowed ? `${cards.length}/${allCards.length}` : allCards.length}</span>
              </button>
            </section>
          )
          const cardNodes = []
          let dropPosition = 0
          for (const card of cards) {
            if (showGap && card.id !== drag.cardId && drag.overIndex === dropPosition) {
              cardNodes.push(<div key={`gap-${dropPosition}`} className="kb-gap" style={{ height: drag.h }} />)
            }
            cardNodes.push(<Card
              key={card.id}
              boardId={boardId}
              share={share}
              card={card}
              labelNames={board.labelNames}
              mine={cardMatchesView(card, 'mine', me)}
              changed={changedIds.has(card.id)}
              assigneeLabel={assigneeLabelForCard(card)}
              assigneeMember={collaboratorForHost(displayMembers, card.assigneeHost)}
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
              className={`kb-col${showGap ? ' kb-drop' : ''}${columnDragClass}${renamingColumnId === col.id ? ' is-renaming' : ''}`}
              style={{ '--kb-col-index': columnIndex, ...columnDragStyle }}
              aria-label={col.name}
            >
              <div className="kb-col-head" onPointerDown={event => startColumnDrag(event, col.id)} title={access.canWrite ? 'Drag to move this list' : undefined}>
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
                  onBlur={e => {
                    setRenamingColumnId(null)
                    if (e.target.value.trim() && e.target.value !== col.name) renameColumn(col.id, e.target.value.trim())
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
                <span className="kb-count">{narrowed ? `${cards.length}/${allCards.length}` : allCards.length}</span>
                {access.canWrite && listMenu(col, columnIndex)}
              </div>
              {access.canWrite && confirmDeleteCol === col.id && (
                <div ref={columnConfirmRef} tabIndex={-1} className="kb-col-confirm" role="alertdialog" aria-modal="true" aria-label={`Delete list ${col.name}`}>
                  <div className="kb-col-confirm-copy">
                    Delete <strong>“{col.name}”</strong>{allCards.length ? ` and its ${allCards.length} card${allCards.length === 1 ? '' : 's'}` : ''}?
                  </div>
                  <div className="kb-col-confirm-actions">
                    <button className="kb-btn kb-btn-quiet" onClick={() => setConfirmDeleteCol(null)}>Cancel</button>
                    <button className="kb-btn kb-btn-danger" onClick={() => deleteColumn(col.id)}>Delete</button>
                  </div>
                </div>
              )}
              <div className="kb-cards">
                {cardNodes}
                {cards.length === 0 && !showGap && (
                  <div className="kb-empty">{!allCards.length ? 'Nothing here yet'
                    : hasFilters ? 'No matching cards'
                      : boardView === 'mine' ? 'Nothing of yours here'
                        : boardView === 'changed' ? 'Nothing changed here'
                        : 'Nothing unassigned here'}</div>
                )}
              </div>
              {access.canWrite && <button className="kb-addcard" onClick={() => addCard(col.id)}>
                <Plus /> Add card
              </button>}
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
          <div className="kb-card-title">{board.cards[drag.cardId]?.title}</div>
        </div>
      )}

      {openCard_ && (
        <>
          <div className="kb-scrim" onClick={closeCard} />
          <div
            ref={cardSheetRef}
            tabIndex={-1}
            className={`kb-sheet kb-card-sheet${attachmentDropActive ? ' is-dropping' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={isDraftCard ? 'New card' : 'Card details'}
            onPaste={attachFromPaste}
            onDragOver={event => { if (access.canWrite && !isDraftCard && event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); setAttachmentDropActive(true) } }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAttachmentDropActive(false) }}
            onDrop={event => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); setAttachmentDropActive(false); if (access.canWrite) attachFiles(event.dataTransfer.files) }}
          >
            <div className="kb-card-toolbar">
              {isDraftCard || !openCardColumn
                ? <span className="kb-card-toolbar-title">New card</span>
                : <StatusPill columns={board.columns} columnId={openCardColumn.id} colorFor={columnColor} canWrite={access.canWrite}
                  onMove={columnId => moveCard(openCard_.id, columnId, null)} />}
              <span className="kb-card-toolbar-spacer" />
              <SavedIndicator tick={savedTick} />
              <button type="button" className="kb-iconbtn kb-card-close" aria-label="Close card" title="Close. Your changes are already saved." onClick={closeCard}><X /></button>
            </div>
            <CardTitleEditor card={openCard_} canWrite={access.canWrite} onCommit={title => {
              if (!isDraftCard) return updateCard(openCard_.id, { title })
              const saved = mutate({ type: 'add-card', columnId: draftCard.columnId, card: { ...draftCard.card, title } })
              if (saved) { setDraftCard(null); window.mobius?.signal?.('item_created', { type: 'card' }) }
              return saved
            }} onCancel={() => { if (isDraftCard) { setDraftCard(null); setOpenCardId(null) } }} />
            <div className="kb-detail-chips">
              <AssigneePicker
                card={openCard_}
                canWrite={access.canWrite}
                members={displayMembers}
                share={share}
                chip
                onUpdate={patch => isDraftCard ? patchOpenCard(patch) : assignCard(openCard_.id, { label: patch.assignee, host: patch.assigneeHost })}
              />
              <LabelChip label={openCard_.label} labels={LABELS} names={board.labelNames} canWrite={access.canWrite}
                onChange={label => patchOpenCard({ label })} onRename={(color, name) => mutate({ type: 'name-label', color, name })} />
              <DueChip due={openCard_.due} canWrite={access.canWrite} onChange={due => patchOpenCard({ due })} />
            </div>

            <DescriptionSection
              cardId={openCard_.id}
              text={shownNotes(openDetails, openCard_)}
              canWrite={access.canWrite}
              editable={!hasExternalNotes(openCard_) || openDetails?.status === 'ok'}
              loading={hasExternalNotes(openCard_) && (!openDetails || openDetails.status === 'loading')}
              maxLength={share && openDetails?.status === 'ok' ? MAX_NOTES_CHARS : null}
              conflict={notesConflict?.cardId === openCard_.id}
              error={notesError}
              onEditStart={() => beginNotesEdit(openCard_.id)}
              onCommit={notes => saveCardNotes(openCard_.id, notes, notesEditBase(openCard_.id))}
              onKeepMine={() => resolveNotesConflict(true)}
              onUseTheirs={() => resolveNotesConflict(false)}
            />

            {access.canWrite && <input
              ref={fileInputRef}
              className="kb-visually-hidden"
              type="file"
              multiple
              tabIndex={-1}
              disabled={isDraftCard || attachmentBusy}
              onChange={attachFromInput}
            />}
            <AttachmentsSection
              key={openCard_.id}
              boardId={boardId}
              share={share}
              attachments={openCard_.attachments || []}
              canWrite={access.canWrite}
              isDraft={isDraftCard}
              busy={attachmentBusy}
              error={attachmentError}
              onPick={() => fileInputRef.current?.click()}
              onPreview={attachment => setPreviewAttachment(attachment)}
              onDownload={downloadAttachment}
              onRemove={attachment => removeAttachment(openCard_.id, attachment)}
            />

            <ChecklistSection
              checklist={Array.isArray(openCard_.checklist) ? openCard_.checklist : []}
              canWrite={access.canWrite}
              onAdd={text => addCheckItem(openCard_.id, text)}
              onToggle={itemId => toggleCheckItem(openCard_.id, itemId)}
              onDelete={itemId => removeCheckItem(openCard_.id, itemId)}
              onEdit={(itemId, text) => editCheckItem(openCard_.id, itemId, text)}
            />

            <PullRequestSection card={openCard_} canWrite={access.canWrite} online={online} statuses={pullStatuses}
              onUpdate={(previousUrl, nextUrl) => mutateCard({ type: 'edit-pull-request', cardId: openCard_.id, previousUrl, nextUrl })}
              onRefresh={() => setPullStatusRefresh(value => value + 1)} />

            {!isDraftCard && <>
            <CardActivity
              card={openCard_}
              timeline={openTimeline}
              status={openDetails?.status || 'loading'}
              canWrite={access.canWrite}
              nameFor={nameForRef}
              onRestore={ref => assignCard(openCard_.id, ref)}
            />
            {access.canWrite && (confirmDeleteCard
              ? <div ref={cardDeleteConfirmRef} tabIndex={-1} className="kb-col-confirm kb-card-delete-confirm" role="alertdialog" aria-modal="true" aria-label="Delete card">
                <div className="kb-col-confirm-copy">Delete this card{share ? ' for everyone on this board' : ''}? This can’t be undone.</div>
                <div className="kb-col-confirm-actions">
                  <button className="kb-btn kb-btn-quiet" onClick={closeDeleteCardConfirm}>Cancel</button>
                  <button className="kb-btn kb-btn-danger" onClick={() => deleteCard(openCard_.id)}>Delete</button>
                </div>
              </div>
              : <div className="kb-card-danger-zone">
                <button ref={deleteCardButtonRef} className="kb-btn kb-delete-card" onClick={() => setConfirmDeleteCard(true)}>
                  <Trash aria-hidden="true" />
                  Delete card
                </button>
                {createdLabel && <span className="kb-card-created">{createdLabel}</span>}
              </div>)}
            {!access.canWrite && createdLabel && <div className="kb-card-danger-zone"><span className="kb-card-created">{createdLabel}</span></div>}
            </>}
          </div>
        </>
      )}

      {assignmentUndo && (
        <div className="kb-undo-toast" role="status">
          <span>{hasAssignment(assignmentUndo.to)
            ? `Replaced ${nameForRef(assignmentUndo.from)} with ${nameForRef(assignmentUndo.to)}`
            : `Removed ${nameForRef(assignmentUndo.from)} from this card`}</span>
          <button type="button" className="kb-undo-action" onClick={undoAssignment}>Undo</button>
        </div>
      )}

      {previewAttachment && (
        <>
          <div className="kb-scrim kb-lightbox-scrim" onClick={() => setPreviewAttachment(null)} />
          {/* The viewer box covers most of the screen above the backdrop, so a
              tap anywhere except on the picture itself closes it. */}
          <div ref={lightboxRef} tabIndex={-1} className="kb-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${previewAttachment.name || 'image'}`}
            onClick={event => { if (!event.target.closest('.kb-lightbox-image')) setPreviewAttachment(null) }}>
            <button type="button" className="kb-btn kb-lightbox-close" onClick={() => setPreviewAttachment(null)}>Close</button>
            <AttachmentImage boardId={boardId} share={share} attachment={previewAttachment} className="kb-lightbox-image" alt={previewAttachment.name || 'Card image'} />
            <div className="kb-lightbox-caption">{previewAttachment.name || 'Image'}</div>
          </div>
        </>
      )}

      {shareOpen && (
        <ShareSheet
          boardId={boardId}
          share={share}
          members={displayMembers}
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
})

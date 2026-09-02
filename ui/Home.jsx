import { useEffect, useRef, useState } from 'react'
import { Plus, Trash } from '@openai/apps-sdk-ui/components/Icon'
import { invitationKey } from '../domain.js'
import { useModalFocus } from './modalFocus.js'

function JoinInviteTile({ onJoin }) {
  const [open, setOpen] = useState(false)
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const triggerRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const close = () => {
    setOpen(false)
    setError('')
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const submit = async () => {
    const value = invite.trim()
    if (!value || busy) return
    setBusy(true); setError('')
    try { await onJoin(value) } catch (e) { setError(String(e?.message || e)) }
    finally { setBusy(false) }
  }

  if (!open) return (
    <button ref={triggerRef} className="kb-tile kb-join-tile" onClick={() => setOpen(true)}>
      <span className="kb-tile-title">Join with an invite</span>
      <span className="kb-tile-meta">Paste a Kanban invite from another Möbius user</span>
    </button>
  )

  return (
    <div className="kb-tile kb-join-tile kb-join-open">
      <div className="kb-tile-title">Join with an invite</div>
      <div className="kb-inline-field">
        <input
          ref={inputRef}
          className="kb-input"
          value={invite}
          placeholder="Paste invite…"
          aria-label="Kanban invite"
          onChange={event => setInvite(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); submit() }
            if (event.key === 'Escape') { event.preventDefault(); close() }
          }}
        />
        <button className="kb-btn kb-btn-primary" disabled={busy || !invite.trim()} onClick={submit}>Join</button>
      </div>
      {error && <div className="kb-notice kb-error">{error}</div>}
    </div>
  )
}

export default function Home({ boards, shareMap = {}, invitations = [], online, onOpen, onCreate, onDelete, onAccept, onDecline, onJoin }) {
  const [confirmId, setConfirmId] = useState(null)
  const [invError, setInvError] = useState(null)
  const [busyInv, setBusyInv] = useState(null)
  const confirmRef = useModalFocus(Boolean(confirmId), () => setConfirmId(null))

  return (
    <>
      <div className="kb-header kb-home-header">
        <div className="kb-home-heading">
          <h1 className="kb-title-static">Boards</h1>
          <span className="kb-sub">{boards.length === 1 ? '1 board' : `${boards.length} boards`}</span>
        </div>
        {!online && <span className="kb-offline">Offline — local boards still work</span>}
      </div>
      <div className="kb-divider" />
      <div className="kb-home">
        {boards.map(b => {
          const preview = Array.isArray(b.columnPreview) ? b.columnPreview.slice(0, 5) : []
          const maxCards = Math.max(1, ...preview.map(column => column.count))
          return <div key={b.id} className="kb-board-tile">
            {confirmId === b.id ? <div ref={confirmRef} tabIndex={-1} className="kb-tile kb-tile-confirm" role="alertdialog" aria-modal="true" aria-label={`Delete board ${b.title}?`}>
              <div className="kb-confirm-copy">Delete “{b.title}”?</div>
              <div className="kb-composer-row">
                <button className="kb-btn kb-btn-danger kb-btn-compact" onClick={() => { setConfirmId(null); onDelete(b.id) }}>Delete</button>
                <button className="kb-btn kb-btn-quiet kb-btn-compact" onClick={() => setConfirmId(null)}>Cancel</button>
              </div>
            </div> : <>
              <button className="kb-tile" onClick={() => onOpen(b.id)}>
                <div className="kb-tile-title">{b.title}</div>
                <div className="kb-tile-preview" aria-hidden="true">
                  {preview.map((column, index) => (
                    <span
                      key={index}
                      className="kb-tile-bar"
                      data-status={column.color || 'neutral'}
                      style={{ height: `${Math.max(3, Math.round((column.count / maxCards) * 18))}px` }}
                    />
                  ))}
                </div>
                <div className="kb-tile-meta">
                  {b.cardCount === 1 ? '1 card' : `${b.cardCount} cards`} · {b.columnCount === 1 ? '1 list' : `${b.columnCount} lists`}
                  {shareMap[b.id] ? ' · shared' : ''}
                </div>
              </button>
              <button className="kb-iconbtn kb-tile-del" aria-label={`Delete board ${b.title}`} onClick={() => setConfirmId(b.id)}>
                <Trash />
              </button>
            </>}
          </div>
        })}
        <button className="kb-tile kb-newtile" onClick={onCreate}>
          <Plus /> New board
        </button>
        <JoinInviteTile onJoin={onJoin} />
        {invitations.map(inv => {
          const key = invitationKey(inv)
          return (
            <div key={key} className="kb-tile kb-invite-tile">
              <div className="kb-tile-title">{inv.label || 'A shared board'}</div>
              {invError?.key === key
                ? <div className="kb-notice kb-error">{invError.message}</div>
                : <div className="kb-tile-meta">
                    {inv.from_name || inv.host} invited you · {inv.role === 'viewer' ? 'view only' : 'can edit'}
                  </div>}
              <div className="kb-composer-row">
                <button
                  className="kb-btn kb-btn-primary kb-btn-compact"
                  disabled={busyInv !== null}
                  onClick={async () => {
                    setBusyInv(key); setInvError(null)
                    try { await onAccept(inv) } catch (e) { setInvError({ key, message: String(e?.message || e) }) }
                    finally { setBusyInv(null) }
                  }}
                >Accept</button>
                <button
                  className="kb-btn kb-btn-quiet kb-btn-compact"
                  disabled={busyInv !== null}
                  onClick={async () => {
                    setBusyInv(key); setInvError(null)
                    try { await onDecline(inv) } catch (e) { setInvError({ key, message: String(e?.message || e) }) }
                    finally { setBusyInv(null) }
                  }}
                >Decline</button>
              </div>
            </div>
          )
        })}
        {boards.length === 0 && (
          <div className="kb-home-empty">Create your first board to start organizing.</div>
        )}
      </div>
    </>
  )
}

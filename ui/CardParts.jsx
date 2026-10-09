// The open card's sections. Each section owns its own preview limit and
// empty state, so a card opens at a predictable size however much it holds:
// a few lines of description, the first checklist items, and Attachments and
// Activity folded to one line each.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, Check, ChevronDown, ChevronLeft, DotsHorizontal, Paperclip, Pencil, Plus, PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, Reload, Trash } from '@openai/apps-sdk-ui/components/Icon'
import { useModalFocus } from './modalFocus.js'
import { describeActivity } from '../activity.js'
import { describeAssignmentEvent, restorableAssignment } from '../assignment.js'
import { isPreviewImage, loadCardAttachment, MAX_CARD_ATTACHMENTS } from '../attachments.js'
import { checklistProgress, dueDateStatus, formatDueDate, labelDisplayName, MAX_LABEL_NAME_CHARS, shortLinkText } from '../domain.js'
import { cardPullUrls } from '../operations.js'
import { parsePullRequestUrl } from '../prMatching.js'

export const CHECKLIST_PREVIEW_ITEMS = 3
// The description preview height lives in theme.js (.kb-notes-display.is-clamped).

// ---- text ----

export function linkifiedParts(text) {
  return String(text || '').split(/(https?:\/\/[^\s<]+)/gu).flatMap(part => {
    if (!/^https?:\/\//u.test(part)) return [{ text: part }]
    const match = part.match(/^(.*?)([.,!?;:]+)?$/u)
    const url = match?.[1] || part
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) return [{ text: part }]
      return [{ text: url, href: parsed.href }, { text: match?.[2] || '' }]
    } catch {
      return [{ text: part }]
    }
  })
}

// `compactLinks` shortens what a link shows. Use it only where the text is
// displayed, never inside an editor whose text is saved back (the description
// editor reads its own text on blur, so a shortened link would be saved).
export function LinkifiedText({ text, compactLinks = false }) {
  return linkifiedParts(text).map((part, index) => {
    if (!part.href) return part.text
    return (
      <a
        key={index}
        href={part.href}
        target="_blank"
        rel="noreferrer"
        title={compactLinks ? part.href : undefined}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        {compactLinks ? shortLinkText(part.href) : part.text}
      </a>
    )
  })
}

// React owns the editor shell, not its text nodes. The browser owns selection,
// typing, plain-text paste, composition and undo without replacing the clicked
// surface. Incoming polls update idle editors, never the focused draft/caret.
export function InlineCardText({
  value,
  className,
  label,
  placeholder,
  autoFocus = false,
  links = false,
  onFocus,
  onCommit,
  onCancel,
}) {
  const editorRef = useRef(null)
  const dirtyRef = useRef(false)
  const savedText = value || ''

  const renderText = useCallback(text => {
    const editor = editorRef.current
    if (!editor) return
    const parts = links ? linkifiedParts(text) : [{ text }]
    const nodes = parts.map(part => {
      if (!part.href) return document.createTextNode(part.text)
      const anchor = document.createElement('a')
      anchor.textContent = part.text
      anchor.href = part.href
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      return anchor
    })
    editor.replaceChildren(...nodes)
    editor.dataset.empty = text ? 'false' : 'true'
  }, [links])

  useLayoutEffect(() => {
    const isFocused = document.activeElement === editorRef.current
    if (!isFocused && !dirtyRef.current) renderText(savedText)
  }, [savedText, renderText])

  useLayoutEffect(() => {
    if (autoFocus) editorRef.current?.focus()
  }, [])

  const commitOnBlur = event => {
    const text = event.currentTarget.innerText.replace(/\r\n?/g, '\n')
    if (dirtyRef.current && text !== savedText) {
      const acceptedText = onCommit(text)
      if (acceptedText === false) return
      renderText(acceptedText ?? text)
    } else {
      renderText(savedText)
    }
    dirtyRef.current = false
  }

  const cancelOnEscape = event => {
    if (event.key !== 'Escape' || event.isComposing || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    dirtyRef.current = false
    renderText(savedText)
    onCancel?.()
  }

  const openLink = event => {
    const anchor = event.target.closest('a')
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    window.open(anchor.href, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      ref={editorRef}
      className={className}
      contentEditable="plaintext-only"
      role="textbox"
      tabIndex={0}
      aria-label={label}
      aria-multiline="true"
      data-placeholder={placeholder}
      data-modal-inline-editor
      spellCheck
      onInput={event => {
        dirtyRef.current = true
        event.currentTarget.dataset.empty = event.currentTarget.innerText ? 'false' : 'true'
      }}
      onFocus={onFocus}
      onBlur={commitOnBlur}
      onKeyDown={cancelOnEscape}
      onClick={openLink}
    />
  )
}

// ---- small shared pieces ----

// Appears only when loading takes long enough to notice, so a fast load
// never flickers a spinner.
export function DelayedSpinner({ label = 'Loading' }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150)
    return () => clearTimeout(timer)
  }, [])
  return visible ? <span className="kb-mini-spinner" role="status" aria-label={label} /> : null
}

export function SavedIndicator({ tick }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!tick) return undefined
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 1800)
    return () => clearTimeout(timer)
  }, [tick])
  return <span className={`kb-saved${visible ? ' is-visible' : ''}`} role="status" aria-live="polite">
    {visible && <><Check aria-hidden="true" /> Saved</>}
  </span>
}

export function ShowMore({ expanded, onToggle, more, less = 'Show less' }) {
  return <button type="button" className={`kb-show-more${expanded ? ' is-expanded' : ''}`} aria-expanded={expanded} onClick={onToggle}>
    {expanded ? less : more}<ChevronDown aria-hidden="true" />
  </button>
}

export function CardSection({ title, meta, loading, className = '', children }) {
  return <section className={`kb-section${className ? ` ${className}` : ''}`} aria-label={title}>
    <div className="kb-section-head">
      <h3>{title}</h3>
      {meta}
      {loading && <DelayedSpinner label={`Loading ${title.toLocaleLowerCase()}`} />}
    </div>
    {children}
  </section>
}

// A section folded to one line: its title, an optional count or spinner, a
// summary on the right, and a chevron. Opening it shows the children.
export function FoldingSection({ title, meta, summary, open, onToggle, className = '', children }) {
  return <section className={`kb-section kb-folding${className ? ` ${className}` : ''}`} aria-label={title}>
    <button type="button" className="kb-fold-toggle" aria-expanded={open} onClick={onToggle}>
      <h3>{title}</h3>
      {meta}
      <span className="kb-fold-summary">{open ? '' : summary}</span>
      <ChevronDown aria-hidden="true" className="kb-fold-chevron" />
    </button>
    {open && children}
  </section>
}

// On a phone the menu becomes a bottom sheet in document.body: the card sheet
// is transformed, so a fixed menu inside it would be positioned against it.
const PHONE = '(max-width: 640px)'

function usePopover() {
  const rootRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const menuRef = useModalFocus(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePress = event => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [open])
  const toggle = () => {
    setSheet(typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches)
    setOpen(value => !value)
  }
  const layer = menu => (sheet ? createPortal(<>
    <div className="kb-popover-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
    {menu}
  </>, document.body) : menu)
  const menuClass = `kb-popover-menu${sheet ? ' is-sheet' : ''}`
  return { rootRef, menuRef, open, setOpen, toggle, layer, menuClass }
}

// A ••• trigger whose menu closes after an item is chosen. `children` renders
// the items for the current page (`main` when it opens); an item that only
// switches page carries `data-keep-open`.
export function MenuButton({ label, className = '', children }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  const [page, setPage] = useState('main')
  useEffect(() => { if (open) setPage('main') }, [open])
  useEffect(() => {
    if (open) menuRef.current?.querySelector('button:not(:disabled)')?.focus()
  }, [page])
  return <div className={`kb-menu-button${className ? ` ${className}` : ''}`} ref={rootRef}>
    <button type="button" className="kb-iconbtn kb-menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
      onPointerDown={event => event.stopPropagation()} onClick={toggle}>
      <DotsHorizontal aria-hidden="true" />
    </button>
    {open && layer(<div ref={menuRef} className={`${menuClass} kb-menu-end`} role="menu" aria-label={label}
      onClick={event => { if (event.target.closest('button:not(:disabled):not([data-keep-open])')) setOpen(false) }}>
      {children({ page, setPage })}
    </div>)}
  </div>
}

const capitalize = value => value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value

// ---- header ----

export function StatusPill({ columns, columnId, colorFor, canWrite, onMove }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  const current = columns.find(column => column.id === columnId)
  if (!current) return null
  return <div className="kb-status-pill-wrap" ref={rootRef}>
    <button
      type="button"
      className="kb-status-pill"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Status: ${current.name}${canWrite ? '. Change status' : ''}`}
      disabled={!canWrite}
      onClick={toggle}
    >
      <span className="kb-status-dot" style={{ background: colorFor(current) }} aria-hidden="true" />
      <span className="kb-status-name">{current.name}</span>
      {canWrite && <ChevronDown aria-hidden="true" />}
    </button>
    {open && layer(<div ref={menuRef} className={menuClass} role="menu" aria-label="Move card to">
      {columns.map(column => <button
        key={column.id}
        type="button"
        role="menuitemradio"
        aria-checked={column.id === columnId}
        onClick={() => { setOpen(false); if (column.id !== columnId) onMove(column.id) }}
      >
        <span className="kb-status-dot" style={{ background: colorFor(column) }} aria-hidden="true" />
        <span className="kb-menu-label">{column.name}</span>
        {column.id === columnId && <Check aria-hidden="true" />}
      </button>)}
    </div>)}
  </div>
}

// ---- details row: label and due date (assignee lives with the people picker) ----

// Labels are chosen here, and named here too: the names belong to the board,
// so naming "red" as "Urgent" names it on every card.
export function LabelChip({ label, labels, names, canWrite, onChange, onRename }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  const [page, setPage] = useState('choose')
  useEffect(() => { if (open) setPage('choose') }, [open])
  useEffect(() => {
    if (open) menuRef.current?.querySelector(page === 'names' ? 'input' : 'button')?.focus()
  }, [page])
  const current = label && label !== 'none' && labels[label] ? label : ''
  if (!canWrite && !current) return null
  const choose = name => { onChange(name); setOpen(false) }
  const commitName = (color, input) => {
    const name = input.value.trim()
    if (name !== (names?.[color] || '')) onRename(color, name)
  }
  const colors = Object.entries(labels).filter(([name]) => name !== 'none')
  return <div className="kb-chip-wrap" ref={rootRef}>
    <button
      type="button"
      className={`kb-detail-chip${current ? '' : ' is-empty'}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={current ? `Label: ${labelDisplayName(current, names)}. Change label` : 'Add label'}
      disabled={!canWrite}
      onClick={toggle}
    >
      {current
        ? <><span className="kb-chip-swatch" style={{ background: labels[current] }} aria-hidden="true" />{labelDisplayName(current, names)}</>
        : <><Plus aria-hidden="true" />Add label</>}
    </button>
    {open && page === 'choose' && layer(<div ref={menuRef} className={menuClass} role="menu" aria-label="Choose label">
      <div className="kb-menu-heading">Label</div>
      {colors.map(([name, color]) => <button
        key={name}
        type="button"
        role="menuitemradio"
        aria-checked={current === name}
        onClick={() => choose(name)}
      >
        <span className="kb-chip-swatch" style={{ background: color }} aria-hidden="true" />
        <span className={`kb-menu-label${names?.[name] ? '' : ' is-unnamed'}`}>{labelDisplayName(name, names)}</span>
        {current === name && <Check aria-hidden="true" />}
      </button>)}
      <div className="kb-menu-separator" />
      <button type="button" role="menuitem" onClick={() => setPage('names')}><Pencil aria-hidden="true" /><span className="kb-menu-label">Edit label names</span></button>
      {current && <button type="button" role="menuitem" className="kb-menu-danger" onClick={() => choose('none')}>Remove label</button>}
    </div>)}
    {open && page === 'names' && layer(<div ref={menuRef} className={`${menuClass} kb-label-names`} role="dialog" aria-label="Label names">
      <button type="button" className="kb-menu-back" onClick={() => setPage('choose')}><ChevronLeft aria-hidden="true" />Back</button>
      <div className="kb-menu-heading">Label names for this board</div>
      {colors.map(([name, color]) => <label className="kb-label-name-row" key={name}>
        <span className="kb-chip-swatch" style={{ background: color }} aria-hidden="true" />
        <input
          className="kb-input"
          defaultValue={names?.[name] || ''}
          placeholder={capitalize(name)}
          maxLength={MAX_LABEL_NAME_CHARS}
          aria-label={`Name for the ${name} label`}
          onBlur={event => commitName(name, event.currentTarget)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
        />
      </label>)}
      <p className="kb-label-names-hint">Everyone on this board sees these names. Leave one empty to keep just the colour.</p>
    </div>)}
  </div>
}

function localIsoDate(offsetDays = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Due within this many days (but not overdue) reads as "soon" on cards.
export const DUE_SOON_DAYS = 2

export function dueTone(due, today = localIsoDate()) {
  const status = dueDateStatus(due, today)
  if (status === 'overdue') return 'overdue'
  if (status === 'today') return 'soon'
  if (status === 'upcoming' && due <= localIsoDateFrom(today, DUE_SOON_DAYS)) return 'soon'
  return status ? 'later' : ''
}

function localIsoDateFrom(iso, days) {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

export function dueChipText(due) {
  const face = formatDueDate(due)
  if (!face) return ''
  if (face === 'Today') return 'Due today'
  if (/ over$/u.test(face)) return face.replace(/ over$/u, ' overdue')
  return `Due ${face}`
}

function shortDate(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function DueChip({ due, canWrite, onChange }) {
  const { rootRef, menuRef, open, setOpen, toggle, layer, menuClass } = usePopover()
  if (!canWrite && !due) return null
  const choose = value => { onChange(value); setOpen(false) }
  const quick = [['Today', 0], ['Tomorrow', 1], ['In a week', 7]]
  return <div className="kb-chip-wrap" ref={rootRef}>
    <button
      type="button"
      className={`kb-detail-chip${due ? ` kb-due-chip is-${dueTone(due)}` : ' is-empty'}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={due ? `${dueChipText(due)}. Change due date` : 'Add due date'}
      disabled={!canWrite}
      onClick={toggle}
    >
      {due ? <><Calendar aria-hidden="true" />{dueChipText(due)}</> : <><Plus aria-hidden="true" />Add due date</>}
    </button>
    {open && layer(<div ref={menuRef} className={menuClass} role="menu" aria-label="Choose due date">
      <div className="kb-menu-heading">Due date</div>
      {quick.map(([label, days]) => {
        const value = localIsoDate(days)
        return <button key={label} type="button" role="menuitemradio" aria-checked={due === value} onClick={() => choose(value)}>
          <span className="kb-menu-label">{label}</span>
          <span className="kb-menu-meta">{shortDate(value)}</span>
        </button>
      })}
      <label className="kb-menu-date">
        <span>Pick a date</span>
        <input type="date" value={due || ''} onChange={event => { if (event.target.value) choose(event.target.value) }} />
      </label>
      {due && <><div className="kb-menu-separator" /><button type="button" role="menuitem" className="kb-menu-danger" onClick={() => choose('')}>Remove due date</button></>}
    </div>)}
  </div>
}

// ---- description ----

// `text` is the full description when known. While a shared card's moved-out
// description is still loading, the board's preview is shown read-only: an
// edit started from the preview would save a truncated text.
// `maxLength` (shared boards only) refuses a longer text before it is sent;
// the editor keeps the text and says why, so nothing vanishes unsaved.
export function DescriptionSection({ cardId, text, canWrite, editable, loading, maxLength, conflict, error, onEditStart, onCommit, onKeepMine, onUseTheirs }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const [refusedLength, setRefusedLength] = useState(0)
  const bodyRef = useRef(null)
  useEffect(() => { setExpanded(false); setRefusedLength(0) }, [cardId])
  useLayoutEffect(() => {
    const body = bodyRef.current?.querySelector('.kb-notes-display')
    if (!body) return undefined
    const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1)
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(body)
    return () => observer?.disconnect()
  }, [text, expanded, editable])
  if (!canWrite && !text) return null
  // An older description may already be longer than the limit: it can still
  // be edited, just not made longer (the host applies the same rule).
  const commit = value => {
    if (maxLength && value.length > maxLength && value.length > (text || '').length) {
      setRefusedLength(value.length)
      return false
    }
    setRefusedLength(0)
    return onCommit(value) === false ? false : value
  }
  const clamp = expanded ? '' : ' is-clamped'
  return <CardSection title="Description" loading={loading}>
    <div className="kb-description" ref={bodyRef}>
      {canWrite && editable ? <InlineCardText
        key={cardId}
        className={`kb-notes-display kb-editable-field${clamp}`}
        value={text}
        placeholder="Add a description…"
        label="Card description"
        links
        onFocus={onEditStart}
        onCommit={commit}
        onCancel={() => setRefusedLength(0)}
      /> : <div className={`kb-notes-display${text ? '' : ' kb-notes-empty'}${clamp}`}>
        {text ? <LinkifiedText text={text} /> : 'Add a description…'}
      </div>}
    </div>
    {(overflows || expanded) && <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more="Show more" />}
    {conflict && <div className="kb-notes-conflict" role="alert">
      <p>Someone else changed this description while you were editing.</p>
      <div className="kb-notes-conflict-actions">
        <button type="button" className="kb-btn kb-btn-quiet" onClick={onUseTheirs}>Use theirs</button>
        <button type="button" className="kb-btn kb-btn-primary" onClick={onKeepMine}>Keep mine</button>
      </div>
    </div>}
    {refusedLength > 0 && <p className="kb-attachment-error" role="alert">
      Not saved: this description has {refusedLength.toLocaleString()} characters. A shared board keeps at most {maxLength.toLocaleString()}, and a longer one can be edited but not made longer. Make it shorter or move the long part into an attachment.
    </p>}
    {error && <p className="kb-attachment-error" role="alert">{error}</p>}
  </CardSection>
}

// ---- checklist ----

export function ChecklistSection({ checklist, canWrite, onAdd, onToggle, onDelete, onEdit }) {
  const [newItemText, setNewItemText] = useState('')
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [editingItem, setEditingItem] = useState(null)
  if (!checklist.length && !canWrite) return null
  const progress = checklistProgress(checklist)
  const visible = expanded ? checklist : checklist.slice(0, CHECKLIST_PREVIEW_ITEMS)
  const hidden = checklist.length - CHECKLIST_PREVIEW_ITEMS

  const addItem = () => {
    const text = newItemText.trim()
    if (!text || !canWrite) return
    onAdd(text)
    setNewItemText('')
    if (checklist.length >= CHECKLIST_PREVIEW_ITEMS) setExpanded(true)
  }
  const saveItem = item => {
    const text = editingItem.text.trim()
    if (text && text !== item.text) onEdit(item.id, text)
    setEditingItem(null)
  }
  const handleEditKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEditingItem(null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  const meta = progress.total > 0 && <>
    <span className="kb-section-count">{progress.done}/{progress.total}</span>
    <span className={`kb-section-progress${progress.done === progress.total ? ' is-done' : ''}`} role="progressbar"
      aria-label={`${progress.done} of ${progress.total} checklist items complete`}
      aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
      <span style={{ width: `${progress.percent}%` }} />
    </span>
  </>

  return <CardSection title="Checklist" meta={meta}>
    {visible.length > 0 && <div className="kb-checklist">
      {visible.map(item => (
        <div className={`kb-check-item${editingItem?.id === item.id ? ' is-editing' : ''}`} key={item.id}>
          <div className="kb-check-toggle">
            <input type="checkbox" checked={item.done} aria-label={item.text} disabled={!canWrite} onChange={() => onToggle(item.id)} />
            {editingItem?.id === item.id ? (
              <input
                className="kb-input kb-check-edit"
                data-modal-inline-editor
                value={editingItem.text}
                aria-label={`Edit checklist item ${item.text}`}
                autoFocus
                onChange={event => setEditingItem({ id: item.id, text: event.target.value })}
                onBlur={() => saveItem(item)}
                onKeyDown={handleEditKey}
              />
            ) : canWrite ? (
              // Not a <button>: the item's links must stay clickable inside it.
              <span role="button" tabIndex={0} className={`kb-check-text ${item.done ? 'kb-check-done' : ''}`}
                onClick={() => setEditingItem({ id: item.id, text: item.text })}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setEditingItem({ id: item.id, text: item.text })
                }}>
                <LinkifiedText text={item.text} compactLinks />
              </span>
            ) : (
              <span className={`kb-check-text ${item.done ? 'kb-check-done' : ''}`}><LinkifiedText text={item.text} compactLinks /></span>
            )}
          </div>
          {/* On touch screens the bin shows only while the item is being
              edited. Pressing it must not blur the editor first, or the
              edit would close and hide the bin before the tap lands. */}
          {canWrite && <button className="kb-iconbtn kb-check-delete" aria-label={`Delete checklist item ${item.text}`}
            onMouseDown={event => event.preventDefault()}
            onClick={() => { setEditingItem(null); onDelete(item.id) }}><Trash /></button>}
        </div>
      ))}
    </div>}
    {canWrite && adding && <div className="kb-check-add">
      <input
        className="kb-input"
        value={newItemText}
        autoFocus
        placeholder="Add an item…"
        aria-label="New checklist item"
        onChange={event => setNewItemText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); addItem() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAdding(false); setNewItemText('') }
        }}
      />
      <button className="kb-btn kb-btn-primary" disabled={!newItemText.trim()} onClick={addItem}>Add</button>
    </div>}
    <div className="kb-section-actions">
      {hidden > 0 && <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more={`Show ${hidden} more`} less="Show fewer" />}
      {canWrite && !adding && <button type="button" className="kb-quiet-action" onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add an item</button>}
    </div>
  </CardSection>
}

// ---- pull requests: one line each, named by their GitHub title ----

export const PULL_REQUEST_PREVIEW_ITEMS = 2

function pullRequestTitle(url) {
  const pull = parsePullRequestUrl(url)
  return pull ? `${pull.owner}/${pull.repo} #${pull.number}` : url
}

function pullRequestReference(url) {
  const pull = parsePullRequestUrl(url)
  if (pull) return `${pull.repo} #${pull.number}`
  try { return new URL(url).hostname } catch { return 'Link' }
}

const PULL_REQUEST_ICONS = { open: PullRequestOpen, draft: PullRequestDraft, merged: PullRequestMerged, closed: PullRequestClosed }

// Statuses are keyed by URL. Offline, nothing new is fetched: a card keeps its
// last known status, and a link never checked (or not a GitHub PR) shows none.
// Until a title arrives, a line is named by its repository and number.
export function PullRequestSection({ card, canWrite, online, statuses, onUpdate, onRefresh }) {
  const urls = cardPullUrls(card)
  const statusFor = url => (parsePullRequestUrl(url) ? statuses[url] || (online ? { label: 'Checking…', tone: 'unknown' } : null) : null)
  const hints = [...new Set(urls.map(url => statusFor(url)?.hint).filter(Boolean))]
  const [editor, setEditor] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { setEditor(null); setDraft(''); setError(''); setExpanded(false) }, [card.id])
  if (!urls.length && !canWrite) return null
  const save = () => {
    if (!parsePullRequestUrl(draft)) { setError('Use a GitHub pull request link, like https://github.com/owner/repo/pull/123'); return }
    onUpdate(editor === 'add' ? null : editor, draft.trim())
    if (editor === 'add' && urls.length >= PULL_REQUEST_PREVIEW_ITEMS) setExpanded(true)
    setEditor(null); setDraft(''); setError('')
  }
  const cancel = () => { setEditor(null); setDraft(''); setError('') }
  const form = submitLabel => <form className="kb-pr-editor" onSubmit={event => { event.preventDefault(); save() }}>
    <input className="kb-input" type="url" autoFocus value={draft} aria-label="Pull request link"
      placeholder="https://github.com/owner/repo/pull/123"
      onChange={event => { setDraft(event.target.value); setError('') }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }} />
    <button type="submit" className="kb-btn kb-btn-primary">{submitLabel}</button>
    <button type="button" className="kb-btn kb-btn-quiet" onClick={cancel}>Cancel</button>
  </form>
  const canRefresh = online && urls.some(parsePullRequestUrl)
  const adding = editor === 'add'
  const visible = expanded ? urls : urls.slice(0, PULL_REQUEST_PREVIEW_ITEMS)
  const hidden = urls.length - PULL_REQUEST_PREVIEW_ITEMS
  const title = urls.length > 1 ? 'Pull requests' : 'Pull request'
  // Refresh and add sit on the heading's right edge, the same size as each
  // line's pencil, so every button in the section shares one column.
  const headingActions = (canRefresh || canWrite) && <span className="kb-section-head-actions">
    {canRefresh && <button type="button" className="kb-iconbtn kb-section-icon" aria-label="Refresh pull request statuses" title="Refresh statuses" onClick={onRefresh}><Reload /></button>}
    {canWrite && <button type="button" className="kb-iconbtn kb-section-icon" aria-label="Add pull request" title="Add pull request" aria-expanded={adding}
      onClick={() => { if (adding) cancel(); else { setEditor('add'); setDraft(''); setError('') } }}><Plus /></button>}
  </span>
  return <CardSection title={title} className="kb-pr-section" meta={<>
    {urls.length > 1 && <span className="kb-section-count">{urls.length}</span>}
    {headingActions}
  </>}>
    {adding && form('Add')}
    {visible.map(url => {
      const status = statusFor(url)
      if (editor === url) return <div key={url}>
        {form('Save')}
        <button type="button" className="kb-quiet-action kb-menu-danger" onClick={() => { onUpdate(url, ''); cancel() }}><Trash aria-hidden="true" />Remove this pull request</button>
      </div>
      const Icon = PULL_REQUEST_ICONS[status?.tone] || PullRequestOpen
      return <div className="kb-pr-line" key={url}>
        <Icon className="kb-pr-icon" aria-hidden="true" />
        <a className="kb-pr-link" href={url} target="_blank" rel="noreferrer" title={`Open ${pullRequestTitle(url)} on GitHub`}>
          <span className="kb-pr-name">{status?.title || pullRequestTitle(url)}</span>
          {status?.title && <span className="kb-pr-ref">{pullRequestReference(url)}</span>}
        </a>
        {status && <span className={`kb-pr-status kb-pr-status-${status.tone}`}>{status.label}</span>}
        {canWrite && <button type="button" className="kb-iconbtn kb-section-icon kb-pr-edit" aria-label={`Change or remove ${pullRequestTitle(url)}`} title="Change or remove" onClick={() => { setEditor(url); setDraft(url) }}><Pencil /></button>}
      </div>
    })}
    {hidden > 0 && <div className="kb-section-actions">
      <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more={`Show ${hidden} more`} less="Show fewer" />
    </div>}
    {hints.map(hint => <p className="kb-pr-hint" key={hint}>{hint}</p>)}
    {error && <p className="kb-attachment-error" role="alert">{error}</p>}
  </CardSection>
}

// ---- attachments ----

export function AttachmentImage({ boardId, share, attachment, className, alt = '' }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setSrc(''); setFailed(false)
    loadCardAttachment({ boardId, share, attachment }).then(value => {
      if (alive) setSrc(value)
    }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [boardId, share?.host, share?.oid, attachment.id, attachment.path])
  if (failed) return <span className={`${className} kb-image-missing`} role="img" aria-label="Image unavailable" />
  if (!src) return <span className={`${className} kb-image-loading`} aria-hidden="true" />
  return <img className={className} src={src} alt={alt} />
}

function fileBadge(attachment) {
  const extension = String(attachment.name || '').split('.').pop()
  return extension && extension.length <= 5 && extension !== attachment.name ? extension.toLocaleUpperCase() : 'FILE'
}

// A board card shows one attachment: its first picture, or, when it has only
// files, the first file's name. The details row counts all of them.
export function CardTileAttachment({ boardId, share, attachments }) {
  const attachment = attachments.find(isPreviewImage) || attachments[0]
  if (!attachment) return null
  if (isPreviewImage(attachment)) return <AttachmentImage boardId={boardId} share={share} attachment={attachment} className="kb-card-picture" alt="" />
  return <div className="kb-card-file">
    <span className="kb-card-file-badge">{fileBadge(attachment)}</span>
    <span className="kb-card-file-name">{attachment.name || 'Attachment'}</span>
  </div>
}

export const ATTACHMENT_PREVIEW_ITEMS = 3

// Attachments show their first row of files and "Show N more", like the
// checklist. A card without attachments shows the add action on the heading
// line instead. Each card mounts its own section (keyed by card), so a file
// added past the first row expands the list to show it.
export function AttachmentsSection({ boardId, share, attachments, canWrite, isDraft, busy, error, onPick, onPreview, onDownload, onRemove }) {
  const count = attachments.length
  const [expanded, setExpanded] = useState(false)
  const shownCount = useRef(count)
  useEffect(() => {
    if (count > shownCount.current && count > ATTACHMENT_PREVIEW_ITEMS) setExpanded(true)
    shownCount.current = count
  }, [count])
  if (!count && !canWrite) return null
  const full = count >= MAX_CARD_ATTACHMENTS
  const addProps = {
    type: 'button',
    disabled: isDraft || busy || full,
    onClick: onPick,
    title: isDraft ? 'Add a title to attach files' : full ? `Limit of ${MAX_CARD_ATTACHMENTS} reached` : 'Images or files. You can also drop or paste them onto the card.',
  }
  const errorLine = error && <p className="kb-attachment-error" role="alert">{error}</p>
  if (!count) return <section className="kb-section" aria-label="Attachments">
    <div className="kb-section-line">
      <h3>Attachments</h3>
      <button className="kb-detail-chip is-empty" {...addProps}><Plus aria-hidden="true" />{busy ? 'Adding files…' : 'Add attachment'}</button>
    </div>
    {errorLine}
  </section>
  const visible = expanded ? attachments : attachments.slice(0, ATTACHMENT_PREVIEW_ITEMS)
  const hidden = count - ATTACHMENT_PREVIEW_ITEMS
  return <CardSection title="Attachments" meta={<span className="kb-section-count">{count}</span>}>
    <div className="kb-attachment-tiles">
      {visible.map(attachment => {
        const image = isPreviewImage(attachment)
        const name = attachment.name || (image ? 'Image' : 'Attachment')
        return <figure className="kb-attachment-tile" key={attachment.id}>
          <button type="button" className="kb-attachment-open" aria-label={image ? `Preview ${name}` : `Download ${name}`} title={name}
            onClick={() => (image ? onPreview(attachment) : onDownload(attachment))}>
            {image
              ? <AttachmentImage boardId={boardId} share={share} attachment={attachment} className="kb-attachment-thumb" alt="" />
              : <span className="kb-attachment-thumb kb-attachment-file" aria-hidden="true">{fileBadge(attachment)}</span>}
            <figcaption>{name}</figcaption>
          </button>
          {canWrite && <button type="button" className="kb-iconbtn kb-attachment-remove" aria-label={`Remove ${name}`} onClick={() => onRemove(attachment)}><Trash /></button>}
        </figure>
      })}
    </div>
    {(hidden > 0 || canWrite) && <div className="kb-section-actions">
      {hidden > 0 && <ShowMore expanded={expanded} onToggle={() => setExpanded(value => !value)} more={`Show ${hidden} more`} less="Show fewer" />}
      {canWrite && <button className="kb-quiet-action" {...addProps}><Paperclip aria-hidden="true" />{busy ? 'Adding files…' : 'Add attachment'}</button>}
    </div>}
    {errorLine}
  </CardSection>
}

// ---- activity ----

export function formatActivityTime(iso, now = new Date()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  const day = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
  return `${day}, ${time}`
}

const lowerFirst = text => text ? text.charAt(0).toLocaleLowerCase() + text.slice(1) : text

// One timeline: the card's activity (kept beside the board) plus its
// assignment history (kept on the card) and assignment changes this device
// noticed from apps that record no history. Newest first.
export function cardTimeline({ card, activity, assignmentTimeline, actorName }) {
  const changes = (activity || []).map(entry => {
    const actor = actorName(entry)
    return { key: `a-${entry.id}`, at: entry.at, actor, text: describeActivity(entry), kind: 'change' }
  })
  const assignments = (assignmentTimeline || []).map((event, index) => ({
    key: `${event.observed ? 'seen' : 'assign'}-${event.id}`,
    at: event.at,
    event,
    first: index === 0,
    kind: event.observed ? 'observed' : 'assignment',
  }))
  return [...changes, ...assignments].sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}

export function CardActivity({ card, timeline, status, canWrite, nameFor, onRestore }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [card.id])
  const latest = timeline[0]
  const loading = status === 'loading'
  const restoreEvent = timeline.find(item => item.event && !item.event.observed)?.event
  const restore = canWrite && restoreEvent ? restorableAssignment(restoreEvent, card) : null
  const summary = latest
    ? `Last change ${lowerFirst(formatActivityTime(latest.at))}${latest.actor ? ` by ${latest.actor}` : ''}`
    : loading ? '' : 'No changes yet'
  const meta = <>
    {timeline.length > 0 && <span className="kb-section-count">{timeline.length}</span>}
    {loading && <DelayedSpinner label="Loading activity" />}
  </>
  return <FoldingSection title="Activity" meta={meta} summary={summary} open={open} onToggle={() => setOpen(value => !value)} className="kb-card-activity">
    {status === 'unsupported' && <p className="kb-activity-note">Full activity appears once this board’s host updates Kanban. Assignment changes are shown below.</p>}
    {status === 'error' && <p className="kb-activity-note">Activity couldn’t be loaded right now.</p>}
    {timeline.length > 0 && <ol className="kb-activity-list" tabIndex={0} aria-label="Card activity, newest first">
      {timeline.map(item => <li key={item.key} className={`kb-activity-item is-${item.kind}`}>
        <span className="kb-activity-dot" aria-hidden="true" />
        <div className="kb-activity-copy">
          {item.event
            ? <span>{describeAssignmentEvent(item.event, nameFor)}</span>
            : <span><strong>{item.actor}</strong> {item.text}</span>}
          <small>
            <time dateTime={item.at}>{formatActivityTime(item.at)}</time>
            {item.kind === 'observed' && <> · changed outside Kanban</>}
          </small>
        </div>
        {item.event && item.event === restoreEvent && restore && (
          <button type="button" className="kb-btn kb-btn-quiet kb-activity-restore" onClick={() => onRestore(restore)}>
            {nameFor(restore) === 'you' ? 'Put me back' : `Restore ${nameFor(restore)}`}
          </button>
        )}
      </li>)}
    </ol>}
  </FoldingSection>
}

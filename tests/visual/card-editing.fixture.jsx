import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BoardPresence,
  LabelPicker,
  AssigneePicker,
  CardTitleEditor,
  CardNotesEditor,
  ChecklistEditor,
} from './ui/Board.jsx'
import { CSS } from './theme.js'

// Synthetic raster avatar: no account photos or live profile reads.
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const blockLiveWrite = async () => { throw Error('Live writes blocked') }

window.fetch = async () => new Response('', { status: 503 })
window.mobius = {
  storage: {
    get: async () => null,
    set: blockLiveWrite,
    durableWrite: blockLiveWrite,
    subscribe: () => () => {},
  },
  signal: () => {},
}

const people = [
  { host: 'me.example', handle: 'memberone', name: 'Member One', host_owner: true, active: true, avatar: photo },
  { host: 'peer.example', handle: 'membertwo', active: true, avatar: '' },
]

window.__cardEditing = { commits: [], links: [], cancelled: 0 }
window.open = (...args) => { window.__cardEditing.links.push(args) }

function Fixture() {
  const [card, setCard] = useState({
    id: 'fixture',
    title: 'Polish Kanban controls and editing',
    notes: 'First line of card notes.\nSecond line with https://example.com/docs.',
    label: 'blue',
    assignee: '@memberone',
    assigneeHost: 'me.example',
  })
  const [readonly, setReadonly] = useState(false)
  const [checklist, setChecklist] = useState([
    { id: 'first', text: 'Review the card controls', done: false },
    { id: 'second', text: 'Check editing on a phone', done: true },
  ])

  const editChecklistItem = (id, text) => {
    window.__cardEditing.commits.push({ itemId: id, text })
    setChecklist(items => items.map(item => item.id === id ? { ...item, text } : item))
  }
  const updateCard = patch => {
    if (window.__cardEditing.rejectSaves) return false
    window.__cardEditing.commits.push(patch)
    setCard(current => ({ ...current, ...patch }))
    return true
  }

  window.__cardEditing.checklist = checklist
  window.__cardEditing.current = card
  window.__cardEditing.remote = patch => setCard(current => ({ ...current, ...patch }))

  return (
    <div className="kb-root">
      <style>{CSS}</style>
      <header className="kb-toolbar">
        <strong>Kanban interaction check</strong>
        <BoardPresence members={people} onOpen={() => {}} />
      </header>
      <div className="kb-card-sheet kb-sheet" role="dialog" aria-label="Card details">
        <div className="kb-card-toolbar">
          <span className="kb-card-toolbar-title kb-card-toolbar-list">
            <span className="kb-col-status" aria-hidden="true" style={{ background: 'var(--kb-label-blue)' }} />
            <span className="kb-card-toolbar-list-name">In progress</span>
          </span>
          <LabelPicker label={card.label} canWrite={!readonly} onChange={label => updateCard({ label })} />
          <AssigneePicker card={card} canWrite={!readonly} members={people} share={{}} iconOnly onUpdate={updateCard} />
          <button className="kb-btn kb-btn-primary kb-card-toolbar-done" onClick={() => {}}>Done</button>
        </div>
        <div className="kb-card-detail">
          <CardTitleEditor
            card={card}
            canWrite={!readonly}
            onCommit={title => updateCard({ title })}
            onCancel={() => { window.__cardEditing.cancelled++ }}
          />
          <CardNotesEditor card={card} canWrite={!readonly} onCommit={notes => updateCard({ notes })} />
          <ChecklistEditor
            checklist={checklist}
            canWrite={!readonly}
            onEdit={editChecklistItem}
            onAdd={text => setChecklist(items => [...items, { id: 'added', text, done: false }])}
            onToggle={id => setChecklist(items => items.map(item => item.id === id ? { ...item, done: !item.done } : item))}
            onDelete={id => setChecklist(items => items.filter(item => item.id !== id))}
          />
          <button data-fixture-readonly onClick={() => setReadonly(value => !value)}>Toggle read-only</button>
          <button
            data-fixture-draft
            onClick={() => setCard({ id: 'draft', title: '', notes: '', label: 'none', assignee: '' })}
          >
            Test blank draft
          </button>
        </div>
      </div>
    </div>
  )
}

document.body.replaceChildren()
const root = document.createElement('div')
document.body.append(root)
createRoot(root).render(<Fixture />)

export default Fixture

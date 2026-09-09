import { useEffect, useRef } from 'react'
import { visibleFocusableElements } from './focusableElements.js'

// Only the foremost dialog owns keyboard focus. Portalled pickers can sit above
// a sheet without the sheet underneath pulling Tab focus away from them.
const openDialogs = []

// Shared modal behavior for sheets, panels, and in-place confirmations.
export function useModalFocus(open, onClose) {
  const dialogRef = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const opener = document.activeElement
    const dialog = dialogRef.current
    openDialogs.push(dialog)
    const isTopmost = () => openDialogs[openDialogs.length - 1] === dialog
    const focusable = () => visibleFocusableElements(dialog)

    ;(focusable()[0] || dialog)?.focus()
    const onKeyDown = event => {
      if (!isTopmost()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) {
        event.preventDefault()
        dialog?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = openDialogs.lastIndexOf(dialog)
      if (index >= 0) openDialogs.splice(index, 1)
      if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus()
    }
  }, [open])

  return dialogRef
}

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

const SIZES = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }

interface ModalProps {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  size?: keyof typeof SIZES
  /** Buttons row, pinned to the bottom of the dialog. */
  footer?: React.ReactNode
  /** Set while a save is in flight so the dialog cannot be dismissed mid-request. */
  busy?: boolean
  /** false = only the X and the footer buttons close it (long forms with unsaved input). */
  dismissible?: boolean
  children: React.ReactNode
}

export default function Modal({ open, onClose, title, subtitle, size = 'md', footer, busy, dismissible = true, children }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null)
  // Pressing down on the backdrop and releasing there closes; a drag that
  // started inside the form (selecting text) must not.
  const pressedOnBackdrop = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && dismissible) onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, busy, dismissible, onClose])

  useEffect(() => {
    if (!open) return
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea')
    ;(first || panel.current)?.focus()
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget }}
      onMouseUp={(e) => {
        if (pressedOnBackdrop.current && e.target === e.currentTarget && !busy && dismissible) onClose()
        pressedOnBackdrop.current = false
      }}
    >
      <div ref={panel} role="dialog" aria-modal="true" tabIndex={-1} className={`modal-content ${SIZES[size]} outline-none`}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink truncate">{title}</h2>
            {subtitle && <p className="text-xs text-ink-3 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" className="btn-icon -mr-2 -mt-1 shrink-0" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-line bg-surface-2/40 rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

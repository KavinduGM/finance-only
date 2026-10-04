import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import Modal from './Modal'

interface ConfirmOptions {
  title: string
  message?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' for deletes and anything that cannot be undone. */
  tone?: 'default' | 'danger'
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Replaces window.confirm():  if (!(await confirm({ title: 'Delete invoice?', tone: 'danger' }))) return */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<(ok: boolean) => void>()

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = (ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = undefined
    setOptions(null)
  }

  const danger = options?.tone === 'danger'

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!options}
        onClose={() => close(false)}
        size="sm"
        title={
          <span className="flex items-center gap-2">
            {danger && <AlertTriangle size={16} className="text-bad shrink-0" />}
            {options?.title}
          </span>
        }
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => close(false)}>
              {options?.cancelLabel || 'Cancel'}
            </button>
            <button type="button" data-autofocus className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => close(true)}>
              {options?.confirmLabel || 'Confirm'}
            </button>
          </>
        }
      >
        <div className="text-sm text-ink-2 leading-relaxed">{options?.message || 'This cannot be undone.'}</div>
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider')
  return ctx
}

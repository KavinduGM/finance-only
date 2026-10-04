import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Save } from 'lucide-react'
import type { Settings } from '../../services/api'
import { Spinner } from '../../components/ui'

/** Same shape the server accepts, so a bad address is caught before the request. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed text, or null when nothing is left (the server stores a blank field as null). */
export const textOrNull = (value: string) => value.trim() || null

/** A whole number typed into a field, or null when it is anything else. */
export const wholeNumber = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null)

/** Props of the tabs that edit the company settings row. */
export interface SettingsTabProps {
  settings: Settings
  /** Hand back the settings the server returned, so every tab and the rest of the app follow. */
  onSaved: (next: Settings) => void
}

type FormValues = Record<string, string | boolean>

/**
 * Form state for one settings tab. `changed` lists the fields that differ from
 * what is saved, so a tab sends only what the user touched. When the saved
 * settings change underneath (another tab saved), untouched fields follow and
 * edits in progress stay.
 */
export function useSettingsForm<F extends FormValues>(settings: Settings, toForm: (s: Settings) => F) {
  const saved = useMemo(() => toForm(settings), [settings, toForm])
  const [form, setForm] = useState<F>(saved)
  const previous = useRef(saved)

  useEffect(() => {
    const before = previous.current
    if (before === saved) return
    previous.current = saved
    setForm((current) => {
      const next = { ...current }
      for (const key of Object.keys(saved) as (keyof F)[]) {
        if (current[key] === before[key]) next[key] = saved[key]
      }
      return next
    })
  }, [saved])

  const set = useCallback(<K extends keyof F>(key: K, value: F[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }, [])

  const changed = (Object.keys(saved) as (keyof F)[]).filter((key) => form[key] !== saved[key])

  return {
    form,
    set,
    changed,
    dirty: changed.length > 0,
    /** Back to what is saved. */
    discard: () => setForm(saved),
    /** After a save: show exactly what the server stored (trimmed text, cleared password box). */
    adopt: (next: Settings) => setForm(toForm(next)),
  }
}

// ── Layout ───────────────────────────────────────────────────────────────────

export function Section({ title, description, actions, flush, children }: {
  title: string
  description?: React.ReactNode
  /** Buttons at the right of the heading. */
  actions?: React.ReactNode
  /** No padding around the body; for a table that runs edge to edge. */
  flush?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <div className={`flex flex-wrap items-start justify-between gap-3 px-5 pt-5 ${flush ? 'pb-4' : ''}`}>
        <div className="min-w-0">
          <h2 className="card-title">{title}</h2>
          {description && <p className="card-sub max-w-2xl">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={flush ? 'border-t border-line' : 'p-5'}>{children}</div>
    </section>
  )
}

/** Last row of a settings form. It stays in view while there is something to save. */
export function SaveBar({ dirty, saving, onDiscard }: {
  dirty: boolean
  saving: boolean
  onDiscard: () => void
}) {
  return (
    <div
      className={`card flex flex-wrap items-center justify-between gap-3 px-5 py-3
        ${dirty ? 'sticky bottom-3 z-10 border-line-strong' : ''}`}
    >
      <p className="text-xs text-ink-3" aria-live="polite">
        {dirty ? 'You have unsaved changes on this tab.' : 'No unsaved changes.'}
      </p>
      <div className="flex items-center gap-2">
        {dirty && (
          <button type="button" className="btn-ghost" onClick={onDiscard} disabled={saving}>
            Discard
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={!dirty || saving}>
          {saving ? <Spinner /> : <Save size={15} />} Save changes
        </button>
      </div>
    </div>
  )
}

const NOTICE_TONES = {
  info: { box: 'bg-surface-2 border-line text-ink-2', icon: Info },
  good: { box: 'bg-good/10 border-good/20 text-good', icon: CheckCircle2 },
  warn: { box: 'bg-warn/10 border-warn/20 text-warn', icon: AlertTriangle },
  bad: { box: 'bg-bad/10 border-bad/20 text-bad', icon: AlertTriangle },
}

/** A message that stays on the page (a toast is gone after a few seconds). */
export function Notice({ tone = 'info', alert, children }: {
  tone?: keyof typeof NOTICE_TONES
  /** Announce it to screen readers as soon as it appears. */
  alert?: boolean
  children: React.ReactNode
}) {
  const { box, icon: Icon } = NOTICE_TONES[tone]
  return (
    <div role={alert ? 'alert' : undefined} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${box}`}>
      <Icon size={15} className="shrink-0 mt-0.5" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  )
}

// ── Switches ─────────────────────────────────────────────────────────────────

/** An on/off setting. The row carries the label; the word next to the switch states the value. */
export function ToggleRow({ id, label, hint, checked, onChange, disabled, children }: {
  id: string
  label: string
  hint?: React.ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Extra fields that belong to this switch, shown underneath it. */
  children?: React.ReactNode
}) {
  return (
    <div className="py-5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id={`${id}-label`} className="text-sm font-medium text-ink">{label}</p>
          {hint && <p id={`${id}-hint`} className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">{hint}</p>}
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-xs text-ink-3 w-5 text-right" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-labelledby={`${id}-label`}
            aria-describedby={hint ? `${id}-hint` : undefined}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex items-center h-5 w-9 rounded-full border transition-colors duration-150
              disabled:opacity-50 disabled:pointer-events-none
              ${checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line-strong'}`}
          >
            <span
              className={`inline-block w-3.5 h-3.5 rounded-full transition-transform duration-150
                ${checked ? 'translate-x-[18px] bg-accent-ink' : 'translate-x-0.5 bg-ink-3'}`}
            />
          </button>
        </div>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

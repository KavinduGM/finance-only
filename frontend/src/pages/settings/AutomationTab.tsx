import { useState } from 'react'
import toast from 'react-hot-toast'
import { settingsApi } from '../../services/api'
import type { Settings } from '../../services/api'
import { Field } from '../../components/ui'
import { errorMessage } from '../../lib/format'
import { SaveBar, Section, ToggleRow, useSettingsForm, wholeNumber } from './shared'
import type { SettingsTabProps } from './shared'

const toForm = (s: Settings) => ({
  auto_send_reminders: !!s.auto_send_reminders,
  reminder_days_before: String(s.reminder_days_before ?? 3),
  overdue_check_enabled: !!s.overdue_check_enabled,
  low_cash_alert_enabled: !!s.low_cash_alert_enabled,
})

/** The background jobs an administrator can switch on and off. */
export default function AutomationTab({ settings, onSaved }: SettingsTabProps) {
  const { form, set, changed, dirty, discard, adopt } = useSettingsForm(settings, toForm)
  const [daysError, setDaysError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !dirty) return

    const body: Partial<Settings> = {}
    for (const key of changed) {
      if (key === 'reminder_days_before') {
        const days = wholeNumber(form.reminder_days_before)
        if (days === null || days > 60) {
          setDaysError('Enter a whole number of days from 0 to 60')
          return
        }
        body.reminder_days_before = days
      } else {
        body[key] = form[key] ? 1 : 0
      }
    }

    setSaving(true)
    try {
      const next = await settingsApi.update(body)
      adopt(next)
      onSaved(next)
      toast.success('Automation settings saved')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the automation settings'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 max-w-4xl" noValidate>
      <Section title="Automation" description="Work the system does on its own, on the server, whether or not anyone is signed in.">
        <div className="divide-y divide-line">
          <ToggleRow
            id="auto-reminders"
            label="Email payment reminders to clients"
            hint="Every morning at 09:00, clients with an invoice that is due soon or overdue get a reminder by email. Email has to be set up, and the invoice needs a client email address."
            checked={form.auto_send_reminders}
            onChange={(on) => set('auto_send_reminders', on)}
          >
            <Field
              label="Days before the due date"
              className="max-w-xs"
              error={daysError}
              hint="Use 0 to remind on the due date itself. Overdue invoices are reminded every 3 days, up to 6 times."
            >
              <input
                className="input num" type="number" inputMode="numeric" min={0} max={60} step={1}
                disabled={!form.auto_send_reminders}
                value={form.reminder_days_before}
                onChange={(e) => {
                  set('reminder_days_before', e.target.value)
                  if (daysError) setDaysError(null)
                }}
              />
            </Field>
          </ToggleRow>

          <ToggleRow
            id="overdue-check"
            label="Mark invoices overdue automatically"
            hint="A sent invoice that passes its due date changes to Overdue and you are notified. Overdue reminders are only sent for invoices marked this way."
            checked={form.overdue_check_enabled}
            onChange={(on) => set('overdue_check_enabled', on)}
          />

          <ToggleRow
            id="low-cash"
            label="Low cash alert"
            hint="Warns you with a notification when cash on hand falls below one month of average expenses."
            checked={form.low_cash_alert_enabled}
            onChange={(on) => set('low_cash_alert_enabled', on)}
          />
        </div>
      </Section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => {
          discard()
          setDaysError(null)
        }}
      />
    </form>
  )
}

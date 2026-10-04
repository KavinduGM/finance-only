import type { Client, DocumentClientFields } from '../../services/api'
import { Field } from './primitives'

export const emptyClientFields = (): DocumentClientFields => ({
  client_id: null, client_name: '', client_email: '', client_company: '', client_address: '',
})

interface Props {
  clients: Client[]
  value: DocumentClientFields
  onChange: (value: DocumentClientFields) => void
  errors?: { client_name?: string | null; client_email?: string | null }
}

/**
 * "Bill to" block shared by the invoice and proposal forms. Picking a saved
 * client fills the fields; they stay editable because each document keeps its
 * own copy of the client details.
 */
export default function ClientFields({ clients, value, onChange, errors }: Props) {
  const set = (patch: Partial<DocumentClientFields>) => onChange({ ...value, ...patch })

  const pick = (id: string) => {
    if (!id) return set({ client_id: null })
    const c = clients.find((x) => x.id === Number(id))
    if (!c) return
    onChange({
      client_id: c.id,
      client_name: c.name,
      client_email: c.email || '',
      client_company: c.company || '',
      client_address: c.address || '',
    })
  }

  return (
    <div className="form-grid">
      <Field label="Saved client" hint="Pick one to fill the details, or type a new client below" className="form-full">
        <select className="input" value={value.client_id ?? ''} onChange={(e) => pick(e.target.value)}>
          <option value="">— One-off client (not saved) —</option>
          {value.client_id !== null && !clients.some((c) => c.id === value.client_id) && (
            <option value={value.client_id}>Client no longer saved</option>
          )}
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.company ? ` · ${c.company}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Client name" required error={errors?.client_name}>
        <input className="input" value={value.client_name} onChange={(e) => set({ client_name: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Company">
        <input className="input" value={value.client_company || ''} onChange={(e) => set({ client_company: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Email" hint="Needed to send the document by email" error={errors?.client_email}>
        <input className="input" type="email" value={value.client_email || ''} onChange={(e) => set({ client_email: e.target.value })} />
      </Field>
      <Field label="Address">
        <input className="input" value={value.client_address || ''} onChange={(e) => set({ client_address: e.target.value })} maxLength={500} />
      </Field>
    </div>
  )
}

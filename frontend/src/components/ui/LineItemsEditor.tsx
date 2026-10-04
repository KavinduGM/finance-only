import { Plus, Trash2 } from 'lucide-react'
import type { LineItem } from '../../services/api'
import { formatMoney } from '../../lib/format'

const round2 = (n: number) => Math.round((Number(n) || 0) * (1 + Number.EPSILON) * 100) / 100

/**
 * Same arithmetic as the server (backend/src/lib/money.js): the discount comes
 * off before tax, and tax is charged on what is left.
 */
export function computeTotals(items: LineItem[], taxRate: number | string, discount: number | string) {
  const subtotal = round2(items.reduce((s, it) => s + round2((Number(it.quantity) || 0) * round2(Number(it.unit_price) || 0)), 0))
  const disc = round2(Number(discount) || 0)
  const rate = Number(taxRate) || 0
  const taxAmount = round2(((subtotal - disc) * rate) / 100)
  return { subtotal, discount: disc, taxRate: rate, taxAmount, total: round2(subtotal - disc + taxAmount) }
}

export const emptyItem = (): LineItem => ({ description: '', quantity: 1, unit_price: '' })

/** Returns a message for the first problem found, or null when the lines can be saved. */
export function lineItemsProblem(items: LineItem[], discount: number | string, taxRate: number | string = 0): string | null {
  if (items.length === 0) return 'Add at least one line item'
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!String(it.description || '').trim()) return `Line ${i + 1}: add a description`
    if (!(Number(it.quantity) > 0)) return `Line ${i + 1}: quantity must be greater than 0`
    if (!(Number(it.unit_price) >= 0) || it.unit_price === '') return `Line ${i + 1}: enter a unit price`
    const price = Number(it.unit_price)
    if (Math.abs(price - round2(price)) > 1e-9) return `Line ${i + 1}: unit price can have at most 2 decimal places`
    if (String(it.description).trim().length > 1000) return `Line ${i + 1}: description must be 1000 characters or fewer`
  }
  const { subtotal } = computeTotals(items, 0, 0)
  const disc = Number(discount) || 0
  const rate = Number(taxRate) || 0
  if (disc < 0) return 'Discount cannot be negative'
  if (disc > subtotal) return 'Discount cannot be larger than the subtotal'
  if (rate < 0 || rate > 100) return 'Tax rate must be between 0 and 100'
  return null
}

interface Props {
  items: LineItem[]
  onChange: (items: LineItem[]) => void
  currency: string
  taxRate: number | string
  onTaxRate: (v: string) => void
  discount: number | string
  onDiscount: (v: string) => void
}

/** Line items with live totals. Shared by the invoice and proposal forms. */
export default function LineItemsEditor({ items, onChange, currency, taxRate, onTaxRate, discount, onDiscount }: Props) {
  const totals = computeTotals(items, taxRate, discount)

  const patch = (i: number, field: keyof LineItem, value: string) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)))
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i))

  return (
    <div className="rounded-xl border border-line overflow-hidden">
      <div className="hidden sm:grid grid-cols-[1fr_84px_132px_132px_36px] gap-2 px-3 py-2 bg-surface-2/60 border-b border-line">
        <span className="eyebrow">Description</span>
        <span className="eyebrow text-right">Qty</span>
        <span className="eyebrow text-right">Unit price</span>
        <span className="eyebrow text-right">Amount</span>
        <span />
      </div>

      <div className="divide-y divide-line/70">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_84px_132px_132px_36px] gap-2 p-3 items-start">
            <textarea
              className="input col-span-2 sm:col-span-1 resize-y min-h-[36px]"
              rows={1}
              maxLength={1000}
              placeholder="What is being charged for"
              value={it.description}
              onChange={(e) => patch(i, 'description', e.target.value)}
              aria-label={`Line ${i + 1} description`}
            />
            <input
              className="input-num" type="number" min="0" step="any" inputMode="decimal" onWheel={(e) => e.currentTarget.blur()}
              value={it.quantity} onChange={(e) => patch(i, 'quantity', e.target.value)}
              aria-label={`Line ${i + 1} quantity`}
            />
            <input
              className="input-num" type="number" min="0" step="any" inputMode="decimal" onWheel={(e) => e.currentTarget.blur()} placeholder="0.00"
              value={it.unit_price} onChange={(e) => patch(i, 'unit_price', e.target.value)}
              aria-label={`Line ${i + 1} unit price`}
            />
            <div className="h-9 flex items-center justify-end font-mono tabular-nums text-sm text-ink">
              {formatMoney(round2((Number(it.quantity) || 0) * round2(Number(it.unit_price) || 0)), currency)}
            </div>
            <button
              type="button" className="btn-icon-danger justify-self-end" onClick={() => remove(i)}
              disabled={items.length === 1} aria-label={`Remove line ${i + 1}`}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 p-3 border-t border-line bg-surface-2/40">
        <button type="button" className="btn-secondary btn-sm self-start" onClick={() => onChange([...items, emptyItem()])}>
          <Plus size={13} /> Add line
        </button>

        <div className="w-full sm:w-72 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-3">Subtotal</span>
            <span className="font-mono tabular-nums text-ink">{formatMoney(totals.subtotal, currency)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="text-ink-3" htmlFor="doc-discount">Discount</label>
            <input
              id="doc-discount" className="input-num h-8 w-32" type="number" min="0" step="any" inputMode="decimal" onWheel={(e) => e.currentTarget.blur()}
              placeholder="0.00" value={discount} onChange={(e) => onDiscount(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="text-ink-3" htmlFor="doc-tax">Tax %</label>
            <div className="flex items-center gap-2">
              <span className="font-mono tabular-nums text-xs text-ink-3">{formatMoney(totals.taxAmount, currency)}</span>
              <input
                id="doc-tax" className="input-num h-8 w-20" type="number" min="0" max="100" step="any" inputMode="decimal" onWheel={(e) => e.currentTarget.blur()}
                placeholder="0" value={taxRate} onChange={(e) => onTaxRate(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-line">
            <span className="font-semibold text-ink">Total</span>
            <span className="font-mono tabular-nums text-base font-semibold text-accent">{formatMoney(totals.total, currency)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

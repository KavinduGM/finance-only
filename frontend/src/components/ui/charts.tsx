import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useTheme } from '../../context/ThemeContext'
import { formatCompact } from '../../lib/format'

// Chart colours are fixed per series, never per rank: income is always the same
// green, expenses the same orange. Each theme has its own steps of the same
// hues, checked for colour-blind separation and contrast against the card
// surface (#0D1117 dark, #FFFFFF light).
const PALETTES = {
  dark: {
    income: '#199e70', expense: '#d95926', third: '#3987e5',
    grid: '#1f2734', axis: '#30394c', tick: '#6e798b', surface: '#0d1117',
  },
  light: {
    income: '#1baf7a', expense: '#eb6834', third: '#2a78d6',
    grid: '#e2e7ee', axis: '#c9d1dd', tick: '#717e91', surface: '#ffffff',
  },
}

export type SeriesColor = 'income' | 'expense' | 'third'

export function useChartPalette() {
  const { theme } = useTheme()
  return PALETTES[theme]
}

export interface Series {
  key: string
  label: string
  color: SeriesColor
}

/** Swatch + name for each series. Always shown when a chart has two or more. */
export function ChartLegend({ series }: { series: Series[] }) {
  const palette = useChartPalette()
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: palette[s.color] }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function ChartTooltip({ active, payload, label, series, format }: any) {
  const palette = useChartPalette()
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-line-strong bg-surface-3 px-3 py-2 shadow-pop">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-1.5">{label}</p>
      <div className="space-y-1">
        {(series as Series[]).map((s) => {
          const row = payload.find((p: any) => p.dataKey === s.key)
          if (!row) return null
          return (
            <div key={s.key} className="flex items-center justify-between gap-6 text-xs">
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <span className="w-2 h-2 rounded-sm" style={{ background: palette[s.color] }} />
                {s.label}
              </span>
              <span className="font-mono tabular-nums text-ink">{format(row.value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CartesianProps {
  data: Record<string, any>[]
  /** Field used for the x axis labels. */
  xKey: string
  series: Series[]
  /** Formats values in the tooltip (full precision). */
  format: (value: number) => string
  /** Kept for callers; axis ticks are plain compact numbers and the card subtitle names the currency. */
  currency?: string
  height?: number
}

const axisTick = (palette: typeof PALETTES.dark) => ({ fill: palette.tick, fontSize: 11 })

/** Change over time: 2px lines over a faint wash, one shared axis, crosshair tooltip. */
export function TrendChart({ data, xKey, series, format, height = 280 }: CartesianProps) {
  const palette = useChartPalette()
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={palette.grid} />
          <XAxis dataKey={xKey} tick={axisTick(palette)} tickLine={false} axisLine={{ stroke: palette.axis }} tickMargin={8} />
          <YAxis
            tick={axisTick(palette)} tickLine={false} axisLine={false} width={52}
            tickFormatter={(v) => formatCompact(v)}
          />
          <Tooltip
            content={<ChartTooltip series={series} format={format} />}
            cursor={{ stroke: palette.axis, strokeWidth: 1 }}
            isAnimationActive={false}
          />
          {series.map((s) => (
            <Area
              key={s.key} type="monotone" dataKey={s.key} name={s.label}
              stroke={palette[s.color]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              fill={palette[s.color]} fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, fill: palette[s.color], stroke: palette.surface, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Side-by-side columns per period (e.g. money in vs money out per month). */
export function ColumnChart({ data, xKey, series, format, height = 280 }: CartesianProps) {
  const palette = useChartPalette()
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke={palette.grid} />
          <XAxis dataKey={xKey} tick={axisTick(palette)} tickLine={false} axisLine={{ stroke: palette.axis }} tickMargin={8} />
          <YAxis
            tick={axisTick(palette)} tickLine={false} axisLine={false} width={52}
            tickFormatter={(v) => formatCompact(v)}
          />
          <ReferenceLine y={0} stroke={palette.axis} />
          <Tooltip
            content={<ChartTooltip series={series} format={format} />}
            cursor={{ fill: palette.grid, opacity: 0.5 }}
            isAnimationActive={false}
          />
          {series.map((s) => (
            <Bar
              key={s.key} dataKey={s.key} name={s.label} fill={palette[s.color]}
              maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export interface BarListItem {
  label: string
  value: number
  /** Optional second line under the label (a count, a note). */
  hint?: string
}

/**
 * Ranked horizontal bars for a breakdown by category or client. One colour for
 * every bar: the length already shows the size, and the value is printed
 * beside each one, so nothing depends on colour or hover.
 */
export function BarList({ items, format, color = 'third', emptyLabel = 'Nothing to show for this period' }: {
  items: BarListItem[]
  format: (value: number) => string
  color?: SeriesColor
  emptyLabel?: string
}) {
  const palette = useChartPalette()
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 0)
  if (items.length === 0 || max === 0) {
    return <p className="text-sm text-ink-3 py-6 text-center">{emptyLabel}</p>
  }
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink-2 truncate">
              {item.label}
              {item.hint && <span className="text-ink-3 text-xs ml-2">{item.hint}</span>}
            </span>
            <span className="font-mono tabular-nums text-ink shrink-0">{format(item.value)}</span>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-surface-3 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (Math.abs(item.value) / max) * 100)}%`, background: palette[color] }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Card frame for a chart: title, optional subtitle, legend or controls on the right. */
export function ChartCard({ title, subtitle, right, children, className = '' }: {
  title: string
  subtitle?: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`card card-pad ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="card-title">{title}</h3>
          {subtitle && <p className="card-sub">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

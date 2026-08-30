import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { TorghutVisualsChart } from '@/components/torghut-visuals-chart'
import { TorghutVisualsControls } from '@/components/torghut-visuals-controls'
import type {
  IndicatorState,
  RangeOption,
  ResolutionOption,
  TorghutBar,
  TorghutSignal,
} from '@/components/torghut-visuals-types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/torghut/charts')({
  component: TorghutCharts,
})

const MAX_POINTS = 2000

const RANGE_OPTIONS: RangeOption[] = [
  { id: '15m', label: 'Last 15m', seconds: 15 * 60 },
  { id: '1h', label: 'Last 1h', seconds: 60 * 60 },
  { id: '4h', label: 'Last 4h', seconds: 4 * 60 * 60 },
  { id: '1d', label: 'Last 1d', seconds: 24 * 60 * 60 },
  { id: '1w', label: 'Last 1w', seconds: 7 * 24 * 60 * 60 },
]

const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { id: '1s', label: '1s', seconds: 1 },
  { id: '5s', label: '5s', seconds: 5 },
  { id: '15s', label: '15s', seconds: 15 },
  { id: '1m', label: '1m', seconds: 60 },
  { id: '5m', label: '5m', seconds: 5 * 60 },
]

const DEFAULT_INDICATORS: IndicatorState = {
  ema: true,
  boll: true,
  vwap: false,
  macd: false,
  rsi: false,
}

function TorghutCharts() {
  const visualsEnabled = isVisualsEnabled()
  const [symbols, setSymbols] = React.useState<string[]>([])
  const [symbolsError, setSymbolsError] = React.useState<string | null>(null)
  const [isSymbolsLoading, setIsSymbolsLoading] = React.useState(true)
  const [selectedSymbol, setSelectedSymbol] = React.useState('')
  const [rangeId, setRangeId] = React.useState(RANGE_OPTIONS[1].id)
  const [resolutionId, setResolutionId] = React.useState(RESOLUTION_OPTIONS[2].id)
  const [indicators, setIndicators] = React.useState<IndicatorState>(DEFAULT_INDICATORS)
  const [bars, setBars] = React.useState<TorghutBar[]>([])
  const [signals, setSignals] = React.useState<TorghutSignal[]>([])
  const [latestEventTs, setLatestEventTs] = React.useState<string | null>(null)
  const [dataError, setDataError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState<string | null>(null)
  const [refreshTick, setRefreshTick] = React.useState(0)

  const range = React.useMemo(
    () => RANGE_OPTIONS.find((option) => option.id === rangeId) ?? RANGE_OPTIONS[0],
    [rangeId],
  )
  const resolution = React.useMemo(
    () => RESOLUTION_OPTIONS.find((option) => option.id === resolutionId) ?? RESOLUTION_OPTIONS[0],
    [resolutionId],
  )

  const queryLimit = React.useMemo(() => {
    const estimated = Math.ceil(range.seconds / resolution.seconds)
    return Math.min(estimated, MAX_POINTS)
  }, [range, resolution])

  React.useEffect(() => {
    if (!visualsEnabled) return
    const controller = new AbortController()

    const loadSymbols = async () => {
      setIsSymbolsLoading(true)
      setSymbolsError(null)
      try {
        const res = await fetch('/api/torghut/symbols?format=compact', { signal: controller.signal })
        if (!res.ok) throw new Error(`Failed to load symbols (${res.status})`)
        const payload = (await res.json()) as unknown
        const nextSymbols = extractSymbols(payload)
        setSymbols(nextSymbols)
        setSelectedSymbol((current) => {
          if (current && nextSymbols.includes(current)) return current
          return nextSymbols[0] ?? ''
        })
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        setSymbolsError(message)
        setSymbols([])
      } finally {
        if (!controller.signal.aborted) {
          setIsSymbolsLoading(false)
        }
      }
    }

    void loadSymbols()

    return () => controller.abort()
  }, [visualsEnabled])

  React.useEffect(() => {
    if (!visualsEnabled || !selectedSymbol) return
    const controller = new AbortController()

    const loadData = async () => {
      setIsLoading(true)
      setDataError(null)
      try {
        const now = Date.now()
        const from = new Date(now - range.seconds * 1000).toISOString()
        const to = new Date(now).toISOString()
        const params = new URLSearchParams({
          symbol: selectedSymbol,
          range: range.id,
          resolution: resolution.id,
          limit: String(queryLimit),
          refresh: String(refreshTick),
          from,
          to,
        })

        const [barsRes, signalsRes, latestRes] = await Promise.all([
          fetch(`/api/torghut/ta/bars?${params}`, { signal: controller.signal }),
          fetch(`/api/torghut/ta/signals?${params}`, { signal: controller.signal }),
          fetch(`/api/torghut/ta/latest?symbol=${encodeURIComponent(selectedSymbol)}`, { signal: controller.signal }),
        ])

        const errors: string[] = []

        if (!barsRes.ok) {
          errors.push(`Bars request failed (${barsRes.status})`)
          setBars([])
        } else {
          const payload = await safeJson(barsRes)
          setBars(extractItems<TorghutBar>(payload))
        }

        if (!signalsRes.ok) {
          errors.push(`Signals request failed (${signalsRes.status})`)
          setSignals([])
        } else {
          const payload = await safeJson(signalsRes)
          setSignals(extractItems<TorghutSignal>(payload))
        }

        if (latestRes.ok) {
          const payload = await safeJson(latestRes)
          setLatestEventTs(extractLatestTimestamp(payload))
        } else {
          setLatestEventTs(null)
        }

        if (errors.length > 0) {
          setDataError(errors.join('. '))
        }

        setLastUpdatedAt(new Date().toISOString())
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        setDataError(message)
        setBars([])
        setSignals([])
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    }

    void loadData()

    return () => controller.abort()
  }, [visualsEnabled, selectedSymbol, range, resolution, queryLimit, refreshTick])

  const effectiveLatest = React.useMemo(() => {
    if (latestEventTs) return latestEventTs
    return extractLatestTimestampFromSeries(bars, signals)
  }, [latestEventTs, bars, signals])

  const lagMs = React.useMemo(() => {
    if (!effectiveLatest) return null
    const parsed = Date.parse(effectiveLatest)
    if (Number.isNaN(parsed)) return null
    return Math.max(0, Date.now() - parsed)
  }, [effectiveLatest])

  const lagTone = lagMs === null ? 'neutral' : lagMs < 60_000 ? 'good' : lagMs < 180_000 ? 'warn' : 'bad'

  return (
    <main className="mx-auto flex flex-col gap-6 p-6 h-full min-h-0 w-full max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Torghut</p>
          <h1 className="text-lg font-semibold">Charts</h1>
          <p className="text-xs text-muted-foreground">Candlesticks + TA indicators for ClickHouse-backed signals.</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="uppercase tracking-widest">Lag</span>
            <span
              className={cn(
                'rounded-none border px-2 py-0.5 text-xs font-medium',
                lagTone === 'good' && 'border-emerald-500/40 text-emerald-500',
                lagTone === 'warn' && 'border-amber-500/40 text-amber-500',
                lagTone === 'bad' && 'border-rose-500/40 text-rose-500',
                lagTone === 'neutral' && 'border-border text-muted-foreground',
              )}
            >
              {lagMs === null ? '—' : formatLag(lagMs)}
            </span>
          </div>
          <div>
            Latest event{' '}
            <span className="tabular-nums text-foreground">
              {effectiveLatest ? formatTimestamp(effectiveLatest) : '—'}
            </span>
          </div>
          <div>
            Updated{' '}
            <span className="tabular-nums text-foreground">{lastUpdatedAt ? formatTimestamp(lastUpdatedAt) : '—'}</span>
          </div>
        </div>
      </header>

      {!visualsEnabled ? (
        <section className="rounded-none border bg-card p-4 text-xs text-muted-foreground">
          Torghut charts are disabled. Set <code className="text-[0.7rem]">VITE_TORGHUT_VISUALS_ENABLED=true</code> to
          enable the charts.
        </section>
      ) : (
        <div className="flex flex-col gap-6 flex-1 min-h-0">
          {symbolsError ? (
            <section className="rounded-none border border-destructive/40 bg-card p-4 text-xs text-destructive">
              {symbolsError}
            </section>
          ) : null}

          <TorghutVisualsControls
            symbols={symbols}
            selectedSymbol={selectedSymbol}
            onSymbolChange={setSelectedSymbol}
            rangeOptions={RANGE_OPTIONS}
            range={range}
            onRangeChange={setRangeId}
            resolutionOptions={RESOLUTION_OPTIONS}
            resolution={resolution}
            onResolutionChange={setResolutionId}
            indicators={indicators}
            onIndicatorToggle={(key) => setIndicators((current) => ({ ...current, [key]: !current[key] }))}
            onRefresh={() => setRefreshTick((current) => current + 1)}
            isRefreshing={isLoading}
            queryLimit={queryLimit}
            maxPoints={MAX_POINTS}
            disabled={isSymbolsLoading || symbols.length === 0}
          />

          {!selectedSymbol ? (
            <section className="rounded-none border border-dashed bg-card p-6 text-xs text-muted-foreground">
              No symbols are enabled yet.{' '}
              <Link className="text-primary underline-offset-4 hover:underline" to="/torghut/symbols">
                Configure symbols
              </Link>{' '}
              to load charts.
            </section>
          ) : (
            <section className="flex flex-col gap-4 p-4 flex-1 min-h-0 rounded-none border bg-card">
              {dataError ? (
                <div className="rounded-none border border-destructive/40 bg-background p-3 text-xs text-destructive">
                  {dataError}
                </div>
              ) : null}
              <div className="text-xs text-muted-foreground">
                Showing{' '}
                <span className="text-foreground">
                  {selectedSymbol} · {range.label} · {resolution.label}
                </span>
              </div>
              <TorghutVisualsChart bars={bars} signals={signals} indicators={indicators} className="min-h-0 flex-1" />
              {bars.length === 0 && !isLoading ? (
                <div className="text-xs text-muted-foreground">No bar data returned for this range.</div>
              ) : null}
            </section>
          )}
        </div>
      )}
    </main>
  )
}

const isVisualsEnabled = () => {
  const raw = import.meta.env.VITE_TORGHUT_VISUALS_ENABLED
  if (!raw) return true
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

const extractSymbols = (payload: unknown): string[] => {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  if (Array.isArray(record.symbols)) return record.symbols.filter((item): item is string => typeof item === 'string')
  if (Array.isArray(record.items)) {
    return record.items
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).symbol : null))
      .filter((item): item is string => typeof item === 'string')
  }
  return []
}

const extractItems = <T,>(payload: unknown): T[] => {
  if (Array.isArray(payload)) return payload as T[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const items = record.items ?? record.bars ?? record.signals ?? record.data ?? record.rows
  return Array.isArray(items) ? (items as T[]) : []
}

const safeJson = async (res: Response): Promise<unknown> => {
  if (res.status === 204) return null
  return res.json().catch(() => null)
}

const extractLatestTimestamp = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const direct = coerceTimestamp(
    record.event_ts ?? record.eventTs ?? record.ts ?? record.time ?? record.maxEventTs ?? record.max_event_ts,
  )
  if (direct) return direct

  const nested = record.latest ?? record.item ?? record.data
  if (nested && typeof nested === 'object') {
    const nestedRecord = nested as Record<string, unknown>
    return coerceTimestamp(
      nestedRecord.event_ts ??
        nestedRecord.eventTs ??
        nestedRecord.ts ??
        nestedRecord.time ??
        nestedRecord.maxEventTs ??
        nestedRecord.max_event_ts,
    )
  }

  return null
}

const extractLatestTimestampFromSeries = (bars: TorghutBar[], signals: TorghutSignal[]): string | null => {
  const latest = [
    ...bars.map((bar) => bar.event_ts ?? bar.eventTs ?? bar.ts ?? bar.time),
    ...signals.map((signal) => signal.event_ts ?? signal.eventTs ?? signal.ts ?? signal.time),
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0]

  if (!latest) return null
  return new Date(latest).toISOString()
}

const coerceTimestamp = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return null
}

const formatLag = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return `${hours}h ${remMinutes}m`
}

const formatTimestamp = (value: string): string => {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(parsed))
}

import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

export const Route = createFileRoute('/torghut/trading')({
  component: TorghutTrading,
})

type StrategyItem = {
  id: string
  name: string
  enabled: boolean
  baseTimeframe: string
  universeSymbols: unknown
}

type Interval = {
  tz: string
  day: string
  startUtc: string
  endUtc: string
}

type TradingSummary = {
  interval: Interval
  strategy: { id: string; name: string } | null
  realizedPnl: {
    value: number
    closedQty: number
    winRate: number | null
    winCount: number
    lossCount: number
    series: { ts: string; realizedPnl: number }[]
    warnings: string[]
  }
  executions: { filledCount: number }
  rejections: {
    rejectedCount: number
    topReasons: { reason: string; count: number }[]
  }
  equity: {
    available: boolean
    byAccount: { alpacaAccountLabel: string; delta: number; series: { ts: string; equity: number }[] }[]
  }
}

type FilledExecution = {
  executionId: string
  tradeDecisionId: string | null
  strategyId: string
  strategyName: string | null
  createdAt: string
  symbol: string
  side: string
  filledQty: number
  avgFillPrice: number | null
  timeframe: string | null
  alpacaAccountLabel: string | null
}

type RejectedDecision = {
  id: string
  createdAt: string
  alpacaAccountLabel: string
  symbol: string
  timeframe: string
  status: string
  rationale: string | null
  riskReasons: string[]
  strategyId: string
  strategyName: string
}

const DEFAULT_TZ = 'America/New_York'

const formatEtDayToday = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const record: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type] = part.value
  }
  const year = record.year
  const month = record.month
  const day = record.day
  if (!year || !month || !day) return new Date().toISOString().slice(0, 10)
  return `${year}-${month}-${day}`
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

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

const getErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { message?: unknown; error?: unknown }
  if (typeof record.message === 'string' && record.message) return record.message
  if (typeof record.error === 'string' && record.error) return record.error
  return null
}

const isStrategiesPayload = (value: unknown): value is { ok: true; items: StrategyItem[] } => {
  if (!value || typeof value !== 'object') return false
  if (!('ok' in value) || !('items' in value)) return false
  if ((value as { ok?: unknown }).ok !== true) return false
  return Array.isArray((value as { items?: unknown }).items)
}

const isSummaryPayload = (value: unknown): value is { ok: true; summary: TradingSummary } => {
  if (!value || typeof value !== 'object') return false
  if (!('ok' in value) || !('summary' in value)) return false
  return (value as { ok?: unknown }).ok === true
}

const isItemsPayload = <T,>(value: unknown): value is { ok: true; items: T[] } => {
  if (!value || typeof value !== 'object') return false
  if (!('items' in value)) return false
  return Array.isArray((value as { items?: unknown }).items)
}

const reasonHistogramConfig = {
  count: {
    label: 'Count',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig

function TorghutTrading() {
  const [day, setDay] = React.useState(() => formatEtDayToday())
  const [strategies, setStrategies] = React.useState<StrategyItem[]>([])
  const [strategyId, setStrategyId] = React.useState<string>('')
  const [strategiesError, setStrategiesError] = React.useState<string | null>(null)
  const [disabledMessage, setDisabledMessage] = React.useState<string | null>(null)

  const [summary, setSummary] = React.useState<TradingSummary | null>(null)
  const [summaryError, setSummaryError] = React.useState<string | null>(null)
  const [executions, setExecutions] = React.useState<FilledExecution[]>([])
  const [decisions, setDecisions] = React.useState<RejectedDecision[]>([])
  const [isLoading, setIsLoading] = React.useState(false)

  const loadStrategies = React.useCallback(async () => {
    setDisabledMessage(null)
    setStrategiesError(null)
    try {
      const response = await fetch('/api/torghut/trading/strategies')
      const payload = (await response.json().catch(() => null)) as unknown
      if (!response.ok) {
        const message = getErrorMessage(payload) ?? `Failed to load strategies (${response.status})`
        const disabled = Boolean(payload && typeof payload === 'object' && 'disabled' in payload)
        if (disabled) setDisabledMessage(message)
        setStrategiesError(message)
        setStrategies([])
        return
      }

      if (!isStrategiesPayload(payload)) {
        setStrategiesError('Unexpected strategies payload.')
        setStrategies([])
        return
      }

      const parsed = payload.items.filter(
        (item) => item && typeof item.id === 'string' && typeof item.name === 'string',
      )
      setStrategies(parsed as StrategyItem[])
      setStrategyId((current) => {
        if (current && parsed.some((item) => item.id === current)) return current
        return parsed[0]?.id ?? ''
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load strategies.'
      setStrategiesError(message)
      setStrategies([])
    }
  }, [])

  const loadData = React.useCallback(async (params: { day: string; strategyId: string }) => {
    setIsLoading(true)
    setSummaryError(null)
    setDisabledMessage(null)

    const query = new URLSearchParams({ day: params.day, tz: DEFAULT_TZ })
    if (params.strategyId) query.set('strategyId', params.strategyId)

    try {
      const [summaryRes, execRes, decRes] = await Promise.all([
        fetch(`/api/torghut/trading/summary?${query}`),
        fetch(`/api/torghut/trading/executions?${query}`),
        fetch(`/api/torghut/trading/decisions?${query}`),
      ])

      const summaryPayload = (await summaryRes.json().catch(() => null)) as unknown
      if (!summaryRes.ok) {
        const message = getErrorMessage(summaryPayload) ?? `Failed to load summary (${summaryRes.status})`
        const disabled = Boolean(summaryPayload && typeof summaryPayload === 'object' && 'disabled' in summaryPayload)
        if (disabled) setDisabledMessage(message)
        setSummaryError(message)
        setSummary(null)
        setExecutions([])
        setDecisions([])
        return
      }

      if (!isSummaryPayload(summaryPayload)) {
        setSummaryError('Unexpected summary payload.')
        setSummary(null)
        setExecutions([])
        setDecisions([])
        return
      }
      setSummary(summaryPayload.summary)

      const execPayload = (await execRes.json().catch(() => null)) as unknown
      setExecutions(execRes.ok && isItemsPayload<FilledExecution>(execPayload) ? execPayload.items : [])

      const decPayload = (await decRes.json().catch(() => null)) as unknown
      setDecisions(decRes.ok && isItemsPayload<RejectedDecision>(decPayload) ? decPayload.items : [])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load trading history.'
      setSummaryError(message)
      setSummary(null)
      setExecutions([])
      setDecisions([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadStrategies()
  }, [loadStrategies])

  React.useEffect(() => {
    if (!strategyId || !day) return
    void loadData({ day, strategyId })
  }, [day, strategyId, loadData])

  const selectedStrategy = React.useMemo(
    () => strategies.find((strategy) => strategy.id === strategyId) ?? null,
    [strategies, strategyId],
  )

  const equityAccounts = summary?.equity.byAccount ?? []

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Torghut</p>
          <h1 className="text-lg font-semibold">Trading</h1>
          <p className="text-xs text-muted-foreground">
            Filled executions, realized PnL (average-cost, long-only), and rejection diagnostics for a single ET trading
            day.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Button variant="outline" onClick={() => void loadData({ day, strategyId })} disabled={isLoading || !day}>
            Refresh
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="border-b">
          <div className="space-y-1">
            <CardTitle>Filters</CardTitle>
            <CardDescription>America/New_York day buckets (backend computes UTC interval).</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 pt-4 md:grid-cols-3">
          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor="trading-day">
              Trading day (ET)
            </label>
            <Input
              id="trading-day"
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
              min="2020-01-01"
              max="2100-12-31"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-xs font-medium" htmlFor="trading-strategy">
              Strategy
            </label>
            <Select value={strategyId} onValueChange={(value) => setStrategyId(value ?? '')}>
              <SelectTrigger id="trading-strategy" className="w-full">
                <SelectValue placeholder={strategies.length === 0 ? 'Loading strategies…' : 'Select strategy'} />
              </SelectTrigger>
              <SelectContent>
                {strategies.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No strategies
                  </SelectItem>
                ) : null}
                {strategies.map((strategy) => (
                  <SelectItem key={strategy.id} value={strategy.id}>
                    <span>{strategy.name}</span>
                    {strategy.enabled ? null : <span className="text-muted-foreground">disabled</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {strategiesError ? (
              <div className="text-xs text-destructive" aria-live="polite">
                {strategiesError}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {disabledMessage ? (
        <Card className="border-amber-500/40">
          <CardHeader className="border-b">
            <CardTitle>Trading History Disabled</CardTitle>
            <CardDescription>This deployment does not have Torghut DB credentials configured.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4 text-xs text-muted-foreground">
            {disabledMessage}
            <div className="mt-2">
              Set <code className="text-[0.7rem]">TORGHUT_DB_DSN</code> on the Jangar runtime to enable read-only
              queries.
            </div>
          </CardContent>
        </Card>
      ) : null}

      {summaryError ? (
        <Card className="border-destructive/40">
          <CardHeader className="border-b">
            <CardTitle>Unable To Load Trading History</CardTitle>
            <CardDescription>Fix the error below, then refresh.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4 text-xs text-destructive" aria-live="polite">
            {summaryError}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Realized PnL</CardTitle>
            <CardDescription>
              {selectedStrategy ? (
                <>
                  Strategy <span className="font-medium text-foreground">{selectedStrategy.name}</span> (filled
                  executions only)
                </>
              ) : (
                'Filled executions only'
              )}
            </CardDescription>
            <CardAction>
              {isLoading ? <span className="text-xs text-muted-foreground">Loading…</span> : null}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {summary ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-3xl font-medium tabular-nums">
                    <span
                      className={
                        summary.realizedPnl.value > 0
                          ? 'text-emerald-600'
                          : summary.realizedPnl.value < 0
                            ? 'text-rose-600'
                            : undefined
                      }
                    >
                      {currency.format(summary.realizedPnl.value)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Closed qty{' '}
                    <span className="tabular-nums text-foreground">
                      {compactNumber.format(summary.realizedPnl.closedQty)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <div>
                    Win rate{' '}
                    <span className="tabular-nums text-foreground">
                      {summary.realizedPnl.winRate === null ? '—' : `${Math.round(summary.realizedPnl.winRate * 100)}%`}
                    </span>
                  </div>
                  <div>
                    Wins <span className="tabular-nums text-foreground">{summary.realizedPnl.winCount}</span>
                  </div>
                  <div>
                    Losses <span className="tabular-nums text-foreground">{summary.realizedPnl.lossCount}</span>
                  </div>
                </div>
                {summary.realizedPnl.series.length > 1 ? (
                  <RealizedPnlChart series={summary.realizedPnl.series} />
                ) : null}
                {summary.realizedPnl.warnings.length > 0 ? (
                  <details className="rounded-none border bg-muted/20 p-3 text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium text-foreground">
                      PnL warnings ({summary.realizedPnl.warnings.length})
                    </summary>
                    <ul className="mt-2 list-disc pl-4">
                      {summary.realizedPnl.warnings.slice(0, 12).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Equity Delta</CardTitle>
            <CardDescription>Account-level curve from position snapshots (if available)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {summary ? (
              equityAccounts.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {equityAccounts.slice(0, 3).map((account) => (
                      <span key={account.alpacaAccountLabel} className="rounded-none border border-border px-2 py-0.5">
                        {account.alpacaAccountLabel}:{' '}
                        <span
                          className={
                            account.delta > 0 ? 'text-emerald-600' : account.delta < 0 ? 'text-rose-600' : undefined
                          }
                        >
                          {currency.format(account.delta)}
                        </span>
                      </span>
                    ))}
                    {equityAccounts.length > 3 ? (
                      <span className="rounded-none border border-border px-2 py-0.5">
                        +{equityAccounts.length - 3} more
                      </span>
                    ) : null}
                  </div>
                  <EquityChart accounts={equityAccounts} />
                </>
              ) : (
                <div className="text-xs text-muted-foreground">No position snapshots found for this interval.</div>
              )
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Counts</CardTitle>
            <CardDescription>Fills vs rejections for the selected day</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 pt-4 md:grid-cols-2">
            <div className="rounded-none border bg-card p-3">
              <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Filled executions
              </div>
              <div className="mt-2 text-2xl font-medium tabular-nums">
                {summary ? summary.executions.filledCount : isLoading ? '…' : '—'}
              </div>
            </div>
            <div className="rounded-none border bg-card p-3">
              <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Rejected decisions
              </div>
              <div className="mt-2 text-2xl font-medium tabular-nums">
                {summary ? summary.rejections.rejectedCount : isLoading ? '…' : '—'}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Top Rejection Reasons</CardTitle>
            <CardDescription>From trade_decisions.decision_json.risk_reasons</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            {summary ? (
              summary.rejections.topReasons.length > 0 ? (
                <ChartContainer config={reasonHistogramConfig} className="h-56 w-full">
                  <BarChart data={summary.rejections.topReasons} layout="vertical" margin={{ left: 0, right: 12 }}>
                    <CartesianGrid horizontal={false} />
                    <XAxis type="number" dataKey="count" hide />
                    <YAxis
                      dataKey="reason"
                      type="category"
                      width={150}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={(value: string) => truncateLabel(value)}
                    />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                    <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="p-4 text-xs text-muted-foreground">No rejection reasons recorded.</div>
              )
            ) : (
              <Skeleton className="h-56 w-full" />
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Query Interval</CardTitle>
          <CardDescription>
            Backend uses <span className="font-medium text-foreground">{DEFAULT_TZ}</span> day buckets and queries
            Torghut Postgres with computed UTC bounds.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 text-xs text-muted-foreground">
          {summary ? (
            <div className="space-y-1">
              <div>
                Day (ET) <span className="tabular-nums text-foreground">{summary.interval.day}</span>
              </div>
              <div>
                Start UTC <span className="tabular-nums text-foreground">{summary.interval.startUtc}</span>
              </div>
              <div>
                End UTC <span className="tabular-nums text-foreground">{summary.interval.endUtc}</span>
              </div>
            </div>
          ) : (
            <span>{isLoading ? 'Loading…' : '—'}</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Filled Executions</CardTitle>
          <CardDescription>Joined executions to trade_decisions and strategies.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <ExecutionsTable items={executions} isLoading={isLoading} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Rejected Decisions</CardTitle>
          <CardDescription>Decision-level diagnostics with risk reasons.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <RejectedDecisionsTable items={decisions} isLoading={isLoading} />
        </CardContent>
      </Card>
    </main>
  )
}

const pnlChartConfig = {
  realizedPnl: {
    label: 'Realized PnL',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

function RealizedPnlChart({ series }: { series: { ts: string; realizedPnl: number }[] }) {
  return (
    <ChartContainer config={pnlChartConfig} className="h-56 w-full">
      <LineChart data={series} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="ts"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) => formatShortTime(value)}
        />
        <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={(value: number) => currency.format(value)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Line dataKey="realizedPnl" type="monotone" stroke="var(--color-realizedPnl)" strokeWidth={2} dot={false} />
      </LineChart>
    </ChartContainer>
  )
}

const formatShortTime = (value: string) => {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(parsed))
}

function EquityChart({
  accounts,
}: {
  accounts: { alpacaAccountLabel: string; delta: number; series: { ts: string; equity: number }[] }[]
}) {
  const seriesKeys = React.useMemo(() => {
    const colors = ['var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-1)', 'var(--chart-2)']
    return accounts.slice(0, colors.length).map((account, index) => ({
      key: `acct_${index}`,
      label: account.alpacaAccountLabel,
      color: colors[index] ?? 'var(--chart-1)',
      series: account.series,
    }))
  }, [accounts])

  const data = React.useMemo(() => {
    const rowsByTs = new Map<string, Record<string, unknown>>()
    for (const { key, series } of seriesKeys) {
      for (const point of series) {
        const row = rowsByTs.get(point.ts) ?? { ts: point.ts }
        row[key] = point.equity
        rowsByTs.set(point.ts, row)
      }
    }
    return [...rowsByTs.values()].sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)))
  }, [seriesKeys])

  const config = React.useMemo(() => {
    const next: Record<string, { label: string; color: string }> = {}
    for (const item of seriesKeys) {
      next[item.key] = { label: item.label, color: item.color }
    }
    return next satisfies ChartConfig
  }, [seriesKeys])

  return (
    <ChartContainer config={config} className="h-56 w-full">
      <LineChart data={data} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="ts"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) => formatShortTime(value)}
        />
        <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={(value: number) => currency.format(value)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        {seriesKeys.map((item) => (
          <Line
            key={item.key}
            dataKey={item.key}
            type="monotone"
            stroke={`var(--color-${item.key})`}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}

function ExecutionsTable({ items, isLoading }: { items: FilledExecution[]; isLoading: boolean }) {
  if (isLoading && items.length === 0) return <Skeleton className="h-40 w-full" />
  if (items.length === 0) return <div className="text-xs text-muted-foreground">No filled executions found.</div>

  return (
    <div className="overflow-hidden rounded-none border bg-card">
      <table className="w-full text-xs">
        <thead className="border-b bg-muted/30 text-muted-foreground">
          <tr className="text-left uppercase tracking-widest">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium text-right">Qty</th>
            <th className="px-3 py-2 font-medium text-right">Avg fill</th>
            <th className="px-3 py-2 font-medium">Strategy</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 500).map((item) => (
            <tr key={item.executionId} className="border-b last:border-b-0">
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{formatTimestamp(item.createdAt)}</td>
              <td className="px-3 py-2 font-medium text-foreground">{item.symbol}</td>
              <td className="px-3 py-2">
                <span
                  className={
                    item.side.toLowerCase() === 'buy'
                      ? 'text-emerald-600'
                      : item.side.toLowerCase() === 'sell'
                        ? 'text-rose-600'
                        : 'text-muted-foreground'
                  }
                >
                  {item.side}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {compactNumber.format(item.filledQty)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {item.avgFillPrice === null ? '—' : currency.format(item.avgFillPrice)}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{item.strategyName ?? item.strategyId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RejectedDecisionsTable({ items, isLoading }: { items: RejectedDecision[]; isLoading: boolean }) {
  if (isLoading && items.length === 0) return <Skeleton className="h-40 w-full" />
  if (items.length === 0) return <div className="text-xs text-muted-foreground">No rejected decisions found.</div>

  return (
    <div className="overflow-hidden rounded-none border bg-card">
      <table className="w-full text-xs">
        <thead className="border-b bg-muted/30 text-muted-foreground">
          <tr className="text-left uppercase tracking-widest">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">Timeframe</th>
            <th className="px-3 py-2 font-medium">Reasons</th>
            <th className="px-3 py-2 font-medium">Strategy</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 500).map((item) => (
            <tr key={item.id} className="border-b last:border-b-0">
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{formatTimestamp(item.createdAt)}</td>
              <td className="px-3 py-2 font-medium text-foreground">{item.symbol}</td>
              <td className="px-3 py-2 text-muted-foreground">{item.timeframe}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {item.riskReasons.length > 0 ? (
                    item.riskReasons.slice(0, 6).map((reason) => (
                      <span key={reason} className="rounded-none border border-border px-2 py-0.5 text-[11px]">
                        {reason}
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {item.riskReasons.length > 6 ? (
                    <span className="rounded-none border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                      +{item.riskReasons.length - 6}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{item.strategyName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const truncateLabel = (value: string, max = 28) => {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

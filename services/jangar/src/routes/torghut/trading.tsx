import {
  Button,
  Calendar,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import { CalendarIcon } from 'lucide-react'
import * as React from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { TorghutStrategySelectValue } from '@/components/torghut-strategy-select-value'
import {
  DEFAULT_TZ,
  fetchTradingSnapshot,
  fetchTradingStrategies,
  loadTorghutTradingPageData,
  type FilledExecution,
  type RejectedDecision,
  type StrategyItem,
  type TorghutTradingPageData,
  type TradingSummary,
} from '@/data/torghut-trading'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/torghut/trading')({
  loader: async (): Promise<TorghutTradingPageData> => loadTorghutTradingPageData(formatEtDayToday()),
  component: TorghutTrading,
})
const MIN_TRADING_DAY = '2020-01-01'
const MAX_TRADING_DAY = '2100-12-31'

function formatEtDayToday() {
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

const parseTradingDay = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (Number.isNaN(parsed.getTime())) return null
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null
  return parsed
}

const formatTradingDay = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatTradingDayLabel = (value: string): string => {
  const parsed = parseTradingDay(value)
  if (!parsed) return value
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed)
}

const minTradingDayDate = parseTradingDay(MIN_TRADING_DAY) ?? new Date(2020, 0, 1)
const maxTradingDayDate = parseTradingDay(MAX_TRADING_DAY) ?? new Date(2100, 11, 31)

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

const reasonHistogramConfig = {
  count: {
    label: 'Count',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig

function TorghutTrading() {
  const initialData = Route.useLoaderData() as TorghutTradingPageData
  const [day, setDay] = React.useState(() => formatEtDayToday())
  const [isDayPickerOpen, setIsDayPickerOpen] = React.useState(false)
  const [strategies, setStrategies] = React.useState<StrategyItem[]>(initialData.strategies)
  const [strategyId, setStrategyId] = React.useState<string>(initialData.selectedStrategyId)
  const [strategiesError, setStrategiesError] = React.useState<string | null>(initialData.strategiesError)
  const [disabledMessage, setDisabledMessage] = React.useState<string | null>(initialData.disabledMessage)

  const [summary, setSummary] = React.useState<TradingSummary | null>(initialData.summary)
  const [summaryError, setSummaryError] = React.useState<string | null>(initialData.summaryError)
  const [executions, setExecutions] = React.useState<FilledExecution[]>(initialData.executions)
  const [decisions, setDecisions] = React.useState<RejectedDecision[]>(initialData.decisions)
  const [isLoading, setIsLoading] = React.useState(false)

  const loadDataRequestIdRef = React.useRef(0)
  const loadDataAbortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    return () => {
      loadDataAbortRef.current?.abort()
    }
  }, [])

  React.useEffect(() => {
    setStrategies(initialData.strategies)
    setStrategiesError(initialData.strategiesError)
    setDisabledMessage(initialData.disabledMessage)
    setSummary(initialData.summary)
    setSummaryError(initialData.summaryError)
    setExecutions(initialData.executions)
    setDecisions(initialData.decisions)
    setStrategyId((current) => {
      if (current && initialData.strategies.some((strategy) => strategy.id === current)) {
        return current
      }
      return initialData.selectedStrategyId
    })
  }, [initialData])

  const loadStrategies = React.useCallback(async () => {
    setDisabledMessage(null)
    setStrategiesError(null)
    try {
      const result = await fetchTradingStrategies()
      if (!result.ok) {
        if (result.disabled) setDisabledMessage(result.error)
        setStrategiesError(result.error)
        setStrategies([])
        return
      }

      const parsed = result.items
      setStrategies(parsed)
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
    const requestId = loadDataRequestIdRef.current + 1
    loadDataRequestIdRef.current = requestId

    loadDataAbortRef.current?.abort()
    const controller = new AbortController()
    loadDataAbortRef.current = controller

    setIsLoading(true)
    setSummaryError(null)
    setDisabledMessage(null)

    try {
      const result = await fetchTradingSnapshot({
        day: params.day,
        strategyId: params.strategyId,
        signal: controller.signal,
      })

      if (loadDataRequestIdRef.current !== requestId) return
      if (!result.ok) {
        if (result.disabledMessage) setDisabledMessage(result.disabledMessage)
        setSummaryError(result.error)
        setSummary(null)
        setExecutions([])
        setDecisions([])
        return
      }

      setSummary(result.summary)
      setExecutions(result.executions)
      setDecisions(result.decisions)
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : 'Failed to load trading history.'
      setSummaryError(message)
      setSummary(null)
      setExecutions([])
      setDecisions([])
    } finally {
      if (loadDataRequestIdRef.current === requestId) {
        setIsLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    if (!strategyId || !day) return
    void loadData({ day, strategyId })
  }, [day, strategyId, loadData])

  const selectedStrategy = React.useMemo(
    () => strategies.find((strategy) => strategy.id === strategyId) ?? null,
    [strategies, strategyId],
  )

  const equityAccounts = summary?.equity.byAccount ?? []
  const runtimeProfitability = summary?.runtime.profitability ?? null
  const runtimeControlPlane = summary?.runtime.controlPlane ?? null
  const runtimePnlProxyNotional = runtimeProfitability?.realizedPnlProxyNotional ?? null
  const runtimeAbsSlippageBps = runtimeProfitability?.avgAbsSlippageBps ?? null
  let runtimePnlTone: 'default' | 'success' | 'warning' | 'danger' = 'default'
  if ((runtimePnlProxyNotional ?? 0) > 0) {
    runtimePnlTone = 'success'
  } else if ((runtimePnlProxyNotional ?? 0) < 0) {
    runtimePnlTone = 'danger'
  }

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
          <Button
            variant="outline"
            onClick={() => {
              void loadStrategies()
              if (day && strategyId) {
                void loadData({ day, strategyId })
              }
            }}
            disabled={isLoading || !day}
          >
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
            <Popover open={isDayPickerOpen} onOpenChange={setIsDayPickerOpen}>
              <PopoverTrigger
                id="trading-day"
                aria-label="Select trading day"
                render={
                  <Button variant="outline" className={cn('w-full justify-between px-3 text-left font-normal')}>
                    <span className="tabular-nums">{formatTradingDayLabel(day)}</span>
                    <CalendarIcon className="size-4 text-muted-foreground" />
                  </Button>
                }
              />
              <PopoverContent align="start" className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={parseTradingDay(day) ?? undefined}
                  onSelect={(selectedDay) => {
                    if (!selectedDay) return
                    setDay(formatTradingDay(selectedDay))
                    setIsDayPickerOpen(false)
                  }}
                  captionLayout="dropdown"
                  startMonth={minTradingDayDate}
                  endMonth={maxTradingDayDate}
                  disabled={(date) => date < minTradingDayDate || date > maxTradingDayDate}
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-xs font-medium" htmlFor="trading-strategy">
              Strategy
            </label>
            <Select value={strategyId} onValueChange={(value) => setStrategyId(value ?? '')}>
              <SelectTrigger id="trading-strategy" className="w-full">
                <TorghutStrategySelectValue
                  placeholder={strategies.length === 0 ? 'Loading strategies…' : 'Select strategy'}
                  strategyId={strategyId}
                  strategies={strategies}
                />
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
            <CardDescription>Decision funnel and execution posture for the selected day</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 pt-4 md:grid-cols-2 xl:grid-cols-3">
            <MetricTile
              label="Generated decisions"
              value={summary ? summary.decisions.generatedCount : isLoading ? '…' : '—'}
            />
            <MetricTile
              label="Blocked decisions"
              value={summary ? summary.decisions.blockedCount : isLoading ? '…' : '—'}
            />
            <MetricTile label="Planned rows" value={summary ? summary.decisions.plannedCount : isLoading ? '…' : '—'} />
            <MetricTile
              label="Stale planned"
              value={summary ? summary.decisions.stalePlannedCount : isLoading ? '…' : '—'}
              tone={summary && summary.decisions.stalePlannedCount > 0 ? 'danger' : 'default'}
            />
            <MetricTile
              label="Submit attempts"
              value={summary ? summary.decisions.executionSubmitAttempts : isLoading ? '…' : '—'}
            />
            <MetricTile
              label="Filled executions"
              value={summary ? summary.executions.filledCount : isLoading ? '…' : '—'}
              tone={summary && summary.executions.filledCount > 0 ? 'success' : 'default'}
            />
            <MetricTile
              label="Rejected decisions"
              value={summary ? summary.rejections.rejectedCount : isLoading ? '…' : '—'}
              tone={summary && summary.rejections.rejectedCount > 0 ? 'warning' : 'default'}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Submission Funnel</CardTitle>
            <CardDescription>Generated to blocked/submitted with current shadow-first posture</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {summary ? (
              <>
                <div className="grid gap-3 md:grid-cols-5">
                  <MetricTile label="Generated" value={summary.decisions.submissionFunnel.generatedCount} compact />
                  <MetricTile label="Blocked" value={summary.decisions.submissionFunnel.blockedCount} compact />
                  <MetricTile label="Submitted" value={summary.decisions.submissionFunnel.submittedCount} compact />
                  <MetricTile label="Filled" value={summary.decisions.submissionFunnel.filledCount} compact />
                  <MetricTile label="Rejected" value={summary.decisions.submissionFunnel.rejectedCount} compact />
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    Top blocked reasons
                  </div>
                  {summary.decisions.topBlockedReasons.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {summary.decisions.topBlockedReasons.map((item) => (
                        <span key={item.reason} className="rounded-none border border-border px-2 py-1 text-xs">
                          {item.reason}
                          <span className="ml-2 tabular-nums text-muted-foreground">{item.count}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">No blocked decisions recorded.</div>
                  )}
                </div>
              </>
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
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

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Runtime Control Plane</CardTitle>
            <CardDescription>Torghut live posture from runtime status and profitability evidence</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {summary ? (
              <>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="rounded-none border border-border px-2 py-0.5">
                    Capital stage:{' '}
                    <span className="font-medium text-foreground">
                      {runtimeControlPlane?.capitalStage ?? 'unknown'}
                    </span>
                  </span>
                  <span className="rounded-none border border-border px-2 py-0.5">
                    Toggle parity:{' '}
                    <span className="font-medium text-foreground">
                      {runtimeControlPlane?.criticalToggleParity.status ?? 'unknown'}
                    </span>
                  </span>
                  <span className="rounded-none border border-border px-2 py-0.5">
                    Revision:{' '}
                    <span className="font-medium text-foreground">
                      {runtimeControlPlane?.activeRevision ?? 'unknown'}
                    </span>
                  </span>
                </div>
                {runtimeControlPlane?.criticalToggleParity.mismatches.length ? (
                  <div className="rounded-none border border-amber-500/40 bg-amber-50/40 p-3 text-xs text-amber-900">
                    Shadow-first parity mismatches: {runtimeControlPlane.criticalToggleParity.mismatches.join(', ')}
                  </div>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2">
                  <MetricTile
                    label="Runtime PnL proxy"
                    value={runtimePnlProxyNotional === null ? '—' : currency.format(runtimePnlProxyNotional)}
                    compact
                    tone={runtimePnlTone}
                  />
                  <MetricTile
                    label="Abs slippage"
                    value={runtimeAbsSlippageBps === null ? '—' : `${compactNumber.format(runtimeAbsSlippageBps)} bps`}
                    compact
                  />
                  <MetricTile label="Runtime decisions" value={runtimeProfitability?.decisionCount ?? '—'} compact />
                  <MetricTile label="Runtime executions" value={runtimeProfitability?.executionCount ?? '—'} compact />
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>
                    Profitability lookback:{' '}
                    <span className="tabular-nums text-foreground">{runtimeProfitability?.lookbackHours ?? '—'}h</span>
                  </div>
                  <div>
                    TCA samples:{' '}
                    <span className="tabular-nums text-foreground">{runtimeProfitability?.tcaSampleCount ?? '—'}</span>
                  </div>
                </div>
                {runtimeProfitability?.caveatCodes.length ? (
                  <div className="flex flex-wrap gap-2">
                    {runtimeProfitability.caveatCodes.map((code) => (
                      <span
                        key={code}
                        className="rounded-none border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {code}
                      </span>
                    ))}
                  </div>
                ) : null}
                {runtimeProfitability?.error || runtimeControlPlane?.error ? (
                  <div className="rounded-none border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                    {runtimeProfitability?.error ?? runtimeControlPlane?.error}
                  </div>
                ) : null}
              </>
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

function MetricTile({
  label,
  value,
  tone = 'default',
  compact = false,
}: {
  label: string
  value: React.ReactNode
  tone?: 'default' | 'success' | 'warning' | 'danger'
  compact?: boolean
}) {
  let toneClass = 'text-foreground'
  if (tone === 'success') {
    toneClass = 'text-emerald-600'
  } else if (tone === 'warning') {
    toneClass = 'text-amber-600'
  } else if (tone === 'danger') {
    toneClass = 'text-rose-600'
  }

  return (
    <div className="rounded-none border bg-card p-3">
      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn('mt-2 font-medium tabular-nums', compact ? 'text-xl' : 'text-2xl', toneClass)}>{value}</div>
    </div>
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

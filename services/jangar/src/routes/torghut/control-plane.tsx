import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@proompteng/design/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { TorghutStrategySelectValue } from '@/components/torghut-strategy-select-value'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/torghut/control-plane')({
  component: TorghutQuantControlPlane,
})

type StrategyItem = {
  id: string
  name: string
  enabled: boolean
  baseTimeframe: string
  universeSymbols: unknown
}

type QuantMetric = {
  metricName: string
  window: string
  unit: string
  valueNumeric: number | null
  status: string
  quality: string
  formulaVersion: string
  asOf: string
  freshnessSeconds: number
}

type QuantAlert = {
  alertId: string
  severity: 'warning' | 'critical'
  metricName: string
  window: string
  threshold: Record<string, unknown>
  observed: Record<string, unknown>
  openedAt: string
  resolvedAt: string | null
  state: 'open' | 'resolved'
}

type AutoresearchEpoch = {
  epochId: string
  status: string
  targetNetPnlPerDay: string | null
  paperCount: number
  candidateSpecCount: number
  replayedCandidateCount: number
  portfolioCandidateCount: number
  bestPortfolioNetPnlPerDay: string | null
  bestPortfolioActiveDayRatio: string | null
  bestPortfolioPositiveDayRatio: string | null
  blockedPromotionReasons: string[]
  bestPortfolioSleeves: unknown[]
  mlxRankBucketLift: Record<string, unknown>
  falsePositiveTable: Record<string, unknown>[]
  bestFalseNegativeTable: Record<string, unknown>[]
  startedAt: string | null
  completedAt: string | null
  failureReason: string | null
}

type AutoresearchSummary = {
  available: boolean
  count: number
  epochs: AutoresearchEpoch[]
  error: string | null
}

type SnapshotFrame = {
  strategyId: string
  account: string
  window: string
  frameAsOf: string
  metrics: QuantMetric[]
  alerts: QuantAlert[]
  autoresearch?: AutoresearchSummary
}

const WINDOWS = ['1m', '5m', '15m', '1h', '1d', '5d', '20d'] as const

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const ratio = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const humanizeToken = (value: string) => value.split('_').filter(Boolean).join(' ')

const formatAsOf = (value: string) => {
  const [datePart, timePartRaw = ''] = value.split('T')
  if (!datePart || !timePartRaw) return value
  const timePart = timePartRaw.replace('Z', '')
  const [hhmmss] = timePart.split('.')
  return `${datePart} ${hhmmss} UTC`
}

const qualityTone = (quality: string) => {
  if (quality === 'error') {
    return {
      badge: 'border-red-500/40 bg-red-500/15 text-red-200',
      row: 'border-red-500/35 bg-red-500/10',
      primaryText: 'text-red-100',
      secondaryText: 'text-red-200/85',
    }
  }
  if (quality === 'stale') {
    return {
      badge: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
      row: 'border-amber-500/35 bg-amber-500/10',
      primaryText: 'text-amber-100',
      secondaryText: 'text-amber-200/85',
    }
  }
  if (quality === 'insufficient_data') {
    return {
      badge: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300',
      row: 'border-zinc-600 bg-zinc-900/70',
      primaryText: 'text-zinc-100',
      secondaryText: 'text-zinc-300',
    }
  }
  return {
    badge: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
    row: 'border-zinc-700 bg-zinc-900/85',
    primaryText: 'text-zinc-100',
    secondaryText: 'text-zinc-300',
  }
}

const formatMetric = (metric: QuantMetric) => {
  if (metric.status !== 'ok') return null
  if (metric.valueNumeric === null) return null
  if (metric.unit === 'USD') return currency.format(metric.valueNumeric)
  if (metric.unit === 'count') return integer.format(metric.valueNumeric)
  if (metric.unit === 'bps') return `${ratio.format(metric.valueNumeric)} bps`
  if (metric.unit === 'ms') return `${integer.format(metric.valueNumeric)} ms`
  if (metric.unit === 'minutes') return `${integer.format(metric.valueNumeric)} min`
  if (metric.unit === 'seconds') return `${integer.format(metric.valueNumeric)} s`
  if (metric.unit === 'ratio') return ratio.format(metric.valueNumeric)
  return ratio.format(metric.valueNumeric)
}

const formatOptionalCurrency = (value: string | null) => {
  if (!value) return 'n/a'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? currency.format(numeric) : value
}

const formatOptionalRatio = (value: string | null) => {
  if (!value) return 'n/a'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? ratio.format(numeric) : value
}

const stringField = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const evidenceLabel = (row: Record<string, unknown>) =>
  stringField(row, 'candidate_spec_id') ?? stringField(row, 'candidate_id') ?? 'candidate'

const evidenceReason = (row: Record<string, unknown>) => {
  const failureReasons = row.failure_reasons
  if (Array.isArray(failureReasons)) {
    const rendered = failureReasons
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 2)
      .map(humanizeToken)
      .join(', ')
    if (rendered) return rendered
  }
  return stringField(row, 'reason') ?? stringField(row, 'evidence_status') ?? 'review'
}

const shortId = (value: string) => (value.length > 18 ? `${value.slice(0, 18)}...` : value)

const severityColor = (severity: QuantAlert['severity']) => (severity === 'critical' ? 'bg-red-600' : 'bg-amber-600')

const freshnessBadge = (freshnessSeconds: number, quality: string) => {
  const label = `${freshnessSeconds}s`
  const tone = qualityTone(quality).badge
  return (
    <Badge variant="outline" className={cn('font-mono text-[0.65rem] px-2 py-0.5', tone)}>
      {label}
    </Badge>
  )
}

const groupFreshness = (metrics: QuantMetric[]) => {
  if (metrics.length === 0) return { freshnessSeconds: 0, quality: 'insufficient_data' }
  const maxFreshness = metrics.reduce((acc, m) => Math.max(acc, m.freshnessSeconds ?? 0), 0)
  const hasStale = metrics.some((m) => m.quality === 'stale')
  const hasError = metrics.some((m) => m.quality === 'error')
  const hasInsufficient = metrics.some((m) => m.quality === 'insufficient_data')
  const quality = hasError ? 'error' : hasStale ? 'stale' : hasInsufficient ? 'insufficient_data' : 'good'
  return { freshnessSeconds: maxFreshness, quality }
}

function TorghutQuantControlPlane() {
  const [strategies, setStrategies] = React.useState<StrategyItem[]>([])
  const [strategyId, setStrategyId] = React.useState<string>('')
  const [account, setAccount] = React.useState<string>('')
  const [window, setWindow] = React.useState<(typeof WINDOWS)[number]>('1d')
  const [frame, setFrame] = React.useState<SnapshotFrame | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    let mounted = true
    const loadStrategies = async () => {
      try {
        const resp = await fetch('/api/torghut/trading/strategies')
        const payload = (await resp.json().catch(() => null)) as { ok: true; items: StrategyItem[] } | null
        if (!mounted) return
        if (!resp.ok || !payload?.ok) {
          setStrategies([])
          return
        }
        setStrategies(payload.items ?? [])
        if (!strategyId) {
          const preferred = (payload.items ?? []).find((s) => s.enabled) ?? payload.items?.[0]
          if (preferred) setStrategyId(preferred.id)
        }
      } catch {
        if (!mounted) return
        setStrategies([])
      }
    }
    void loadStrategies()
    return () => {
      mounted = false
    }
  }, [strategyId])

  const loadSnapshot = React.useCallback(async () => {
    if (!strategyId) return
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams()
      query.set('strategy_id', strategyId)
      query.set('account', account)
      query.set('window', window)
      const resp = await fetch(`/api/torghut/trading/control-plane/quant/snapshot?${query.toString()}`)
      const payload = (await resp.json().catch(() => null)) as
        | { ok: true; frame: SnapshotFrame }
        | { ok: false; message?: string }
        | null
      if (!resp.ok || !payload || payload.ok !== true) {
        setFrame(null)
        setError((payload as { message?: string } | null)?.message ?? 'Snapshot request failed')
        return
      }
      setFrame(payload.frame)
    } catch (err) {
      setFrame(null)
      setError(err instanceof Error ? err.message : 'Snapshot request failed')
    } finally {
      setLoading(false)
    }
  }, [strategyId, account, window])

  React.useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])

  React.useEffect(() => {
    if (!strategyId) return
    const query = new URLSearchParams()
    query.set('strategy_id', strategyId)
    query.set('account', account)
    query.set('window', window)
    const es = new EventSource(`/api/torghut/trading/control-plane/quant/stream?${query.toString()}`)

    const onMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: 'quant.metrics.snapshot'; frame: SnapshotFrame }
          | { type: 'quant.metrics.delta' }
          | { type: 'quant.alert.opened' }
          | { type: 'quant.alert.resolved' }
          | { type: 'error'; message: string }

        if (payload.type === 'quant.metrics.snapshot') {
          setFrame(payload.frame)
        } else if (payload.type === 'error') {
          setError(payload.message)
        }
      } catch {
        // ignore stream parse errors; the snapshot poll is a backstop.
      }
    }

    es.addEventListener('message', onMessage)
    es.onerror = () => {
      // Let the periodic snapshot fetch own user-facing errors.
    }

    return () => {
      es.removeEventListener('message', onMessage)
      es.close()
    }
  }, [strategyId, account, window])

  const metrics = frame?.metrics ?? []
  const byName = new Map(metrics.map((m) => [m.metricName, m]))

  const perf = metrics.filter((m) =>
    ['net_pnl', 'realized_pnl', 'unrealized_pnl', 'cumulative_return', 'trade_count', 'win_rate'].includes(
      m.metricName,
    ),
  )
  const risk = metrics.filter((m) =>
    ['sharpe_annualized', 'volatility_annualized', 'max_drawdown', 'drawdown_duration_minutes'].includes(m.metricName),
  )
  const exposure = metrics.filter((m) =>
    [
      'gross_exposure',
      'net_exposure',
      'leverage_gross_over_equity',
      'position_concentration_top1_pct',
      'position_concentration_top5_pct',
      'position_hhi',
    ].includes(m.metricName),
  )
  const execution = metrics.filter((m) =>
    [
      'fill_ratio',
      'reject_rate',
      'cancel_rate',
      'slippage_bps_vs_mid',
      'implementation_shortfall_bps',
      'decision_to_submit_latency_ms_p50',
      'decision_to_submit_latency_ms_p95',
      'submit_to_fill_latency_ms_p50',
      'submit_to_fill_latency_ms_p95',
    ].includes(m.metricName),
  )
  const pipeline = metrics.filter((m) =>
    ['ta_freshness_seconds', 'context_freshness_seconds', 'metrics_pipeline_lag_seconds'].includes(m.metricName),
  )

  return (
    <div className="h-full w-full overflow-auto text-zinc-100">
      <div className="mx-auto w-full max-w-6xl p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">Torghut Quant Control Plane</h1>
          <p className="text-sm text-zinc-400">
            Near-real-time performance, risk, and execution surfaces. Read-only; Torghut remains execution authority.
          </p>
          <div className="pt-2">
            <Link
              to="/torghut/control-plane/simulation"
              className="inline-flex h-8 items-center rounded-md border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-100 hover:bg-zinc-800"
            >
              Open simulation control plane
            </Link>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card className="border-zinc-800/80 bg-zinc-950/70">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Strategy</CardTitle>
              <CardDescription className="text-zinc-400">Select an enabled strategy.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select value={strategyId} onValueChange={(value) => setStrategyId(value ?? '')}>
                <SelectTrigger>
                  <TorghutStrategySelectValue
                    placeholder="Select strategy"
                    strategyId={strategyId}
                    strategies={strategies}
                  />
                </SelectTrigger>
                <SelectContent>
                  {strategies.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.enabled ? '' : ' (disabled)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="mt-2 text-xs text-zinc-400">
                Missing strategies? Check Torghut trading status and Jangar Torghut DB connectivity.
              </div>
            </CardContent>
          </Card>

          <Card className="border-zinc-800/80 bg-zinc-950/70">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Account</CardTitle>
              <CardDescription className="text-zinc-400">Optional. Empty means aggregate.</CardDescription>
            </CardHeader>
            <CardContent>
              <input
                className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-zinc-500/50"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="alpaca account label"
              />
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="outline" className="text-[0.7rem]">
                  window: {window}
                </Badge>
                {frame ? (
                  <Badge variant="outline" className="text-[0.7rem] font-mono">
                    formula: {byName.get('net_pnl')?.formulaVersion ?? 'v1'}
                  </Badge>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card className="border-zinc-800/80 bg-zinc-950/70">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Window</CardTitle>
              <CardDescription className="text-zinc-400">Controls aggregation window semantics.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select value={window} onValueChange={(v) => setWindow(v as (typeof WINDOWS)[number])}>
                <SelectTrigger>
                  <SelectValue placeholder="Select window" />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w} value={w}>
                      {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                className="mt-3 inline-flex h-9 items-center rounded-md border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-100 hover:bg-zinc-800"
                onClick={() => void loadSnapshot()}
              >
                Refresh snapshot
              </button>
            </CardContent>
          </Card>
        </div>

        {error ? (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
            <div className="font-medium">Snapshot error</div>
            <div className="mt-1">{error}</div>
            <div className="mt-2 text-xs">
              See{' '}
              <Link to="/torghut/trading" className="underline decoration-red-300/80 underline-offset-2">
                Torghut Trading
              </Link>{' '}
              for raw execution history.
            </div>
          </div>
        ) : null}

        <AutoresearchEpochsPanel summary={frame?.autoresearch ?? null} loading={loading} />

        <div className="mt-6 grid grid-cols-1 gap-3">
          <MetricGroup
            title="Performance"
            subtitle="PnL and headline return metrics."
            metrics={perf}
            loading={loading}
          />
          <MetricGroup
            title="Risk"
            subtitle="Risk-adjusted performance and drawdowns."
            metrics={risk}
            loading={loading}
          />
          <MetricGroup
            title="Exposure"
            subtitle="Exposure, leverage, and concentration."
            metrics={exposure}
            loading={loading}
          />
          <MetricGroup
            title="Execution (TCA)"
            subtitle="Execution quality and latency surfaces."
            metrics={execution}
            loading={loading}
          />
          <MetricGroup
            title="Pipeline"
            subtitle="Upstream freshness and end-to-end staleness."
            metrics={pipeline}
            loading={loading}
          />
        </div>

        {frame?.alerts?.length ? (
          <Card className="mt-6 border-zinc-800/80 bg-zinc-950/70">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Active Alerts</CardTitle>
              <CardDescription className="text-zinc-400">
                Threshold breaches emitted by the control plane.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-2">
                {frame.alerts.map((alert) => (
                  <div
                    key={alert.alertId}
                    className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-900/60 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className={cn('h-2 w-2 rounded-full', severityColor(alert.severity))} />
                      <div className="flex flex-col">
                        <div className="text-sm font-medium">
                          {alert.metricName} ({alert.window})
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">{alert.alertId}</div>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[0.7rem]">
                      {alert.severity}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

function AutoresearchEpochsPanel({ summary, loading }: { summary: AutoresearchSummary | null; loading: boolean }) {
  const epochs = summary?.epochs ?? []
  return (
    <Card className="mt-6 border-zinc-800/80 bg-zinc-950/70">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-sm">Whitepaper Autoresearch</CardTitle>
            <CardDescription className="text-zinc-400">
              Latest persisted epochs, candidate coverage, and promotion blockers.
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-[0.7rem]">
            {summary?.available === false ? 'unavailable' : `${summary?.count ?? epochs.length} epochs`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !summary ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {['epoch-a', 'epoch-b', 'epoch-c'].map((key) => (
              <Skeleton key={key} className="h-28 w-full" />
            ))}
          </div>
        ) : summary?.available === false ? (
          <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-100">
            {summary.error ?? 'Autoresearch epochs unavailable'}
          </div>
        ) : epochs.length === 0 ? (
          <div className="text-sm text-zinc-400">No persisted autoresearch epochs available.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {epochs.map((epoch) => {
              const lift = stringField(epoch.mlxRankBucketLift, 'lift_net_pnl_per_day')
              return (
                <div key={epoch.epochId} className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-xs text-zinc-300">{shortId(epoch.epochId)}</div>
                      <div className="mt-1 text-sm font-medium text-zinc-100">
                        {formatOptionalCurrency(epoch.bestPortfolioNetPnlPerDay)} / day
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[0.7rem]">
                      {epoch.status}
                    </Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                      <div className="text-zinc-500">Specs</div>
                      <div className="font-mono text-zinc-100">
                        {epoch.replayedCandidateCount}/{epoch.candidateSpecCount}
                      </div>
                    </div>
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                      <div className="text-zinc-500">Sleeves</div>
                      <div className="font-mono text-zinc-100">{epoch.bestPortfolioSleeves.length}</div>
                    </div>
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                      <div className="text-zinc-500">Active</div>
                      <div className="font-mono text-zinc-100">
                        {formatOptionalRatio(epoch.bestPortfolioActiveDayRatio)}
                      </div>
                    </div>
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                      <div className="text-zinc-500">Positive</div>
                      <div className="font-mono text-zinc-100">
                        {formatOptionalRatio(epoch.bestPortfolioPositiveDayRatio)}
                      </div>
                    </div>
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                      <div className="text-zinc-500">MLX lift</div>
                      <div className="font-mono text-zinc-100">{formatOptionalCurrency(lift)}</div>
                    </div>
                    <div className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                      <div className="text-zinc-500">Evidence</div>
                      <div className="font-mono text-zinc-100">
                        {epoch.falsePositiveTable.length}/{epoch.bestFalseNegativeTable.length}
                      </div>
                    </div>
                  </div>

                  {epoch.blockedPromotionReasons.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {epoch.blockedPromotionReasons.slice(0, 4).map((reason) => (
                        <Badge
                          key={reason}
                          variant="outline"
                          className="border-amber-500/40 text-[0.65rem] text-amber-200"
                        >
                          {humanizeToken(reason)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  <AutoresearchEvidenceRows title="False positives" rows={epoch.falsePositiveTable} />
                  <AutoresearchEvidenceRows title="False negatives" rows={epoch.bestFalseNegativeTable} />
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AutoresearchEvidenceRows({ title, rows }: { title: string; rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null
  return (
    <div className="mt-3 border-t border-zinc-800 pt-2">
      <div className="mb-1 text-[0.65rem] uppercase tracking-normal text-zinc-500">{title}</div>
      <div className="space-y-1">
        {rows.slice(0, 2).map((row, index) => (
          <div
            key={`${title}-${evidenceLabel(row)}-${index}`}
            className="flex items-start justify-between gap-2 text-xs"
          >
            <span className="font-mono text-zinc-300">{shortId(evidenceLabel(row))}</span>
            <span className="max-w-[60%] text-right text-zinc-400">{evidenceReason(row)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MetricGroup({
  title,
  subtitle,
  metrics,
  loading,
}: {
  title: string
  subtitle: string
  metrics: QuantMetric[]
  loading: boolean
}) {
  const freshness = groupFreshness(metrics)
  const skeletonKeys = React.useMemo(() => ['a', 'b', 'c', 'd', 'e', 'f'], [])
  return (
    <Card className="border-zinc-800/80 bg-zinc-950/70">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-sm">{title}</CardTitle>
            <CardDescription className="text-zinc-400">{subtitle}</CardDescription>
          </div>
          {metrics.length > 0 ? freshnessBadge(freshness.freshnessSeconds, freshness.quality) : null}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {skeletonKeys.map((key) => (
              <Skeleton key={key} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {metrics.map((metric) => (
              <MetricRow key={metric.metricName} metric={metric} />
            ))}
            {metrics.length === 0 ? (
              <div className="text-sm text-zinc-400">No metrics available for this group yet.</div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MetricRow({ metric }: { metric: QuantMetric }) {
  const value = formatMetric(metric)
  const isOk = metric.status === 'ok' && value !== null
  const tone = qualityTone(metric.quality)
  const metricName = humanizeToken(metric.metricName)
  const statusLabel = humanizeToken(metric.status)

  return (
    <div className={cn('flex items-center justify-between rounded-md border p-3', tone.row)}>
      <div className="flex flex-col gap-0.5">
        <div className={cn('text-sm font-medium', tone.primaryText)}>{metricName}</div>
        <div className={cn('text-xs font-mono', tone.secondaryText)}>{formatAsOf(metric.asOf)}</div>
      </div>
      <div className="flex items-center gap-2">
        {freshnessBadge(metric.freshnessSeconds, metric.quality)}
        <div className={cn('text-sm font-mono', isOk ? tone.primaryText : tone.secondaryText)}>
          {isOk ? value : statusLabel}
        </div>
      </div>
    </div>
  )
}

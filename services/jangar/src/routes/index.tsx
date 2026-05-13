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
  Skeleton,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

export const Route = createFileRoute('/')({ component: Home })

type MemoriesStatsPayload = {
  ok: true
  range: { days: number; from: string; to: string }
  byDay: { day: string; count: number }[]
  topNamespaces: { namespace: string; count: number }[]
}

const isCountPayload = (value: unknown): value is { ok: true; count: number } => {
  if (!value || typeof value !== 'object') return false
  if (!('ok' in value) || !('count' in value)) return false
  return value.ok === true && typeof value.count === 'number'
}

const getMaybeErrorMessage = (value: unknown) => {
  if (!value || typeof value !== 'object') return null
  const record = value as { error?: unknown; message?: unknown }
  if (typeof record.error === 'string' && record.error) return record.error
  if (typeof record.message === 'string' && record.message) return record.message
  return null
}

function Home() {
  const [count, setCount] = React.useState<number | null>(null)
  const [countError, setCountError] = React.useState<string | null>(null)
  const [stats, setStats] = React.useState<MemoriesStatsPayload | null>(null)
  const [statsError, setStatsError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setIsLoading(true)
    setCountError(null)
    setStatsError(null)
    try {
      const [countResponse, statsResponse] = await Promise.all([
        fetch('/api/memories/count'),
        fetch('/api/memories/stats'),
      ])

      const countPayload = (await countResponse.json().catch(() => null)) as unknown
      if (!countResponse.ok || !isCountPayload(countPayload)) {
        const message = getMaybeErrorMessage(countPayload) ?? 'Unable to load memory count right now.'
        setCountError(message)
        setCount(null)
      } else {
        setCount(countPayload.count)
      }

      const statsPayload = (await statsResponse.json().catch(() => null)) as
        | MemoriesStatsPayload
        | { error?: string }
        | null
      if (!statsResponse.ok || !statsPayload || !('ok' in statsPayload) || statsPayload.ok !== true) {
        const message =
          (statsPayload && 'error' in statsPayload && typeof statsPayload.error === 'string' && statsPayload.error) ||
          'Unable to load memory stats right now.'
        setStatsError(message)
        setStats(null)
      } else {
        setStats(statsPayload)
      }
    } catch {
      setCountError('Unable to load memory count right now.')
      setCount(null)
      setStatsError('Unable to load memory stats right now.')
      setStats(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <Card>
        <CardHeader className="border-b">
          <div className="space-y-1">
            <CardTitle>Memories</CardTitle>
            <CardDescription>Total entries</CardDescription>
          </div>
          <CardAction>
            <Button variant="outline" onClick={load} disabled={isLoading}>
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-2">
          {countError ? (
            <div className="text-xs text-destructive" aria-live="polite">
              {countError}
            </div>
          ) : null}
          <div className="text-3xl font-medium tabular-nums">{count ?? (isLoading ? '…' : '—')}</div>
        </CardContent>
      </Card>

      <section className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Volume</CardTitle>
            <CardDescription>Entries per day (last {stats?.range.days ?? 30} days)</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            {statsError ? (
              <div className="text-xs text-destructive" aria-live="polite">
                {statsError}
              </div>
            ) : stats && stats.byDay.length > 0 ? (
              <MemoriesByDayChart data={stats.byDay} />
            ) : isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : (
              <div className="text-xs text-muted-foreground">No data yet.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Namespaces</CardTitle>
            <CardDescription>Top namespaces (last {stats?.range.days ?? 30} days)</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            {statsError ? (
              <div className="text-xs text-destructive" aria-live="polite">
                {statsError}
              </div>
            ) : stats && stats.topNamespaces.length > 0 ? (
              <MemoriesTopNamespacesChart data={stats.topNamespaces} />
            ) : isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : (
              <div className="text-xs text-muted-foreground">No data yet.</div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  )
}

const memoriesByDayConfig = {
  count: {
    label: 'Entries',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

function MemoriesByDayChart({ data }: { data: { day: string; count: number }[] }) {
  return (
    <ChartContainer config={memoriesByDayConfig} className="h-56 w-full">
      <LineChart data={data} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) => formatShortDay(value)}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Line
          dataKey="count"
          type="monotone"
          stroke="var(--color-count)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3 }}
        />
      </LineChart>
    </ChartContainer>
  )
}

const memoriesTopNamespacesConfig = {
  count: {
    label: 'Entries',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig

function MemoriesTopNamespacesChart({ data }: { data: { namespace: string; count: number }[] }) {
  return (
    <ChartContainer config={memoriesTopNamespacesConfig} className="h-56 w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 12 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" dataKey="count" hide />
        <YAxis
          dataKey="namespace"
          type="category"
          width={96}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(value: string) => truncateLabel(value)}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
      </BarChart>
    </ChartContainer>
  )
}

const formatShortDay = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const truncateLabel = (value: string, max = 14) => {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

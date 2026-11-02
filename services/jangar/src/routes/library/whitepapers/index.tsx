import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@proompteng/design/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { listWhitepapers, type WhitepaperListItem } from '@/data/whitepapers'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/library/whitepapers/')({
  component: LibraryWhitepapersRoute,
})

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'agentrun_dispatched', label: 'AgentRun dispatched' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
] as const

const VERDICT_OPTIONS = [
  { value: 'all', label: 'All verdicts' },
  { value: 'implement', label: 'Implement' },
  { value: 'investigate', label: 'Investigate' },
  { value: 'reject', label: 'Reject' },
] as const

const statusTone = (status: string) => {
  if (status === 'completed') return '!border-emerald-300/60 !bg-emerald-500/25 !text-emerald-100'
  if (status === 'failed') return '!border-rose-300/60 !bg-rose-500/25 !text-rose-100'
  if (status === 'agentrun_dispatched') return '!border-cyan-300/60 !bg-cyan-500/25 !text-cyan-100'
  if (status === 'queued') return '!border-amber-300/60 !bg-amber-500/25 !text-amber-100'
  return '!border-zinc-300/50 !bg-zinc-500/25 !text-zinc-100'
}

const verdictTone = (verdict: string) => {
  if (verdict === 'implement') return '!border-emerald-300/60 !bg-emerald-500/25 !text-emerald-100'
  if (verdict === 'investigate') return '!border-amber-300/60 !bg-amber-500/25 !text-amber-100'
  if (verdict === 'reject') return '!border-rose-300/60 !bg-rose-500/25 !text-rose-100'
  return '!border-zinc-300/50 !bg-zinc-500/25 !text-zinc-100'
}

const formatDate = (value: string | null) => {
  if (!value) return 'n/a'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const formatFileSize = (bytes: number | null) => {
  if (!bytes || bytes <= 0) return 'n/a'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function LibraryWhitepapersRoute() {
  const [queryInput, setQueryInput] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState<(typeof STATUS_OPTIONS)[number]['value']>('all')
  const [verdict, setVerdict] = React.useState<(typeof VERDICT_OPTIONS)[number]['value']>('all')
  const [items, setItems] = React.useState<WhitepaperListItem[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadWhitepapers = React.useCallback(async () => {
    setLoading(true)
    setError(null)

    const result = await listWhitepapers({
      query: query || undefined,
      status: status === 'all' ? undefined : status,
      verdict: verdict === 'all' ? undefined : verdict,
      limit: 80,
      offset: 0,
    })

    if (!result.ok) {
      setItems([])
      setTotal(0)
      setError(result.message)
      setLoading(false)
      return
    }

    setItems(result.items)
    setTotal(result.total)
    setLoading(false)
  }, [query, status, verdict])

  React.useEffect(() => {
    void loadWhitepapers()
  }, [loadWhitepapers])

  const submitQuery = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setQuery(queryInput.trim())
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-7xl p-6">
        <div className="mb-6 flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            Browse whitepapers processed by Torghut. Open any run to read the source PDF and AgentRun analysis side by
            side.
          </p>
        </div>

        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Filters</CardTitle>
            <CardDescription>Search by title, run id, or source identifier.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitQuery} className="grid gap-3 md:grid-cols-[1fr_200px_200px_auto]">
              <Input
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder="Search whitepapers"
                className="w-full"
              />
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as (typeof STATUS_OPTIONS)[number]['value'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={verdict}
                onValueChange={(value) => setVerdict(value as (typeof VERDICT_OPTIONS)[number]['value'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VERDICT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit">Apply</Button>
            </form>
          </CardContent>
        </Card>

        <div className="mb-3 text-xs text-muted-foreground">{loading ? 'Loading...' : `${total} result(s)`}</div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Card key={String(index)}>
                <CardHeader className="gap-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-3 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}

        {error ? (
          <Card className="border-rose-500/40 bg-rose-500/10">
            <CardHeader>
              <CardTitle className="text-sm text-rose-200">Library request failed</CardTitle>
              <CardDescription className="[overflow-wrap:anywhere] text-rose-100/90">{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void loadWhitepapers()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">No whitepapers found</CardTitle>
              <CardDescription>Try broadening filters or clear the search query.</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {!loading && !error && items.length > 0 ? (
          <div className="space-y-3">
            {items.map((item) => (
              <WhitepaperListCard key={item.runId} item={item} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function WhitepaperListCard({ item }: { item: WhitepaperListItem }) {
  const verdictValue = item.verdict?.verdict ?? null

  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="min-w-0 flex-1 text-base [overflow-wrap:anywhere]">
            {item.document.title ?? item.runId}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" className={cn('font-mono text-[0.65rem] px-2 py-0.5', statusTone(item.status))}>
              {item.status}
            </Badge>
            {verdictValue ? (
              <Badge
                variant="outline"
                className={cn('font-mono text-[0.65rem] px-2 py-0.5', verdictTone(verdictValue))}
              >
                {verdictValue}
              </Badge>
            ) : null}
          </div>
        </div>
        <CardDescription className="font-mono text-[0.7rem] [overflow-wrap:anywhere]">
          {item.runId}
          {item.document.sourceIdentifier ? ` • ${item.document.sourceIdentifier}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
        <div>
          <span className="font-medium text-foreground">Created:</span> {formatDate(item.createdAt)}
        </div>
        <div>
          <span className="font-medium text-foreground">Parse:</span> {item.version.parseStatus ?? 'n/a'}
        </div>
        <div>
          <span className="font-medium text-foreground">AgentRun:</span> {item.latestAgentrun?.status ?? 'n/a'}
        </div>
        <div>
          <span className="font-medium text-foreground">File size:</span> {formatFileSize(item.version.fileSizeBytes)}
        </div>
        <div className="md:col-span-2 [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">Failure reason:</span> {item.failureReason ?? 'n/a'}
        </div>
        <div className="md:col-span-2 flex justify-end">
          <Button asChild>
            <Link to="/library/whitepapers/$runId" params={{ runId: item.runId }}>
              view
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Separator,
  Spinner,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import { Clock3, Hash, Search } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
})

type MemoryResult = {
  id: string
  namespace: string
  content: string
  summary: string | null
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
  distance?: number
}

const MAX_RESULTS = 12

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

const formatTimestamp = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const toRelevanceScore = (distance: number | undefined) => {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return null
  return Math.max(0, Math.min(100, Math.round((1 - distance) * 100)))
}

function MemoriesPage() {
  const [query, setQuery] = React.useState('')
  const [isSearching, setIsSearching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [results, setResults] = React.useState<MemoryResult[]>([])
  const [lastQuery, setLastQuery] = React.useState<string | null>(null)
  const [hasSearched, setHasSearched] = React.useState(false)

  const submitQuery = async () => {
    const trimmedQuery = query.trim()
    setError(null)

    if (!trimmedQuery) {
      setResults([])
      setError('Query is required.')
      return
    }

    setIsSearching(true)
    try {
      const params = new URLSearchParams({
        query: trimmedQuery,
        limit: String(MAX_RESULTS),
      })
      const response = await fetch(`/api/memories?${params.toString()}`)
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        memories?: MemoryResult[]
        error?: string
        message?: string
      } | null
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload?.error ?? payload?.message ?? 'Unable to query right now. Please try again.'
        setResults([])
        setError(message)
        return
      }
      const nextResults = Array.isArray(payload.memories) ? payload.memories : []
      setResults(nextResults)
      setLastQuery(trimmedQuery)
      setHasSearched(true)
    } catch {
      setResults([])
      setError('Unable to query right now. Please try again.')
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col p-5">
      <section className="overflow-hidden rounded-lg border border-zinc-500/20 bg-card">
        <div className="flex flex-col gap-4 p-5">
          <header className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold tracking-[0.12em] text-zinc-500">semantic search</p>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Relevant matches across all namespaces
            </h1>
            <p className="max-w-3xl text-xs text-zinc-600 dark:text-zinc-300">
              Queries run globally and return only relevant results. Weak semantic tail matches are filtered out.
            </p>
          </header>

          <form
            className="flex flex-col gap-3 md:flex-row md:items-center"
            onSubmit={(event) => {
              event.preventDefault()
              void submitQuery()
            }}
          >
            <label className="sr-only" htmlFor="memories-query">
              Query
            </label>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                id="memories-query"
                name="query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search memories by concept, topic, or phrase"
                autoComplete="off"
                className="pl-9"
              />
            </div>
            <Button type="submit" disabled={isSearching}>
              {isSearching ? (
                <span className="flex items-center gap-2">
                  <Spinner className="size-3.5" />
                  Searching
                </span>
              ) : (
                'Search'
              )}
            </Button>
          </form>
        </div>

        {error ? (
          <div className="border-t border-zinc-500/20 p-5">
            <Card className="border-destructive/30 bg-destructive/5">
              <CardHeader>
                <CardTitle className="text-sm text-destructive">Search failed</CardTitle>
                <CardDescription className="text-destructive/90">{error}</CardDescription>
              </CardHeader>
            </Card>
          </div>
        ) : null}

        {!error && hasSearched && results.length === 0 ? (
          <div className="border-t border-zinc-500/20 p-5">
            <Empty className="border-zinc-500/30 bg-zinc-500/5">
              <EmptyHeader>
                <EmptyTitle>No relevant matches found</EmptyTitle>
                <EmptyDescription>
                  {lastQuery ? `No strong matches for "${lastQuery}".` : 'No strong matches for this query.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : null}

        {!error && results.length > 0 ? (
          <section className="grid gap-3 border-t border-zinc-500/20 p-5">
            {results.map((result) => {
              const relevanceScore = toRelevanceScore(result.distance)
              const relevanceClassName = cn('bg-zinc-100 text-zinc-700', {
                'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300':
                  relevanceScore != null && relevanceScore >= 75,
                'bg-amber-500/15 text-amber-700 dark:text-amber-300':
                  relevanceScore != null && relevanceScore < 75 && relevanceScore >= 60,
              })
              return (
                <Card key={result.id} className="border-zinc-500/20 bg-card transition-colors hover:border-zinc-500/40">
                  <CardHeader className="gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <CardTitle className="text-sm text-zinc-900 dark:text-zinc-50">
                          {result.summary ? truncate(result.summary, 140) : truncate(result.content, 140)}
                        </CardTitle>
                        <CardDescription>{truncate(result.content, 260)}</CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        {relevanceScore != null ? (
                          <Badge className={relevanceClassName}>{relevanceScore}% relevance</Badge>
                        ) : null}
                        <Badge variant="outline">{result.namespace}</Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Separator />
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="size-3.5" />
                        {formatTimestamp(result.createdAt)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Hash className="size-3.5" />
                        {result.id}
                      </span>
                      {typeof result.distance === 'number' ? <span>distance {result.distance.toFixed(3)}</span> : null}
                    </div>
                    {result.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {result.tags.map((tag) => (
                          <Badge key={`${result.id}-${tag}`} variant="outline">
                            #{tag}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              )
            })}
          </section>
        ) : null}
      </section>
    </main>
  )
}

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

import {
  searchWhitepapersSemantic,
  type WhitepaperSemanticSearchItem,
  type WhitepaperSemanticSearchScope,
} from '@/data/whitepapers'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/library/whitepapers/search')({
  component: WhitepaperSemanticSearchRoute,
})

const STATUS_OPTIONS = [
  { value: 'completed', label: 'Completed' },
  { value: 'agentrun_dispatched', label: 'AgentRun dispatched' },
  { value: 'queued', label: 'Queued' },
  { value: 'failed', label: 'Failed' },
] as const

const SCOPE_OPTIONS: { value: WhitepaperSemanticSearchScope; label: string }[] = [
  { value: 'all', label: 'All scopes' },
  { value: 'synthesis', label: 'Synthesis' },
  { value: 'full_text', label: 'Full text' },
]

const formatNumber = (value: number | null) => (value === null || Number.isNaN(value) ? 'n/a' : value.toFixed(4))

function WhitepaperSemanticSearchRoute() {
  const [queryInput, setQueryInput] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [scope, setScope] = React.useState<WhitepaperSemanticSearchScope>('all')
  const [status, setStatus] = React.useState<(typeof STATUS_OPTIONS)[number]['value']>('completed')
  const [subjectInput, setSubjectInput] = React.useState('')
  const [subject, setSubject] = React.useState('')

  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [items, setItems] = React.useState<WhitepaperSemanticSearchItem[]>([])
  const [total, setTotal] = React.useState(0)

  const runSearch = React.useCallback(async () => {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      setItems([])
      setTotal(0)
      setError('Enter a query to search semantic index')
      return
    }

    setLoading(true)
    setError(null)
    const result = await searchWhitepapersSemantic({
      query: normalizedQuery,
      scope,
      status,
      subject: subject || undefined,
      limit: 30,
      offset: 0,
    })
    setLoading(false)

    if (!result.ok) {
      setItems([])
      setTotal(0)
      setError(result.message)
      return
    }

    setItems(result.items)
    setTotal(result.total)
  }, [query, scope, status, subject])

  React.useEffect(() => {
    if (!query) return
    void runSearch()
  }, [query, runSearch])

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setQuery(queryInput.trim())
    setSubject(subjectInput.trim())
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-6xl p-6">
        <div className="mb-6 flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">Semantic search</h1>
          <p className="text-sm text-muted-foreground">
            Hybrid semantic + lexical retrieval over whitepaper full text and synthesis content.
          </p>
        </div>

        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Query</CardTitle>
            <CardDescription>Search by meaning, then filter by scope and run status.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[1fr_180px_180px_180px_auto]">
              <Input
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder="Find ideas, methods, or claims"
              />
              <Select value={scope} onValueChange={(value) => setScope(value as WhitepaperSemanticSearchScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Input
                value={subjectInput}
                onChange={(event) => setSubjectInput(event.target.value)}
                placeholder="Subject (optional)"
              />
              <Button type="submit">Search</Button>
            </form>
          </CardContent>
        </Card>

        <div className="mb-3 text-xs text-muted-foreground">{loading ? 'Searching…' : `${total} result(s)`}</div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Card key={String(index)}>
                <CardHeader className="gap-2">
                  <Skeleton className="h-4 w-2/3" />
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
              <CardTitle className="text-sm text-rose-200">Semantic search failed</CardTitle>
              <CardDescription className="[overflow-wrap:anywhere] text-rose-100/90">{error}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {!loading && !error && query && items.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">No results</CardTitle>
              <CardDescription>Try broader wording or switch to full-text scope.</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {!loading && !error && items.length > 0 ? (
          <div className="space-y-3">
            {items.map((item, index) => (
              <Card key={`${item.runId}-${item.chunk.chunkIndex}-${String(index)}`}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="min-w-0 flex-1 text-base [overflow-wrap:anywhere]">
                      {item.document.title ?? item.runId}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={cn('font-mono text-[0.65rem] px-2 py-0.5')}>
                        {item.chunk.sourceScope}
                      </Badge>
                      <Badge variant="outline" className={cn('font-mono text-[0.65rem] px-2 py-0.5')}>
                        {item.runStatus}
                      </Badge>
                    </div>
                  </div>
                  <CardDescription className="font-mono text-[0.7rem] [overflow-wrap:anywhere]">
                    {item.runId}
                    {item.chunk.sectionKey ? ` • ${item.chunk.sectionKey}` : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm leading-6 text-foreground">{item.chunk.snippet}</p>
                  <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
                    <div>
                      <span className="font-medium text-foreground">Hybrid:</span> {formatNumber(item.hybridScore)}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Semantic:</span>{' '}
                      {formatNumber(item.semanticDistance)}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Lexical:</span> {formatNumber(item.lexicalScore)}
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button asChild>
                      <Link to="/library/whitepapers/$runId" params={{ runId: item.runId }}>
                        view run
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

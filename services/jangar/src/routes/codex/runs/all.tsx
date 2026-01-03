import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type CodexRunSummaryRecord, fetchCodexRecentRuns } from '@/data/codex'
import { cn } from '@/lib/utils'

type CodexRunsAllSearchState = {
  repository: string
  limit: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const parseSearchNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

export const Route = createFileRoute('/codex/runs/all')({
  validateSearch: (search: Record<string, unknown>): CodexRunsAllSearchState => {
    const limitRaw = parseSearchNumber(search.limit) ?? DEFAULT_LIMIT
    return {
      repository: typeof search.repository === 'string' ? search.repository : '',
      limit: Math.min(limitRaw, MAX_LIMIT),
    }
  },
  component: CodexRunsAllPage,
})

function CodexRunsAllPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [repository, setRepository] = React.useState(searchState.repository)
  const [limit, setLimit] = React.useState(searchState.limit.toString())
  const [runs, setRuns] = React.useState<CodexRunSummaryRecord[]>([])
  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const repositoryId = React.useId()
  const limitId = React.useId()

  const repositoryRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    setRepository(searchState.repository)
    setLimit(searchState.limit.toString())
  }, [searchState])

  const loadRuns = React.useCallback(async (params: { repository?: string; limit: number }) => {
    setIsLoading(true)
    setError(null)
    setStatus(null)
    try {
      const result = await fetchCodexRecentRuns({
        repository: params.repository,
        limit: params.limit,
      })
      if (!result.ok) {
        setRuns([])
        setError(result.message)
        return
      }
      setRuns(result.runs)
      setStatus(result.runs.length === 0 ? 'No runs found.' : `Loaded ${result.runs.length} runs.`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setRuns([])
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    const trimmedRepository = searchState.repository.trim()
    void loadRuns({
      repository: trimmedRepository.length > 0 ? trimmedRepository : undefined,
      limit: searchState.limit,
    })
  }, [loadRuns, searchState])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const trimmedRepository = repository.trim()
    const parsedLimit = parseSearchNumber(limit) ?? DEFAULT_LIMIT

    void navigate({
      search: (prev) => ({
        ...prev,
        repository: trimmedRepository,
        limit: Math.min(parsedLimit, MAX_LIMIT),
      }),
    })
  }

  return (
    <main className="mx-auto space-y-6 p-6 w-full max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Codex</p>
          <h1 className="text-lg font-semibold">All runs</h1>
          <p className="text-xs text-muted-foreground">Browse recent Codex judge runs across repositories.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{runs.length}</span> runs loaded
        </div>
      </header>

      <section className="rounded-none p-4 border bg-card">
        <form className="space-y-3" onSubmit={submit}>
          <div className="grid md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor={repositoryId}>
                Repository (optional)
              </label>
              <Input
                ref={repositoryRef}
                id={repositoryId}
                name="repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="proompteng/lab"
                autoComplete="off"
                aria-invalid={Boolean(formError)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor={limitId}>
                Limit
              </label>
              <Input
                id={limitId}
                name="limit"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                placeholder={DEFAULT_LIMIT.toString()}
                inputMode="numeric"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Loading…' : 'Load runs'}
            </Button>
            <span>
              Default limit {DEFAULT_LIMIT}, max {MAX_LIMIT}.
            </span>
          </div>
          {formError ? (
            <p className="text-xs text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </section>

      {error ? (
        <section className="rounded-none p-4 text-xs border border-destructive/40 bg-destructive/10 text-destructive">
          {error}
        </section>
      ) : null}

      {status ? (
        <div className="text-xs text-muted-foreground" aria-live="polite">
          {status}
        </div>
      ) : null}

      {runs.length > 0 ? (
        <section className="space-y-3">
          {runs.map((run) => (
            <RunSummaryCard key={run.id} run={run} />
          ))}
        </section>
      ) : (
        <section className="rounded-none p-6 text-center text-xs border border-dashed bg-card text-muted-foreground">
          No runs loaded yet.
        </section>
      )}
    </main>
  )
}

function RunSummaryCard({ run }: { run: CodexRunSummaryRecord }) {
  return (
    <article className="rounded-none p-4 border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Issue</span>
            <Link
              to="/codex/runs"
              search={{
                repository: run.repository,
                issueNumber: run.issueNumber,
                branch: '',
                limit: DEFAULT_LIMIT,
              }}
              className="text-sm font-semibold text-primary hover:underline"
            >
              #{run.issueNumber}
            </Link>
            <span className="text-muted-foreground">{run.repository}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Attempt</span>
            <span className="text-sm font-semibold tabular-nums">#{run.attempt}</span>
            <StatusPill value={run.status} />
            {run.stage ? <StatusPill value={run.stage} tone="muted" /> : null}
            {run.phase ? <StatusPill value={run.phase} tone="muted" /> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            Workflow <span className="text-foreground">{run.workflowName}</span>
            {run.workflowNamespace ? <span className="text-muted-foreground"> / {run.workflowNamespace}</span> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            Branch <span className="text-foreground">{run.branch}</span>
          </div>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            Created <span className="tabular-nums">{formatDateTime(run.createdAt)}</span>
          </div>
          <div>
            Started <span className="tabular-nums">{formatDateTime(run.startedAt)}</span>
          </div>
          <div>
            Finished <span className="tabular-nums">{formatDateTime(run.finishedAt)}</span>
          </div>
        </div>
      </header>

      <div className="grid md:grid-cols-3 mt-4 gap-3 text-xs">
        <DetailBlock label="CI status">
          <div className="font-medium text-foreground">{run.ciStatus ?? '—'}</div>
        </DetailBlock>
        <DetailBlock label="Review status">
          <div className="font-medium text-foreground">{run.reviewStatus ?? '—'}</div>
        </DetailBlock>
        <DetailBlock label="PR / commit">
          {run.prUrl ? <ExternalLink href={run.prUrl}>PR #{run.prNumber ?? '—'}</ExternalLink> : 'No PR link.'}
          <div className="text-muted-foreground">Commit {run.commitSha ?? '—'}</div>
        </DetailBlock>
      </div>
    </article>
  )
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  )
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="underline-offset-4 hover:underline text-primary" target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function StatusPill({ value, tone }: { value: string; tone?: 'muted' | 'default' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-none px-2 py-1 text-[10px] font-medium uppercase tracking-widest border',
        tone === 'muted' ? 'border-border bg-muted/40 text-muted-foreground' : 'border-border bg-muted text-foreground',
      )}
    >
      {value}
    </span>
  )
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const formatDateTime = (value: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return dateFormatter.format(date)
}

import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import {
  type CodexArtifactRecord,
  type CodexEvaluationRecord,
  type CodexIssueSummaryRecord,
  type CodexRunHistory,
  type CodexRunHistoryEntry,
  type CodexRunStats,
  fetchCodexIssueSummaries,
  fetchCodexRunHistory,
} from '@/data/codex'
import { cn } from '@/lib/utils'

type CodexRunsSearchState = {
  repository: string
  issueNumber: number | null
  branch: string
  limit: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const DEFAULT_REPOSITORY = 'proompteng/lab'

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

export const Route = createFileRoute('/codex/runs')({
  validateSearch: (search: Record<string, unknown>): CodexRunsSearchState => {
    const limitRaw = parseSearchNumber(search.limit) ?? DEFAULT_LIMIT
    const repository =
      typeof search.repository === 'string' && search.repository.trim().length > 0
        ? search.repository
        : DEFAULT_REPOSITORY
    return {
      repository,
      issueNumber: parseSearchNumber(search.issueNumber),
      branch: typeof search.branch === 'string' ? search.branch : '',
      limit: Math.min(limitRaw, MAX_LIMIT),
    }
  },
  component: CodexRunsPage,
})

function CodexRunsPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [repository, setRepository] = React.useState(searchState.repository)
  const [issueNumber, setIssueNumber] = React.useState(
    searchState.issueNumber ? searchState.issueNumber.toString() : '',
  )
  const [branch, setBranch] = React.useState(searchState.branch)
  const [limit, setLimit] = React.useState(searchState.limit.toString())

  const [history, setHistory] = React.useState<CodexRunHistory | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [issueOptions, setIssueOptions] = React.useState<CodexIssueSummaryRecord[]>([])
  const [issueStatus, setIssueStatus] = React.useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [issueError, setIssueError] = React.useState<string | null>(null)

  const repositoryId = React.useId()
  const issueId = React.useId()
  const branchId = React.useId()
  const limitId = React.useId()

  const repositoryRef = React.useRef<HTMLInputElement | null>(null)
  const filteredIssueOptions = React.useMemo(() => {
    const query = issueNumber.trim()
    if (!query) return issueOptions
    return issueOptions.filter((issue) => issue.issueNumber.toString().includes(query))
  }, [issueNumber, issueOptions])

  React.useEffect(() => {
    setRepository(searchState.repository)
    setIssueNumber(searchState.issueNumber ? searchState.issueNumber.toString() : '')
    setBranch(searchState.branch)
    setLimit(searchState.limit.toString())
  }, [searchState])

  React.useEffect(() => {
    const trimmedRepository = repository.trim()
    if (!trimmedRepository) {
      setIssueOptions([])
      setIssueStatus('idle')
      setIssueError(null)
      return
    }

    const controller = new AbortController()
    let active = true
    setIssueStatus('loading')
    setIssueError(null)
    fetchCodexIssueSummaries({ repository: trimmedRepository, limit: 200, signal: controller.signal })
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setIssueOptions([])
          setIssueStatus('error')
          setIssueError(result.message)
          return
        }
        setIssueOptions(result.issues)
        setIssueStatus('loaded')
        setIssueError(null)
      })
      .catch((err: unknown) => {
        if (!active) return
        const message = err instanceof Error ? err.message : String(err)
        setIssueOptions([])
        setIssueStatus('error')
        setIssueError(message)
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [repository])

  const loadRuns = React.useCallback(
    async (params: { repository: string; issueNumber: number; branch?: string; limit: number }) => {
      setIsLoading(true)
      setError(null)
      setStatus(null)
      try {
        const result = await fetchCodexRunHistory(params)
        if (!result.ok) {
          setHistory(null)
          setError(result.message)
          return
        }
        setHistory(result.history)
        setStatus(
          result.history.runs.length === 0
            ? 'No runs found for this issue.'
            : `Loaded ${result.history.runs.length} runs.`,
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setHistory(null)
        setError(message)
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  React.useEffect(() => {
    if (!searchState.repository || !searchState.issueNumber) {
      setHistory(null)
      setStatus(null)
      return
    }

    void loadRuns({
      repository: searchState.repository,
      issueNumber: searchState.issueNumber,
      branch: searchState.branch.trim() || undefined,
      limit: searchState.limit,
    })
  }, [loadRuns, searchState])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const trimmedRepository = repository.trim()
    const parsedIssue = parseSearchNumber(issueNumber)
    const parsedLimit = parseSearchNumber(limit) ?? DEFAULT_LIMIT

    if (!trimmedRepository) {
      setFormError('Repository is required.')
      repositoryRef.current?.focus()
      return
    }
    if (!parsedIssue) {
      setFormError('Issue number is required.')
      document.getElementById(issueId)?.focus()
      return
    }

    void navigate({
      search: {
        repository: trimmedRepository,
        issueNumber: parsedIssue,
        branch: branch.trim(),
        limit: Math.min(parsedLimit, MAX_LIMIT),
      },
    })
  }

  return (
    <main className="mx-auto space-y-6 p-6 w-full max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Codex</p>
          <h1 className="text-lg font-semibold">Run history</h1>
          <p className="text-xs text-muted-foreground">Query Codex judge runs by repository and issue.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          {history ? <span className="tabular-nums">{history.runs.length}</span> : '—'} runs loaded
        </div>
      </header>

      <section className="rounded-none p-4 border bg-card">
        <form className="space-y-3" onSubmit={submit}>
          <div className="grid md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor={repositoryId}>
                Repository
              </label>
              <Input
                ref={repositoryRef}
                id={repositoryId}
                name="repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder={DEFAULT_REPOSITORY}
                autoComplete="off"
                aria-invalid={Boolean(formError)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor={issueId}>
                Issue number
              </label>
              <Combobox
                inputValue={issueNumber}
                onInputValueChange={(value) => setIssueNumber(value)}
                value={issueNumber.length > 0 ? issueNumber : null}
                onValueChange={(value) => setIssueNumber(value ?? '')}
                autoHighlight
                openOnInputClick
              >
                <ComboboxInput
                  id={issueId}
                  name="issueNumber"
                  placeholder="2151"
                  inputMode="numeric"
                  aria-invalid={Boolean(formError)}
                  showTrigger
                />
                <ComboboxContent>
                  <ComboboxList>
                    {filteredIssueOptions.map((issue) => (
                      <ComboboxItem key={issue.issueNumber} value={issue.issueNumber.toString()}>
                        <span className="text-foreground">#{issue.issueNumber}</span>
                        <span className="text-muted-foreground">{issue.runCount} runs</span>
                      </ComboboxItem>
                    ))}
                    <ComboboxEmpty>No recent issues found.</ComboboxEmpty>
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <p className="text-xs text-muted-foreground">
                {issueStatus === 'loading'
                  ? 'Loading recent issues…'
                  : repository.trim().length === 0
                    ? 'Enter a repository to load issues. You can still type any issue number.'
                    : `Showing ${issueOptions.length} recent issues. You can type any issue number.`}
              </p>
              {issueStatus === 'error' ? (
                <p className="text-xs text-destructive" role="alert">
                  {issueError ?? 'Unable to load issues.'}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor={branchId}>
                Branch (optional)
              </label>
              <Input
                id={branchId}
                name="branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                autoComplete="off"
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

      {history ? (
        <section className="space-y-6">
          <StatsSection stats={history.stats} />
          <RunsSection runs={history.runs} />
        </section>
      ) : (
        <section className="rounded-none p-6 text-center text-xs border border-dashed bg-card text-muted-foreground">
          Enter a repository and issue number to load Codex run history.
        </section>
      )}
    </main>
  )
}

function StatsSection({ stats }: { stats: CodexRunStats }) {
  const failureReasons = Object.entries(stats.failureReasonCounts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Summary stats</h2>
        <span className="text-xs text-muted-foreground">Aggregated across visible runs</span>
      </header>
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Completion rate" value={formatPercent(stats.completionRate)} />
        <StatCard label="Avg attempts" value={formatNumber(stats.avgAttemptsPerIssue)} />
        <StatCard label="Avg judge confidence" value={formatPercent(stats.avgJudgeConfidence)} />
        <StatCard label="Avg CI duration" value={formatDuration(stats.avgCiDurationSeconds)} />
      </div>
      <div className="rounded-none p-4 border bg-card">
        <div className="text-xs font-medium text-muted-foreground">Failure reasons</div>
        {failureReasons.length === 0 ? (
          <div className="mt-2 text-xs text-muted-foreground">No failure reasons recorded.</div>
        ) : (
          <ul className="mt-2 space-y-1 text-xs">
            {failureReasons.map(([reason, count]) => (
              <li key={reason} className="flex items-center justify-between gap-2">
                <span className="text-foreground">{reason}</span>
                <span className="tabular-nums text-muted-foreground">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-none p-4 border bg-card">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function RunsSection({ runs }: { runs: CodexRunHistoryEntry[] }) {
  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Runs</h2>
        <span className="text-xs text-muted-foreground">Ordered by attempt</span>
      </header>
      {runs.length === 0 ? (
        <div className="rounded-none p-6 text-center text-xs border bg-card text-muted-foreground">
          No runs found for this issue.
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((entry) => (
            <RunCard key={entry.run.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  )
}

function RunCard({ entry }: { entry: CodexRunHistoryEntry }) {
  const { run, artifacts, evaluation } = entry

  return (
    <article className="rounded-none p-4 border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Attempt</span>
            <span className="text-sm font-semibold tabular-nums">#{run.attempt}</span>
            <StatusPill value={run.status} />
            {run.phase ? <StatusPill value={run.phase} tone="muted" /> : null}
            {run.stage ? <StatusPill value={run.stage} tone="muted" /> : null}
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

      <div className="grid lg:grid-cols-2 mt-4 gap-4">
        <div className="space-y-3">
          <DetailBlock label="CI status">
            <div className="font-medium text-foreground">{run.ciStatus ?? '—'}</div>
            {run.ciUrl ? (
              <ExternalLink href={run.ciUrl}>Open CI</ExternalLink>
            ) : (
              <div className="text-muted-foreground">No CI link provided.</div>
            )}
            {run.ciStatusUpdatedAt ? (
              <div className="text-muted-foreground">Updated {formatDateTime(run.ciStatusUpdatedAt)}</div>
            ) : null}
          </DetailBlock>

          <DetailBlock label="Review status">
            <div className="font-medium text-foreground">{run.reviewStatus ?? '—'}</div>
            <div className="text-muted-foreground">{formatReviewSummary(run.reviewSummary)}</div>
            {run.reviewStatusUpdatedAt ? (
              <div className="text-muted-foreground">Updated {formatDateTime(run.reviewStatusUpdatedAt)}</div>
            ) : null}
          </DetailBlock>

          <DetailBlock label="PR / commit">
            {run.prUrl ? (
              <ExternalLink href={run.prUrl}>PR #{run.prNumber ?? '—'}</ExternalLink>
            ) : (
              <div className="text-muted-foreground">No PR link.</div>
            )}
            <div className="text-muted-foreground">Commit {run.commitSha ?? '—'}</div>
          </DetailBlock>
        </div>

        <div className="space-y-3">
          <EvaluationBlock evaluation={evaluation} />
          <ArtifactsBlock artifacts={artifacts} />
        </div>
      </div>
    </article>
  )
}

function EvaluationBlock({ evaluation }: { evaluation: CodexEvaluationRecord | null }) {
  return (
    <DetailBlock label="Evaluation">
      <div className="font-medium text-foreground">{evaluation?.decision ?? '—'}</div>
      <div className="text-muted-foreground">Confidence {formatPercent(evaluation?.confidence ?? null)}</div>
      {evaluation?.nextPrompt ? (
        <div
          className="rounded-none p-2 text-[11px] border bg-background text-muted-foreground"
          title={evaluation.nextPrompt}
        >
          {truncateText(evaluation.nextPrompt, 240)}
        </div>
      ) : (
        <div className="text-muted-foreground">No next prompt captured.</div>
      )}
    </DetailBlock>
  )
}

function ArtifactsBlock({ artifacts }: { artifacts: CodexArtifactRecord[] }) {
  return (
    <DetailBlock label="Artifacts">
      {artifacts.length === 0 ? (
        <div className="text-muted-foreground">No artifacts attached.</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{artifact.name || 'artifact'}</span>
              {artifact.url ? (
                <ExternalLink href={artifact.url}>Open</ExternalLink>
              ) : (
                <span className="text-muted-foreground">{artifact.key}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailBlock>
  )
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="text-muted-foreground">{label}</div>
      {children}
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

const percentFormatter = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })
const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

const formatPercent = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—'
  return percentFormatter.format(value)
}

const formatNumber = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—'
  return numberFormatter.format(value)
}

const formatDuration = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const seconds = rounded % 60
  const parts = []
  if (hours > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

const truncateText = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

const formatReviewSummary = (summary: Record<string, unknown>) => {
  if (!summary || Object.keys(summary).length === 0) {
    return 'No review summary.'
  }
  if (typeof summary.summary === 'string') {
    return truncateText(summary.summary, 200)
  }
  if (typeof summary.message === 'string') {
    return truncateText(summary.message, 200)
  }
  return truncateText(JSON.stringify(summary), 200)
}

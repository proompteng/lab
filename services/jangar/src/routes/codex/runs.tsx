import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { type CodexRunSummaryRecord, fetchCodexRecentRuns, fetchCodexRunsPage } from '@/data/codex'
import { cn } from '@/lib/utils'

type CodexRunsSearchState = {
  repository: string
  page: number
  pageSize: number
}

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const DEFAULT_SEARCH_LIMIT = 50

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
    const pageRaw = parseSearchNumber(search.page) ?? DEFAULT_PAGE
    const pageSizeRaw = parseSearchNumber(search.pageSize) ?? DEFAULT_PAGE_SIZE
    return {
      repository: typeof search.repository === 'string' ? search.repository : '',
      page: Math.max(pageRaw, 1),
      pageSize: Math.min(pageSizeRaw, MAX_PAGE_SIZE),
    }
  },
  component: CodexRunsPage,
})

function CodexRunsPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [repository, setRepository] = React.useState(searchState.repository)
  const [pageSize, setPageSize] = React.useState(searchState.pageSize.toString())
  const [runs, setRuns] = React.useState<CodexRunSummaryRecord[]>([])
  const [reviewQueue, setReviewQueue] = React.useState<CodexRunSummaryRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const repositoryId = React.useId()
  const pageSizeId = React.useId()

  const repositoryRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    setRepository(searchState.repository)
    setPageSize(searchState.pageSize.toString())
  }, [searchState.pageSize, searchState.repository])

  const loadRuns = React.useCallback(async (params: { repository?: string; page: number; pageSize: number }) => {
    setIsLoading(true)
    setError(null)
    setStatus(null)
    try {
      const result = await fetchCodexRunsPage({
        repository: params.repository,
        page: params.page,
        pageSize: params.pageSize,
      })
      if (!result.ok) {
        setRuns([])
        setTotal(0)
        setError(result.message)
        return
      }
      setRuns(result.runs)
      setTotal(result.total)
      setStatus(result.runs.length === 0 ? 'No runs found.' : `Loaded ${result.runs.length} runs.`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setRuns([])
      setTotal(0)
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    const trimmedRepository = searchState.repository.trim()
    void loadRuns({
      repository: trimmedRepository.length > 0 ? trimmedRepository : undefined,
      page: searchState.page,
      pageSize: searchState.pageSize,
    })
  }, [loadRuns, searchState.page, searchState.pageSize, searchState.repository])

  React.useEffect(() => {
    const trimmedRepository = searchState.repository.trim()
    const controller = new AbortController()
    fetchCodexRecentRuns({
      repository: trimmedRepository.length > 0 ? trimmedRepository : undefined,
      limit: 50,
      signal: controller.signal,
    })
      .then((result) => {
        if (!result.ok) {
          setReviewQueue([])
          return
        }
        const queued = result.runs.filter((run) => {
          const statusValue = run.reviewStatus?.toLowerCase() ?? ''
          if (statusValue === 'approved') return false
          if (statusValue === 'pending' || statusValue === 'changes_requested' || statusValue === 'commented') {
            return true
          }
          return run.stage === 'review'
        })
        setReviewQueue(queued)
      })
      .catch(() => {
        setReviewQueue([])
      })
    return () => controller.abort()
  }, [searchState.repository])

  const totalPages = Math.max(1, Math.ceil(total / searchState.pageSize))
  const clampedPage = Math.min(searchState.page, totalPages)
  const isFirstPage = clampedPage <= 1
  const isLastPage = clampedPage >= totalPages
  const pageStartIndex = total > 0 ? (clampedPage - 1) * searchState.pageSize : 0
  const rangeStart = total > 0 ? pageStartIndex + 1 : 0
  const rangeEnd = total > 0 ? Math.min(pageStartIndex + runs.length, total) : 0
  const pageNumbers = React.useMemo(() => {
    if (totalPages <= 1) return [1]
    const windowSize = 5
    const start = Math.max(1, Math.min(clampedPage - 2, totalPages - windowSize + 1))
    const count = Math.min(totalPages, windowSize)
    return Array.from({ length: count }, (_, index) => start + index)
  }, [clampedPage, totalPages])
  const rangeLabel = total === 0 ? 'No runs yet.' : `${rangeStart}-${rangeEnd} of ${total}`
  const pageLabel = totalPages > 1 ? `Page ${clampedPage}/${totalPages}` : 'Page 1'

  const goToPage = React.useCallback(
    (page: number) => {
      void navigate({
        search: {
          repository: searchState.repository,
          page,
          pageSize: searchState.pageSize,
        },
      })
    },
    [navigate, searchState.pageSize, searchState.repository],
  )

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const trimmedRepository = repository.trim()
    const parsedPageSize = parseSearchNumber(pageSize) ?? DEFAULT_PAGE_SIZE

    void navigate({
      search: {
        repository: trimmedRepository,
        page: DEFAULT_PAGE,
        pageSize: Math.min(parsedPageSize, MAX_PAGE_SIZE),
      },
    })
  }

  return (
    <main className="mx-auto space-y-6 p-6 w-full max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Codex</p>
          <h1 className="text-lg font-semibold">All runs</h1>
          <p className="text-xs text-muted-foreground">Browse all Codex judge runs across repositories.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{total}</span> total runs
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
              <label className="text-xs font-medium" htmlFor={pageSizeId}>
                Rows per page
              </label>
              <Input
                id={pageSizeId}
                name="pageSize"
                value={pageSize}
                onChange={(event) => setPageSize(event.target.value)}
                placeholder={DEFAULT_PAGE_SIZE.toString()}
                inputMode="numeric"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Loading…' : 'Load runs'}
            </Button>
            <span>
              Default size {DEFAULT_PAGE_SIZE}, max {MAX_PAGE_SIZE}.
            </span>
          </div>
          {formError ? (
            <p className="text-xs text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </section>

      <section className="rounded-none border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-xs text-muted-foreground">
          <span>Review queue</span>
          <span className="tabular-nums">{reviewQueue.length}</span>
        </div>
        {reviewQueue.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">Issue</th>
                  <th className="px-3 py-2 text-left font-medium">Repository</th>
                  <th className="px-3 py-2 text-left font-medium">Review status</th>
                  <th className="px-3 py-2 text-left font-medium">PR</th>
                  <th className="px-3 py-2 text-left font-medium">PR status</th>
                  <th className="px-3 py-2 text-left font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {reviewQueue.map((run) => {
                  const prStatus = getPrStatus(run)
                  return (
                    <tr key={`review-${run.id}`} className="border-b last:border-0">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link
                          to="/codex/search"
                          search={{
                            repository: run.repository,
                            issueNumber: run.issueNumber,
                            branch: '',
                            limit: DEFAULT_SEARCH_LIMIT,
                          }}
                          className="text-primary hover:underline"
                        >
                          #{run.issueNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{run.repository}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {run.reviewStatus ?? 'pending'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {run.prUrl ? (
                          <ExternalLink href={run.prUrl}>PR #{run.prNumber ?? '—'}</ExternalLink>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {prStatus ? <StatusPill value={prStatus} tone="muted" /> : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {formatDateTime(run.updatedAt)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-muted-foreground">No review queue items.</div>
        )}
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

      <section className="rounded-none border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-xs text-muted-foreground">
          <span>{rangeLabel}</span>
          <span>{pageLabel}</span>
        </div>
        {runs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">Issue</th>
                  <th className="px-3 py-2 text-left font-medium">Repository</th>
                  <th className="px-3 py-2 text-left font-medium">Attempt</th>
                  <th className="px-3 py-2 text-left font-medium">Iteration</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Stage / Phase</th>
                  <th className="px-3 py-2 text-left font-medium">Judge</th>
                  <th className="px-3 py-2 text-left font-medium">Workflow</th>
                  <th className="px-3 py-2 text-left font-medium">Branch</th>
                  <th className="px-3 py-2 text-left font-medium">PR</th>
                  <th className="px-3 py-2 text-left font-medium">PR status</th>
                  <th className="px-3 py-2 text-left font-medium">CI</th>
                  <th className="px-3 py-2 text-left font-medium">Review</th>
                  <th className="px-3 py-2 text-left font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const prStatus = getPrStatus(run)
                  return (
                    <tr key={run.id} className="border-b last:border-0">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link
                          to="/codex/search"
                          search={{
                            repository: run.repository,
                            issueNumber: run.issueNumber,
                            branch: '',
                            limit: DEFAULT_SEARCH_LIMIT,
                          }}
                          className="text-primary hover:underline"
                        >
                          #{run.issueNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{run.repository}</td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">#{run.attempt}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {run.iteration ? (
                          <span className="tabular-nums">
                            {run.iteration}
                            {run.iterationCycle ? `/${run.iterationCycle}` : ''}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <StatusPill value={run.status} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {run.stage ?? '—'} / {run.phase ?? '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{run.decision ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-foreground">{run.workflowName}</div>
                        {run.workflowNamespace ? (
                          <div className="text-muted-foreground">{run.workflowNamespace}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{run.branch}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {run.prUrl ? (
                          <ExternalLink href={run.prUrl}>PR #{run.prNumber ?? '—'}</ExternalLink>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {prStatus ? <StatusPill value={prStatus} tone="muted" /> : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{run.ciStatus ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{run.reviewStatus ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {formatDateTime(run.createdAt)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-muted-foreground">No runs loaded yet.</div>
        )}
        {totalPages > 1 ? (
          <div className="border-t px-3 py-2">
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    aria-disabled={isFirstPage}
                    className={isFirstPage ? 'pointer-events-none opacity-50' : undefined}
                    onClick={() => {
                      if (isFirstPage) return
                      goToPage(Math.max(1, clampedPage - 1))
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
              <PaginationContent>
                {pageNumbers.map((page) => (
                  <PaginationItem key={page}>
                    <PaginationLink isActive={page === clampedPage} onClick={() => goToPage(page)}>
                      {page}
                    </PaginationLink>
                  </PaginationItem>
                ))}
              </PaginationContent>
              <PaginationContent>
                <PaginationItem>
                  <PaginationNext
                    aria-disabled={isLastPage}
                    className={isLastPage ? 'pointer-events-none opacity-50' : undefined}
                    onClick={() => {
                      if (isLastPage) return
                      goToPage(Math.min(totalPages, clampedPage + 1))
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        ) : null}
      </section>
    </main>
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

const getPrStatus = (run: CodexRunSummaryRecord): string | null => {
  if (run.prNumber == null) return null
  if (run.prMerged) return 'merged'
  return run.prState ?? null
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

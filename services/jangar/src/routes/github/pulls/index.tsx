import { Button, Input } from '@proompteng/design/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import { fetchGithubPulls, type GithubPullListItem } from '@/data/github'

const DEFAULT_REPOSITORY = 'proompteng/lab'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const NULL_CURSOR_TOKEN = '~'

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

const formatDateTime = (value: string | null) => {
  if (!value) return '—'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parsed))
}

const badgeClass = (variant: 'success' | 'warning' | 'danger' | 'neutral') => {
  const base = 'inline-flex items-center rounded-none border px-2 py-0.5 text-xs uppercase tracking-wide'
  switch (variant) {
    case 'success':
      return `${base} border-emerald-200 bg-emerald-50 text-emerald-700`
    case 'warning':
      return `${base} border-amber-200 bg-amber-50 text-amber-700`
    case 'danger':
      return `${base} border-red-200 bg-red-50 text-red-700`
    default:
      return `${base} border-border bg-muted text-muted-foreground`
  }
}

const parseCursorHistory = (raw: string | undefined) => {
  if (!raw) return [] as Array<string | null>
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => (token === NULL_CURSOR_TOKEN ? null : token))
}

const serializeCursorHistory = (values: Array<string | null>) =>
  values.map((value) => value ?? NULL_CURSOR_TOKEN).join(',')

type PullsSearchState = {
  repository: string
  state: string
  author: string
  label: string
  reviewDecision: string
  ciStatus: string
  limit: number
  cursor?: string
  cursorHistory?: string
}

export const Route = createFileRoute('/github/pulls/')({
  validateSearch: (search: Record<string, unknown>): PullsSearchState => {
    const limitRaw = parseSearchNumber(search.limit) ?? DEFAULT_LIMIT
    return {
      repository: typeof search.repository === 'string' ? search.repository : '',
      state: typeof search.state === 'string' ? search.state : '',
      author: typeof search.author === 'string' ? search.author : '',
      label: typeof search.label === 'string' ? search.label : '',
      reviewDecision: typeof search.reviewDecision === 'string' ? search.reviewDecision : '',
      ciStatus: typeof search.ciStatus === 'string' ? search.ciStatus : '',
      limit: Math.min(limitRaw, MAX_LIMIT),
      cursor: typeof search.cursor === 'string' && search.cursor.trim().length > 0 ? search.cursor : undefined,
      cursorHistory:
        typeof search.cursorHistory === 'string' && search.cursorHistory.trim().length > 0
          ? search.cursorHistory
          : undefined,
    }
  },
  component: GithubPullsPage,
})

function GithubPullsPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [repository, setRepository] = React.useState(searchState.repository)
  const [state, setState] = React.useState(searchState.state)
  const [author, setAuthor] = React.useState(searchState.author)
  const [label, setLabel] = React.useState(searchState.label)
  const [reviewDecision, setReviewDecision] = React.useState(searchState.reviewDecision)
  const [ciStatus, setCiStatus] = React.useState(searchState.ciStatus)
  const [limit, setLimit] = React.useState(searchState.limit.toString())

  const [items, setItems] = React.useState<GithubPullListItem[]>([])
  const [viewerLogin, setViewerLogin] = React.useState<string | null>(null)
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [repositoriesAllowed, setRepositoriesAllowed] = React.useState<string[]>([])
  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const searchParams =
    typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
  const repositoryParam = searchParams.get('repository')?.trim() ?? ''
  const authorParamRaw = searchParams.get('author')
  const authorParam = authorParamRaw?.trim() ?? ''
  const limitParam = parseSearchNumber(searchParams.get('limit') ?? undefined)
  const hasRepositoryParam = repositoryParam.length > 0
  const hasAuthorParam = authorParamRaw !== null && authorParam.length > 0
  const hasAuthorFilter = authorParam.length > 0
  const hasLimitParam = limitParam !== null
  const cursorHistory = parseCursorHistory(searchState.cursorHistory)
  const currentPage = cursorHistory.length + 1
  const repositoryValue = repository || (!hasRepositoryParam ? DEFAULT_REPOSITORY : '')
  const authorValue = author || (!hasAuthorParam ? (viewerLogin ?? '') : '')

  React.useEffect(() => {
    setRepository(searchState.repository)
    setState(searchState.state)
    setAuthor(searchState.author)
    setLabel(searchState.label)
    setReviewDecision(searchState.reviewDecision)
    setCiStatus(searchState.ciStatus)
    setLimit(searchState.limit.toString())
  }, [searchState])

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const shouldSetRepository = !hasRepositoryParam
    const shouldSetAuthor = !hasAuthorParam && viewerLogin
    const shouldSetLimit = !hasLimitParam
    if (!shouldSetRepository && !shouldSetAuthor && !shouldSetLimit) return
    void navigate({
      replace: true,
      search: {
        ...searchState,
        repository: shouldSetRepository ? DEFAULT_REPOSITORY : searchState.repository,
        author: shouldSetAuthor ? (viewerLogin ?? '') : searchState.author,
        limit: searchState.limit,
        cursor: undefined,
        cursorHistory: undefined,
      },
    })
  }, [hasAuthorParam, hasLimitParam, hasRepositoryParam, navigate, searchState, viewerLogin])

  const loadPulls = React.useCallback(
    async (params: PullsSearchState, options: { hasRepository: boolean }) => {
      setLoading(true)
      setError(null)
      setStatus(null)
      try {
        const response = await fetchGithubPulls({
          repository: options.hasRepository ? params.repository : DEFAULT_REPOSITORY,
          state: params.state || undefined,
          author: hasAuthorFilter ? params.author : undefined,
          label: params.label || undefined,
          reviewDecision: params.reviewDecision || undefined,
          ciStatus: params.ciStatus || undefined,
          limit: params.limit,
          cursor: params.cursor ?? null,
        })

        if (!response.ok) {
          setError(response.error)
          setItems([])
          setNextCursor(null)
          return
        }

        setItems(response.items)
        setNextCursor(response.nextCursor ?? null)
        setViewerLogin(response.viewerLogin ?? null)
        setRepositoriesAllowed(response.repositoriesAllowed ?? [])
        setStatus(response.items.length === 0 ? 'No pull requests found.' : `Loaded ${response.items.length} pulls.`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setItems([])
        setNextCursor(null)
      } finally {
        setLoading(false)
      }
    },
    [hasAuthorFilter],
  )

  React.useEffect(() => {
    void loadPulls(searchState, { hasRepository: hasRepositoryParam })
  }, [hasRepositoryParam, loadPulls, searchState])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsedLimit = parseSearchNumber(limit) ?? DEFAULT_LIMIT
    void navigate({
      search: {
        repository: repositoryValue.trim() || DEFAULT_REPOSITORY,
        state: state.trim(),
        author: authorValue.trim(),
        label: label.trim(),
        reviewDecision: reviewDecision.trim(),
        ciStatus: ciStatus.trim(),
        limit: Math.min(parsedLimit, MAX_LIMIT),
        cursor: undefined,
        cursorHistory: undefined,
      },
    })
  }

  const goToNextPage = () => {
    if (!nextCursor) return
    const nextHistory = [...cursorHistory, searchState.cursor ?? null]
    void navigate({
      search: {
        ...searchState,
        cursor: nextCursor,
        cursorHistory: serializeCursorHistory(nextHistory),
      },
    })
  }

  const goToPreviousPage = () => {
    if (cursorHistory.length === 0) return
    const nextHistory = cursorHistory.slice(0, -1)
    const previousCursor = cursorHistory[cursorHistory.length - 1]
    void navigate({
      search: {
        ...searchState,
        cursor: previousCursor ?? undefined,
        cursorHistory: nextHistory.length > 0 ? serializeCursorHistory(nextHistory) : undefined,
      },
    })
  }

  return (
    <main className="space-y-6 p-6 w-full max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">GitHub</p>
          <h1 className="text-lg font-semibold">PR reviews</h1>
          <p className="text-xs text-muted-foreground">Review pull requests from the Codex webhook stream.</p>
        </div>
        <div className="text-xs text-muted-foreground">{loading ? 'Loading…' : `${items.length} pulls`}</div>
      </header>

      <section className="rounded-none p-4 border bg-card">
        <form className="space-y-3" onSubmit={submit}>
          <div className="grid gap-3 lg:grid-cols-6">
            <div className="space-y-1 lg:col-span-2">
              <label className="text-xs font-medium" htmlFor="repo">
                Repository
              </label>
              <Input
                id="repo"
                name="repository"
                value={repositoryValue}
                onChange={(event) => setRepository(event.target.value)}
                placeholder={repositoriesAllowed[0] ?? 'proompteng/lab'}
                list="github-repos"
              />
              <datalist id="github-repos">
                {repositoriesAllowed.map((repo) => (
                  <option key={repo} value={repo} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="state">
                State
              </label>
              <select
                id="state"
                className="h-9 w-full border bg-background px-2 text-xs"
                value={state}
                onChange={(event) => setState(event.target.value)}
              >
                <option value="">Any</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="merged">Merged</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="author">
                Author
              </label>
              <Input id="author" value={authorValue} onChange={(event) => setAuthor(event.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="label">
                Label
              </label>
              <Input id="label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="reviewDecision">
                Review
              </label>
              <select
                id="reviewDecision"
                className="h-9 w-full border bg-background px-2 text-xs"
                value={reviewDecision}
                onChange={(event) => setReviewDecision(event.target.value)}
              >
                <option value="">Any</option>
                <option value="approved">Approved</option>
                <option value="changes_requested">Changes requested</option>
                <option value="commented">Commented</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="ciStatus">
                CI
              </label>
              <select
                id="ciStatus"
                className="h-9 w-full border bg-background px-2 text-xs"
                value={ciStatus}
                onChange={(event) => setCiStatus(event.target.value)}
              >
                <option value="">Any</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
                <option value="pending">Pending</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="limit">
                Limit
              </label>
              <Input id="limit" value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={loading} size="sm">
              {loading ? 'Loading…' : 'Filter'}
            </Button>
            {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
            {error ? <span className="text-xs text-red-500">{error}</span> : null}
          </div>
        </form>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="text-muted-foreground">Page {currentPage}</div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || cursorHistory.length === 0}
            onClick={goToPreviousPage}
          >
            Previous
          </Button>
          <Button type="button" size="sm" disabled={loading || !nextCursor} onClick={goToNextPage}>
            Next
          </Button>
        </div>
      </section>

      <section className="overflow-hidden rounded-none border bg-card">
        <table className="w-full text-left text-xs">
          <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="px-3 py-2">PR</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Author</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Review</th>
              <th className="px-3 py-2">CI</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={6}>
                  {loading ? 'Loading pull requests…' : 'No pull requests found.'}
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const [owner, repo] = item.repository.split('/')
                return (
                  <tr key={`${item.repository}-${item.number}`} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-medium">
                      <Link
                        to="/github/pulls/$owner/$repo/$number"
                        params={{ owner: owner ?? '', repo: repo ?? '', number: String(item.number) }}
                      >
                        {item.repository}#{item.number}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-sm">{item.title ?? 'Untitled'}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {item.headRef ?? 'unknown'} → {item.baseRef ?? 'unknown'}
                      </div>
                    </td>
                    <td className="px-3 py-2">{item.authorLogin ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(item.updatedAt ?? item.receivedAt)}
                    </td>
                    <td className="px-3 py-2">
                      {item.review?.decision ? (
                        <span
                          className={badgeClass(
                            item.review.decision === 'approved'
                              ? 'success'
                              : item.review.decision === 'changes_requested'
                                ? 'danger'
                                : 'warning',
                          )}
                        >
                          {item.review.decision.replace('_', ' ')}
                        </span>
                      ) : (
                        <span className={badgeClass('neutral')}>pending</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {item.checks?.status ? (
                        <span
                          className={badgeClass(
                            item.checks.status === 'success'
                              ? 'success'
                              : item.checks.status === 'failure'
                                ? 'danger'
                                : 'warning',
                          )}
                        >
                          {item.checks.status}
                        </span>
                      ) : (
                        <span className={badgeClass('neutral')}>unknown</span>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </section>
    </main>
  )
}

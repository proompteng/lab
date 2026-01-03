import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchGithubPulls, type GithubPullListItem } from '@/data/github'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

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

type PullsSearchState = {
  repository: string
  state: string
  author: string
  label: string
  reviewDecision: string
  ciStatus: string
  limit: number
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
  const [repositoriesAllowed, setRepositoriesAllowed] = React.useState<string[]>([])
  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    setRepository(searchState.repository)
    setState(searchState.state)
    setAuthor(searchState.author)
    setLabel(searchState.label)
    setReviewDecision(searchState.reviewDecision)
    setCiStatus(searchState.ciStatus)
    setLimit(searchState.limit.toString())
  }, [searchState])

  const loadPulls = React.useCallback(async (params: PullsSearchState) => {
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const response = await fetchGithubPulls({
        repository: params.repository || undefined,
        state: params.state || undefined,
        author: params.author || undefined,
        label: params.label || undefined,
        reviewDecision: params.reviewDecision || undefined,
        ciStatus: params.ciStatus || undefined,
        limit: params.limit,
      })

      if (!response.ok) {
        setError(response.error)
        setItems([])
        return
      }

      setItems(response.items)
      setRepositoriesAllowed(response.repositoriesAllowed ?? [])
      setStatus(response.items.length === 0 ? 'No pull requests found.' : `Loaded ${response.items.length} pulls.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadPulls(searchState)
  }, [loadPulls, searchState])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsedLimit = parseSearchNumber(limit) ?? DEFAULT_LIMIT
    void navigate({
      search: {
        repository: repository.trim(),
        state: state.trim(),
        author: author.trim(),
        label: label.trim(),
        reviewDecision: reviewDecision.trim(),
        ciStatus: ciStatus.trim(),
        limit: Math.min(parsedLimit, MAX_LIMIT),
      },
    })
  }

  return (
    <main className="mx-auto space-y-6 p-6 w-full max-w-6xl">
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
                value={repository}
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
              <Input id="author" value={author} onChange={(event) => setAuthor(event.target.value)} />
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

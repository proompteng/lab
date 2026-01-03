import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  fetchGithubPull,
  fetchGithubPullFiles,
  fetchGithubPullThreads,
  type GithubCheckSummary,
  type GithubIssueComment,
  type GithubPrFile,
  type GithubPullState,
  type GithubReviewSummary,
  type GithubReviewThread,
  mergeGithubPull,
  resolveGithubThread,
  submitGithubReview,
} from '@/data/github'

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

type TabKey = 'overview' | 'files' | 'conversation' | 'checks'

type InlineComment = {
  id: string
  path: string
  line: string
  side: 'LEFT' | 'RIGHT'
  body: string
  startLine: string
}

export const Route = createFileRoute('/github/pulls/$owner/$repo/$number')({
  component: GithubPullDetailPage,
})

function GithubPullDetailPage() {
  const { owner, repo, number } = Route.useParams()
  const prNumber = Number.parseInt(number, 10)

  const [pull, setPull] = React.useState<GithubPullState | null>(null)
  const [review, setReview] = React.useState<GithubReviewSummary | null>(null)
  const [checks, setChecks] = React.useState<GithubCheckSummary | null>(null)
  const [issueComments, setIssueComments] = React.useState<GithubIssueComment[]>([])
  const [threads, setThreads] = React.useState<GithubReviewThread[]>([])
  const [files, setFiles] = React.useState<GithubPrFile[]>([])
  const [capabilities, setCapabilities] = React.useState({ reviewsWriteEnabled: false, mergeWriteEnabled: false })

  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const [activeTab, setActiveTab] = React.useState<TabKey>('overview')
  const [reviewBody, setReviewBody] = React.useState('')
  const [reviewEvent, setReviewEvent] = React.useState<'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'>('COMMENT')
  const [inlineComments, setInlineComments] = React.useState<InlineComment[]>([])
  const [mergeMethod, setMergeMethod] = React.useState<'merge' | 'squash' | 'rebase'>('squash')
  const [mergeTitle, setMergeTitle] = React.useState('')
  const [mergeMessage, setMergeMessage] = React.useState('')
  const [deleteBranch, setDeleteBranch] = React.useState(true)

  const loadAll = React.useCallback(async () => {
    if (!Number.isFinite(prNumber)) {
      setError('Invalid pull request number')
      return
    }
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const pullRes = await fetchGithubPull(owner, repo, prNumber)
      if (!pullRes.ok) {
        setError(pullRes.error)
        return
      }
      setPull(pullRes.pull)
      setReview(pullRes.review)
      setChecks(pullRes.checks)
      setIssueComments(pullRes.issueComments)
      setCapabilities(pullRes.capabilities)

      const [filesRes, threadsRes] = await Promise.all([
        fetchGithubPullFiles(owner, repo, prNumber),
        fetchGithubPullThreads(owner, repo, prNumber),
      ])
      if (filesRes.ok) setFiles(filesRes.files)
      if (threadsRes.ok) setThreads(threadsRes.threads)

      setStatus('Loaded pull request details.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [owner, repo, prNumber])

  React.useEffect(() => {
    void loadAll()
  }, [loadAll])

  const createInlineComment = () => ({
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    path: '',
    line: '',
    side: 'RIGHT' as const,
    body: '',
    startLine: '',
  })

  const addInlineComment = () => {
    setInlineComments((prev) => [...prev, createInlineComment()])
  }

  const updateInlineComment = (id: string, key: keyof InlineComment, value: string) => {
    setInlineComments((prev) => prev.map((comment) => (comment.id === id ? { ...comment, [key]: value } : comment)))
  }

  const submitReview = async () => {
    if (!pull) return
    setStatus(null)
    setError(null)
    const comments = inlineComments
      .map((comment) => ({
        path: comment.path.trim(),
        line: Number.parseInt(comment.line, 10),
        side: comment.side,
        body: comment.body.trim(),
        startLine: comment.startLine ? Number.parseInt(comment.startLine, 10) : undefined,
      }))
      .filter((comment) => comment.path && Number.isFinite(comment.line) && comment.body)
      .map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        startLine: Number.isFinite(comment.startLine) ? comment.startLine : undefined,
      }))

    const response = await submitGithubReview(owner, repo, pull.number, {
      event: reviewEvent,
      body: reviewBody.trim() || undefined,
      comments,
    })

    if (!response.ok) {
      setError(response.error)
      return
    }

    setReviewBody('')
    setInlineComments([])
    setStatus('Review submitted.')
    await loadAll()
  }

  const toggleThreadResolution = async (thread: GithubReviewThread) => {
    setStatus(null)
    setError(null)
    const response = await resolveGithubThread(owner, repo, prNumber, thread.threadKey, !thread.isResolved)
    if (!response.ok) {
      setError(response.error)
      return
    }
    setThreads((prev) =>
      prev.map((item) => (item.threadKey === thread.threadKey ? { ...item, isResolved: !item.isResolved } : item)),
    )
    setStatus(`Thread ${thread.isResolved ? 'reopened' : 'resolved'}.`)
  }

  const submitMerge = async () => {
    if (!pull) return
    setStatus(null)
    setError(null)
    const response = await mergeGithubPull(owner, repo, prNumber, {
      method: mergeMethod,
      commitTitle: mergeTitle.trim() || undefined,
      commitMessage: mergeMessage.trim() || undefined,
      deleteBranch,
    })
    if (!response.ok) {
      setError(response.error)
      return
    }
    setStatus('Merge submitted.')
    await loadAll()
  }

  const reviewBadge = review?.decision
    ? badgeClass(
        review.decision === 'approved' ? 'success' : review.decision === 'changes_requested' ? 'danger' : 'warning',
      )
    : badgeClass('neutral')

  const checkBadge = checks?.status
    ? badgeClass(checks.status === 'success' ? 'success' : checks.status === 'failure' ? 'danger' : 'warning')
    : badgeClass('neutral')

  if (!pull && error) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <div className="rounded-none border bg-card p-6 text-sm text-red-500">{error}</div>
      </main>
    )
  }

  return (
    <main className="mx-auto space-y-6 p-6 w-full max-w-6xl">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">GitHub</p>
            <h1 className="text-lg font-semibold">{pull?.title ?? 'Pull request'}</h1>
            <p className="text-xs text-muted-foreground">
              {owner}/{repo} · #{pull?.number ?? prNumber} · {pull?.headRef ?? 'unknown'} → {pull?.baseRef ?? 'unknown'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={badgeClass(pull?.merged ? 'success' : pull?.state === 'open' ? 'warning' : 'neutral')}>
              {pull?.merged ? 'merged' : (pull?.state ?? 'unknown')}
            </span>
            <span className={reviewBadge}>{review?.decision?.replace('_', ' ') ?? 'review pending'}</span>
            <span className={checkBadge}>{checks?.status ?? 'checks unknown'}</span>
            <span className={badgeClass(pull?.draft ? 'warning' : 'neutral')}>{pull?.draft ? 'draft' : 'ready'}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>Updated {formatDateTime(pull?.updatedAt ?? pull?.receivedAt ?? null)}</span>
          <span>Mergeable: {pull?.mergeableState ?? 'unknown'}</span>
          {pull?.htmlUrl ? (
            <a className="text-foreground underline" href={pull.htmlUrl} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          ) : null}
        </div>
      </header>

      {loading ? <div className="text-xs text-muted-foreground">Loading latest data…</div> : null}
      {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}
      {error ? <div className="text-xs text-red-500">{error}</div> : null}

      <section className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(['overview', 'files', 'conversation', 'checks'] as TabKey[]).map((tab) => (
              <Button
                key={tab}
                type="button"
                size="sm"
                variant={activeTab === tab ? 'default' : 'outline'}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </Button>
            ))}
          </div>

          {activeTab === 'overview' ? (
            <div className="space-y-4 rounded-none border bg-card p-4 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-muted-foreground">Author</div>
                  <div className="text-sm font-medium">{pull?.authorLogin ?? '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Labels</div>
                  <div className="text-sm font-medium">{pull?.labels?.length ? pull.labels.join(', ') : '—'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Checks</div>
                  <div className="text-sm font-medium">{checks?.status ?? 'unknown'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Review threads</div>
                  <div className="text-sm font-medium">{review?.unresolvedThreadsCount ?? 0} unresolved</div>
                </div>
              </div>
              <div className="text-muted-foreground">Description</div>
              <div className="whitespace-pre-wrap text-sm">{pull?.body ?? 'No description provided.'}</div>
            </div>
          ) : null}

          {activeTab === 'files' ? (
            <div className="space-y-3 rounded-none border bg-card p-4 text-xs">
              {files.length === 0 ? (
                <div className="text-muted-foreground">No file snapshots stored yet.</div>
              ) : (
                files.map((file) => (
                  <div key={file.path} className="space-y-2 border-b pb-3 last:border-b-0">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">{file.path}</div>
                      <div className="text-muted-foreground">
                        +{file.additions ?? 0} / -{file.deletions ?? 0}
                      </div>
                    </div>
                    {file.patch ? (
                      <pre className="overflow-x-auto bg-muted p-2 text-[11px] leading-relaxed">{file.patch}</pre>
                    ) : (
                      <div className="text-muted-foreground">No patch stored.</div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : null}

          {activeTab === 'conversation' ? (
            <div className="space-y-4 rounded-none border bg-card p-4 text-xs">
              <div className="space-y-2">
                <div className="text-sm font-medium">Issue comments</div>
                {issueComments.length === 0 ? (
                  <div className="text-muted-foreground">No issue comments.</div>
                ) : (
                  issueComments.map((comment) => (
                    <div key={comment.commentId} className="space-y-1 border-b pb-2 last:border-b-0">
                      <div className="text-[11px] text-muted-foreground">
                        {comment.authorLogin ?? 'unknown'} · {formatDateTime(comment.createdAt)}
                      </div>
                      <div className="whitespace-pre-wrap text-sm">{comment.body ?? '—'}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">Review threads</div>
                {threads.length === 0 ? (
                  <div className="text-muted-foreground">No review threads.</div>
                ) : (
                  threads.map((thread) => (
                    <div key={thread.threadKey} className="space-y-2 border-b pb-3 last:border-b-0">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">{thread.path ?? 'unknown'}</div>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => toggleThreadResolution(thread)}
                          disabled={!capabilities.reviewsWriteEnabled}
                        >
                          {thread.isResolved ? 'Reopen' : 'Resolve'}
                        </Button>
                      </div>
                      {thread.comments.map((comment) => (
                        <div key={comment.commentId} className="space-y-1 rounded-none border p-2">
                          <div className="text-[11px] text-muted-foreground">
                            {comment.authorLogin ?? 'unknown'} · {formatDateTime(comment.createdAt)}
                          </div>
                          <div className="whitespace-pre-wrap text-sm">{comment.body ?? '—'}</div>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {activeTab === 'checks' ? (
            <div className="space-y-3 rounded-none border bg-card p-4 text-xs">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Checks summary</div>
                <span className={checkBadge}>{checks?.status ?? 'unknown'}</span>
              </div>
              {checks?.runs.length ? (
                <div className="space-y-2">
                  {checks.runs.map((run) => (
                    <div key={run.id} className="flex items-center justify-between border-b pb-2 last:border-b-0">
                      <div>
                        <div className="text-sm font-medium">{run.name ?? 'Check'}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {run.status ?? 'unknown'} · {run.conclusion ?? 'pending'}
                        </div>
                      </div>
                      {run.url ? (
                        <a
                          className="text-[11px] text-foreground underline"
                          href={run.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Details
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No check runs stored.</div>
              )}
            </div>
          ) : null}
        </div>

        <aside className="space-y-4">
          <section className="rounded-none border bg-card p-4 text-xs space-y-3">
            <div className="text-sm font-medium">Review composer</div>
            <select
              className="h-9 w-full border bg-background px-2 text-xs"
              value={reviewEvent}
              onChange={(event) => setReviewEvent(event.target.value as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT')}
            >
              <option value="COMMENT">Comment</option>
              <option value="APPROVE">Approve</option>
              <option value="REQUEST_CHANGES">Request changes</option>
            </select>
            <textarea
              className="min-h-[120px] w-full border bg-background p-2 text-sm"
              placeholder="Summary"
              value={reviewBody}
              onChange={(event) => setReviewBody(event.target.value)}
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase text-muted-foreground">Inline comments</div>
                <Button type="button" size="xs" variant="outline" onClick={addInlineComment}>
                  Add
                </Button>
              </div>
              {inlineComments.length === 0 ? (
                <div className="text-muted-foreground">No inline comments.</div>
              ) : (
                inlineComments.map((comment) => (
                  <div key={comment.id} className="space-y-2 border p-2">
                    <Input
                      placeholder="path/to/file.ts"
                      value={comment.path}
                      onChange={(event) => updateInlineComment(comment.id, 'path', event.target.value)}
                    />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        placeholder="line"
                        value={comment.line}
                        onChange={(event) => updateInlineComment(comment.id, 'line', event.target.value)}
                        inputMode="numeric"
                      />
                      <select
                        className="h-9 w-full border bg-background px-2 text-xs"
                        value={comment.side}
                        onChange={(event) => updateInlineComment(comment.id, 'side', event.target.value)}
                      >
                        <option value="RIGHT">Right</option>
                        <option value="LEFT">Left</option>
                      </select>
                    </div>
                    <Input
                      placeholder="start line (optional)"
                      value={comment.startLine}
                      onChange={(event) => updateInlineComment(comment.id, 'startLine', event.target.value)}
                      inputMode="numeric"
                    />
                    <textarea
                      className="min-h-[80px] w-full border bg-background p-2 text-sm"
                      placeholder="Comment"
                      value={comment.body}
                      onChange={(event) => updateInlineComment(comment.id, 'body', event.target.value)}
                    />
                  </div>
                ))
              )}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={loading || !capabilities.reviewsWriteEnabled}
              onClick={() => void submitReview()}
            >
              Submit review
            </Button>
            {!capabilities.reviewsWriteEnabled ? (
              <div className="text-[11px] text-muted-foreground">Review writes are disabled.</div>
            ) : null}
          </section>

          <section className="rounded-none border bg-card p-4 text-xs space-y-3">
            <div className="text-sm font-medium">Merge controls</div>
            <div className="space-y-2 text-muted-foreground">
              <div>Mergeable: {pull?.mergeableState ?? 'unknown'}</div>
              <div>Checks: {checks?.status ?? 'unknown'}</div>
              <div>Review: {review?.decision ?? 'pending'}</div>
              <div>Unresolved threads: {review?.unresolvedThreadsCount ?? 0}</div>
            </div>
            <select
              className="h-9 w-full border bg-background px-2 text-xs"
              value={mergeMethod}
              onChange={(event) => setMergeMethod(event.target.value as 'merge' | 'squash' | 'rebase')}
            >
              <option value="merge">Merge</option>
              <option value="squash">Squash</option>
              <option value="rebase">Rebase</option>
            </select>
            <Input
              placeholder="Commit title (optional)"
              value={mergeTitle}
              onChange={(event) => setMergeTitle(event.target.value)}
            />
            <textarea
              className="min-h-[80px] w-full border bg-background p-2 text-sm"
              placeholder="Commit message (optional)"
              value={mergeMessage}
              onChange={(event) => setMergeMessage(event.target.value)}
            />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
              Delete branch after merge
            </label>
            <Button
              type="button"
              size="sm"
              disabled={loading || !capabilities.mergeWriteEnabled}
              onClick={() => void submitMerge()}
            >
              Merge pull request
            </Button>
            {!capabilities.mergeWriteEnabled ? (
              <div className="text-[11px] text-muted-foreground">Merge writes are disabled.</div>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  )
}

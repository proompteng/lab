import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { type FileTreeNode, FileTreeView } from '@/components/file-tree'
import type { CodexRunRecord } from '@/data/codex'
import {
  fetchGithubPullChecks,
  fetchGithubPullDeploymentEvidenceSummary,
  fetchGithubPullFiles,
  fetchGithubPullJudgeRuns,
  fetchGithubPullWriteActions,
  loadGithubPullDetailPageData,
  postGithubPullDeploymentEvidence,
  type GithubCheckState,
  type GithubCheckSummary,
  type GithubDeploymentEvidenceSummary,
  type GithubIssueComment,
  type GithubPullDetailPageData,
  type GithubPrFile,
  type GithubPullState,
  type GithubReviewSummary,
  type GithubReviewThread,
  type GithubWriteAudit,
  mergeGithubPull,
  refreshGithubPullFiles,
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

type TabKey = 'overview' | 'files' | 'conversation' | 'checks' | 'audits' | 'judge'

type InlineComment = {
  id: string
  path: string
  line: string
  side: 'LEFT' | 'RIGHT'
  body: string
  startLine: string
}

const buildFileTree = (files: GithubPrFile[]) => {
  const root: FileTreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    let current = root
    let currentPath = ''
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] ?? ''
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let node = current.children.find((child) => child.name === segment)
      if (!node) {
        node = { name: segment, path: currentPath, children: [] }
        current.children.push(node)
      }
      if (index === segments.length - 1) {
        node.file = file
      }
      current = node
    }
  }
  const sortTree = (node: FileTreeNode) => {
    node.children.sort((a, b) => {
      if (a.file && !b.file) return 1
      if (!a.file && b.file) return -1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach(sortTree)
  }
  sortTree(root)
  return root
}

const formatShortSha = (value: string | null | undefined) => (value ? value.slice(0, 7) : '—')

export const Route = createFileRoute('/github/pulls/$owner/$repo/$number')({
  loader: async ({
    params,
  }: {
    params: { owner: string; repo: string; number: string }
  }): Promise<GithubPullDetailPageData> => {
    const prNumber = Number.parseInt(params.number, 10)
    if (!Number.isFinite(prNumber)) {
      return { ok: false, error: 'Invalid pull request number' }
    }

    return loadGithubPullDetailPageData(params.owner, params.repo, prNumber)
  },
  component: GithubPullDetailPage,
})

function GithubPullDetailPage() {
  const initialData = Route.useLoaderData() as GithubPullDetailPageData
  const { owner, repo, number } = Route.useParams()
  const prNumber = Number.parseInt(number, 10)

  const [pull, setPull] = React.useState<GithubPullState | null>(() => (initialData.ok ? initialData.pull : null))
  const [review, setReview] = React.useState<GithubReviewSummary | null>(() =>
    initialData.ok ? initialData.review : null,
  )
  const [checks, setChecks] = React.useState<GithubCheckSummary | null>(() =>
    initialData.ok ? initialData.checks : null,
  )
  const [checksByCommit, setChecksByCommit] = React.useState<GithubCheckState[]>(() =>
    initialData.ok ? initialData.checksByCommit : [],
  )
  const [issueComments, setIssueComments] = React.useState<GithubIssueComment[]>(() =>
    initialData.ok ? initialData.issueComments : [],
  )
  const [threads, setThreads] = React.useState<GithubReviewThread[]>(() => (initialData.ok ? initialData.threads : []))
  const [files, setFiles] = React.useState<GithubPrFile[]>(() => (initialData.ok ? initialData.files : []))
  const [judgeRuns, setJudgeRuns] = React.useState<CodexRunRecord[]>(() =>
    initialData.ok ? initialData.judgeRuns : [],
  )
  const [writeActions, setWriteActions] = React.useState<GithubWriteAudit[]>(() =>
    initialData.ok ? initialData.writeActions : [],
  )
  const [deploymentEvidence, setDeploymentEvidence] = React.useState<GithubDeploymentEvidenceSummary>(() =>
    initialData.ok
      ? initialData.deploymentEvidence
      : {
          rollout: null,
          rollback: null,
        },
  )
  const [capabilities, setCapabilities] = React.useState(() =>
    initialData.ok ? initialData.capabilities : { reviewsWriteEnabled: false, mergeWriteEnabled: false },
  )

  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(() => (initialData.ok ? null : initialData.error))
  const [loading, setLoading] = React.useState(false)
  const [refreshingFiles, setRefreshingFiles] = React.useState(false)
  const [deploymentAction, setDeploymentAction] = React.useState<'rollout' | 'rollback'>('rollout')
  const [deploymentMissionId, setDeploymentMissionId] = React.useState('')
  const [deploymentStage, setDeploymentStage] = React.useState('')
  const [deploymentReference, setDeploymentReference] = React.useState('')
  const [deploymentStatus, setDeploymentStatus] = React.useState('')
  const [deploymentReason, setDeploymentReason] = React.useState('')

  const [activeTab, setActiveTab] = React.useState<TabKey>('overview')
  const [reviewBody, setReviewBody] = React.useState('')
  const [reviewEvent, setReviewEvent] = React.useState<'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'>('COMMENT')
  const [inlineComments, setInlineComments] = React.useState<InlineComment[]>([])
  const [mergeMethod, setMergeMethod] = React.useState<'merge' | 'squash' | 'rebase'>('squash')
  const [mergeTitle, setMergeTitle] = React.useState('')
  const [mergeMessage, setMergeMessage] = React.useState('')
  const [deleteBranch, setDeleteBranch] = React.useState(true)
  const [selectedFilePath, setSelectedFilePath] = React.useState<string | null>(null)
  const fileTree = React.useMemo(() => buildFileTree(files), [files])
  const autoRefreshRef = React.useRef(false)
  const autoRefreshKey = `${owner}/${repo}#${prNumber}`
  const lastAutoRefreshKeyRef = React.useRef(autoRefreshKey)

  React.useEffect(() => {
    if (!initialData.ok) {
      setPull(null)
      setReview(null)
      setChecks(null)
      setChecksByCommit([])
      setIssueComments([])
      setThreads([])
      setFiles([])
      setJudgeRuns([])
      setWriteActions([])
      setDeploymentEvidence({ rollout: null, rollback: null })
      setCapabilities({ reviewsWriteEnabled: false, mergeWriteEnabled: false })
      setError(initialData.error)
      return
    }

    setPull(initialData.pull)
    setReview(initialData.review)
    setChecks(initialData.checks)
    setChecksByCommit(initialData.checksByCommit)
    setIssueComments(initialData.issueComments)
    setThreads(initialData.threads)
    setFiles(initialData.files)
    setJudgeRuns(initialData.judgeRuns)
    setWriteActions(initialData.writeActions)
    setDeploymentEvidence(initialData.deploymentEvidence)
    setCapabilities(initialData.capabilities)
    setError(null)
  }, [initialData])

  const pollForFiles = React.useCallback(
    async (options: { attempts?: number; delayMs?: number } = {}) => {
      if (!Number.isFinite(prNumber)) return 0
      const attempts = options.attempts ?? 12
      const delayMs = options.delayMs ?? 2000
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const filesRes = await fetchGithubPullFiles(owner, repo, prNumber)
        if (filesRes.ok && filesRes.files.length > 0) {
          setFiles(filesRes.files)
          return filesRes.files.length
        }
        if (filesRes.ok && !filesRes.refreshing && attempt > 1) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return 0
    },
    [owner, repo, prNumber],
  )

  const loadWriteActions = React.useCallback(async () => {
    if (!Number.isFinite(prNumber)) return
    const auditsRes = await fetchGithubPullWriteActions(owner, repo, prNumber)
    if (auditsRes.ok) {
      setWriteActions(auditsRes.audits)
    }
  }, [owner, repo, prNumber])

  const loadAll = React.useCallback(async () => {
    if (!Number.isFinite(prNumber)) {
      setError('Invalid pull request number')
      return
    }
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const data = await loadGithubPullDetailPageData(owner, repo, prNumber)
      if (!data.ok) {
        setError(data.error)
        return
      }

      setPull(data.pull)
      setReview(data.review)
      setChecks(data.checks)
      setIssueComments(data.issueComments)
      setCapabilities(data.capabilities)
      setThreads(data.threads)
      setChecksByCommit(data.checksByCommit)
      setJudgeRuns(data.judgeRuns)
      setWriteActions(data.writeActions)
      setDeploymentEvidence(data.deploymentEvidence)
      setFiles(data.files)
      if (data.files.length === 0) {
        void pollForFiles({ attempts: 12 })
      }

      setStatus('Loaded pull request details.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [owner, pollForFiles, prNumber, repo])

  const submitDeploymentEvidence = async () => {
    if (!pull) return
    if (deploymentAction === 'rollout' && !deploymentReference.trim()) {
      setError('Rollout requires a deployment reference')
      return
    }
    if (deploymentAction === 'rollback' && !deploymentReason.trim()) {
      setError('Rollback requires a reason')
      return
    }
    setStatus(null)
    setError(null)

    const response = await postGithubPullDeploymentEvidence(owner, repo, prNumber, {
      action: deploymentAction,
      missionId: deploymentMissionId.trim() || undefined,
      stage: deploymentStage.trim() || undefined,
      reference: deploymentReference.trim() || undefined,
      status: deploymentStatus.trim() || undefined,
      reason: deploymentReason.trim() || undefined,
    })

    if (!response.ok) {
      setError(response.error)
      return
    }

    setDeploymentReference('')
    setDeploymentStatus('')
    setDeploymentReason('')
    setStatus('Deployment evidence submitted.')
    await loadWriteActions()
    const deploymentEvidenceRes = await fetchGithubPullDeploymentEvidenceSummary(owner, repo, prNumber)
    if (deploymentEvidenceRes.ok) {
      setDeploymentEvidence(deploymentEvidenceRes.deployment)
    }
  }

  React.useEffect(() => {
    if (lastAutoRefreshKeyRef.current === autoRefreshKey) return
    lastAutoRefreshKeyRef.current = autoRefreshKey
    autoRefreshRef.current = false
  }, [autoRefreshKey])

  React.useEffect(() => {
    if (files.length === 0) {
      setSelectedFilePath(null)
      return
    }
    const stillExists = files.some((file) => file.path === selectedFilePath)
    if (!stillExists) {
      setSelectedFilePath(files[0]?.path ?? null)
    }
  }, [files, selectedFilePath])

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

  const refreshFiles = React.useCallback(
    async (options: { auto?: boolean } = {}) => {
      if (!Number.isFinite(prNumber)) return
      setRefreshingFiles(true)
      setStatus(null)
      setError(null)
      const response = await refreshGithubPullFiles(owner, repo, prNumber)
      if (!response.ok) {
        setError(response.error)
        setRefreshingFiles(false)
        return
      }
      if (options.auto) {
        const refreshedCount = await pollForFiles({ attempts: 12 })
        if (refreshedCount > 0) {
          setStatus(`Refreshed worktree snapshot (${refreshedCount} files).`)
        } else {
          setStatus('Queued worktree snapshot refresh.')
        }
      } else {
        await loadAll()
        setStatus(`Refreshed worktree snapshot (${response.fileCount} files).`)
      }
      setRefreshingFiles(false)
    },
    [loadAll, owner, pollForFiles, prNumber, repo],
  )

  React.useEffect(() => {
    if (loading || files.length > 0 || autoRefreshRef.current) return
    autoRefreshRef.current = true
    void refreshFiles({ auto: true })
  }, [files.length, loading, refreshFiles])

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
      <main className="p-6 w-full max-w-6xl">
        <div className="rounded-none border bg-card p-6 text-sm text-red-500">{error}</div>
      </main>
    )
  }

  return (
    <main className="space-y-6 p-6 w-full max-w-6xl">
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
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className="space-y-4">
          <TabsList variant="line" className="w-full justify-start">
            {(
              [
                { key: 'overview', label: 'Overview' },
                { key: 'files', label: 'Files' },
                { key: 'conversation', label: 'Conversation' },
                { key: 'checks', label: 'Checks' },
                { key: 'audits', label: 'Write actions' },
                { key: 'judge', label: 'Judge' },
              ] as Array<{ key: TabKey; label: string }>
            ).map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key} className="flex-none justify-start">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview">
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
          </TabsContent>

          <TabsContent value="files">
            <div className="space-y-3 rounded-none border bg-card p-4 text-xs">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Worktree snapshot</div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{files.length} files</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void refreshFiles()}
                    disabled={refreshingFiles}
                  >
                    {refreshingFiles ? 'Refreshing…' : 'Refresh'}
                  </Button>
                </div>
              </div>
              {files.length === 0 ? (
                <div className="text-muted-foreground">No file snapshots stored yet.</div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-[240px_1fr]">
                  <div className="space-y-1 border-r pr-2">
                    <FileTreeView
                      nodes={fileTree.children}
                      selectedPath={selectedFilePath}
                      onSelect={(path) => setSelectedFilePath(path)}
                    />
                  </div>
                  <div className="space-y-3">
                    {files
                      .filter((file) => file.path === selectedFilePath)
                      .map((file) => (
                        <div key={file.path} className="space-y-2">
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
                      ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="conversation">
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
          </TabsContent>

          <TabsContent value="checks">
            <div className="space-y-3 rounded-none border bg-card p-4 text-xs">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Checks summary</div>
                <span className={checkBadge}>{checks?.status ?? 'unknown'}</span>
              </div>
              {checksByCommit.length ? (
                <div className="space-y-2">
                  {checksByCommit.map((commit) => (
                    <div key={commit.commitSha} className="space-y-2 border-b pb-3 last:border-b-0">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium">Commit {formatShortSha(commit.commitSha)}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {commit.status ?? 'unknown'} · {commit.totalCount} checks
                          </div>
                        </div>
                        {commit.detailsUrl ? (
                          <a
                            className="text-[11px] text-foreground underline"
                            href={commit.detailsUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Details
                          </a>
                        ) : null}
                      </div>
                      {commit.runs.length ? (
                        <div className="space-y-2">
                          {commit.runs.map((run) => (
                            <div
                              key={run.id}
                              className="flex items-center justify-between border-b pb-2 last:border-b-0"
                            >
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
                        <div className="text-muted-foreground">No check runs stored for this commit.</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No checks stored yet.</div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="audits">
            <div className="space-y-3 rounded-none border bg-card p-4 text-xs">
              <div className="space-y-2 rounded-none border p-3">
                <div className="text-sm font-medium">Latest deployment evidence</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1 border-r pr-2">
                    <div className="text-muted-foreground">Rollout</div>
                    {deploymentEvidence.rollout ? (
                      <>
                        <div>{formatDateTime(deploymentEvidence.rollout.receivedAt)}</div>
                        <div>
                          Ref: {deploymentEvidence.rollout.rolloutRef ?? '—'} · Stage:{' '}
                          {deploymentEvidence.rollout.stage ?? '—'}
                        </div>
                        <div>Mission: {deploymentEvidence.rollout.missionId ?? '—'}</div>
                        <div>Status: {deploymentEvidence.rollout.rolloutStatus ?? '—'}</div>
                        <div>Result: {deploymentEvidence.rollout.success ? 'passed' : 'failed'}</div>
                      </>
                    ) : (
                      <div className="text-muted-foreground">No rollout evidence recorded.</div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground">Rollback</div>
                    {deploymentEvidence.rollback ? (
                      <>
                        <div>{formatDateTime(deploymentEvidence.rollback.receivedAt)}</div>
                        <div>
                          Ref: {deploymentEvidence.rollback.rollbackRef ?? '—'} · Stage:{' '}
                          {deploymentEvidence.rollback.stage ?? '—'}
                        </div>
                        <div>Mission: {deploymentEvidence.rollback.missionId ?? '—'}</div>
                        <div>Reason: {deploymentEvidence.rollback.rollbackReason ?? '—'}</div>
                        <div>Result: {deploymentEvidence.rollback.success ? 'passed' : 'failed'}</div>
                      </>
                    ) : (
                      <div className="text-muted-foreground">No rollback evidence recorded.</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-sm font-medium">Write action audit trail</div>
              {writeActions.length === 0 ? (
                <div className="text-muted-foreground">No write actions recorded yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full table-fixed border-separate border-spacing-0 text-left">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5">Time</th>
                        <th className="px-2 py-1.5">Action</th>
                        <th className="px-2 py-1.5">Actor</th>
                        <th className="px-2 py-1.5">Mission</th>
                        <th className="px-2 py-1.5">Stage</th>
                        <th className="px-2 py-1.5">Class</th>
                        <th className="px-2 py-1.5">Risk</th>
                        <th className="px-2 py-1.5">Rollout</th>
                        <th className="px-2 py-1.5">Rollback</th>
                        <th className="px-2 py-1.5">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {writeActions.map((audit) => (
                        <tr key={`${audit.receivedAt}-${audit.action}-${audit.actor ?? ''}`}>
                          <td className="border-t px-2 py-1.5 text-xs">{formatDateTime(audit.receivedAt)}</td>
                          <td className="border-t px-2 py-1.5 text-xs">{audit.action}</td>
                          <td className="border-t px-2 py-1.5 text-xs">{audit.actor ?? '—'}</td>
                          <td className="border-t px-2 py-1.5 text-xs">{audit.missionId ?? '—'}</td>
                          <td className="border-t px-2 py-1.5 text-xs">{audit.stage ?? '—'}</td>
                          <td className="border-t px-2 py-1.5 text-xs">{audit.actionClass ?? '—'}</td>
                          <td className="border-t px-2 py-1.5 text-xs">{audit.riskClass ?? '—'}</td>
                          <td className="border-t px-2 py-1.5 text-xs">
                            {audit.rolloutRef ?? audit.rolloutStatus ?? '—'}
                          </td>
                          <td className="border-t px-2 py-1.5 text-xs">
                            {audit.rollbackRef ?? audit.rollbackReason ?? '—'}
                          </td>
                          <td className="border-t px-2 py-1.5 text-xs">
                            {audit.success ? 'success' : 'failed'}
                            {audit.error ? <div className="text-red-500">{audit.error}</div> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="judge">
            <div className="space-y-3 rounded-none border bg-card p-4 text-xs">
              <div className="text-sm font-medium">Judge runs</div>
              {judgeRuns.length === 0 ? (
                <div className="text-muted-foreground">No judge runs recorded yet.</div>
              ) : (
                <div className="space-y-2">
                  {judgeRuns.map((run) => (
                    <div key={run.id} className="space-y-1 border-b pb-2 last:border-b-0">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">
                          Attempt {run.attempt} · {run.status}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{formatDateTime(run.createdAt)}</div>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Commit {formatShortSha(run.commitSha)} · CI {run.ciStatus ?? 'unknown'} · Review{' '}
                        {run.reviewStatus ?? 'unknown'}
                      </div>
                      {run.prUrl ? (
                        <a
                          className="text-[11px] text-foreground underline"
                          href={run.prUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open PR
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

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

          <section className="rounded-none border bg-card p-4 text-xs space-y-3">
            <div className="text-sm font-medium">Rollout / rollback evidence</div>
            <select
              className="h-9 w-full border bg-background px-2 text-xs"
              value={deploymentAction}
              onChange={(event) => setDeploymentAction(event.target.value as 'rollout' | 'rollback')}
            >
              <option value="rollout">Rollout</option>
              <option value="rollback">Rollback</option>
            </select>
            <Input
              placeholder="Mission ID (optional)"
              value={deploymentMissionId}
              onChange={(event) => setDeploymentMissionId(event.target.value)}
            />
            <Input
              placeholder="Stage (optional)"
              value={deploymentStage}
              onChange={(event) => setDeploymentStage(event.target.value)}
            />
            <Input
              placeholder={deploymentAction === 'rollout' ? 'Deployment reference' : 'Rollback reference'}
              value={deploymentReference}
              onChange={(event) => setDeploymentReference(event.target.value)}
            />
            <Input
              placeholder={deploymentAction === 'rollout' ? 'Rollout status (optional)' : 'Rollback status (optional)'}
              value={deploymentStatus}
              onChange={(event) => setDeploymentStatus(event.target.value)}
            />
            <Input
              placeholder={deploymentAction === 'rollback' ? 'Rollback reason' : 'Note (optional)'}
              value={deploymentReason}
              onChange={(event) => setDeploymentReason(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={loading || !capabilities.mergeWriteEnabled}
              onClick={() => void submitDeploymentEvidence()}
            >
              Record deployment evidence
            </Button>
            {!capabilities.mergeWriteEnabled ? (
              <div className="text-[11px] text-muted-foreground">Deployment evidence writes are disabled.</div>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  )
}

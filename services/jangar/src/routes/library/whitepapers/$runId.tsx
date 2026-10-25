import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  Textarea,
} from '@proompteng/design/ui'
import { IconExternalLink } from '@tabler/icons-react'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import ReactMarkdown from 'react-markdown'

import {
  approveWhitepaperImplementation,
  getWhitepaperDetail,
  type WhitepaperDetail,
  whitepaperPdfPath,
} from '@/data/whitepapers'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/library/whitepapers/$runId')({
  component: LibraryWhitepaperDetailRoute,
})

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

const formatConfidence = (value: number | null) => {
  if (value === null || Number.isNaN(value)) return 'n/a'
  return value.toFixed(3)
}

const toLines = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry : null))
      .filter((entry): entry is string => Boolean(entry))
  }
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function LibraryWhitepaperDetailRoute() {
  const { runId } = Route.useParams()
  const [detail, setDetail] = React.useState<WhitepaperDetail | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadDetail = React.useCallback(async () => {
    setLoading(true)
    setError(null)

    const result = await getWhitepaperDetail(runId)
    if (!result.ok) {
      setDetail(null)
      setError(result.message)
      setLoading(false)
      return
    }

    setDetail(result.item)
    setLoading(false)
  }, [runId])

  React.useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const title = detail?.document.title ?? runId

  return (
    <div className="flex h-full min-h-0 w-full flex-col p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
          <p className="font-mono text-[0.72rem] text-muted-foreground [overflow-wrap:anywhere]">{runId}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" asChild>
            <Link to="/library/whitepapers">Back to list</Link>
          </Button>
          {detail?.run.status ? (
            <Badge
              variant="outline"
              className={cn('font-mono text-[0.65rem] px-2 py-0.5', statusTone(detail.run.status))}
            >
              {detail.run.status}
            </Badge>
          ) : null}
          {detail?.verdict?.verdict ? (
            <Badge
              variant="outline"
              className={cn('font-mono text-[0.65rem] px-2 py-0.5', verdictTone(detail.verdict.verdict))}
            >
              {detail.verdict.verdict}
            </Badge>
          ) : null}
        </div>
      </div>

      {loading ? (
        <Card className="shrink-0">
          <CardHeader>
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </CardContent>
        </Card>
      ) : null}

      {error ? (
        <Card className="shrink-0 border-rose-500/40 bg-rose-500/10">
          <CardHeader>
            <CardTitle className="text-sm text-rose-200">Failed to load whitepaper details</CardTitle>
            <CardDescription className="[overflow-wrap:anywhere] text-rose-100/90">{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void loadDetail()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {detail ? (
        <>
          <div className="hidden min-h-0 flex-1 overflow-hidden rounded-lg border md:block">
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-h-0 border-r">
                <PdfPane runId={runId} detail={detail} />
              </div>
              <AnalysisPane detail={detail} runId={runId} onRefresh={loadDetail} scrollable />
            </div>
          </div>

          <div className="space-y-4 md:hidden">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Whitepaper PDF</CardTitle>
                <CardDescription>{detail.version.fileName ?? 'source.pdf'}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[52vh] overflow-hidden rounded-md border">
                  <iframe
                    src={whitepaperPdfPath(runId)}
                    title={`whitepaper-${runId}`}
                    className="h-full w-full border-0"
                  />
                </div>
              </CardContent>
            </Card>
            <AnalysisPane detail={detail} runId={runId} onRefresh={loadDetail} />
          </div>
        </>
      ) : null}
    </div>
  )
}

function PdfPane({ runId, detail }: { runId: string; detail: WhitepaperDetail }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">Whitepaper PDF</div>
          <div className="truncate font-mono text-[0.7rem] text-muted-foreground">
            {detail.version.fileName ?? 'source.pdf'}
          </div>
        </div>
        {detail.pdf.sourceAttachmentUrl ? (
          <Button variant="secondary" size="sm" asChild>
            <a href={detail.pdf.sourceAttachmentUrl} target="_blank" rel="noreferrer">
              Source
              <IconExternalLink className="ml-1 h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
      </div>
      <div className="flex-1 bg-muted/30">
        <iframe src={whitepaperPdfPath(runId)} title={`whitepaper-${runId}`} className="h-full w-full border-0" />
      </div>
    </div>
  )
}

function AnalysisPane({
  detail,
  runId,
  onRefresh,
  scrollable = false,
}: {
  detail: WhitepaperDetail
  runId: string
  onRefresh: () => Promise<void>
  scrollable?: boolean
}) {
  const keyFindings = detail.synthesis?.keyFindings ?? []
  const recommendations = detail.verdict?.recommendations ?? []
  const [approvedBy, setApprovedBy] = React.useState(detail.engineeringTrigger?.approvedBy ?? '')
  const [approvalReason, setApprovalReason] = React.useState('')
  const [approvalPending, setApprovalPending] = React.useState(false)
  const [approvalError, setApprovalError] = React.useState<string | null>(null)
  const [approvalMessage, setApprovalMessage] = React.useState<string | null>(null)
  const trigger = detail.engineeringTrigger
  const belowThreshold = trigger
    ? !['engineering_candidate', 'engineering_priority'].includes(trigger.implementationGrade)
    : true
  const allowManualApproval = detail.run.status === 'completed' && belowThreshold && trigger?.decision !== 'dispatched'

  const submitManualApproval = async () => {
    const approver = approvedBy.trim()
    const reason = approvalReason.trim()
    if (!approver || !reason) {
      setApprovalError('Approver identity and rationale are required.')
      return
    }
    setApprovalPending(true)
    setApprovalError(null)
    setApprovalMessage(null)
    const result = await approveWhitepaperImplementation(runId, {
      approvedBy: approver,
      approvalReason: reason,
    })
    setApprovalPending(false)
    if (!result.ok) {
      setApprovalError(result.message)
      return
    }
    setApprovalReason('')
    setApprovalMessage('Manual approval recorded. Engineering dispatch was requested.')
    await onRefresh()
  }

  return (
    <div className={cn(scrollable && 'h-full min-h-0 overflow-y-auto')}>
      <div className="space-y-4 p-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Run summary</CardTitle>
            <CardDescription>{detail.document.sourceIdentifier ?? 'No source identifier'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs md:grid-cols-2">
            <Row label="Created" value={formatDate(detail.run.createdAt)} />
            <Row label="Completed" value={formatDate(detail.run.completedAt)} />
            <Row label="Trigger" value={detail.run.triggerSource} />
            <Row label="Parse status" value={detail.version.parseStatus ?? 'n/a'} />
            <Row label="AgentRun" value={detail.latestAgentrun?.status ?? 'n/a'} />
            <Row label="Verdict confidence" value={formatConfidence(detail.verdict?.confidence ?? null)} />
            <Row label="Failure reason" value={detail.run.failureReason ?? 'n/a'} className="md:col-span-2" />
          </CardContent>
        </Card>

        {detail.run.status === 'failed' ? (
          <Card className="border-amber-500/40 bg-amber-500/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-amber-200">Requeue support</CardTitle>
              <CardDescription className="[overflow-wrap:anywhere] text-amber-100/90">
                Comment <code>research whitepaper</code> on the source GitHub issue to requeue this run.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Executive summary</CardTitle>
            <CardDescription>
              {detail.synthesis?.methodologySummary ?? 'No methodology summary available.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6 text-foreground">
            <p>{detail.synthesis?.executiveSummary ?? 'No synthesis generated yet.'}</p>
            {keyFindings.length ? (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Key findings
                </div>
                <ul className="list-disc space-y-1 pl-5">
                  {keyFindings.map((finding, index) => (
                    <li key={`${String(index)}-${finding.slice(0, 18)}`}>{finding}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Implementation plan</CardTitle>
            <CardDescription>Rendered from whitepaper synthesis output.</CardDescription>
          </CardHeader>
          <CardContent className="prose prose-zinc max-w-none text-sm">
            {detail.synthesis?.implementationPlanMd ? (
              <ReactMarkdown>{detail.synthesis.implementationPlanMd}</ReactMarkdown>
            ) : (
              <p>No implementation plan markdown available.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Verdict</CardTitle>
            <CardDescription>{detail.verdict?.decisionPolicy ?? 'No verdict policy'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Verdict" value={detail.verdict?.verdict ?? 'n/a'} />
            <Row label="Score" value={formatConfidence(detail.verdict?.score ?? null)} />
            <Row label="Confidence" value={formatConfidence(detail.verdict?.confidence ?? null)} />
            <Row label="Requires follow-up" value={detail.verdict?.requiresFollowup ? 'yes' : 'no'} />
            <Row label="Rationale" value={detail.verdict?.rationale ?? 'n/a'} className="pt-1" />
            {recommendations.length ? (
              <div className="pt-1">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Recommendations
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {recommendations.map((recommendation, index) => (
                    <li key={`${String(index)}-${recommendation.slice(0, 18)}`}>{recommendation}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Engineering trigger</CardTitle>
            <CardDescription>Persisted two-speed feeder decision and approval audit contract.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Implementation grade" value={trigger?.implementationGrade ?? 'n/a'} />
            <Row label="Decision" value={trigger?.decision ?? 'n/a'} />
            <Row label="Rollout profile" value={trigger?.rolloutProfile ?? 'n/a'} />
            <Row label="Approval source" value={trigger?.approvalSource ?? 'n/a'} />
            <Row label="Approved by" value={trigger?.approvedBy ?? 'n/a'} />
            <Row label="Approved at" value={formatDate(trigger?.approvedAt ?? null)} />
            <Row
              label="Dispatch AgentRun"
              value={trigger?.dispatchedAgentrunName ?? detail.latestAgentrun?.name ?? 'n/a'}
            />
            <Row label="Approval reason" value={trigger?.approvalReason ?? 'n/a'} />
            <Row label="Reason codes" value={(trigger?.reasonCodes ?? []).join(', ') || 'n/a'} className="pt-1" />
          </CardContent>
        </Card>

        {allowManualApproval ? (
          <Card className="border-amber-500/40 bg-amber-500/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-amber-200">Manual implementation override</CardTitle>
              <CardDescription className="[overflow-wrap:anywhere] text-amber-100/90">
                This run is below auto-dispatch thresholds. Approving here writes an auditable
                <code className="mx-1">approval_source=jangar_ui</code>
                override and dispatches B1 engineering work.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-amber-100/90" htmlFor="approved-by">
                  Approver
                </label>
                <Input
                  id="approved-by"
                  value={approvedBy}
                  onChange={(event) => setApprovedBy(event.target.value)}
                  placeholder="name@company.com"
                />
              </div>
              <div className="space-y-1">
                <label
                  className="text-xs font-medium uppercase tracking-wide text-amber-100/90"
                  htmlFor="approval-reason"
                >
                  Rationale
                </label>
                <Textarea
                  id="approval-reason"
                  value={approvalReason}
                  onChange={(event) => setApprovalReason(event.target.value)}
                  placeholder="Why this run should still enter B1 engineering despite thresholds."
                  rows={4}
                />
              </div>
              {approvalError ? <p className="text-xs text-rose-200">{approvalError}</p> : null}
              {approvalMessage ? <p className="text-xs text-emerald-200">{approvalMessage}</p> : null}
              <Button onClick={() => void submitManualApproval()} disabled={approvalPending}>
                {approvalPending ? 'Submitting approval...' : 'Approve for implementation'}
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {detail.rolloutTransitions.length ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Automatic rollout transitions</CardTitle>
              <CardDescription>Deterministic stage progression and rollback/halt audit trail.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {detail.rolloutTransitions.map((transition) => (
                <div key={transition.id} className="rounded-md border p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {(transition.fromStage ?? 'start') + ' -> ' + (transition.toStage ?? 'hold')}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn('font-mono text-[0.65rem] px-2 py-0.5', statusTone(transition.status))}
                    >
                      {transition.transitionType}:{transition.status}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-muted-foreground">
                    <div>Blocking gate: {transition.blockingGate ?? 'n/a'}</div>
                    <div>Reason codes: {transition.reasonCodes.join(', ') || 'n/a'}</div>
                    <div>Created: {formatDate(transition.createdAt)}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Design pull requests</CardTitle>
            <CardDescription>Generated design artifacts from AgentRun output.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {detail.designPullRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground">No design pull requests captured yet.</p>
            ) : (
              detail.designPullRequests.map((pr) => (
                <div key={pr.id} className="rounded-md border p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="font-medium">Attempt {pr.attempt ?? 0}</div>
                    <Badge variant="outline" className="font-mono text-[0.65rem] px-2 py-0.5">
                      {pr.status}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-muted-foreground">
                    <div>{pr.repository ?? 'n/a'}</div>
                    <div>
                      {pr.baseBranch ?? 'n/a'} → {pr.headBranch ?? 'n/a'}
                    </div>
                    {pr.prUrl ? (
                      <a
                        className="inline-flex items-center text-primary underline-offset-4 hover:underline"
                        href={pr.prUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PR #{pr.prNumber ?? 'n/a'}
                        <IconExternalLink className="ml-1 h-3.5 w-3.5" />
                      </a>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Workflow timeline</CardTitle>
            <CardDescription>Step-level audit trail for this run.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {detail.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No steps recorded.</p>
            ) : (
              detail.steps.map((step) => {
                const errorLines = toLines(step.error)
                return (
                  <div key={step.id} className="rounded-md border p-2 text-xs">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="font-medium">
                        {step.stepName} (attempt {step.attempt ?? 1})
                      </div>
                      <Badge
                        variant="outline"
                        className={cn('font-mono text-[0.65rem] px-2 py-0.5', statusTone(step.status))}
                      >
                        {step.status}
                      </Badge>
                    </div>
                    <div className="space-y-1 text-muted-foreground">
                      <div>Started: {formatDate(step.startedAt)}</div>
                      <div>Completed: {formatDate(step.completedAt)}</div>
                      <div>Duration: {step.durationMs ? `${step.durationMs} ms` : 'n/a'}</div>
                      {errorLines.length ? (
                        <div className="[overflow-wrap:anywhere] text-rose-300">
                          {errorLines.slice(0, 2).map((line, index) => (
                            <div key={`${step.id}-err-${String(index)}`}>{line}</div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn('text-xs text-muted-foreground [overflow-wrap:anywhere]', className)}>
      <span className="mr-1 font-medium text-foreground">{label}:</span>
      <span className="break-words">{value}</span>
    </div>
  )
}

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ScrollArea,
  Skeleton,
} from '@proompteng/design/ui'
import { IconExternalLink } from '@tabler/icons-react'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import ReactMarkdown from 'react-markdown'

import { getWhitepaperDetail, type WhitepaperDetail, whitepaperPdfPath } from '@/data/whitepapers'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/library/whitepapers/$runId')({
  component: LibraryWhitepaperDetailRoute,
})

const statusTone = (status: string) => {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-950 border-emerald-200'
  if (status === 'failed') return 'bg-rose-100 text-rose-950 border-rose-200'
  if (status === 'agentrun_dispatched') return 'bg-blue-100 text-blue-950 border-blue-200'
  if (status === 'queued') return 'bg-amber-100 text-amber-950 border-amber-200'
  return 'bg-zinc-100 text-zinc-950 border-zinc-200'
}

const verdictTone = (verdict: string) => {
  if (verdict === 'implement') return 'bg-emerald-100 text-emerald-950 border-emerald-200'
  if (verdict === 'reject') return 'bg-rose-100 text-rose-950 border-rose-200'
  return 'bg-zinc-100 text-zinc-950 border-zinc-200'
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
    <div className="h-full w-full overflow-auto">
      <div className="mx-auto w-full max-w-[1440px] p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <p className="font-mono text-[0.72rem] text-muted-foreground">{runId}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
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
          <Card>
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
          <Card className="border-rose-300 bg-rose-50">
            <CardHeader>
              <CardTitle className="text-sm text-rose-950">Failed to load whitepaper details</CardTitle>
              <CardDescription className="text-rose-900">{error}</CardDescription>
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
            <div className="hidden h-[72vh] min-h-[680px] overflow-hidden rounded-lg border md:block">
              <div className="grid h-full grid-cols-2">
                <div className="border-r">
                  <PdfPane runId={runId} detail={detail} />
                </div>
                <AnalysisPane detail={detail} />
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
              <AnalysisPane detail={detail} />
            </div>
          </>
        ) : null}
      </div>
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
          <Button variant="outline" size="sm" asChild>
            <a href={detail.pdf.sourceAttachmentUrl} target="_blank" rel="noreferrer">
              Source
              <IconExternalLink className="ml-1 h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
      </div>
      <div className="flex-1 bg-zinc-100">
        <iframe src={whitepaperPdfPath(runId)} title={`whitepaper-${runId}`} className="h-full w-full border-0" />
      </div>
    </div>
  )
}

function AnalysisPane({ detail }: { detail: WhitepaperDetail }) {
  const keyFindings = detail.synthesis?.keyFindings ?? []
  const recommendations = detail.verdict?.recommendations ?? []

  return (
    <ScrollArea className="h-full">
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
          <Card className="border-amber-300 bg-amber-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-amber-950">Requeue support</CardTitle>
              <CardDescription className="text-amber-900">
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
          <CardContent className="space-y-3 text-sm leading-6 text-zinc-900">
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
                        <div className="text-rose-700">
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
    </ScrollArea>
  )
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn('text-xs text-muted-foreground', className)}>
      <span className="mr-1 font-medium text-foreground">{label}:</span>
      <span>{value}</span>
    </div>
  )
}

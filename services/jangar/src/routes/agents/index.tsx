import { Button, Input } from '@proompteng/design/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import { AgentStreamStatusBadge, buildRunSummaries, useAgentEventStream } from '@/components/agent-comms'

export const Route = createFileRoute('/agents/')({
  component: AgentsIndexPage,
})

const formatTimestamp = (value: string | null) => {
  if (!value) return 'Unknown time'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

function AgentsIndexPage() {
  const navigate = Route.useNavigate()
  const [runId, setRunId] = React.useState('')
  const [lookupError, setLookupError] = React.useState<string | null>(null)

  const { messages, status, error, lastEventAt } = useAgentEventStream({ channel: 'general', maxMessages: 240 })
  const summaries = React.useMemo(() => buildRunSummaries(messages), [messages])

  const submitLookup = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = runId.trim()
    if (!trimmed) {
      setLookupError('Enter a run id to open the timeline.')
      return
    }
    setLookupError(null)
    void navigate({ to: '/agents/$runId', params: { runId: trimmed } })
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">Agent communications</h1>
          <p className="text-xs text-muted-foreground">Monitor live agent chatter and open run timelines.</p>
        </div>
        <AgentStreamStatusBadge status={status} lastEventAt={lastEventAt} />
      </header>

      {error ? (
        <div className="p-3 rounded-none border border-destructive/40 bg-destructive/10 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 p-4 rounded-none border border-border bg-card">
          <h2 className="text-sm font-semibold text-foreground">General channel</h2>
          <p className="text-xs text-muted-foreground">
            Global cross-workflow feed. Use this when you want the shared agent communications channel.
          </p>
          <Button variant="outline" render={<Link to="/agents/general" />}>
            Open /agents/general
          </Button>
        </div>

        <div className="space-y-3 p-4 rounded-none border border-border bg-card">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Jump to a run</h2>
            <p className="text-xs text-muted-foreground">Enter a run id to open the per-run timeline.</p>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={submitLookup}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-foreground" htmlFor="agents-run-id">
                Run id
              </label>
              <Input
                id="agents-run-id"
                name="runId"
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
                placeholder="Run id"
                autoComplete="off"
              />
            </div>
            <Button type="submit">Open run</Button>
          </form>
          {lookupError ? (
            <div className="text-xs text-destructive" role="alert">
              {lookupError}
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Active runs</h2>
          <span className="text-xs text-muted-foreground">{summaries.runs.length} runs</span>
        </div>
        {summaries.runs.length === 0 ? (
          <div className="p-6 rounded-none border border-border bg-card text-xs text-muted-foreground">
            No active runs yet. Wait for the general channel to receive messages.
          </div>
        ) : (
          <ul className="overflow-hidden rounded-none border border-border bg-card">
            {summaries.runs.map((summary) => (
              <li key={summary.runId ?? summary.workflowUid} className="border-b border-border last:border-b-0">
                {summary.runId ? (
                  <Link
                    to="/agents/$runId"
                    params={{ runId: summary.runId }}
                    className="flex flex-col gap-2 p-4 transition hover:bg-muted/20"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-foreground">Run {summary.runId}</div>
                        <div className="text-xs text-muted-foreground">
                          {summary.workflowName ?? 'Unknown workflow'}
                          {summary.workflowNamespace ? ` (${summary.workflowNamespace})` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">{formatTimestamp(summary.lastMessageAt)}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">{summary.preview}</div>
                  </Link>
                ) : (
                  <div className="flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-foreground">Workflow {summary.workflowUid}</div>
                        <div className="text-xs text-muted-foreground">
                          {summary.workflowName ?? 'Unknown workflow'}
                          {summary.workflowNamespace ? ` (${summary.workflowNamespace})` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">{formatTimestamp(summary.lastMessageAt)}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">{summary.preview}</div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {summaries.workflows.length > 0 ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Workflows without run ids</h2>
            <span className="text-xs text-muted-foreground">{summaries.workflows.length} workflows</span>
          </div>
          <ul className="overflow-hidden rounded-none border border-border bg-card">
            {summaries.workflows.map((summary) => (
              <li key={summary.workflowUid} className="flex flex-col gap-2 p-4 border-b border-border last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <div className="text-sm font-semibold text-foreground">Workflow {summary.workflowUid}</div>
                    <div className="text-xs text-muted-foreground">
                      {summary.workflowName ?? 'Unknown workflow'}
                      {summary.workflowNamespace ? ` (${summary.workflowNamespace})` : ''}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">{formatTimestamp(summary.lastMessageAt)}</div>
                </div>
                <div className="text-xs text-muted-foreground">{summary.preview}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}

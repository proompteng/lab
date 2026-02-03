import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  AgentMessageList,
  AgentStreamStatusBadge,
  sortMessagesByTimestamp,
  useAgentEventStream,
} from '@/components/agent-comms'
import { Button } from '@proompteng/design/ui'

export const Route = createFileRoute('/agents/$runId')({
  component: AgentsRunPage,
})

const formatTimestamp = (value: string | null) => {
  if (!value) return 'Unknown time'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

function AgentsRunPage() {
  const { runId } = Route.useParams()
  const { messages, status, error, lastEventAt } = useAgentEventStream({ runId, maxMessages: 500 })

  const ordered = React.useMemo(() => sortMessagesByTimestamp(messages, 'asc'), [messages])
  const groupedByAgent = React.useMemo(() => {
    const byAgent = new Map<string, typeof ordered>()
    for (const message of ordered) {
      const key = message.agentId ?? 'unknown-agent'
      const list = byAgent.get(key)
      if (list) {
        list.push(message)
      } else {
        byAgent.set(key, [message])
      }
    }
    return Array.from(byAgent.entries()).map(([agentId, list]) => ({ agentId, messages: list }))
  }, [ordered])

  const runMeta = React.useMemo(() => {
    const findValue = (selector: (message: (typeof ordered)[number]) => string | null) =>
      ordered.map(selector).find((value) => Boolean(value)) ?? null

    return {
      workflowName: findValue((message) => message.workflowName),
      workflowUid: findValue((message) => message.workflowUid),
      workflowNamespace: findValue((message) => message.workflowNamespace),
      stage: findValue((message) => message.stage),
      firstMessageAt: ordered.length > 0 ? (ordered[0]?.timestamp ?? null) : null,
      lastMessageAt: ordered.length > 0 ? (ordered[ordered.length - 1]?.timestamp ?? null) : null,
    }
  }, [ordered])

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">Run {runId}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" render={<Link to="/agents" />}>
              Back to overview
            </Button>
            <Button variant="ghost" size="sm" render={<Link to="/agents/general" />}>
              General channel
            </Button>
          </div>
        </div>
        <AgentStreamStatusBadge status={status} lastEventAt={lastEventAt} />
      </header>

      <section className="space-y-3 p-4 rounded-none border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Run details</h2>
          <span className="text-xs text-muted-foreground">{ordered.length} messages</span>
        </div>
        <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">Workflow</div>
            <div>{runMeta.workflowName ?? 'Unknown workflow'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">Workflow UID</div>
            <div>{runMeta.workflowUid ?? 'Unknown'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">Namespace</div>
            <div>{runMeta.workflowNamespace ?? 'Unknown'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">Stage</div>
            <div>{runMeta.stage ?? 'Unknown'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">First message</div>
            <div>{formatTimestamp(runMeta.firstMessageAt)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">Latest message</div>
            <div>{formatTimestamp(runMeta.lastMessageAt)}</div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="p-3 rounded-none border border-destructive/40 bg-destructive/10 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Messages by agent</h2>
          <span className="text-xs text-muted-foreground">{groupedByAgent.length} agents</span>
        </div>
        {groupedByAgent.length === 0 ? (
          <AgentMessageList messages={[]} emptyLabel="No messages yet. Waiting for run events." />
        ) : (
          groupedByAgent.map((group) => (
            <section key={group.agentId} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">{group.agentId}</h3>
                <span className="text-xs text-muted-foreground">{group.messages.length} events</span>
              </div>
              <AgentMessageList messages={group.messages} emptyLabel="No messages yet." />
            </section>
          ))
        )}
      </section>
    </main>
  )
}

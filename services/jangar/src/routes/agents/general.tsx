import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  AgentMessageList,
  AgentStreamStatusBadge,
  sortMessagesByTimestamp,
  useAgentEventStream,
} from '@/components/agent-comms'
import { Button } from '@proompteng/design/ui'

export const Route = createFileRoute('/agents/general')({
  component: AgentsGeneralPage,
})

function AgentsGeneralPage() {
  const { messages, status, error, lastEventAt } = useAgentEventStream({ channel: 'general', maxMessages: 400 })
  const sortedMessages = React.useMemo(() => sortMessagesByTimestamp(messages, 'desc'), [messages])

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">General channel</h1>
          <p className="text-xs text-muted-foreground">
            Live stream of cross-workflow messages published to the shared channel.
          </p>
          <Button variant="ghost" size="sm" render={<Link to="/agents" />}>
            Back to overview
          </Button>
        </div>
        <AgentStreamStatusBadge status={status} lastEventAt={lastEventAt} />
      </header>

      {error ? (
        <div className="p-3 rounded-none border border-destructive/40 bg-destructive/10 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Messages</h2>
          <span className="text-xs text-muted-foreground">{sortedMessages.length} events</span>
        </div>
        <AgentMessageList
          messages={sortedMessages}
          emptyLabel="No messages yet. Waiting for the general channel to publish events."
          showRunLink
        />
      </section>
    </main>
  )
}

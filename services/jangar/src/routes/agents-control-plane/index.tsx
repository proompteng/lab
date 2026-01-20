import { createFileRoute, Link } from '@tanstack/react-router'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/agents-control-plane/')({
  component: AgentsControlPlanePage,
})

const cards = [
  { to: '/agents-control-plane/agents', title: 'Agents', description: 'Agent configurations and defaults.' },
  { to: '/agents-control-plane/agent-runs', title: 'Agent runs', description: 'Execution history and status.' },
  {
    to: '/agents-control-plane/agent-providers',
    title: 'Agent providers',
    description: 'Provider runtime and integration settings.',
  },
  {
    to: '/agents-control-plane/implementation-specs',
    title: 'Implementation specs',
    description: 'Normalized implementation definitions.',
  },
  {
    to: '/agents-control-plane/implementation-sources',
    title: 'Implementation sources',
    description: 'Upstream feeds that generate specs.',
  },
  { to: '/agents-control-plane/memories', title: 'Memories', description: 'Memory backends and health.' },
  {
    to: '/agents-control-plane/orchestrations',
    title: 'Orchestrations',
    description: 'Workflow definitions and policies.',
  },
  {
    to: '/agents-control-plane/orchestration-runs',
    title: 'Orchestration runs',
    description: 'Execution records and step status.',
  },
  { to: '/agents-control-plane/tools', title: 'Tools', description: 'Tool definitions and runtime bindings.' },
  { to: '/agents-control-plane/tool-runs', title: 'Tool runs', description: 'Tool execution history and outcomes.' },
  { to: '/agents-control-plane/signals', title: 'Signals', description: 'Signal definitions and payload schemas.' },
  {
    to: '/agents-control-plane/signal-deliveries',
    title: 'Signal deliveries',
    description: 'Signal delivery events and payloads.',
  },
  {
    to: '/agents-control-plane/approval-policies',
    title: 'Approval policies',
    description: 'Approval gates and compliance rules.',
  },
  { to: '/agents-control-plane/budgets', title: 'Budgets', description: 'Resource and cost ceilings.' },
  { to: '/agents-control-plane/secret-bindings', title: 'Secret bindings', description: 'Secret access mappings.' },
  { to: '/agents-control-plane/schedules', title: 'Schedules', description: 'Time-based triggers and automation.' },
  { to: '/agents-control-plane/artifacts', title: 'Artifacts', description: 'Stored outputs and logs.' },
  { to: '/agents-control-plane/workspaces', title: 'Workspaces', description: 'Workspace storage and lifecycle.' },
]

function AgentsControlPlanePage() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
        <h1 className="text-lg font-semibold">Agents control plane</h1>
        <p className="text-xs text-muted-foreground">Browse core agent primitives and review their current status.</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <div key={card.to} className="space-y-3 rounded-none border border-border bg-card p-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-foreground">{card.title}</h2>
              <p className="text-xs text-muted-foreground">{card.description}</p>
            </div>
            <Link to={card.to} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              Open
            </Link>
          </div>
        ))}
      </section>
    </main>
  )
}

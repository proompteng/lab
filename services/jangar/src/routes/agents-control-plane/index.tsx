import { createFileRoute, Link } from '@tanstack/react-router'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/agents-control-plane/')({
  component: AgentsControlPlanePage,
})

const sections = [
  {
    label: 'Resources',
    items: [
      { to: '/agents-control-plane/agents', title: 'Agents', description: 'Agent configurations and defaults.' },
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
      { to: '/agents-control-plane/tools', title: 'Tools', description: 'Tool definitions and runtime wiring.' },
    ],
  },
  {
    label: 'Runs',
    items: [
      { to: '/agents-control-plane/agent-runs', title: 'Agent runs', description: 'Execution history and status.' },
      { to: '/agents-control-plane/tool-runs', title: 'Tool runs', description: 'Execution history for tools.' },
    ],
  },
  {
    label: 'Policies',
    items: [
      { to: '/agents-control-plane/approvals', title: 'Approvals', description: 'Approval policies and gates.' },
      { to: '/agents-control-plane/budgets', title: 'Budgets', description: 'Budget ceilings and enforcement.' },
      {
        to: '/agents-control-plane/secret-bindings',
        title: 'Secret bindings',
        description: 'Secret access control policies.',
      },
    ],
  },
  {
    label: 'Signals',
    items: [
      { to: '/agents-control-plane/signals', title: 'Signals', description: 'Signal definitions and routing.' },
      {
        to: '/agents-control-plane/signal-deliveries',
        title: 'Signal deliveries',
        description: 'Delivery records and payloads.',
      },
    ],
  },
  {
    label: 'Storage',
    items: [
      { to: '/agents-control-plane/memories', title: 'Memories', description: 'Memory backends and health.' },
      { to: '/agents-control-plane/artifacts', title: 'Artifacts', description: 'Artifact storage configuration.' },
      { to: '/agents-control-plane/workspaces', title: 'Workspaces', description: 'Workspace storage definitions.' },
    ],
  },
  {
    label: 'Orchestration',
    items: [
      { to: '/agents-control-plane/orchestrations', title: 'Orchestrations', description: 'Orchestration templates.' },
      {
        to: '/agents-control-plane/orchestration-runs',
        title: 'Orchestration runs',
        description: 'Execution records for orchestrations.',
      },
      { to: '/agents-control-plane/schedules', title: 'Schedules', description: 'Recurring schedule definitions.' },
    ],
  },
]

function AgentsControlPlanePage() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
        <h1 className="text-lg font-semibold">Agents control plane</h1>
        <p className="text-xs text-muted-foreground">Browse core agent primitives and review their current status.</p>
      </header>

      <section className="space-y-6">
        {sections.map((section) => (
          <div key={section.label} className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{section.label}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {section.items.map((card) => (
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
            </div>
          </div>
        ))}
      </section>
    </main>
  )
}

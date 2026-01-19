import { createFileRoute, Link } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'

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
            <Button variant="outline" size="sm" render={<Link to={card.to} />}>
              Open
            </Button>
          </div>
        ))}
      </section>
    </main>
  )
}

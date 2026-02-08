import { createFileRoute } from '@tanstack/react-router'
import { Activity, ShieldCheck, Boxes, Eye, Network, Sparkles } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@proompteng/design/ui'

export const Route = createFileRoute('/')({ component: App })

const sections = [
  {
    icon: Activity,
    title: 'Runs',
    description: 'Inspect recent agent runs, traces, and outcomes.',
  },
  {
    icon: ShieldCheck,
    title: 'Policies',
    description: 'Review guardrails and approvals in one place.',
  },
  {
    icon: Boxes,
    title: 'Tools',
    description: 'Track registered tools and their usage.',
  },
  {
    icon: Eye,
    title: 'Observability',
    description: 'See what happened and why it happened.',
  },
  {
    icon: Network,
    title: 'Routing',
    description: 'Choose which model handles each task.',
  },
  {
    icon: Sparkles,
    title: 'Experiments',
    description: 'Test changes safely before rollout.',
  },
]

function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-12 sm:py-16">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">control plane</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">proompteng app</h1>
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            Control plane UI shell. Wire it up to backend services and data sources to get a live view of agents,
            policies, and runs.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {sections.map(({ icon: Icon, title, description }) => (
            <Card key={title} className="group transition hover:ring-ring/30">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <span className="inline-flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground group-hover:text-foreground">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <CardTitle>{title}</CardTitle>
                    <CardDescription>{description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">Coming soon.</CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}

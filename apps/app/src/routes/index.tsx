import { createFileRoute } from '@tanstack/react-router'
import { Activity, ShieldCheck, Boxes, Eye, Network, Sparkles } from 'lucide-react'

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
    <div className="min-h-screen bg-slate-950 text-white">
      <section className="mx-auto flex flex-col gap-6 px-6 py-16 max-w-5xl">
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">control plane</p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">proompteng app</h1>
          <p className="max-w-2xl text-sm text-slate-300 sm:text-base">
            This is the control plane UI shell. Wire it up to your backend services and data sources to get a live view
            of agents, policies, and runs.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {sections.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="rounded-2xl border p-5 transition border-slate-800 bg-slate-900/60 hover:border-slate-700"
            >
              <Icon className="mb-3 size-6 text-cyan-300" />
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-2 text-sm text-slate-300">{description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

export const Route = createFileRoute('/')({
  component: Overview,
})

function Overview() {
  return (
    <div className="grid gap-8 text-slate-100">
      <section className="glass-surface rounded-2xl p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-cyan-300">golink</p>
            <h1 className="text-3xl font-semibold tracking-tight">Short, memorable routes for the team</h1>
            <p className="mt-2 max-w-2xl text-slate-300">
              Add a slug once and everyone can reach it via{' '}
              <span className="font-semibold text-white">http://go/&lt;slug&gt;</span>. Admins can search, edit, and
              remove entries without downtime.
            </p>
          </div>
          <Link
            to="/admin"
            className="group inline-flex items-center justify-center rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-violet-500 px-5 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/30 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          >
            Open admin
            <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card title="Create" body="Add a slug, target URL, and context in seconds." />
        <Card title="Redirect" body="Requests to /{slug} 302 to the saved target; missing slugs return a 404." />
        <Card title="Audit" body="Optimistic edits roll back on failure and keep inline errors visible." />
      </section>
    </div>
  )
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="glass-surface rounded-2xl border border-white/5 p-5 shadow-lg shadow-black/30">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mt-2 text-sm text-slate-300 leading-relaxed">{body}</p>
    </div>
  )
}

import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@proompteng/design/ui'

export const Route = createFileRoute('/')({
  component: Overview,
})

function Overview() {
  return (
    <div className="grid gap-8 text-slate-100">
      <section className="glass-surface rounded-2xl py-8 px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl tracking-tight">Short, memorable links</h1>
            <p className="mt-2 max-w-2xl text-slate-300">Add links that so that you don't have to remember</p>
          </div>
          <Button className="flex">
            <Link to="/admin" className="group inline-flex items-center">
              <span>Go to admin</span>
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card title="Create" body="Add short links" />
        <Card title="Redirect" body="Redirect via short URLs" />
        <Card title="Edit" body="Edit existing short links" />
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

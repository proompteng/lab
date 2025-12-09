import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12 space-y-6">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-widest text-cyan-400">Jangar</p>
        <h1 className="text-3xl font-semibold">OpenAI-compatible gateway for OpenWebUI</h1>
        <p className="text-slate-300 max-w-3xl">
          This service exposes <code className="px-1 py-0.5 bg-slate-800 rounded">/openai/v1</code> endpoints backed by
          Effect-powered request validation and streaming passthrough to your configured OpenAI API base.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <Card title="Models endpoint" detail="Lists configured upstream models">
          <Link className="text-cyan-300 underline" to="/openai/v1/models">
            GET /openai/v1/models
          </Link>
        </Card>
        <Card title="Chat completions" detail="Streaming-only SSE proxy for OpenWebUI">
          <code className="text-sm">POST /openai/v1/chat/completions</code>
        </Card>
      </section>
    </main>
  )
}

function Card({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-lg shadow-black/30">
      <h3 className="text-lg font-medium text-slate-100">{title}</h3>
      <p className="text-slate-400 text-sm mb-3">{detail}</p>
      {children}
    </div>
  )
}

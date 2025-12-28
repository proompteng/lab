import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { serverFns } from '../data/memories'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [count, setCount] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await serverFns.countMemories({ data: {} })
      if (!result.ok) {
        setError(result.message)
        setCount(null)
        return
      }
      setCount(result.count)
    } catch {
      setError('Unable to load memory count right now.')
      setCount(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <section className="space-y-3 rounded-none border bg-card p-4">
        <header className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-sm font-medium">Memories</h1>
            <p className="text-xs text-muted-foreground">Total entries</p>
          </div>
          <Button variant="outline" onClick={load} disabled={isLoading}>
            Refresh
          </Button>
        </header>
        {error ? (
          <div className="text-xs text-destructive" aria-live="polite">
            {error}
          </div>
        ) : null}
        <div className="text-3xl font-medium tabular-nums">{count ?? (isLoading ? '…' : '—')}</div>
      </section>

      <section className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Quick links</div>
        <div className="grid gap-3 md:grid-cols-2">
          <InfoCard title="Models endpoint" detail="Lists configured upstream models">
            <Link className="text-primary underline-offset-4 hover:underline" to="/openai/v1/models">
              GET /openai/v1/models
            </Link>
          </InfoCard>
          <InfoCard title="Chat completions" detail="Streaming-only SSE proxy for OpenWebUI">
            <code className="text-xs">POST /openai/v1/chat/completions</code>
          </InfoCard>
          <InfoCard title="Torghut symbols" detail="Configure the symbol universe for torghut-ws">
            <Link className="text-primary underline-offset-4 hover:underline" to="/torghut/symbols">
              /torghut/symbols
            </Link>
          </InfoCard>
          <InfoCard title="Torghut visuals" detail="Candlestick + TA charts from ClickHouse">
            <Link className="text-primary underline-offset-4 hover:underline" to="/torghut/visuals">
              /torghut/visuals
            </Link>
          </InfoCard>
        </div>
      </section>
    </main>
  )
}

function InfoCard({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-none border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="text-xs text-foreground">{children}</div>
    </div>
  )
}

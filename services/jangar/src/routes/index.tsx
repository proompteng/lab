import { createFileRoute } from '@tanstack/react-router'
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
    <main className="mx-auto w-full max-w-4xl p-6 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-sm font-medium">Memories</h1>
          <p className="text-xs text-muted-foreground">Total entries</p>
        </div>
        <Button variant="outline" onClick={load} disabled={isLoading}>
          Refresh
        </Button>
      </header>

      {error ? <div className="text-xs text-destructive">{error}</div> : null}
      <div className="text-3xl font-medium tabular-nums">{count ?? (isLoading ? '…' : '—')}</div>
    </main>
  )
}

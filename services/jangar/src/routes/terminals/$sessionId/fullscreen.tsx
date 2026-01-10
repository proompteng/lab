import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { TerminalView } from '@/components/terminal-view'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/terminals/$sessionId/fullscreen')({
  component: TerminalFullscreenPage,
})

type TerminalSession = {
  id: string
  status: 'creating' | 'ready' | 'error' | 'closed'
  terminalUrl?: string | null
  reconnectToken?: string | null
}

function TerminalFullscreenPage() {
  const { sessionId } = Route.useParams()
  const [session, setSession] = React.useState<TerminalSession | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const loadSession = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(sessionId)}`)
      const payload = (await response.json().catch(() => null)) as
        | { ok: true; session: TerminalSession }
        | { ok: false; message?: string }
        | null

      if (!response.ok || !payload || !('ok' in payload) || !payload.ok) {
        throw new Error(
          payload && 'message' in payload ? payload.message || 'Unable to load session.' : 'Unable to load session.',
        )
      }

      setSession(payload.session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load terminal session.')
      setSession(null)
    } finally {
      setIsLoading(false)
    }
  }, [sessionId])

  React.useEffect(() => {
    void loadSession()
  }, [loadSession])

  React.useEffect(() => {
    if (session?.status !== 'creating') return
    const interval = setInterval(() => {
      void loadSession()
    }, 2000)
    return () => clearInterval(interval)
  }, [session, loadSession])

  return (
    <main className="relative flex h-svh w-full flex-col bg-black">
      <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
        <Button size="sm" variant="secondary" render={<Link to="/terminals" />}>
          Back to sessions
        </Button>
      </div>

      {error ? (
        <div className="absolute inset-x-4 top-16 z-10 rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex flex-col gap-3 rounded-none border border-border bg-card p-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-64 w-[70vw]" />
          </div>
        </div>
      ) : session?.status === 'ready' ? (
        <div className="flex h-full w-full">
          <TerminalView
            sessionId={session.id}
            terminalUrl={session.terminalUrl ?? null}
            variant="fullscreen"
            reconnectToken={session.reconnectToken ?? null}
          />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          Terminal session not ready.
        </div>
      )}
    </main>
  )
}

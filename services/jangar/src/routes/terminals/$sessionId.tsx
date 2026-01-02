import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { TerminalView } from '@/components/terminal-view'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/terminals/$sessionId')({
  component: TerminalSessionPage,
})

type TerminalSession = {
  id: string
  label: string
  worktreePath: string | null
  worktreeName: string | null
  createdAt: string | null
  attached: boolean
  status: 'creating' | 'ready' | 'error' | 'closed'
  errorMessage?: string | null
  readyAt?: string | null
  closedAt?: string | null
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const formatDateTime = (value: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return dateFormatter.format(date)
}

function TerminalSessionPage() {
  const { sessionId } = Route.useParams()
  const navigate = Route.useNavigate()
  const [session, setSession] = React.useState<TerminalSession | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isTerminating, setIsTerminating] = React.useState(false)

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

  const statusLabel = session?.status ?? 'creating'
  const statusTone =
    statusLabel === 'ready'
      ? 'text-emerald-400'
      : statusLabel === 'creating'
        ? 'text-amber-400'
        : statusLabel === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground'
  const statusDot =
    statusLabel === 'ready'
      ? 'bg-emerald-400'
      : statusLabel === 'creating'
        ? 'bg-amber-400'
        : statusLabel === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  return (
    <main className="flex flex-col gap-4 p-6 min-h-svh">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Terminal session</p>
          <h1 className="text-lg font-semibold">{session?.label ?? sessionId}</h1>
          <div className="text-xs text-muted-foreground">
            {session?.worktreePath ? `Worktree: ${session.worktreePath}` : 'Worktree path unavailable'}
          </div>
          <div className="text-xs text-muted-foreground">
            Created {formatDateTime(session?.createdAt ?? null)} - {session?.attached ? 'Attached' : 'Detached'}
          </div>
          <div className={`text-xs flex items-center gap-2 ${statusTone}`}>
            <span className={`h-2 w-2 rounded-full ${statusDot}`} />
            {statusLabel === 'creating' ? 'Provisioning' : statusLabel}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" render={<Link to="/terminals" />}>
            All sessions
          </Button>
          <Button
            variant="destructive"
            disabled={isTerminating || session?.status === 'creating'}
            onClick={async () => {
              if (!session) return
              setIsTerminating(true)
              setError(null)
              try {
                const response = await fetch(`/api/terminals/${encodeURIComponent(session.id)}/terminate`, {
                  method: 'POST',
                })
                const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null
                if (!response.ok || !payload?.ok) {
                  throw new Error(payload?.message ?? 'Unable to terminate session.')
                }
                await navigate({ to: '/terminals' })
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Unable to terminate session.')
              } finally {
                setIsTerminating(false)
              }
            }}
          >
            {isTerminating ? 'Terminating...' : 'Terminate session'}
          </Button>
          <Button variant="outline" onClick={loadSession} disabled={isLoading}>
            Refresh
          </Button>
        </div>
      </header>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <section className="flex flex-col flex-1 min-h-0">
        {session?.status === 'ready' ? (
          <TerminalView sessionId={sessionId} />
        ) : session?.status === 'error' ? (
          <div className="rounded-none border border-destructive/40 bg-destructive/10 p-4 text-xs text-destructive">
            {session.errorMessage ?? 'Terminal session failed to start. Refresh to retry.'}
          </div>
        ) : session?.status === 'closed' ? (
          <div className="rounded-none border border-border bg-card p-4 text-xs text-muted-foreground">
            Session closed. Create a new session to continue.
          </div>
        ) : (
          <div className="rounded-none border border-border bg-card p-4 text-xs text-muted-foreground">
            Preparing terminal session. It will connect automatically once ready.
          </div>
        )}
      </section>
    </main>
  )
}

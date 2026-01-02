import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/terminals/')({
  component: TerminalsIndexPage,
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

function TerminalsIndexPage() {
  const [sessions, setSessions] = React.useState<TerminalSession[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [isCreating, setIsCreating] = React.useState(false)
  const [showClosed, setShowClosed] = React.useState(false)

  const loadSessions = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(showClosed ? '/api/terminals?includeClosed=1' : '/api/terminals')
      const payload = (await response.json().catch(() => null)) as
        | { ok: true; sessions: TerminalSession[] }
        | { ok: false; message?: string }
        | null

      if (!response.ok || !payload || !('ok' in payload) || !payload.ok) {
        throw new Error(
          payload && 'message' in payload ? payload.message || 'Unable to load sessions.' : 'Unable to load sessions.',
        )
      }

      setSessions(payload.sessions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load terminal sessions.')
    } finally {
      setIsLoading(false)
    }
  }, [showClosed])

  const createSession = React.useCallback(async () => {
    setIsCreating(true)
    setError(null)
    try {
      const response = await fetch('/api/terminals?create=1')
      const payload = (await response.json().catch(() => null)) as
        | { ok: true; session: TerminalSession }
        | { ok: false; message?: string }
        | null

      if (!response.ok || !payload || !('ok' in payload) || !payload.ok) {
        throw new Error(
          payload && 'message' in payload
            ? payload.message || 'Unable to create session.'
            : 'Unable to create session.',
        )
      }

      const session = payload.session
      setSessions((prev) => [session, ...prev])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create terminal session.')
    } finally {
      setIsCreating(false)
    }
  }, [])

  const deleteSession = React.useCallback(async (sessionId: string) => {
    setError(null)
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(sessionId)}/delete`, {
        method: 'POST',
      })
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || 'Unable to delete session.')
      }
      setSessions((prev) => prev.filter((session) => session.id !== sessionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete terminal session.')
    }
  }, [])

  React.useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  React.useEffect(() => {
    if (!sessions.some((session) => session.status === 'creating')) return
    const interval = setInterval(() => {
      void loadSessions()
    }, 2000)
    return () => clearInterval(interval)
  }, [sessions, loadSessions])

  const statusMeta = (status: TerminalSession['status']) => {
    switch (status) {
      case 'ready':
        return { label: 'Ready', dot: 'bg-emerald-400', tone: 'text-emerald-400' }
      case 'creating':
        return { label: 'Creating', dot: 'bg-amber-400', tone: 'text-amber-400' }
      case 'error':
        return { label: 'Error', dot: 'bg-destructive', tone: 'text-destructive' }
      case 'closed':
        return { label: 'Closed', dot: 'bg-muted-foreground', tone: 'text-muted-foreground' }
    }
  }

  return (
    <main className="mx-auto space-y-6 p-6 w-full max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Terminals</p>
          <h1 className="text-lg font-semibold">Terminal sessions</h1>
          <p className="text-xs text-muted-foreground">
            Create and reconnect to tmux-backed terminal sessions for Codex and repo worktrees.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setShowClosed((prev) => !prev)} disabled={isLoading}>
            {showClosed ? 'Hide closed' : 'Show closed'}
          </Button>
          <Button variant="outline" onClick={loadSessions} disabled={isLoading}>
            Refresh
          </Button>
          <Button onClick={createSession} disabled={isCreating}>
            {isCreating ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
                Creating...
              </span>
            ) : (
              'New session'
            )}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {sessions.length === 0 ? (
        <section className="rounded-none border border-border bg-card p-6 text-xs text-muted-foreground">
          {isLoading ? 'Loading sessions...' : 'No terminal sessions yet. Create one to get started.'}
        </section>
      ) : (
        <section className="overflow-hidden rounded-none border border-border bg-card">
          <ul>
            {sessions.map((session) => (
              <li key={session.id} className="border-b border-border last:border-b-0">
                {(() => {
                  const meta = statusMeta(session.status)
                  return (
                    <div
                      className={cn(
                        'flex flex-col gap-2 p-4 transition',
                        session.status === 'ready' ? 'hover:bg-muted/20' : 'opacity-70',
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <Link
                          to="/terminals/$sessionId"
                          params={{ sessionId: session.id }}
                          onClick={(event) => {
                            if (session.status !== 'ready') {
                              event.preventDefault()
                            }
                          }}
                          aria-disabled={session.status !== 'ready'}
                          className={cn(
                            'flex-1 space-y-1',
                            session.status === 'ready' ? 'cursor-pointer' : 'cursor-not-allowed',
                          )}
                        >
                          <div className="text-sm font-semibold text-foreground">{session.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {session.worktreePath ?? 'Unknown worktree'}
                          </div>
                        </Link>
                        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
                          <span>{formatDateTime(session.createdAt)}</span>
                          <span>{session.attached ? 'Attached' : 'Detached'}</span>
                          {(session.status === 'closed' || session.status === 'error') && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                void deleteSession(session.id)
                              }}
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>Session id: {session.id}</span>
                        <span className={cn('flex items-center gap-2', meta.tone)}>
                          <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
                          {meta.label}
                        </span>
                      </div>
                      {session.status === 'error' && session.errorMessage ? (
                        <div className="text-xs text-destructive">{session.errorMessage}</div>
                      ) : null}
                    </div>
                  )
                })()}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

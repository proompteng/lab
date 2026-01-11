import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import { toast } from 'sonner'

import { TerminalView } from '@/components/terminal-view'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/terminals/$sessionId/')({
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
  terminalUrl?: string | null
  reconnectToken?: string | null
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
  const [isDeleting, setIsDeleting] = React.useState(false)
  const isInitialLoading = isLoading && !session && !error

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
    <main className="flex h-full min-h-0 flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        {isInitialLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-3 w-52" />
            <Skeleton className="h-3 w-24" />
          </div>
        ) : (
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
              {statusLabel === 'creating' ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
                  Provisioning
                </span>
              ) : (
                statusLabel
              )}
              <span className={`h-2 w-2 rounded-full ${statusDot}`} />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" render={<Link to="/terminals" />}>
            All sessions
          </Button>
          <Button
            variant="secondary"
            disabled={!session}
            onClick={() => {
              if (!session) return
              const target = `/terminals/${encodeURIComponent(session.id)}/fullscreen`
              window.open(target, '_blank', 'noopener,noreferrer')
            }}
          >
            Open fullscreen
          </Button>
          <Button
            variant="destructive"
            disabled={isTerminating || session?.status !== 'ready'}
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
                window.dispatchEvent(new Event('terminals:refresh'))
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
          {(session?.status === 'closed' || session?.status === 'error') && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="outline" disabled={isDeleting}>
                    {isDeleting ? 'Deleting...' : 'Delete session'}
                  </Button>
                }
              />
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete terminal session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the session record and deletes its worktree files. This action cannot be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel size="sm" className="min-w-[96px]">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    size="sm"
                    className="min-w-[96px]"
                    onClick={async () => {
                      if (!session) return
                      setIsDeleting(true)
                      setError(null)
                      try {
                        const response = await fetch(`/api/terminals/${encodeURIComponent(session.id)}/delete`, {
                          method: 'POST',
                        })
                        const payload = (await response.json().catch(() => null)) as {
                          ok?: boolean
                          message?: string
                        } | null
                        if (!response.ok || !payload?.ok) {
                          throw new Error(payload?.message ?? 'Unable to delete session.')
                        }
                        window.dispatchEvent(new Event('terminals:refresh'))
                        toast.success('Terminal session deleted.')
                        await navigate({ to: '/terminals' })
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Unable to delete session.')
                        toast.error('Failed to delete terminal session.')
                      } finally {
                        setIsDeleting(false)
                      }
                    }}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button variant="outline" onClick={loadSession} disabled={isLoading}>
            {isLoading ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
                Refreshing...
              </span>
            ) : (
              'Refresh'
            )}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {isDeleting ? <div className="h-0.5 w-full bg-emerald-400/70 animate-pulse" aria-hidden /> : null}

      <section className="flex flex-col flex-1 min-h-0">
        {isInitialLoading ? (
          <div className="flex flex-col gap-3 rounded-none border border-border bg-card p-4">
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
              Loading terminal session...
            </div>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-52" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : session?.status === 'ready' ? (
          <div className="flex flex-1 min-h-0">
            <TerminalView
              sessionId={session?.id ?? sessionId}
              terminalUrl={session?.terminalUrl ?? null}
              reconnectToken={session?.reconnectToken ?? null}
              className="flex-1 min-h-0"
            />
          </div>
        ) : session?.status === 'error' ? (
          <div className="rounded-none border border-destructive/40 bg-destructive/10 p-4 text-xs text-destructive">
            {session.errorMessage ?? 'Terminal session failed to start. Refresh to retry.'}
          </div>
        ) : session?.status === 'closed' ? (
          <div className="rounded-none border border-border bg-card p-4 text-xs text-muted-foreground">
            Session closed. Create a new session to continue.
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-none border border-border bg-card p-4 text-xs text-muted-foreground">
            <div className="inline-flex items-center gap-2">
              <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
              Preparing terminal session...
            </div>
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-52" />
          </div>
        )}
      </section>
    </main>
  )
}

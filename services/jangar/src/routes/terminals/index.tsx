import { createFileRoute, Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'

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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
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

const skeletonKeys = ['skeleton-a', 'skeleton-b', 'skeleton-c', 'skeleton-d', 'skeleton-e', 'skeleton-f']

function TerminalsIndexPage() {
  const [sessions, setSessions] = React.useState<TerminalSession[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [isCreating, setIsCreating] = React.useState(false)
  const [deletingSessions, setDeletingSessions] = React.useState<Record<string, boolean>>({})
  const [showClosed, setShowClosed] = React.useState(false)
  const isInitialLoading = isLoading && sessions.length === 0
  const showPendingRow = isCreating && !sessions.some((session) => session.status === 'creating')
  const tableColumns =
    'grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.6fr)_minmax(0,0.5fr)]'

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
      window.dispatchEvent(new Event('terminals:refresh'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create terminal session.')
    } finally {
      setIsCreating(false)
    }
  }, [])

  const deleteSession = React.useCallback(async (sessionId: string) => {
    setError(null)
    setDeletingSessions((prev) => ({ ...prev, [sessionId]: true }))
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(sessionId)}/delete`, {
        method: 'POST',
      })
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || 'Unable to delete session.')
      }
      setSessions((prev) => prev.filter((session) => session.id !== sessionId))
      setDeletingSessions((prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      window.dispatchEvent(new Event('terminals:refresh'))
      toast.success('Terminal session deleted.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete terminal session.')
      setDeletingSessions((prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      toast.error('Failed to delete terminal session.')
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
    <main className="mx-auto flex flex-col gap-6 p-6 w-full max-w-6xl min-h-svh overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Terminals</p>
          <h1 className="text-lg font-semibold">Terminal sessions</h1>
          <p className="text-xs text-muted-foreground">
            Create and reconnect to durable terminal sessions for Codex and repo worktrees.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setShowClosed((prev) => !prev)} disabled={isLoading}>
            {showClosed ? 'Hide closed' : 'Show closed'}
          </Button>
          <Button variant="outline" onClick={loadSessions} disabled={isLoading}>
            {isLoading ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
                Refreshing...
              </span>
            ) : (
              'Refresh'
            )}
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

      <section className="flex flex-1 min-h-0 rounded-none border border-border bg-card">
        {isInitialLoading ? (
          <div className="w-full">
            <div
              className={cn(
                'grid gap-4 border-b border-border px-4 py-3 text-[11px] uppercase tracking-widest text-muted-foreground',
                tableColumns,
              )}
            >
              <span>Session</span>
              <span>Worktree</span>
              <span>Created</span>
              <span>State</span>
              <span>Status</span>
              <span className="text-right">Actions</span>
            </div>
            {skeletonKeys.map((key) => (
              <div
                key={key}
                className={cn('grid items-center gap-4 px-4 py-4 border-b border-border last:border-b-0', tableColumns)}
              >
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
                <div className="flex justify-end">
                  <Skeleton className="h-8 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-6 text-xs text-muted-foreground">No terminal sessions yet. Create one to get started.</div>
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-0">
              <div
                className={cn(
                  'grid items-center gap-4 border-b border-border px-4 py-3 text-[11px] uppercase tracking-widest text-muted-foreground',
                  tableColumns,
                )}
              >
                <span>Session</span>
                <span>Worktree</span>
                <span>Created</span>
                <span>State</span>
                <span>Status</span>
                <span className="text-right">Actions</span>
              </div>
              {showPendingRow ? (
                <div
                  className={cn(
                    'grid items-center gap-4 px-4 py-4 border-b border-border text-xs text-muted-foreground',
                    tableColumns,
                  )}
                >
                  <div className="space-y-2">
                    <div className="inline-flex items-center gap-2 text-amber-400">
                      <span className="h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" />
                      Provisioning session...
                    </div>
                    <Skeleton className="h-3 w-36" />
                  </div>
                  <Skeleton className="h-3 w-44" />
                  <Skeleton className="h-3 w-20" />
                  <span className="text-amber-400">Creating</span>
                  <span className="inline-flex items-center gap-2 text-amber-400">
                    <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                    Creating
                  </span>
                  <div className="flex items-center justify-end">
                    <Skeleton className="h-8 w-20" />
                  </div>
                </div>
              ) : null}
              {sessions.map((session) => {
                const meta = statusMeta(session.status)
                const rowTone = session.status === 'ready' ? 'hover:bg-muted/20' : 'opacity-70'
                const isDeleting = Boolean(deletingSessions[session.id])
                return (
                  <div
                    key={session.id}
                    className={cn(
                      'grid items-center gap-4 px-4 py-4 border-b border-border last:border-b-0 text-sm text-foreground transition',
                      tableColumns,
                      rowTone,
                    )}
                    data-session-id={session.id}
                    data-session-status={session.status}
                  >
                    <div className="flex flex-col gap-1">
                      <Link
                        to="/terminals/$sessionId"
                        params={{ sessionId: session.id }}
                        onClick={(event) => {
                          if (session.status !== 'ready') event.preventDefault()
                        }}
                        aria-disabled={session.status !== 'ready'}
                        className={cn(
                          'block text-sm font-semibold truncate',
                          session.status === 'ready' ? 'cursor-pointer' : 'cursor-not-allowed',
                        )}
                      >
                        {session.label}
                      </Link>
                      <div className="text-xs text-muted-foreground truncate" title={session.id}>
                        Session id: {session.id}
                      </div>
                      {session.status === 'error' && session.errorMessage ? (
                        <div className="text-xs text-destructive">{session.errorMessage}</div>
                      ) : null}
                    </div>
                    <div
                      className="text-xs text-muted-foreground truncate"
                      title={session.worktreePath ?? 'Unknown worktree'}
                    >
                      {session.worktreePath ?? 'Unknown worktree'}
                    </div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(session.createdAt)}</div>
                    <div className="text-xs text-muted-foreground">{session.attached ? 'Attached' : 'Detached'}</div>
                    <div className={cn('inline-flex items-center gap-2 text-xs', meta.tone)}>
                      <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
                      {meta.label}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      {session.status === 'ready' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            window.open(`/terminals/${encodeURIComponent(session.id)}/fullscreen`, '_blank', 'noopener')
                          }}
                        >
                          Fullscreen
                        </Button>
                      ) : null}
                      {(session.status === 'closed' || session.status === 'error') && (
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isDeleting}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                              >
                                <span className="inline-flex items-center gap-2">
                                  {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
                                  Delete
                                </span>
                              </Button>
                            }
                          />
                          <AlertDialogContent size="sm">
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete terminal session?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This permanently removes the session record and deletes its worktree files. This cannot
                                be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel className="min-w-[96px]" size="sm">
                                Cancel
                              </AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                size="sm"
                                className="min-w-[96px]"
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void deleteSession(session.id)
                                }}
                                disabled={isDeleting}
                              >
                                <span className="inline-flex items-center gap-2">
                                  {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
                                  {isDeleting ? 'Deleting' : 'Delete'}
                                </span>
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </section>
    </main>
  )
}

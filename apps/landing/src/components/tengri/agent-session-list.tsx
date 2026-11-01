'use client'

import { Button, Skeleton } from '@proompteng/design/ui'
import { Archive, ArrowLeft, LoaderCircle, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TengriCodexThreadPage } from '@/lib/tengri/codex-threads'
import { cn } from '@/lib/utils'
import { runTengriAction, TengriRequestError } from './client'

type SessionIndex = TengriCodexThreadPage & { archived: boolean } & (
    | { phase: 'loading' | 'ready' }
    | { phase: 'retrying'; cursor?: string }
    | { phase: 'error'; error: string }
  )

export function AgentSessionList({
  agentId,
  enabled,
  selected,
  busyThreadIds,
  canSelect,
  revision,
  onSelect,
  onArchived,
}: {
  agentId: string
  enabled: boolean
  selected: { id: string; unavailable: boolean } | null
  busyThreadIds: ReadonlySet<string>
  canSelect: boolean
  revision: number
  onSelect: (threadId: string) => void
  onArchived: (threadId: string) => void
}) {
  const [index, setIndex] = useState<SessionIndex>({ archived: false, phase: 'loading', threads: [], nextCursor: null })
  const [reload, setReload] = useState(0)
  const [changing, setChanging] = useState<ReadonlySet<string>>(new Set())
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const load = useCallback(
    async (cursor?: string) => {
      if (!enabled) return
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      setIndex((current) => ({ ...current, phase: 'loading' }))
      try {
        const page = await runTengriAction<TengriCodexThreadPage>(
          { action: 'list-threads', agentId, archived: index.archived, ...(cursor ? { cursor } : {}) },
          controller.signal,
        )
        if (controller.signal.aborted) return
        if (cursor && page.nextCursor === cursor) throw new Error('The chat index returned the same page twice.')
        setIndex((current) => ({
          archived: index.archived,
          phase: 'ready',
          threads: cursor
            ? [...new Map([...current.threads, ...page.threads].map((thread) => [thread.id, thread])).values()]
            : page.threads,
          nextCursor: page.nextCursor,
        }))
      } catch (cause) {
        if (controller.signal.aborted) return
        const retryable =
          cause instanceof TypeError ||
          (cause instanceof DOMException && cause.name === 'AbortError') ||
          (cause instanceof TengriRequestError &&
            cause.code !== 'model_catalog_invalid' &&
            cause.code !== 'conversation_history_invalid' &&
            cause.code !== 'chat_index_invalid' &&
            (cause.status === 408 || cause.status === 429 || cause.status >= 500))
        setIndex((current) =>
          retryable
            ? { ...current, phase: 'retrying', cursor }
            : {
                ...current,
                phase: 'error',
                error: cause instanceof Error ? cause.message : 'Could not load chats.',
              },
        )
      }
    },
    [agentId, enabled, index.archived],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [load, revision, reload])
  useEffect(() => {
    if (!enabled || index.phase !== 'retrying' || changing.size > 0) return
    const cursor = index.cursor
    const timer = window.setTimeout(() => void load(cursor), 2000)
    return () => window.clearTimeout(timer)
  }, [changing, enabled, index, load])
  useEffect(() => {
    const refresh = () => void load()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [load])

  async function setArchived(threadId: string, archived: boolean) {
    if (changing.has(threadId)) return
    request.current?.abort()
    setChanging((current) => new Set([...current, threadId]))
    try {
      await runTengriAction({ action: 'set-thread-archived', agentId, threadId, archived })
      if (!mounted.current) return
      setIndex((current) => ({
        ...current,
        phase: 'ready',
        threads:
          current.archived === archived ? current.threads : current.threads.filter((thread) => thread.id !== threadId),
      }))
      if (archived) onArchived(threadId)
      else setIndex({ archived: false, phase: 'loading', threads: [], nextCursor: null })
      setReload((current) => current + 1)
    } catch (cause) {
      if (mounted.current)
        setIndex((current) => ({
          ...current,
          phase: 'error',
          error: cause instanceof Error ? cause.message : 'Could not update this chat.',
        }))
    } finally {
      if (mounted.current) setChanging((current) => new Set([...current].filter((id) => id !== threadId)))
    }
  }

  if (!enabled) return null
  const threads = index.threads
  const recovering = index.phase === 'loading' || index.phase === 'retrying'
  return (
    <>
      <nav
        aria-label={index.archived ? 'Archived chats' : 'Conversations'}
        aria-busy={recovering}
        className="tengri-chat-scrollbar min-h-0 flex-1 overflow-auto py-1 [scrollbar-gutter:stable]"
      >
        {index.archived ? <p className="px-4 py-2 text-label-12 text-zinc-400">Archived chats</p> : null}
        {recovering && !threads.length ? (
          <div role="status" aria-label="Loading chats" className="space-y-3 px-4 py-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-3 w-4/5 rounded bg-zinc-800 motion-reduce:animate-none" />
            ))}
          </div>
        ) : !threads.length && index.phase === 'ready' && index.archived ? (
          <p className="px-4 py-2 text-label-12 text-zinc-400">No archived chats</p>
        ) : null}
        <ul className="px-1.5">
          {threads.map((thread) => {
            const unavailable = thread.id === selected?.id && selected.unavailable
            const active = thread.id === selected?.id && !index.archived
            const busy = busyThreadIds.has(thread.id)
            return (
              <li key={thread.id} className="group relative mb-0.5 flex min-w-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  data-conversation-id={thread.id}
                  disabled={!canSelect || index.archived}
                  aria-current={active ? 'true' : undefined}
                  aria-description={busy ? 'Response in progress' : undefined}
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    'h-8 min-w-0 flex-1 justify-start gap-2 pl-2.5 pr-8 text-left [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:pr-12',
                    active
                      ? 'bg-white/[0.06] text-zinc-100'
                      : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-copy-14">{thread.title}</span>
                  {busy ? (
                    <LoaderCircle
                      className="size-3 shrink-0 animate-spin text-zinc-500 motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {unavailable ? <span className="text-label-12 text-zinc-400">Unavailable</span> : null}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${index.archived ? 'Restore' : 'Archive'} ${thread.title}`}
                  title={
                    index.archived ? 'Restore chat' : busy ? 'Finish the response before archiving' : 'Archive chat'
                  }
                  disabled={changing.has(thread.id) || (!index.archived && (busy || unavailable || !canSelect))}
                  onClick={() => void setArchived(thread.id, !index.archived)}
                  className="absolute right-1 size-6 text-zinc-400 hover:text-zinc-100 [@media(pointer:coarse)]:size-11 [@media(hover:hover)]:invisible [@media(hover:hover)]:group-hover:visible [@media(hover:hover)]:group-focus-within:visible"
                >
                  {changing.has(thread.id) ? (
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : index.archived ? (
                    <RotateCcw aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Archive aria-hidden="true" className="size-3.5" />
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
        {index.phase === 'error' ? (
          <div className="px-4 py-2 text-label-12 text-zinc-400">
            <p role="alert">{index.error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-1 rounded text-zinc-200 outline-none underline underline-offset-2 focus-visible:ring-1 focus-visible:ring-blue-400"
            >
              Retry chats
            </button>
          </div>
        ) : null}
        {index.nextCursor ? (
          <button
            type="button"
            disabled={recovering}
            onClick={() => void load(index.nextCursor ?? undefined)}
            className="mx-4 my-2 rounded text-label-12 text-zinc-400 outline-none hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            Load older chats
          </button>
        ) : null}
      </nav>
      <button
        type="button"
        onClick={() => setIndex({ archived: !index.archived, phase: 'loading', threads: [], nextCursor: null })}
        className="m-2 flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-label-12 text-zinc-400 outline-none hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400"
      >
        {index.archived ? (
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        ) : (
          <Archive className="size-3.5" aria-hidden="true" />
        )}
        {index.archived ? 'Back to chats' : 'Archived chats'}
      </button>
    </>
  )
}

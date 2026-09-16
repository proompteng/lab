'use client'

import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TengriPreviewSession } from '@/lib/tengri/types'
import { safePreviewLaunchUrl, safePreviewSessionOrigin } from './chrome-model'
import { runTengriAction } from './client'
import { listRecoverableCodeDrafts, type CodeDraft } from './code-editor-draft-storage'
import { enqueueCodeOpenRequest, type CodeOpenRequest } from './code-editor-model'

const channel = 'tengri-vscode-v1'

export function CodeWorkbench({
  agentId,
  agentCreatedAt,
  desktopId,
  lifecycleBusy,
  ownerId,
  onDirtyChange,
  onFocus,
  previewGatewayOrigin,
  registerGuard,
  request,
  windowId,
}: {
  agentId: string
  agentCreatedAt: string
  desktopId: string
  lifecycleBusy: boolean
  ownerId: string
  onDirtyChange: (dirty: boolean) => void
  onFocus: () => void
  previewGatewayOrigin: string
  registerGuard: (windowId: string, guard: (close: boolean) => Promise<boolean>) => () => void
  request: CodeOpenRequest | null
  windowId: string
}) {
  const [session, setSession] = useState<TengriPreviewSession | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [fileError, setFileError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [queue, setQueue] = useState<CodeOpenRequest[]>([])
  const [drafts, setDrafts] = useState<CodeDraft[]>([])
  const iframe = useRef<HTMLIFrameElement>(null)
  const checks = useRef(new Map<string, (dirty: boolean, error?: string) => void>())
  const dirty = useRef(false)
  const callbacks = useRef({ onDirtyChange, onFocus })
  callbacks.current = { onDirtyChange, onFocus }

  useEffect(() => {
    setDrafts(listRecoverableCodeDrafts({ agentId, agentCreatedAt, ownerId }))
  }, [agentId, agentCreatedAt, ownerId])

  useEffect(() => {
    if (request) setQueue((current) => enqueueCodeOpenRequest(current, request))
  }, [request])

  useEffect(() => {
    let disposed = false
    let issued: TengriPreviewSession | null = null
    setReady(false)
    setSession(null)
    setError('')
    const revoke = (value: TengriPreviewSession) =>
      runTengriAction(
        {
          action: 'revoke-preview-session',
          agentId,
          sessionId: value.id,
          revocationToken: new URL(value.launchUrl).hash.slice(1),
        },
        { keepalive: true },
      ).catch(() => undefined)
    void runTengriAction<TengriPreviewSession>({
      action: 'editor-session',
      agentId,
      windowId: `${desktopId}-${windowId}`,
    })
      .then((value) => {
        issued = value
        if (disposed) {
          void revoke(value)
          return
        }
        const launchUrl = safePreviewLaunchUrl(value.launchUrl, previewGatewayOrigin)
        const previewOrigin = safePreviewSessionOrigin(value.previewOrigin, value.id)
        if (!launchUrl || !previewOrigin) throw new Error('Tengri returned an invalid VS Code session')
        dirty.current = true
        callbacks.current.onDirtyChange(true)
        setSession({ ...value, launchUrl, previewOrigin })
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'VS Code could not be started')
      })
    return () => {
      disposed = true
      if (issued) void revoke(issued)
    }
  }, [agentId, attempt, desktopId, previewGatewayOrigin, windowId])

  useEffect(() => {
    if (!session) return
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== session.previewOrigin) return
      if (typeof event.data !== 'object' || event.data === null) return
      const message = event.data
      if (
        !('channel' in message) ||
        message.channel !== channel ||
        !('sessionId' in message) ||
        message.sessionId !== session.id ||
        !('type' in message)
      )
        return
      if (message.type === 'state' && 'dirty' in message && typeof message.dirty === 'boolean') {
        dirty.current = message.dirty
        callbacks.current.onDirtyChange(message.dirty)
        setError('')
        setReady(true)
      } else if (message.type === 'focus') {
        callbacks.current.onFocus()
      } else if (message.type === 'disconnected') {
        dirty.current = true
        callbacks.current.onDirtyChange(true)
        setReady(false)
      } else if (message.type === 'result' && 'id' in message && typeof message.id === 'string') {
        checks.current.get(message.id)?.(
          'dirty' in message && typeof message.dirty === 'boolean' ? message.dirty : true,
          'error' in message && typeof message.error === 'string' ? message.error : undefined,
        )
        setQueue((current) => current.filter((item) => String(item.requestId) !== message.id))
        if ('error' in message && typeof message.error === 'string') setFileError(message.error)
      }
    }
    const requestState = () =>
      iframe.current?.contentWindow?.postMessage(
        { channel, sessionId: session.id, type: 'state' },
        session.previewOrigin,
      )
    window.addEventListener('message', receive)
    const interval = window.setInterval(requestState, 2000)
    return () => {
      window.removeEventListener('message', receive)
      window.clearInterval(interval)
    }
  }, [session])

  useEffect(() => {
    if (!ready || !session || !queue[0]) return
    const pending = queue[0]
    const send = () =>
      iframe.current?.contentWindow?.postMessage(
        { channel, sessionId: session.id, type: 'open', path: pending.path, id: String(pending.requestId) },
        session.previewOrigin,
      )
    send()
    const retry = window.setInterval(send, 2000)
    return () => window.clearInterval(retry)
  }, [queue, ready, session])

  useEffect(() => {
    if (ready || !session) return
    const timeout = window.setTimeout(
      () => setError('VS Code is not responding. Retry to reconnect to the workspace.'),
      30_000,
    )
    return () => window.clearTimeout(timeout)
  }, [ready, session])

  useEffect(
    () =>
      registerGuard(windowId, async (close) => {
        if (!session) return !dirty.current
        if (!ready)
          throw new Error('Wait for VS Code to reconnect before closing its window or changing the agent lifecycle.')
        const id = crypto.randomUUID()
        return new Promise<boolean>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            checks.current.delete(id)
            reject(new Error('VS Code has not confirmed that its edits are saved.'))
          }, 60_000)
          checks.current.set(id, (value, failure) => {
            window.clearTimeout(timer)
            checks.current.delete(id)
            dirty.current = value
            callbacks.current.onDirtyChange(value)
            if (failure) reject(new Error(failure))
            else resolve(!value)
          })
          iframe.current?.contentWindow?.postMessage(
            { channel, sessionId: session.id, type: close ? 'close' : 'check', id },
            session.previewOrigin,
          )
        })
      }),
    [ready, registerGuard, session, windowId],
  )

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current && !ready) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [ready])

  useEffect(
    () => () => {
      for (const settle of checks.current.values()) settle(true)
      callbacks.current.onDirtyChange(false)
    },
    [],
  )

  return (
    <div inert={lifecycleBusy || undefined} className="relative flex h-full min-h-0 flex-col bg-[#1f1f1f]">
      {drafts.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 px-3 py-2 text-[12px] text-white/70">
          <span>Recovered drafts from the previous editor:</span>
          {drafts.map((draft) => (
            <button
              className="text-sky-300 underline"
              key={draft.draftId}
              onClick={() => downloadDraft(draft)}
              type="button"
            >
              Download {draft.path}
            </button>
          ))}
        </div>
      ) : null}
      {fileError ? (
        <div className="flex items-center gap-2 bg-red-950/60 px-3 py-1.5 text-xs text-red-200" role="alert">
          {fileError}
          <button aria-label="Dismiss file error" onClick={() => setFileError('')} type="button">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {session ? (
        <iframe
          className="min-h-0 w-full flex-1 border-0"
          ref={iframe}
          title="VS Code workbench"
          src={session.launchUrl}
          allow="clipboard-read; clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-pointer-lock"
          referrerPolicy="no-referrer"
        />
      ) : null}
      {!ready ? (
        <div
          className={`${session ? 'absolute top-2 right-3 rounded-md border border-white/10 bg-zinc-900/95 px-3 py-2 shadow-lg' : 'flex flex-1 items-center justify-center'} text-xs text-white/65`}
          role={error ? 'alert' : 'status'}
        >
          {error ? (
            <div className="max-w-md px-4 text-center">
              <p>{error}</p>
              <button
                className="mt-3 rounded bg-white/10 px-3 py-1.5 text-white hover:bg-white/15"
                onClick={() => setAttempt((current) => current + 1)}
                type="button"
              >
                Retry VS Code
              </button>
            </div>
          ) : (
            <span className="flex items-center gap-2">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              {session ? 'Connecting to VS Code…' : 'Starting VS Code in your agent…'}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

function downloadDraft(draft: CodeDraft) {
  const url = URL.createObjectURL(new Blob([draft.content], { type: draft.contentType || 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = draft.path.split('/').at(-1) || 'recovered-draft.txt'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

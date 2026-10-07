'use client'

import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TengriPreviewSession } from '@/lib/tengri/types'
import { runTengriAction } from './client'
import { safePreviewLaunchUrl, safePreviewSessionOrigin } from './preview-session'

export function ChromeApp({
  agentId,
  onFocus,
  previewGatewayOrigin,
}: {
  agentId: string
  onFocus: () => void
  previewGatewayOrigin: string
}) {
  const [session, setSession] = useState<TengriPreviewSession | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const focus = useRef(onFocus)
  focus.current = onFocus

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
    void runTengriAction<TengriPreviewSession>({ action: 'browser-session', agentId })
      .then((value) => {
        issued = value
        if (disposed) {
          void revoke(value)
          return
        }
        const launchUrl = safePreviewLaunchUrl(value.launchUrl, previewGatewayOrigin)
        const previewOrigin = safePreviewSessionOrigin(value.previewOrigin, value.id)
        if (!launchUrl || !previewOrigin) throw new Error('Tengri returned an invalid browser session')
        setSession({ ...value, launchUrl, previewOrigin })
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Chrome could not be started')
      })
    return () => {
      disposed = true
      if (issued) void revoke(issued)
    }
  }, [agentId, attempt, previewGatewayOrigin])

  useEffect(() => {
    if (!session) return
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== session.previewOrigin) return
      if (typeof event.data !== 'object' || event.data === null) return
      const message = event.data
      if (
        !('channel' in message) ||
        message.channel !== 'tengri-browser-v1' ||
        !('sessionId' in message) ||
        message.sessionId !== session.id ||
        !('type' in message)
      )
        return
      if (message.type === 'ready') {
        setReady(true)
        setError('')
      } else if (message.type === 'focus') focus.current()
      else if (message.type === 'error') {
        setReady(false)
        setError('error' in message && typeof message.error === 'string' ? message.error : 'Chrome disconnected')
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [session])

  useEffect(() => {
    if (!session || ready) return
    const timeout = window.setTimeout(() => setError('Chrome is not responding. Retry to reconnect.'), 30_000)
    return () => window.clearTimeout(timeout)
  }, [ready, session])

  return (
    <div className="relative h-full w-full bg-[#202124]">
      {session ? (
        <iframe
          ref={frame}
          title="Chrome browser"
          src={session.launchUrl}
          data-window-default-focus
          className="h-full w-full border-0"
          allow={`clipboard-read ${session.previewOrigin}; clipboard-write ${session.previewOrigin}`}
          referrerPolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts"
        />
      ) : null}
      {!ready || error ? (
        <div className="absolute inset-0 z-10 grid place-content-center gap-3 bg-[#202124] p-8 text-center text-sm text-zinc-400">
          {error ? (
            <>
              <p role="alert">{error}</p>
              <button
                type="button"
                className="justify-self-center rounded-lg bg-white/8 px-4 py-2 text-zinc-200 outline-none hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-blue-400"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Reconnect Chrome
              </button>
            </>
          ) : (
            <p role="status" className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Starting Chrome…
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

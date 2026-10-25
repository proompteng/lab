'use client'

import { reportBrowserFailure } from '@/lib/observability/client'

import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDesktopPreview } from './use-desktop-preview'

export function ChromeApp({
  agentId,
  desktopId,
  windowId,
  onFocus,
  previewGatewayOrigin,
}: {
  agentId: string
  desktopId: string
  windowId: string
  onFocus: () => void
  previewGatewayOrigin: string
}) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (error) reportBrowserFailure('chrome.connection')
  }, [error])
  const frame = useRef<HTMLIFrameElement>(null)
  const focus = useRef(onFocus)
  focus.current = onFocus

  const preview = useDesktopPreview({
    action: 'browser-session',
    agentId,
    frame,
    previewGatewayOrigin,
    windowId: `${desktopId}-${windowId}`,
  })
  const { session, connectionGeneration } = preview
  const connectionError = preview.error || error
  useEffect(() => {
    setReady(false)
    setError('')
  }, [session, connectionGeneration])

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
          key={connectionGeneration}
          ref={frame}
          title="Chrome browser"
          src={connectionGeneration ? session.previewOrigin : session.launchUrl}
          data-window-default-focus
          className="h-full w-full border-0"
          allow={`clipboard-read ${session.previewOrigin}; clipboard-write ${session.previewOrigin}`}
          referrerPolicy="no-referrer"
          sandbox="allow-same-origin allow-scripts"
        />
      ) : null}
      {preview.renewalFrame}
      {!ready || connectionError ? (
        <div
          className={
            ready && !preview.error
              ? 'absolute inset-x-3 top-3 z-10 flex items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-zinc-900/95 p-3 text-sm text-zinc-200'
              : 'absolute inset-0 z-10 grid place-content-center gap-3 bg-[#202124] p-8 text-center text-sm text-zinc-400'
          }
        >
          {connectionError ? (
            <>
              <p role="alert">{connectionError}</p>
              <button
                type="button"
                className="justify-self-center rounded-lg bg-white/8 px-4 py-2 text-zinc-200 outline-none hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-blue-400"
                onClick={() => {
                  setError('')
                  preview.retry()
                }}
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

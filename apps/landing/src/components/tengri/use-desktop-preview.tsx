'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TengriPreviewSession } from '@/lib/tengri/types'
import { reportBrowserFailure } from '@/lib/observability/client'
import { runTengriAction, TengriRequestError } from './client'
import { safePreviewLaunchUrl, safePreviewSessionOrigin } from './preview-session'

export function useDesktopPreview({
  action,
  agentId,
  frame,
  previewGatewayOrigin,
  windowId,
}: {
  action: 'editor-session' | 'browser-session'
  agentId: string
  frame: RefObject<HTMLIFrameElement | null>
  previewGatewayOrigin: string
  windowId: string
}) {
  const [session, setSession] = useState<TengriPreviewSession | null>(null)
  const [error, setError] = useState('')
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  useEffect(() => {
    if (error) reportBrowserFailure('preview.lease')
  }, [error])
  const [renewal, setRenewal] = useState<{ launchUrl: string; nonce: string } | null>(null)
  const renewalFrame = useRef<HTMLIFrameElement>(null)
  const retry = useRef(() => {})

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let current: TengriPreviewSession | null = null
    let issued: TengriPreviewSession | null = null
    let confirmed: TengriPreviewSession | null = null
    let pendingNonce: string | null = null
    let inFlight = false
    let failures = 0
    let timer: number | undefined
    let acknowledged = false
    let leaseId: string | null = null
    let issuedAt = 0
    let reconnect = false
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
    const schedule = (delay: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void start()
      }, delay)
    }
    const fail = (cause: unknown) => {
      if (disposed || controller.signal.aborted) return
      window.clearTimeout(timer)
      pendingNonce = null
      if (issued && issued !== confirmed) {
        void revoke(issued)
        issued = confirmed
      }
      setRenewal(null)
      const transient =
        cause instanceof TypeError ||
        (cause instanceof TengriRequestError && (cause.status === 408 || cause.status === 429 || cause.status >= 500))
      if (transient) {
        schedule(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)))
        if (failures < 3) return
      }
      setError(cause instanceof Error ? cause.message : 'Workspace connection failed')
    }
    async function start(ensureRunning = false) {
      if (disposed || inFlight || pendingNonce) return
      window.clearTimeout(timer)
      setError('')
      inFlight = true
      try {
        issuedAt = performance.now()
        const value = await runTengriAction<TengriPreviewSession>(
          { action, agentId, windowId, renewal: acknowledged && !ensureRunning },
          controller.signal,
        )
        issued = value
        if (disposed) {
          void revoke(value)
          return
        }
        const launchUrl = safePreviewLaunchUrl(value.launchUrl, previewGatewayOrigin)
        const previewOrigin = safePreviewSessionOrigin(value.previewOrigin, value.id)
        if (
          !launchUrl ||
          !previewOrigin ||
          (current && (current.id !== value.id || current.previewOrigin !== previewOrigin))
        )
          throw new Error('Tengri returned an invalid workspace session')
        if (!current || !acknowledged) {
          current = { ...value, launchUrl, previewOrigin }
          setSession(current)
        } else {
          reconnect = ensureRunning
          pendingNonce = crypto.randomUUID()
          const url = new URL(launchUrl)
          url.searchParams.set('__tengri_renew', pendingNonce)
          setRenewal({ launchUrl: url.href, nonce: pendingNonce })
        }
        timer = window.setTimeout(() => fail(new TypeError('Workspace authorization renewal timed out')), 30_000)
      } catch (cause) {
        fail(cause)
      } finally {
        inFlight = false
      }
    }
    const receive = (event: MessageEvent<unknown>) => {
      if (!current || event.origin !== current.previewOrigin || typeof event.data !== 'object' || event.data === null)
        return
      const message = event.data
      if (
        !('channel' in message) ||
        message.channel !== 'tengri-preview-lease-v1' ||
        !('sessionId' in message) ||
        message.sessionId !== current.id ||
        !('nonce' in message) ||
        (pendingNonce
          ? event.source !== renewalFrame.current?.contentWindow || message.nonce !== pendingNonce
          : acknowledged || event.source !== frame.current?.contentWindow || message.nonce !== '')
      )
        return
      if (!('type' in message)) return
      if (message.type === 'error') {
        fail(new Error('Workspace authorization was rejected'))
        return
      }
      if (
        message.type !== 'renewed' ||
        !('expiresInMs' in message) ||
        typeof message.expiresInMs !== 'number' ||
        !Number.isFinite(message.expiresInMs) ||
        message.expiresInMs <= 0 ||
        message.expiresInMs > 30 * 60_000 ||
        !('leaseId' in message) ||
        typeof message.leaseId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(message.leaseId)
      )
        return
      const remaining = message.expiresInMs - (performance.now() - issuedAt)
      if (remaining <= 0) return
      if (acknowledged && (reconnect || leaseId !== message.leaseId)) setConnectionGeneration((value) => value + 1)
      leaseId = message.leaseId
      reconnect = false
      pendingNonce = null
      acknowledged = true
      confirmed = issued
      failures = 0
      setError('')
      setRenewal(null)
      schedule(Math.max(1000, remaining / 2))
    }
    retry.current = () => {
      failures = 0
      void start(true)
    }
    setSession(null)
    setRenewal(null)
    setConnectionGeneration(0)
    setError('')
    window.addEventListener('message', receive)
    void start()
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
      window.removeEventListener('message', receive)
      if (issued) void revoke(issued)
      if (confirmed && confirmed !== issued) void revoke(confirmed)
    }
  }, [action, agentId, frame, previewGatewayOrigin, windowId])

  return {
    session,
    error,
    retry: () => retry.current(),
    connectionGeneration,
    renewalFrame: renewal ? (
      <iframe
        key={renewal.nonce}
        ref={renewalFrame}
        src={renewal.launchUrl}
        title="Renew workspace connection"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
    ) : null,
  }
}

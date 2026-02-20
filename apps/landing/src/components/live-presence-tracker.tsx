'use client'

import { useEffect, useRef } from 'react'
import {
  getPresenceHeartbeatSeconds,
  LIVE_PRESENCE_ENABLED,
  normalizePresencePath,
  type PresenceEvent,
} from '@/lib/live-presence'

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL

type PresencePayload = {
  event: PresenceEvent
  sessionId: string
  path: string
}

export default function LivePresenceTracker() {
  if (!LIVE_PRESENCE_ENABLED || !convexUrl) {
    return null
  }

  return <PresenceRuntime />
}

function PresenceRuntime() {
  const sessionIdRef = useRef<string>('')
  const heartbeatTimerRef = useRef<number | null>(null)

  useEffect(() => {
    sessionIdRef.current = createSessionId()
    const heartbeatIntervalMs = getPresenceHeartbeatSeconds() * 1000

    const sendEvent = (event: PresenceEvent, preferBeacon: boolean) => {
      const payload: PresencePayload = {
        event,
        sessionId: sessionIdRef.current,
        path: normalizePresencePath(window.location.pathname),
      }

      const encoded = JSON.stringify(payload)
      if (preferBeacon && typeof navigator.sendBeacon === 'function') {
        const sent = navigator.sendBeacon('/api/presence', new Blob([encoded], { type: 'application/json' }))
        if (sent) {
          return
        }
      }

      void fetch('/api/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encoded,
        keepalive: preferBeacon,
        cache: 'no-store',
      })
    }

    const stopHeartbeat = () => {
      if (heartbeatTimerRef.current === null) {
        return
      }

      window.clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }

    const startHeartbeat = () => {
      if (heartbeatTimerRef.current !== null) {
        return
      }

      heartbeatTimerRef.current = window.setInterval(() => {
        if (document.visibilityState !== 'visible') {
          return
        }

        sendEvent('heartbeat', false)
      }, heartbeatIntervalMs)
    }

    sendEvent('join', false)
    startHeartbeat()

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        sendEvent('join', false)
        startHeartbeat()
      } else {
        stopHeartbeat()
        sendEvent('leave', true)
      }
    }

    const handlePageHide = () => {
      stopHeartbeat()
      sendEvent('leave', true)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      stopHeartbeat()
      sendEvent('leave', true)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [])

  return null
}

function createSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

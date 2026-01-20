import * as React from 'react'

import type { AgentPrimitiveKind, ControlPlaneStatus, PrimitiveResource } from '@/data/agents-control-plane'

export type ControlPlaneStreamStatus = 'connecting' | 'open' | 'error' | 'closed'

export type ControlPlaneResourceEvent = {
  type: 'resource'
  kind: AgentPrimitiveKind
  namespace: string
  action: string | null
  name: string | null
  resource: PrimitiveResource
}

export type ControlPlaneStatusEvent = {
  type: 'status'
  namespace: string
  status: ControlPlaneStatus
}

export type ControlPlaneErrorEvent = {
  type: 'error'
  namespace: string
  message: string
}

export type ControlPlaneStreamEvent = ControlPlaneResourceEvent | ControlPlaneStatusEvent | ControlPlaneErrorEvent

type ControlPlaneStreamHandlers = {
  onEvent?: (event: ControlPlaneStreamEvent) => void
}

type ControlPlaneStreamState = {
  status: ControlPlaneStreamStatus
  error: string | null
  lastEventAt: string | null
}

const safeParseJson = (value: string) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const isStreamEvent = (payload: unknown): payload is ControlPlaneStreamEvent => {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return typeof record.type === 'string'
}

export const useControlPlaneStream = (
  namespace: string,
  handlers: ControlPlaneStreamHandlers,
): ControlPlaneStreamState => {
  const [status, setStatus] = React.useState<ControlPlaneStreamStatus>('connecting')
  const [error, setError] = React.useState<string | null>(null)
  const [lastEventAt, setLastEventAt] = React.useState<string | null>(null)
  const openedRef = React.useRef(false)
  const handlersRef = React.useRef(handlers)

  React.useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  React.useEffect(() => {
    const trimmedNamespace = namespace.trim()
    if (!trimmedNamespace) {
      setStatus('closed')
      setError(null)
      setLastEventAt(null)
      return
    }

    setStatus('connecting')
    setError(null)
    setLastEventAt(null)
    openedRef.current = false

    const params = new URLSearchParams({ namespace: trimmedNamespace })
    const source = new EventSource(`/api/agents/control-plane/stream?${params.toString()}`)

    source.onopen = () => {
      openedRef.current = true
      setStatus('open')
      setError(null)
    }

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus('error')
        setError('Stream disconnected.')
        return
      }
      if (!openedRef.current) {
        setStatus('connecting')
        setError(null)
        return
      }
      setStatus('open')
      setError(null)
    }

    source.onmessage = (event) => {
      if (!event.data) return
      const parsed = safeParseJson(event.data)
      if (!isStreamEvent(parsed)) return
      handlersRef.current.onEvent?.(parsed)
      setLastEventAt(new Date().toISOString())
    }

    return () => {
      source.close()
      setStatus('closed')
    }
  }, [namespace])

  return { status, error, lastEventAt }
}

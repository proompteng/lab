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

type ControlPlaneStreamOptions = {
  emitState?: boolean
}

type ControlPlaneReloadOptions = {
  minIntervalMs?: number
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
  options: ControlPlaneStreamOptions = {},
): ControlPlaneStreamState => {
  const emitState = options.emitState ?? true
  const [status, setStatus] = React.useState<ControlPlaneStreamStatus>(() => (emitState ? 'connecting' : 'closed'))
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
      if (emitState) {
        setStatus('closed')
        setError(null)
        setLastEventAt(null)
      }
      return
    }

    if (emitState) {
      setStatus('connecting')
      setError(null)
      setLastEventAt(null)
    }
    openedRef.current = false

    const params = new URLSearchParams({ namespace: trimmedNamespace })
    const source = new EventSource(`/api/agents/control-plane/stream?${params.toString()}`)

    source.onopen = () => {
      openedRef.current = true
      if (emitState) {
        setStatus('open')
        setError(null)
      }
    }

    source.onerror = () => {
      if (!emitState) return
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
      if (emitState) {
        setLastEventAt(new Date().toISOString())
      }
    }

    return () => {
      source.close()
      if (emitState) {
        setStatus('closed')
      }
    }
  }, [emitState, namespace])

  return { status, error, lastEventAt }
}

export const useControlPlaneReload = (onReload: () => void, options: ControlPlaneReloadOptions = {}): (() => void) => {
  const minIntervalMs = options.minIntervalMs ?? 5_000
  const timerRef = React.useRef<number | null>(null)
  const lastReloadAtRef = React.useRef(0)
  const onReloadRef = React.useRef(onReload)

  React.useEffect(() => {
    onReloadRef.current = onReload
  }, [onReload])

  React.useEffect(
    () => () => {
      if (timerRef.current === null) return
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    },
    [],
  )

  return React.useCallback(() => {
    if (timerRef.current !== null) return
    const now = Date.now()
    const elapsed = now - lastReloadAtRef.current
    const delay = elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      lastReloadAtRef.current = Date.now()
      onReloadRef.current()
    }, delay)
  }, [minIntervalMs])
}

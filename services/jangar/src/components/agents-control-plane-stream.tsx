import * as React from 'react'

import type { ResourceRevisionEntry } from '@/components/agents-control-plane'
import { getResourcePhase } from '@/components/agents-control-plane'
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

export type ControlPlaneStreamState = {
  status: ControlPlaneStreamStatus
  error: string | null
  lastEventAt: string | null
}

export type ResourceStreamEvent = {
  type: string
  kind: AgentPrimitiveKind
  namespace: string
  name: string | null
  resource: PrimitiveResource
}

export type ResourceStreamErrorEvent = {
  type: 'ERROR'
  error: string
}

type ResourceStreamHandlers = {
  onEvent?: (event: ResourceStreamEvent) => void
  onError?: (message: string) => void
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

const isResourceStreamEvent = (payload: unknown): payload is ResourceStreamEvent => {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  if (typeof record.type !== 'string') return false
  if (typeof record.kind !== 'string') return false
  if (typeof record.namespace !== 'string') return false
  if (!record.resource || typeof record.resource !== 'object' || Array.isArray(record.resource)) return false
  return true
}

const isResourceErrorEvent = (payload: unknown): payload is ResourceStreamErrorEvent => {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return record.type === 'ERROR' && typeof record.error === 'string'
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

export const useControlPlaneResourceStream = (
  params: { kind: AgentPrimitiveKind; name: string; namespace: string },
  handlers: ResourceStreamHandlers,
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
    const trimmedNamespace = params.namespace.trim()
    const trimmedName = params.name.trim()
    if (!trimmedNamespace || !trimmedName) {
      setStatus('closed')
      setError(null)
      setLastEventAt(null)
      return
    }

    setStatus('connecting')
    setError(null)
    setLastEventAt(null)
    openedRef.current = false

    const searchParams = new URLSearchParams({
      kind: params.kind,
      name: trimmedName,
      namespace: trimmedNamespace,
      stream: '1',
    })
    const source = new EventSource(`/api/agents/control-plane/resource?${searchParams.toString()}`)

    source.onopen = () => {
      openedRef.current = true
      setStatus('open')
      setError(null)
    }

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus('error')
        const message = 'Stream disconnected.'
        setError(message)
        handlersRef.current.onError?.(message)
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
      if (isResourceErrorEvent(parsed)) {
        setStatus('error')
        setError(parsed.error)
        handlersRef.current.onError?.(parsed.error)
        return
      }
      if (!isResourceStreamEvent(parsed)) return
      if (parsed.kind !== params.kind) return
      handlersRef.current.onEvent?.(parsed)
      setLastEventAt(new Date().toISOString())
    }

    return () => {
      source.close()
      setStatus('closed')
    }
  }, [params.kind, params.name, params.namespace])

  return { status, error, lastEventAt }
}

export const useResourceRevisionTimeline = (params: {
  kind: AgentPrimitiveKind
  name: string
  namespace: string
  limit?: number
  onResource?: (resource: PrimitiveResource) => void
}) => {
  const limit = params.limit ?? 25
  const [entries, setEntries] = React.useState<ResourceRevisionEntry[]>([])
  const [streamError, setStreamError] = React.useState<string | null>(null)
  const entryIdRef = React.useRef(0)

  const stream = useControlPlaneResourceStream(
    { kind: params.kind, name: params.name, namespace: params.namespace },
    {
      onEvent: (event) => {
        entryIdRef.current += 1
        const timestamp = new Date().toISOString()
        const entry: ResourceRevisionEntry = {
          id: `${timestamp}-${entryIdRef.current}`,
          type: event.type,
          timestamp,
          name: event.name ?? params.name,
          namespace: event.namespace ?? params.namespace,
          phase: getResourcePhase(event.resource),
        }
        setEntries((prev) => [entry, ...prev].slice(0, limit))
        params.onResource?.(event.resource)
      },
      onError: (message) => setStreamError(message),
    },
  )

  React.useEffect(() => {
    void params.kind
    void params.name
    void params.namespace
    void limit
    setEntries([])
    setStreamError(null)
    entryIdRef.current = 0
  }, [params.kind, params.name, params.namespace, limit])

  return { entries, status: stream.status, error: streamError ?? stream.error }
}

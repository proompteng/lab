export type AgentPrimitiveKind =
  | 'Agent'
  | 'AgentRun'
  | 'AgentProvider'
  | 'ImplementationSpec'
  | 'ImplementationSource'
  | 'Memory'
  | 'Tool'
  | 'ToolRun'
  | 'ApprovalPolicy'
  | 'Budget'
  | 'Signal'
  | 'SignalDelivery'
  | 'Schedule'
  | 'Artifact'
  | 'Workspace'
  | 'SecretBinding'
  | 'Orchestration'
  | 'OrchestrationRun'

export type PrimitiveResource = {
  apiVersion: string | null
  kind: string | null
  metadata: Record<string, unknown>
  spec: Record<string, unknown>
  status: Record<string, unknown>
}

export type PrimitiveListResult =
  | { ok: true; items: PrimitiveResource[]; total: number; kind: AgentPrimitiveKind; namespace: string }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type PrimitiveDetailResult =
  | { ok: true; resource: Record<string, unknown>; kind: AgentPrimitiveKind; namespace: string }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type PrimitiveEventItem = {
  name: string | null
  namespace: string | null
  type: string | null
  reason: string | null
  action: string | null
  count: number | null
  message: string | null
  firstTimestamp: string | null
  lastTimestamp: string | null
  eventTime: string | null
  involvedObject: unknown
}

export type PrimitiveEventsResult =
  | {
      ok: true
      items: PrimitiveEventItem[]
      kind: AgentPrimitiveKind
      namespace: string
      name: string
    }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type ControllerStatus = {
  name: string
  enabled: boolean
  started: boolean
  crds_ready: boolean
  missing_crds: string[]
  last_checked_at: string
  status: 'healthy' | 'degraded' | 'disabled' | 'unknown'
  message: string
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: 'healthy' | 'configured' | 'degraded' | 'disabled' | 'unknown'
  message: string
  endpoint: string
}

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
  latency_ms: number
}

export type GrpcStatus = {
  enabled: boolean
  address: string
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
}

export type NamespaceStatus = {
  namespace: string
  status: 'healthy' | 'degraded'
  degraded_components: string[]
}

export type ControlPlaneStatus = {
  service: string
  generated_at: string
  controllers: ControllerStatus[]
  runtime_adapters: RuntimeAdapterStatus[]
  database: DatabaseStatus
  grpc: GrpcStatus
  namespaces: NamespaceStatus[]
}

export type ControlPlaneStatusResult =
  | { ok: true; status: ControlPlaneStatus }
  | { ok: false; message: string; status?: number; raw?: unknown }

const extractErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message
  if (typeof record.detail === 'string') return record.detail
  return null
}

const parseResponse = async (response: Response) => {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false as const,
      message: extractErrorMessage(payload) ?? response.statusText,
      status: response.status,
      raw: payload,
    }
  }
  return payload
}

export const fetchPrimitiveList = async (params: {
  kind: AgentPrimitiveKind
  namespace: string
  phase?: string
  runtime?: string
  limit?: number
  signal?: AbortSignal
}): Promise<PrimitiveListResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    namespace: params.namespace,
  })
  if (params.phase) {
    searchParams.set('phase', params.phase)
  }
  if (params.runtime) {
    searchParams.set('runtime', params.runtime)
  }
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/agents/control-plane/resources?${searchParams.toString()}`, {
    signal: params.signal,
  })

  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }

  const record = payload as Record<string, unknown>
  const items = Array.isArray(record.items) ? (record.items as PrimitiveResource[]) : []
  const total = typeof record.total === 'number' ? record.total : items.length
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  return { ok: true, items, total, kind: params.kind, namespace }
}

export const fetchPrimitiveDetail = async (params: {
  kind: AgentPrimitiveKind
  name: string
  namespace: string
  signal?: AbortSignal
}): Promise<PrimitiveDetailResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    name: params.name,
    namespace: params.namespace,
  })
  const response = await fetch(`/api/agents/control-plane/resource?${searchParams.toString()}`, {
    signal: params.signal,
  })
  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }
  const record = payload as Record<string, unknown>
  const resource =
    record.resource && typeof record.resource === 'object' ? (record.resource as Record<string, unknown>) : {}
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  return { ok: true, resource, kind: params.kind, namespace }
}

export const fetchPrimitiveEvents = async (params: {
  kind: AgentPrimitiveKind
  name: string
  namespace: string
  uid?: string | null
  limit?: number
  signal?: AbortSignal
}): Promise<PrimitiveEventsResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    name: params.name,
    namespace: params.namespace,
  })
  if (params.uid) {
    searchParams.set('uid', params.uid)
  }
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/agents/control-plane/events?${searchParams.toString()}`, {
    signal: params.signal,
  })
  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }
  const record = payload as Record<string, unknown>
  const items = Array.isArray(record.items) ? (record.items as PrimitiveEventItem[]) : []
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  const name = typeof record.name === 'string' ? record.name : params.name
  return { ok: true, items, kind: params.kind, namespace, name }
}

export const fetchControlPlaneStatus = async (params: {
  namespace: string
  signal?: AbortSignal
}): Promise<ControlPlaneStatusResult> => {
  const searchParams = new URLSearchParams({ namespace: params.namespace })
  const response = await fetch(`/api/agents/control-plane/status?${searchParams.toString()}`, {
    signal: params.signal,
  })

  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }

  return { ok: true, status: payload as ControlPlaneStatus }
}

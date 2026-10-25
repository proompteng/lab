import {
  createMemoryEmbeddingIndexIfReady as defaultCreateMemoryEmbeddingIndexIfReady,
  queryMemory as defaultQueryMemory,
  resolveMemoryConnection as defaultResolveMemoryConnection,
  writeMemoryEmbedding as defaultWriteMemoryEmbedding,
  writeMemoryEvent as defaultWriteMemoryEvent,
  writeMemoryKv as defaultWriteMemoryKv,
} from '../memory-provider'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
import { asRecord, asString, normalizeNamespace } from '../primitives'

export type MemoryOperationsApiDependencies = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  requireLeaderForMutation?: () => Response | null
  resolveMemoryConnection?: typeof defaultResolveMemoryConnection
  writeMemoryEvent?: typeof defaultWriteMemoryEvent
  writeMemoryKv?: typeof defaultWriteMemoryKv
  writeMemoryEmbedding?: typeof defaultWriteMemoryEmbedding
  queryMemory?: typeof defaultQueryMemory
  createMemoryEmbeddingIndexIfReady?: typeof defaultCreateMemoryEmbeddingIndexIfReady
}

type MemoryOperationPayload =
  | {
      operation: 'event'
      memoryRef: string
      namespace: string
      eventType: string
      payload: Record<string, unknown>
    }
  | {
      operation: 'kv'
      memoryRef: string
      namespace: string
      key: string
      value: Record<string, unknown>
    }
  | {
      operation: 'embedding'
      memoryRef: string
      namespace: string
      key: string
      text: string
      metadata: Record<string, unknown>
    }
  | {
      operation: 'query'
      memoryRef: string
      namespace: string
      query: string
      limit?: number
    }
  | {
      operation: 'embedding-index'
      memoryRef: string
      namespace: string
    }

const getKubeClient = (deps: MemoryOperationsApiDependencies) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const parseMemoryRef = (payload: Record<string, unknown>) => {
  const memoryRefRaw = asString(payload.memoryRef)
  if (!memoryRefRaw) throw new Error('memoryRef is required')
  let memoryRef = memoryRefRaw
  let namespace = normalizeNamespace(asString(payload.namespace))
  if (memoryRefRaw.includes('/')) {
    const [ns, name] = memoryRefRaw.split('/', 2)
    if (ns && name) {
      namespace = ns
      memoryRef = name
    }
  }
  return { memoryRef, namespace }
}

const parsePositiveLimit = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

export const parseMemoryOperationPayload = (payload: Record<string, unknown>): MemoryOperationPayload => {
  const { memoryRef, namespace } = parseMemoryRef(payload)
  const operation = asString(payload.operation)

  if (operation === 'event') {
    const eventType = asString(payload.eventType)
    if (!eventType) throw new Error('eventType is required for memory event operations')
    return {
      operation,
      memoryRef,
      namespace,
      eventType,
      payload: asRecord(payload.payload) ?? {},
    }
  }

  if (operation === 'kv') {
    const key = asString(payload.key)
    if (!key) throw new Error('key is required for memory kv operations')
    const value = asRecord(payload.value)
    if (!value) throw new Error('value is required for memory kv operations')
    return { operation, memoryRef, namespace, key, value }
  }

  if (operation === 'embedding') {
    const key = asString(payload.key)
    if (!key) throw new Error('key is required for memory embedding operations')
    const text = asString(payload.text)
    if (!text) throw new Error('text is required for memory embedding operations')
    return {
      operation,
      memoryRef,
      namespace,
      key,
      text,
      metadata: asRecord(payload.metadata) ?? {},
    }
  }

  if (operation === 'query') {
    const query = asString(payload.query)
    if (!query) throw new Error('query is required for memory query operations')
    return {
      operation,
      memoryRef,
      namespace,
      query,
      limit: parsePositiveLimit(payload.limit),
    }
  }

  if (operation === 'embedding-index') {
    return { operation, memoryRef, namespace }
  }

  throw new Error('operation must be one of event, kv, embedding, query, embedding-index')
}

export const postMemoryOperationsHandler = async (request: Request, deps: MemoryOperationsApiDependencies = {}) => {
  try {
    requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseMemoryOperationPayload(payload)
    if (parsed.operation !== 'query') {
      const leaderResponse = deps.requireLeaderForMutation?.()
      if (leaderResponse) return leaderResponse
    }
    const kube = getKubeClient(deps)
    const resolveMemoryConnection = deps.resolveMemoryConnection ?? defaultResolveMemoryConnection
    const connection = await resolveMemoryConnection(parsed.memoryRef, parsed.namespace, kube)

    if (parsed.operation === 'event') {
      await (deps.writeMemoryEvent ?? defaultWriteMemoryEvent)(connection, parsed.eventType, parsed.payload)
      return okResponse({
        ok: true,
        operation: parsed.operation,
        memoryRef: parsed.memoryRef,
        namespace: parsed.namespace,
      })
    }

    if (parsed.operation === 'kv') {
      await (deps.writeMemoryKv ?? defaultWriteMemoryKv)(connection, parsed.key, parsed.value)
      return okResponse({
        ok: true,
        operation: parsed.operation,
        memoryRef: parsed.memoryRef,
        namespace: parsed.namespace,
      })
    }

    if (parsed.operation === 'embedding') {
      await (deps.writeMemoryEmbedding ?? defaultWriteMemoryEmbedding)(
        connection,
        parsed.key,
        parsed.text,
        parsed.metadata,
      )
      return okResponse({
        ok: true,
        operation: parsed.operation,
        memoryRef: parsed.memoryRef,
        namespace: parsed.namespace,
      })
    }

    if (parsed.operation === 'embedding-index') {
      const created = await (deps.createMemoryEmbeddingIndexIfReady ?? defaultCreateMemoryEmbeddingIndexIfReady)(
        connection,
      )
      return okResponse({
        ok: true,
        operation: parsed.operation,
        memoryRef: parsed.memoryRef,
        namespace: parsed.namespace,
        created,
      })
    }

    const results = await (deps.queryMemory ?? defaultQueryMemory)(connection, parsed.query, parsed.limit ?? 10)
    return okResponse({
      ok: true,
      operation: parsed.operation,
      memoryRef: parsed.memoryRef,
      namespace: parsed.namespace,
      results,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  }
}

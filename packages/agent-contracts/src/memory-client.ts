import {
  buildAgentsServiceUrl,
  fetchAgentsJson,
  postAgentsJson,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type { AgentsServiceJsonResult } from './agents-http'

export type AgentsMemoryResourceInput = {
  name: string
  namespace?: string | null
}

export type AgentsMemoryResource = Record<string, unknown>

export type AgentsMemoryResourceResult = {
  ok: boolean
  kind?: 'Memory' | string | null
  namespace?: string | null
  resource?: AgentsMemoryResource | null
}

export const fetchMemoryResourceFromAgentsService = async (
  input: AgentsMemoryResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryResourceResult>> => {
  const targetUrl = buildAgentsServiceUrl('/v1/memories/resources', env)
  targetUrl.searchParams.set('name', input.name)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  return fetchAgentsJson<AgentsMemoryResourceResult>(servicePath(targetUrl), env)
}

export type AgentsMemoryOperation =
  | {
      operation: 'event'
      eventType: string
      payload?: Record<string, unknown>
    }
  | {
      operation: 'kv'
      key: string
      value: Record<string, unknown>
    }
  | {
      operation: 'embedding'
      key: string
      text: string
      metadata?: Record<string, unknown>
    }
  | {
      operation: 'query'
      query: string
      limit?: number | null
    }

export type AgentsMemoryOperationInput = {
  deliveryId: string
  memoryRef: string
  namespace?: string | null
  operation: AgentsMemoryOperation
}

export type AgentsMemoryOperationResult = {
  ok: boolean
  operation?: string | null
  memoryRef?: string | null
  namespace?: string | null
  results?: { key: string; score: number | null; metadata: Record<string, unknown> }[]
}

export const submitMemoryOperationToAgentsService = async (
  input: AgentsMemoryOperationInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryOperationResult>> => {
  const payload = {
    memoryRef: input.memoryRef,
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...input.operation,
  }

  return postAgentsJson<AgentsMemoryOperationResult>('/v1/memory-operations', payload, {
    env,
    idempotencyKey: input.deliveryId,
  })
}

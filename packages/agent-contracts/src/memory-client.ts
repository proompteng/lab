import {
  resolveAgentsServiceBaseUrl,
  resolveAgentsServiceClientName,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-service-client'
import {
  fetchAgentsNamedResource,
  type AgentsNamedResourceInput,
  type AgentsResourceResult,
} from './agents-resource-endpoints'

export type { AgentsNamedResourceInput, AgentsResourceResult }
export type { AgentsServiceJsonResult } from './agents-service-client'

export const fetchMemoryResourceFromAgentsService = async (
  input: AgentsNamedResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> =>
  fetchAgentsNamedResource('/v1/memories/resources', input, env)

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

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJsonBody = async (response: Response): Promise<Record<string, unknown> | null> =>
  response.json().catch(() => null) as Promise<Record<string, unknown> | null>

const getBodyError = (body: Record<string, unknown> | null) => {
  const error = body?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : null
}

export const submitMemoryOperationToAgentsService = async (
  input: AgentsMemoryOperationInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsMemoryOperationResult>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/v1/memory-operations', `${baseUrl}/`)
  const payload = {
    memoryRef: input.memoryRef,
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...input.operation,
  }

  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify(payload),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': input.deliveryId,
        'x-agents-client': resolveAgentsServiceClientName(env),
      },
      method: 'POST',
    })
    const body = (await readJsonBody(upstream)) as AgentsMemoryOperationResult | null
    if (upstream.ok && body !== null) {
      return {
        ok: true,
        status: upstream.status,
        body,
      }
    }

    return {
      ok: false,
      status: upstream.status,
      body,
      error: getBodyError(body) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: getErrorMessage(error),
    }
  }
}

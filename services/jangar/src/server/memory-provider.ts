import { createHash, randomUUID } from 'node:crypto'

import {
  fetchMemoryResourceFromAgentsService,
  submitMemoryOperationToAgentsService,
  type AgentsMemoryOperation,
  type AgentsMemoryOperationResult,
  type AgentsServiceJsonResult,
} from '@proompteng/agent-contracts/memory-client'

import { resolveEmbeddingConfig } from './memory-config'

export type MemoryConnection = {
  memoryRef: string
  namespace: string
}

export type MemoryQueryResult = {
  key: string
  score: number | null
  metadata: Record<string, unknown>
}

type EnvSource = Record<string, string | undefined>
type MemoryResourceGetter = (memoryName: string, namespace: string) => Promise<Record<string, unknown> | null>
type MemoryOperationSubmitter = (
  input: {
    deliveryId: string
    memoryRef: string
    namespace: string
    operation: AgentsMemoryOperation
  },
  env?: EnvSource,
) => Promise<AgentsServiceJsonResult<AgentsMemoryOperationResult>>

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const readNested = (obj: Record<string, unknown>, path: string[]) => {
  let cursor: unknown = obj
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}

const stableOperationPrefix = (operation: AgentsMemoryOperation) =>
  createHash('sha256').update(JSON.stringify(operation)).digest('hex').slice(0, 16)

const createDeliveryId = (connection: MemoryConnection, operation: AgentsMemoryOperation) =>
  `memory-${connection.namespace}-${connection.memoryRef}-${stableOperationPrefix(operation)}-${randomUUID()}`

export const loadEmbeddingConfig = (env: EnvSource = process.env) => resolveEmbeddingConfig(env)

export const closeMemoryProviderPools = async () => undefined

const getMemoryResourceFromAgentsService: MemoryResourceGetter = async (memoryName, namespace) => {
  const result = await fetchMemoryResourceFromAgentsService({ name: memoryName, namespace })
  if (result.ok) {
    const resource = result.body.resource
    return resource && typeof resource === 'object' && !Array.isArray(resource) ? resource : null
  }
  if (result.status === 404) {
    return null
  }
  throw new Error(result.error ?? `Agents service returned HTTP ${result.status}`)
}

const assertMemoryResourceSupported = (memoryName: string, namespace: string, memory: Record<string, unknown>) => {
  const spec = (readNested(memory, ['spec']) ?? {}) as Record<string, unknown>
  const memoryType = asString(readNested(spec, ['type'])) ?? 'custom'
  if (memoryType !== 'postgres') {
    throw new Error(`memory ${memoryName} uses unsupported type ${memoryType}`)
  }

  return { memoryRef: memoryName, namespace }
}

export const resolveMemoryConnection = async (
  memoryName: string,
  namespace: string,
  _kube?: unknown,
  deps: { getMemoryResource?: MemoryResourceGetter } = {},
): Promise<MemoryConnection> => {
  const getMemoryResource = deps.getMemoryResource ?? getMemoryResourceFromAgentsService
  const memory = await getMemoryResource(memoryName, namespace)
  if (!memory) {
    throw new Error(`memory ${memoryName} not found in ${namespace}`)
  }

  return assertMemoryResourceSupported(memoryName, namespace, memory)
}

const submitMemoryOperation = async (
  connection: MemoryConnection,
  operation: AgentsMemoryOperation,
  submitter: MemoryOperationSubmitter = submitMemoryOperationToAgentsService,
) => {
  const result = await submitter({
    deliveryId: createDeliveryId(connection, operation),
    memoryRef: connection.memoryRef,
    namespace: connection.namespace,
    operation,
  })
  if (!result.ok) {
    throw new Error(result.error ?? `Agents memory operation failed with HTTP ${result.status}`)
  }
  return result.body
}

export const writeMemoryEvent = async (
  connection: MemoryConnection,
  eventType: string,
  payload: Record<string, unknown>,
  submitter?: MemoryOperationSubmitter,
) => {
  await submitMemoryOperation(connection, { operation: 'event', eventType, payload }, submitter)
}

export const writeMemoryKv = async (
  connection: MemoryConnection,
  key: string,
  value: Record<string, unknown>,
  submitter?: MemoryOperationSubmitter,
) => {
  await submitMemoryOperation(connection, { operation: 'kv', key, value }, submitter)
}

export const writeMemoryEmbedding = async (
  connection: MemoryConnection,
  key: string,
  text: string,
  metadata: Record<string, unknown> = {},
  submitter?: MemoryOperationSubmitter,
) => {
  await submitMemoryOperation(connection, { operation: 'embedding', key, text, metadata }, submitter)
}

export const queryMemory = async (
  connection: MemoryConnection,
  query: string,
  limit = 10,
  submitter?: MemoryOperationSubmitter,
): Promise<MemoryQueryResult[]> => {
  const result = await submitMemoryOperation(connection, { operation: 'query', query, limit }, submitter)
  return result.results ?? []
}

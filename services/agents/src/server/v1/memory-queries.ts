import { queryMemory, resolveMemoryConnection } from '../memory-provider'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
import { asString, normalizeNamespace } from '../primitives'

export type MemoryQueriesApiDependencies = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
}

type MemoryQueryPayload = {
  memoryRef: string
  namespace: string
  query: string
  limit?: number
}

const getKubeClient = (deps: MemoryQueriesApiDependencies) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const parseMemoryQueryPayload = (payload: Record<string, unknown>): MemoryQueryPayload => {
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
  const query = asString(payload.query)
  if (!query) throw new Error('query is required')
  const limit = typeof payload.limit === 'number' ? payload.limit : undefined
  return { memoryRef, namespace, query, limit }
}

export const postMemoryQueriesHandler = async (request: Request, deps: MemoryQueriesApiDependencies = {}) => {
  try {
    requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseMemoryQueryPayload(payload)
    const kube = getKubeClient(deps)
    const connection = await resolveMemoryConnection(parsed.memoryRef, parsed.namespace, kube)
    const results = await queryMemory(connection, parsed.query, parsed.limit ?? 10)
    return okResponse({ ok: true, results })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  }
}

import { createFileRoute } from '@tanstack/react-router'

import { queryMemory, resolveMemoryConnection } from '~/server/memory-provider'
import {
  asString,
  errorResponse,
  normalizeNamespace,
  okResponse,
  parseJsonBody,
  requireIdempotencyKey,
} from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'

export const Route = createFileRoute('/v1/memory-queries')({
  server: {
    handlers: {
      POST: async ({ request }) => postMemoryQueriesHandler(request),
    },
  },
})

type MemoryQueryPayload = {
  memoryRef: string
  namespace: string
  query: string
  limit?: number
}

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

export const postMemoryQueriesHandler = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  try {
    requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseMemoryQueryPayload(payload)
    const kube = deps.kubeClient ?? createKubernetesClient()
    const connection = await resolveMemoryConnection(parsed.memoryRef, parsed.namespace, kube)
    const results = await queryMemory(connection, parsed.query, parsed.limit ?? 10)
    return okResponse({ ok: true, results })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  }
}

import { createFileRoute } from '@tanstack/react-router'
import { type SubmitOrchestrationRunDeps, submitOrchestrationRun } from '~/server/orchestration-submit'
import {
  asRecord,
  asString,
  errorResponse,
  normalizeNamespace,
  okResponse,
  parseJsonBody,
  requireIdempotencyKey,
} from '~/server/primitives-http'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/orchestration-runs')({
  server: {
    handlers: {
      GET: async ({ request }) => getOrchestrationRunsHandler(request),
      POST: async ({ request }) => postOrchestrationRunsHandler(request),
    },
  },
})

type OrchestrationRunPayload = {
  orchestrationRef: { name: string }
  namespace: string
  parameters?: Record<string, string>
  policy?: Record<string, unknown>
}

const normalizeStringMap = (value: Record<string, unknown> | null): Record<string, string> | undefined => {
  if (!value) return undefined
  const entries = Object.entries(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return output
}

const parseOrchestrationRunPayload = (payload: Record<string, unknown>): OrchestrationRunPayload => {
  const orchestrationRef = asRecord(payload.orchestrationRef)
  const name = asString(orchestrationRef?.name)
  if (!name) throw new Error('orchestrationRef.name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const parameters = normalizeStringMap(asRecord(payload.parameters))
  const policy = asRecord(payload.policy) ?? undefined
  return { orchestrationRef: { name }, namespace, parameters, policy }
}

export const getOrchestrationRunsHandler = async (
  request: Request,
  deps: { storeFactory?: typeof createPrimitivesStore } = {},
) => {
  const url = new URL(request.url)
  const orchestrationName =
    asString(url.searchParams.get('orchestrationId')) ?? asString(url.searchParams.get('orchestrationName'))
  if (!orchestrationName) return errorResponse('orchestrationId is required', 400)

  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    await store.ready
    const runs = await store.getOrchestrationRunsByName(orchestrationName)
    return okResponse({ ok: true, runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}

export const postOrchestrationRunsHandler = async (request: Request, deps: SubmitOrchestrationRunDeps = {}) => {
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseOrchestrationRunPayload(payload)

    const result = await submitOrchestrationRun(
      {
        deliveryId,
        orchestrationRef: parsed.orchestrationRef,
        namespace: parsed.namespace,
        parameters: parsed.parameters,
        policy: parsed.policy,
      },
      deps,
    )

    if (result.idempotent) {
      return okResponse({
        ok: true,
        orchestrationRun: result.orchestrationRun,
        resource: result.resource,
        idempotent: true,
      })
    }

    return okResponse({ ok: true, orchestrationRun: result.orchestrationRun, resource: result.resource }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('orchestration') && message.includes('not found')) {
      return errorResponse(message, 404)
    }
    if (message.includes('DATABASE_URL')) {
      return errorResponse(message, 503)
    }
    if (message.includes('policy') || message.includes('budget') || message.includes('approval')) {
      return errorResponse(message, 403)
    }
    return errorResponse(message, 400)
  }
}

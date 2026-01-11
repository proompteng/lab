import { createFileRoute } from '@tanstack/react-router'
import { asRecord, asString, errorResponse, normalizeNamespace, okResponse, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getRunHandler(params.id, request),
    },
  },
})

const extractStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  return asString(status?.phase)
}

export const getRunHandler = async (
  id: string,
  request: Request,
  deps: {
    storeFactory?: typeof createPrimitivesStore
    kubeClient?: ReturnType<typeof createKubernetesClient>
  } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'))
  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    await store.ready
    const run = await store.getRunById(id)
    if (!run) return errorResponse('Run not found', 404)

    const kube = deps.kubeClient ?? createKubernetesClient()
    let resource: Record<string, unknown> | null = null
    if (run.record.externalRunId) {
      const resourceNamespace =
        asString(readNested(run.record.payload, ['resource', 'metadata', 'namespace'])) ??
        asString(readNested(run.record.payload, ['request', 'namespace'])) ??
        namespace
      const resourceName = run.record.externalRunId
      const resourceType = run.kind === 'agent' ? RESOURCE_MAP.AgentRun : RESOURCE_MAP.OrchestrationRun
      resource = await kube.get(resourceType, resourceName, resourceNamespace)
      if (resource) {
        const phase = extractStatusPhase(resource)
        if (phase && phase !== run.record.status) {
          if (run.kind === 'agent') {
            await store.updateAgentRunStatus(run.record.id, phase, run.record.externalRunId)
          } else {
            await store.updateOrchestrationRunStatus(run.record.id, phase, run.record.externalRunId)
          }
          run.record.status = phase
        }
      }
    }

    return okResponse({ ok: true, kind: run.kind, run: run.record, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}

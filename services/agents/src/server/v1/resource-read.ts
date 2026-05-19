import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'
import { hydrateMemoryRecord } from '../primitives-memory'
import type { OrchestrationRunRecord } from '../primitives-store'

export type ResourceReadDependencies = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
}

export type OrchestrationRunReadStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getOrchestrationRunById: (id: string) => Promise<OrchestrationRunRecord | null>
  updateOrchestrationRunDetails: (input: {
    id: string
    status: string
    externalRunId: string | null
    payload: Record<string, unknown>
  }) => Promise<OrchestrationRunRecord | null>
}

export type OrchestrationRunReadDependencies = ResourceReadDependencies & {
  storeFactory: () => OrchestrationRunReadStore
}

export type MemoryReadStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  upsertMemoryResource: (input: {
    memoryName: string
    provider: string
    status: string
    connectionSecret: Record<string, unknown> | null
  }) => Promise<unknown>
}

export type MemoryReadDependencies = ResourceReadDependencies & {
  storeFactory: () => MemoryReadStore
}

const getKubeClient = (deps: ResourceReadDependencies) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const readNamespace = (request: Request) => normalizeNamespace(new URL(request.url).searchParams.get('namespace'))

const extractStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  return asString(status?.phase)
}

export const getAgentHandler = async (id: string, request: Request, deps: ResourceReadDependencies = {}) => {
  const namespace = readNamespace(request)
  const kube = getKubeClient(deps)

  try {
    const resource = await kube.get(RESOURCE_MAP.Agent, id, namespace)
    if (!resource) return errorResponse('Agent not found', 404)
    return okResponse({ ok: true, agent: resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace, id: asString(id) })
  }
}

export const getOrchestrationHandler = async (id: string, request: Request, deps: ResourceReadDependencies = {}) => {
  const namespace = readNamespace(request)
  const kube = getKubeClient(deps)

  try {
    const resource = await kube.get(RESOURCE_MAP.Orchestration, id, namespace)
    if (!resource) return errorResponse('Orchestration not found', 404)
    return okResponse({ ok: true, orchestration: resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace, id: asString(id) })
  }
}

export const getOrchestrationRunHandler = async (
  id: string,
  request: Request,
  deps: OrchestrationRunReadDependencies,
) => {
  const namespace = readNamespace(request)
  const store = deps.storeFactory()
  try {
    await store.ready
    const record = await store.getOrchestrationRunById(id)
    if (!record) return errorResponse('OrchestrationRun not found', 404)

    const resourceNamespace =
      asString(readNested(record.payload, ['resource', 'metadata', 'namespace'])) ??
      asString(readNested(record.payload, ['request', 'namespace'])) ??
      namespace

    const kube = getKubeClient(deps)
    const resource = record.externalRunId
      ? await kube.get(RESOURCE_MAP.OrchestrationRun, record.externalRunId, resourceNamespace)
      : null
    if (resource) {
      const phase = extractStatusPhase(resource)
      if (phase && phase !== record.status) {
        await store.updateOrchestrationRunDetails({
          id: record.id,
          status: phase,
          externalRunId: record.externalRunId,
          payload: { ...record.payload, resource },
        })
        record.status = phase
      }
    }

    return okResponse({ ok: true, orchestrationRun: record, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}

export const getMemoryHandler = async (id: string, request: Request, deps: MemoryReadDependencies) => {
  const namespace = readNamespace(request)
  const kube = getKubeClient(deps)
  const store = deps.storeFactory()
  try {
    const resource = await kube.get(RESOURCE_MAP.Memory, id, namespace)
    if (!resource) return errorResponse('Memory not found', 404)
    await store.ready
    const record = await hydrateMemoryRecord(resource, namespace, kube, store)
    return okResponse({ ok: true, memory: resource, record })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}

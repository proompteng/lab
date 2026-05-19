import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'

import { type AgentRunRecord } from './agent-runs'

type Timestamp = string | Date

export type OrchestrationRunRecord = {
  id: string
  orchestrationName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

export type AgentRunDetailsUpdate = {
  id: string
  status: string
  externalRunId?: string | null
  payload?: Record<string, unknown>
}

export type RunLookupRecord = {
  kind: 'agent' | 'orchestration'
  record: AgentRunRecord | OrchestrationRunRecord
}

export type RunReadApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getAgentRunById: (id: string) => Promise<AgentRunRecord | null>
  updateAgentRunDetails: (input: AgentRunDetailsUpdate) => Promise<AgentRunRecord | null>
  getRunById: (id: string) => Promise<RunLookupRecord | null>
  updateOrchestrationRunDetails: (input: AgentRunDetailsUpdate) => Promise<OrchestrationRunRecord | null>
}

export type RunReadApiDependencies = {
  storeFactory: () => RunReadApiStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  defaultNamespace?: string
}

const extractStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  return asString(status?.phase)
}

const responseStatusForError = (message: string) => (message.includes('DATABASE_URL') ? 503 : 500)

const resolveResourceNamespace = (payload: Record<string, unknown>, fallbackNamespace: string) =>
  asString(readNested(payload, ['resource', 'metadata', 'namespace'])) ??
  asString(readNested(payload, ['request', 'namespace'])) ??
  fallbackNamespace

const getKubeClient = (deps: Pick<RunReadApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

export const getAgentRunHandler = async (id: string, request: Request, deps: RunReadApiDependencies) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), deps.defaultNamespace)
  let store: RunReadApiStore | null = null
  try {
    store = deps.storeFactory()
    await store.ready
    const record = await store.getAgentRunById(id)
    if (!record) return errorResponse('AgentRun not found', 404)

    const resourceNamespace = resolveResourceNamespace(record.payload, namespace)
    const kube = getKubeClient(deps)
    const resource = record.externalRunId
      ? await kube.get(RESOURCE_MAP.AgentRun, record.externalRunId, resourceNamespace)
      : null
    if (resource) {
      const phase = extractStatusPhase(resource)
      if (phase && phase !== record.status) {
        await store.updateAgentRunDetails({
          id: record.id,
          status: phase,
          externalRunId: record.externalRunId,
          payload: { ...record.payload, resource },
        })
        record.status = phase
      }
    }

    return okResponse({ ok: true, agentRun: record, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, responseStatusForError(message))
  } finally {
    await store?.close()
  }
}

export const getRunHandler = async (id: string, request: Request, deps: RunReadApiDependencies) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), deps.defaultNamespace)
  let store: RunReadApiStore | null = null
  try {
    store = deps.storeFactory()
    await store.ready
    const run = await store.getRunById(id)
    if (!run) return errorResponse('Run not found', 404)

    const kube = getKubeClient(deps)
    let resource: Record<string, unknown> | null = null
    if (run.record.externalRunId) {
      const resourceNamespace = resolveResourceNamespace(run.record.payload, namespace)
      const resourceName = run.record.externalRunId
      const resourceType = run.kind === 'agent' ? RESOURCE_MAP.AgentRun : RESOURCE_MAP.OrchestrationRun
      resource = await kube.get(resourceType, resourceName, resourceNamespace)
      if (resource) {
        const phase = extractStatusPhase(resource)
        if (phase && phase !== run.record.status) {
          if (run.kind === 'agent') {
            await store.updateAgentRunDetails({
              id: run.record.id,
              status: phase,
              externalRunId: run.record.externalRunId,
              payload: { ...run.record.payload, resource },
            })
          } else {
            await store.updateOrchestrationRunDetails({
              id: run.record.id,
              status: phase,
              externalRunId: run.record.externalRunId,
              payload: { ...run.record.payload, resource },
            })
          }
          run.record.status = phase
        }
      }
    }

    return okResponse({ ok: true, kind: run.kind, run: run.record, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, responseStatusForError(message))
  } finally {
    await store?.close()
  }
}

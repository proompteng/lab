import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { hydrateMemoryRecord } from '~/server/primitives-memory'
import { createPrimitivesStore } from '~/server/primitives-store'

type AgentRunStatus = {
  phase: string
  runtimeRef?: Record<string, unknown>
  startedAt?: string
  finishedAt?: string
  artifacts?: Array<Record<string, unknown>>
}

type OrchestrationRunStatus = {
  phase: string
  runId?: string
  startedAt?: string
  finishedAt?: string
  stepStatuses?: Array<Record<string, unknown>>
}

const DEFAULT_NAMESPACES = ['jangar']
const DEFAULT_INTERVAL_SECONDS = 30

let started = false
let intervalRef: NodeJS.Timeout | null = null
let reconciling = false

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  const flag = (process.env.JANGAR_PRIMITIVES_RECONCILER ?? '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false'
}

const parseNamespaces = () => {
  const raw = process.env.JANGAR_PRIMITIVES_NAMESPACES
  if (!raw) return DEFAULT_NAMESPACES
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return list.length > 0 ? list : DEFAULT_NAMESPACES
}

const parseIntervalSeconds = () => {
  const raw = process.env.JANGAR_PRIMITIVES_RECONCILER_INTERVAL_SECONDS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_INTERVAL_SECONDS
}

const normalizePayload = (payload: Record<string, unknown> | null | undefined) =>
  payload && typeof payload === 'object' ? payload : {}

const extractAgentRunStatus = (resource: Record<string, unknown>): AgentRunStatus => {
  const status = asRecord(resource.status) ?? {}
  const artifacts = Array.isArray(status.artifacts)
    ? status.artifacts.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : undefined
  return {
    phase: asString(status.phase) ?? 'Pending',
    runtimeRef: asRecord(status.runtimeRef) ?? undefined,
    startedAt: asString(status.startedAt) ?? undefined,
    finishedAt: asString(status.finishedAt) ?? undefined,
    artifacts,
  }
}

const extractOrchestrationRunStatus = (resource: Record<string, unknown>): OrchestrationRunStatus => {
  const status = asRecord(resource.status) ?? {}
  const stepStatuses = Array.isArray(status.stepStatuses)
    ? status.stepStatuses.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : undefined
  return {
    phase: asString(status.phase) ?? 'Pending',
    runId: asString(status.runId) ?? undefined,
    startedAt: asString(status.startedAt) ?? undefined,
    finishedAt: asString(status.finishedAt) ?? undefined,
    stepStatuses,
  }
}

const resolveDeliveryId = (resource: Record<string, unknown>) => {
  const labels = asRecord(readNested(resource, ['metadata', 'labels']))
  return (
    asString(labels?.['jangar.proompteng.ai/delivery-id']) ??
    asString(readNested(resource, ['spec', 'idempotencyKey'])) ??
    null
  )
}

const reconcileAgentRuns = async (
  namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  kube: ReturnType<typeof createKubernetesClient>,
) => {
  const response = await kube.list(RESOURCE_MAP.AgentRun, namespace)
  const items = Array.isArray(response.items) ? (response.items as Record<string, unknown>[]) : []

  for (const item of items) {
    try {
      const metadata = asRecord(item.metadata) ?? {}
      const externalRunId = asString(metadata.name)
      const deliveryId = resolveDeliveryId(item)
      const agentName = asString(readNested(item, ['spec', 'agentRef', 'name']))
      const status = extractAgentRunStatus(item)

      let record = deliveryId ? await store.getAgentRunByDeliveryId(deliveryId) : null
      if (!record && externalRunId) {
        record = await store.getAgentRunByExternalRunId(externalRunId)
      }

      if (!record && deliveryId && agentName) {
        record = await store.createAgentRun({
          agentName,
          deliveryId,
          provider: 'argo',
          status: status.phase,
          externalRunId: externalRunId ?? null,
          payload: { resource: item, status },
        })
      }

      if (!record) continue

      const payload = {
        ...normalizePayload(record.payload),
        resource: item,
        status,
      }

      await store.updateAgentRunDetails({
        id: record.id,
        status: status.phase,
        externalRunId: externalRunId ?? record.externalRunId ?? null,
        payload,
      })
    } catch (error) {
      console.warn('[jangar] failed to reconcile agent run', error)
    }
  }
}

const reconcileOrchestrationRuns = async (
  namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  kube: ReturnType<typeof createKubernetesClient>,
) => {
  const response = await kube.list(RESOURCE_MAP.OrchestrationRun, namespace)
  const items = Array.isArray(response.items) ? (response.items as Record<string, unknown>[]) : []

  for (const item of items) {
    try {
      const metadata = asRecord(item.metadata) ?? {}
      const externalRunId = asString(metadata.name)
      const deliveryId = resolveDeliveryId(item)
      const orchestrationName = asString(readNested(item, ['spec', 'orchestrationRef', 'name']))
      const status = extractOrchestrationRunStatus(item)

      let record = deliveryId ? await store.getOrchestrationRunByDeliveryId(deliveryId) : null
      if (!record && externalRunId) {
        record = await store.getOrchestrationRunByExternalRunId(externalRunId)
      }

      if (!record && deliveryId && orchestrationName) {
        record = await store.createOrchestrationRun({
          orchestrationName,
          deliveryId,
          provider: 'argo',
          status: status.phase,
          externalRunId: externalRunId ?? null,
          payload: { resource: item, status },
        })
      }

      if (!record) continue

      const payload = {
        ...normalizePayload(record.payload),
        resource: item,
        status,
      }

      await store.updateOrchestrationRunDetails({
        id: record.id,
        status: status.phase,
        externalRunId: externalRunId ?? record.externalRunId ?? null,
        payload,
      })
    } catch (error) {
      console.warn('[jangar] failed to reconcile orchestration run', error)
    }
  }
}

const reconcileMemories = async (
  namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  kube: ReturnType<typeof createKubernetesClient>,
) => {
  const response = await kube.list(RESOURCE_MAP.Memory, namespace)
  const items = Array.isArray(response.items) ? (response.items as Record<string, unknown>[]) : []
  for (const item of items) {
    try {
      await hydrateMemoryRecord(item, namespace, kube, store)
    } catch (error) {
      console.warn('[jangar] failed to reconcile memory', error)
    }
  }
}

const reconcileOnce = async () => {
  if (reconciling) return
  reconciling = true
  const store = createPrimitivesStore()
  const kube = createKubernetesClient()
  try {
    await store.ready
    const namespaces = parseNamespaces()
    for (const namespace of namespaces) {
      await reconcileAgentRuns(namespace, store, kube)
      await reconcileOrchestrationRuns(namespace, store, kube)
      await reconcileMemories(namespace, store, kube)
    }
  } catch (error) {
    console.warn('[jangar] primitives reconciler failed', error)
  } finally {
    reconciling = false
    await store.close()
  }
}

export const startPrimitivesReconciler = () => {
  if (started || !shouldStart()) return
  started = true
  void reconcileOnce()
  const intervalMs = parseIntervalSeconds() * 1000
  intervalRef = setInterval(() => {
    void reconcileOnce()
  }, intervalMs)
}

export const stopPrimitivesReconciler = () => {
  if (intervalRef) {
    clearInterval(intervalRef)
    intervalRef = null
  }
  started = false
}

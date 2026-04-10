import { isRuntimeTestEnv } from '~/server/control-plane-config'
import { resolvePrimitivesReconcilerConfig } from '~/server/controller-runtime-config'
import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { createKubeGateway } from '~/server/kube-gateway'
import { startResourceWatch } from '~/server/kube-watch'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
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
const DEFAULT_PRIMITIVES_RECONCILER_ENABLED_FLAG_KEY = 'jangar.primitives_reconciler.enabled'

let started = false
let starting = false
let reconciling = false
let watchHandles: Array<{ stop: () => void }> = []
const namespaceQueues = new Map<string, Promise<void>>()
let storeRef: ReturnType<typeof createPrimitivesStore> | null = null

const shouldStartFallback = () => {
  if (isRuntimeTestEnv()) return false
  return resolvePrimitivesReconcilerConfig().enabled
}

const shouldStart = async () => {
  if (isRuntimeTestEnv()) return false
  return resolveBooleanFeatureToggle({
    key: resolvePrimitivesReconcilerConfig().enabledFlagKey || DEFAULT_PRIMITIVES_RECONCILER_ENABLED_FLAG_KEY,
    keyEnvVar: 'JANGAR_PRIMITIVES_RECONCILER_FLAG_KEY',
    fallbackEnvVar: 'JANGAR_PRIMITIVES_RECONCILER',
    defaultValue: shouldStartFallback(),
  })
}

const parseNamespaces = () => resolvePrimitivesReconcilerConfig().namespaces

const resolveNamespaces = async () => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) return namespaces

  const resolved = await createKubeGateway().listNamespaces()
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kube gateway')
  }
  return resolved
}

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  const current = namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.warn('[jangar] primitives reconciler task failed', error)
    })
  namespaceQueues.set(namespace, next)
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
    asString(readNested(resource, ['spec', 'deliveryId'])) ??
    asString(readNested(resource, ['spec', 'idempotencyKey'])) ??
    null
  )
}

const reconcileAgentRunItem = async (
  item: Record<string, unknown>,
  _namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  _kube: ReturnType<typeof createKubernetesClient>,
) => {
  try {
    const metadata = asRecord(item.metadata) ?? {}
    const externalRunId = asString(metadata.name)
    const deliveryId = resolveDeliveryId(item)
    const agentName = asString(readNested(item, ['spec', 'agentRef', 'name']))
    const status = extractAgentRunStatus(item)
    const runtimeType =
      asString(readNested(status.runtimeRef ?? {}, ['type'])) ?? asString(readNested(item, ['spec', 'runtime', 'type']))
    const provider =
      runtimeType === 'temporal' || runtimeType === 'custom' ? runtimeType : runtimeType ? 'workflow' : 'workflow'

    let record = deliveryId ? await store.getAgentRunByDeliveryId(deliveryId) : null
    if (!record && externalRunId) {
      record = await store.getAgentRunByExternalRunId(externalRunId)
    }

    if (!record && deliveryId && agentName) {
      record = await store.createAgentRun({
        agentName,
        deliveryId,
        provider,
        status: status.phase,
        externalRunId: externalRunId ?? null,
        payload: { resource: item, status },
      })
    }

    if (!record) return

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

const reconcileAgentRuns = async (
  namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  kube: ReturnType<typeof createKubernetesClient>,
) => {
  const response = await kube.list(RESOURCE_MAP.AgentRun, namespace)
  const items = Array.isArray(response.items) ? (response.items as Record<string, unknown>[]) : []
  for (const item of items) {
    await reconcileAgentRunItem(item, namespace, store, kube)
  }
}

const reconcileOrchestrationRunItem = async (
  item: Record<string, unknown>,
  _namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  _kube: ReturnType<typeof createKubernetesClient>,
) => {
  try {
    const metadata = asRecord(item.metadata) ?? {}
    const externalRunId = asString(metadata.name)
    const deliveryId = resolveDeliveryId(item)
    const orchestrationName = asString(readNested(item, ['spec', 'orchestrationRef', 'name']))
    const status = extractOrchestrationRunStatus(item)
    const provider = 'workflow'

    let record = deliveryId ? await store.getOrchestrationRunByDeliveryId(deliveryId) : null
    if (!record && externalRunId) {
      record = await store.getOrchestrationRunByExternalRunId(externalRunId)
    }

    if (!record && deliveryId && orchestrationName) {
      record = await store.createOrchestrationRun({
        orchestrationName,
        deliveryId,
        provider,
        status: status.phase,
        externalRunId: externalRunId ?? null,
        payload: { resource: item, status },
      })
    }

    if (!record) return

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

const reconcileOrchestrationRuns = async (
  namespace: string,
  store: ReturnType<typeof createPrimitivesStore>,
  kube: ReturnType<typeof createKubernetesClient>,
) => {
  const response = await kube.list(RESOURCE_MAP.OrchestrationRun, namespace)
  const items = Array.isArray(response.items) ? (response.items as Record<string, unknown>[]) : []
  for (const item of items) {
    await reconcileOrchestrationRunItem(item, namespace, store, kube)
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

const reconcileOnce = async (
  kube: ReturnType<typeof createKubernetesClient>,
  store: ReturnType<typeof createPrimitivesStore>,
  namespaces: string[],
) => {
  if (reconciling) return
  reconciling = true
  try {
    await store.ready
    for (const namespace of namespaces) {
      await reconcileAgentRuns(namespace, store, kube)
      await reconcileOrchestrationRuns(namespace, store, kube)
      await reconcileMemories(namespace, store, kube)
    }
  } catch (error) {
    console.warn('[jangar] primitives reconciler failed', error)
  } finally {
    reconciling = false
  }
}

export const startPrimitivesReconciler = () => {
  if (started || starting) return
  starting = true
  void (async () => {
    if (!(await shouldStart()) || started || !starting) return
    started = true
    const store = createPrimitivesStore()
    storeRef = store
    const kube = createKubernetesClient()
    const namespaces = await resolveNamespaces()
    console.info('[jangar] primitives reconciler namespace scope:', JSON.stringify(namespaces))

    void reconcileOnce(kube, store, namespaces)

    for (const namespace of namespaces) {
      watchHandles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.AgentRun,
          namespace,
          onEvent: (event) => {
            const resource = asRecord(event.object)
            if (!resource || event.type === 'DELETED') return
            enqueueNamespaceTask(namespace, () => reconcileAgentRunItem(resource, namespace, store, kube))
          },
          onError: (error) => console.warn('[jangar] primitives agent run watch failed', error),
        }),
      )
      watchHandles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.OrchestrationRun,
          namespace,
          onEvent: (event) => {
            const resource = asRecord(event.object)
            if (!resource || event.type === 'DELETED') return
            enqueueNamespaceTask(namespace, () => reconcileOrchestrationRunItem(resource, namespace, store, kube))
          },
          onError: (error) => console.warn('[jangar] primitives orchestration run watch failed', error),
        }),
      )
      watchHandles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Memory,
          namespace,
          onEvent: (event) => {
            const resource = asRecord(event.object)
            if (!resource || event.type === 'DELETED') return
            enqueueNamespaceTask(namespace, async () => {
              await reconcileMemories(namespace, store, kube)
            })
          },
          onError: (error) => console.warn('[jangar] primitives memory watch failed', error),
        }),
      )
    }
  })()
    .catch((error) => {
      console.error('[jangar] primitives reconciler failed to start', error)
      if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
        process.exitCode = 1
        throw error
      }
    })
    .finally(() => {
      starting = false
    })
}

export const stopPrimitivesReconciler = () => {
  starting = false
  for (const handle of watchHandles) {
    handle.stop()
  }
  watchHandles = []
  namespaceQueues.clear()
  if (storeRef) {
    void storeRef.close()
    storeRef = null
  }
  started = false
}

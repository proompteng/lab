import { resolveRuntimeServiceName } from './runtime-identity'
import { resolveControlPlaneCacheConfig } from './controller-runtime-config'
import { isRuntimeTestEnv } from './control-plane-cache-config'
import {
  createControlPlaneCacheStore,
  type ControlPlaneCacheKey,
  type ControlPlaneCacheStore,
  type UpsertControlPlaneCacheResourceInput,
} from './control-plane-cache-store'
import { createKubernetesClient, RESOURCE_MAP } from './kube-types'
import { startResourceWatch } from './kube-watch'
import { asRecord, asString, readNested } from './primitives'
import { buildResourceFingerprint } from './status-utils'

type CacheKind =
  | 'Agent'
  | 'AgentRun'
  | 'AgentProvider'
  | 'ImplementationSpec'
  | 'ImplementationSource'
  | 'VersionControlProvider'

type CacheResource = { kind: CacheKind; resource: string }
type CacheResourceVersionMap = Map<string, string>
type CacheWriteOperation =
  | {
      type: 'delete'
      key: ControlPlaneCacheKey
      attempts: number
    }
  | {
      type: 'upsert'
      input: UpsertControlPlaneCacheResourceInput
      attempts: number
    }

type CacheWriterOptions = {
  store: ControlPlaneCacheStore
  logPrefix: string
  maxPendingWrites: number
  retryDelayMs?: number
  maxRetries?: number
}

const DEFAULT_CLUSTER_ID = 'default'
const DEFAULT_WRITE_RETRY_DELAY_MS = 2_000
const DEFAULT_MAX_WRITE_RETRIES = 10

const CACHE_RESOURCES: CacheResource[] = [
  { kind: 'Agent', resource: RESOURCE_MAP.Agent },
  { kind: 'AgentRun', resource: RESOURCE_MAP.AgentRun },
  { kind: 'AgentProvider', resource: RESOURCE_MAP.AgentProvider },
  { kind: 'ImplementationSpec', resource: RESOURCE_MAP.ImplementationSpec },
  { kind: 'ImplementationSource', resource: RESOURCE_MAP.ImplementationSource },
  { kind: 'VersionControlProvider', resource: RESOURCE_MAP.VersionControlProvider },
]

let started = false
let watchHandles: Array<{ stop: () => void }> = []
let resyncHandles: Array<{ stop: () => void }> = []
let cacheWriters: Array<{ stop: () => void }> = []

const getLogPrefix = () => `[${resolveRuntimeServiceName()}][control-plane-cache]`

const shouldStart = () => {
  if (isRuntimeTestEnv()) return false
  return resolveControlPlaneCacheConfig().enabled
}

const parseNamespaces = () => resolveControlPlaneCacheConfig().namespaces

const resolveClusterId = () => resolveControlPlaneCacheConfig().clusterId || DEFAULT_CLUSTER_ID

const cacheResourceVersionKey = (namespace: string, resource: string) => `${namespace}/${resource}`

const cacheWriteKey = (key: ControlPlaneCacheKey) => `${key.cluster}/${key.kind}/${key.namespace}/${key.name}`

const getOperationKey = (operation: CacheWriteOperation) =>
  operation.type === 'delete' ? cacheWriteKey(operation.key) : cacheWriteKey(operation.input.key)

const getOperationResourceKey = (operation: CacheWriteOperation) =>
  operation.type === 'delete' ? operation.key : operation.input.key

const createControlPlaneCacheWriter = ({
  store,
  logPrefix,
  maxPendingWrites,
  retryDelayMs = DEFAULT_WRITE_RETRY_DELAY_MS,
  maxRetries = DEFAULT_MAX_WRITE_RETRIES,
}: CacheWriterOptions) => {
  const pending = new Map<string, CacheWriteOperation>()
  let stopped = false
  let draining = false
  let retryTimer: NodeJS.Timeout | null = null

  const scheduleDrain = (delayMs = 0) => {
    if (stopped) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(
      () => {
        retryTimer = null
        drain()
      },
      Math.max(0, delayMs),
    )
  }

  const requeueAfterFailure = (operation: CacheWriteOperation, error: unknown) => {
    const key = getOperationKey(operation)
    const resourceKey = getOperationResourceKey(operation)
    const message = error instanceof Error ? error.message : String(error)
    if (operation.attempts >= maxRetries) {
      console.warn(`${logPrefix} write dropped after retries`, {
        kind: resourceKey.kind,
        namespace: resourceKey.namespace,
        name: resourceKey.name,
        error: message,
      })
      return
    }

    console.warn(`${logPrefix} write failed`, {
      kind: resourceKey.kind,
      namespace: resourceKey.namespace,
      name: resourceKey.name,
      attempt: operation.attempts + 1,
      error: message,
    })

    if (!pending.has(key)) {
      pending.set(key, { ...operation, attempts: operation.attempts + 1 } as CacheWriteOperation)
    }
    scheduleDrain(retryDelayMs)
  }

  const drain = () => {
    if (stopped || draining) return
    draining = true
    void (async () => {
      try {
        while (!stopped && pending.size > 0) {
          const next = pending.entries().next().value as [string, CacheWriteOperation] | undefined
          if (!next) return
          const [key, operation] = next
          pending.delete(key)

          try {
            if (operation.type === 'delete') {
              await store.markDeleted(operation.key)
            } else {
              await store.upsertResource(operation.input)
            }
          } catch (error) {
            requeueAfterFailure(operation, error)
            return
          }
        }
      } finally {
        draining = false
        if (!stopped && pending.size > 0 && !retryTimer) {
          scheduleDrain()
        }
      }
    })()
  }

  const enqueue = (operation: CacheWriteOperation) => {
    if (stopped) return
    const key = getOperationKey(operation)
    if (pending.has(key)) pending.delete(key)
    pending.set(key, operation)

    if (pending.size > maxPendingWrites) {
      const oldestKey = pending.keys().next().value as string | undefined
      if (oldestKey) {
        pending.delete(oldestKey)
        console.warn(`${logPrefix} write queue dropped oldest pending resource`, {
          pending: pending.size,
          maxPendingWrites,
        })
      }
    }

    if (!retryTimer) drain()
  }

  return {
    enqueueDelete: (key: ControlPlaneCacheKey) => enqueue({ type: 'delete', key, attempts: 0 }),
    enqueueUpsert: (input: UpsertControlPlaneCacheResourceInput) => enqueue({ type: 'upsert', input, attempts: 0 }),
    pendingSize: () => pending.size,
    stop: () => {
      stopped = true
      pending.clear()
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
    },
  }
}

const toSummary = (resource: Record<string, unknown>) => ({
  apiVersion: asString(resource.apiVersion) ?? null,
  kind: asString(resource.kind) ?? null,
  metadata: asRecord(resource.metadata) ?? {},
  spec: asRecord(resource.spec) ?? {},
  status: asRecord(resource.status) ?? {},
})

const resolveResourceUpdatedAt = (summary: ReturnType<typeof toSummary>) => {
  const candidates = [
    asString(readNested(summary, ['status', 'updatedAt'])),
    asString(readNested(summary, ['status', 'lastUpdatedAt'])),
    asString(readNested(summary, ['status', 'lastSyncedAt'])),
    asString(readNested(summary, ['status', 'syncedAt'])),
    asString(readNested(summary, ['status', 'completedAt'])),
    asString(readNested(summary, ['status', 'finishedAt'])),
    asString(readNested(summary, ['status', 'startedAt'])),
    asString(readNested(summary, ['metadata', 'annotations', 'agents.proompteng.ai/updatedAt'])),
    asString(readNested(summary, ['metadata', 'creationTimestamp'])),
  ]
  return candidates.find((value) => value && value.length > 0) ?? null
}

const coerceStringArray = (value: unknown, limit = 100) => {
  if (!Array.isArray(value)) return []
  const result = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return result.slice(0, limit)
}

const extractFields = (resourceKind: CacheKind, summary: ReturnType<typeof toSummary>) => {
  const metadata = asRecord(summary.metadata) ?? {}
  const spec = asRecord(summary.spec) ?? {}
  const status = asRecord(summary.status) ?? {}

  const statusPhase = resourceKind === 'AgentRun' ? (asString(status.phase) ?? null) : null
  const specRuntimeType = resourceKind === 'AgentRun' ? (asString(readNested(spec, ['runtime', 'type'])) ?? null) : null
  const specAgentRefName =
    resourceKind === 'AgentRun' ? (asString(readNested(spec, ['agentRef', 'name'])) ?? null) : null
  const specImplementationSpecRefName =
    resourceKind === 'AgentRun' ? (asString(readNested(spec, ['implementationSpecRef', 'name'])) ?? null) : null

  const specSourceProvider =
    resourceKind === 'ImplementationSpec' ? (asString(readNested(spec, ['source', 'provider'])) ?? null) : null
  const specSourceExternalId =
    resourceKind === 'ImplementationSpec' ? (asString(readNested(spec, ['source', 'externalId'])) ?? null) : null
  const specSummary = resourceKind === 'ImplementationSpec' ? (asString(spec.summary) ?? null) : null
  const specLabels = resourceKind === 'ImplementationSpec' ? coerceStringArray(spec.labels, 50) : []

  return {
    uid: asString(metadata.uid) ?? null,
    apiVersion: summary.apiVersion,
    resourceVersion: asString(metadata.resourceVersion) ?? null,
    generation:
      typeof metadata.generation === 'number' && Number.isFinite(metadata.generation) ? metadata.generation : null,
    labels: asRecord(metadata.labels) ?? {},
    annotations: asRecord(metadata.annotations) ?? {},
    resourceCreatedAt: asString(metadata.creationTimestamp) ?? null,
    resourceUpdatedAt: resolveResourceUpdatedAt(summary),
    statusPhase,
    specRuntimeType,
    specAgentRefName,
    specImplementationSpecRefName,
    specSourceProvider,
    specSourceExternalId,
    specSummary,
    specLabels,
  }
}

const listOnce = async (namespace: string, store: ControlPlaneCacheStore) => {
  const kube = createKubernetesClient()
  const cluster = resolveClusterId()
  const resourceVersions: CacheResourceVersionMap = new Map()

  for (const entry of CACHE_RESOURCES) {
    try {
      const syncStartedAt = await store.getDbNow()
      const list = await kube.list(entry.resource, namespace)
      const items = Array.isArray(list.items) ? list.items : []
      const resourceVersion = asString(readNested(list, ['metadata', 'resourceVersion']))
      if (resourceVersion) {
        resourceVersions.set(cacheResourceVersionKey(namespace, entry.resource), resourceVersion)
      }
      for (const item of items) {
        const summary = toSummary(asRecord(item) ?? {})
        const metadata = asRecord(summary.metadata) ?? {}
        const name = asString(metadata.name)
        const resourceNamespace = asString(metadata.namespace) ?? namespace
        if (!name) continue
        const fingerprint = buildResourceFingerprint(summary)
        const fields = extractFields(entry.kind, summary)
        await store.upsertResource({
          key: { cluster: resolveClusterId(), kind: entry.kind, namespace: resourceNamespace, name },
          uid: fields.uid,
          apiVersion: fields.apiVersion,
          resourceVersion: fields.resourceVersion,
          generation: fields.generation,
          labels: fields.labels,
          annotations: fields.annotations,
          resource: summary,
          fingerprint,
          resourceCreatedAt: fields.resourceCreatedAt,
          resourceUpdatedAt: fields.resourceUpdatedAt,
          statusPhase: fields.statusPhase,
          specRuntimeType: fields.specRuntimeType,
          specAgentRefName: fields.specAgentRefName,
          specImplementationSpecRefName: fields.specImplementationSpecRefName,
          specSourceProvider: fields.specSourceProvider,
          specSourceExternalId: fields.specSourceExternalId,
          specSummary: fields.specSummary,
          specLabels: fields.specLabels,
        })
      }

      await store.markNotSeenSince({
        cluster,
        kind: entry.kind,
        namespace,
        since: syncStartedAt,
      })
    } catch (error) {
      console.warn(`${getLogPrefix()} list failed`, { kind: entry.kind, namespace, error })
    }
  }

  return resourceVersions
}

const startNamespaceWatches = (
  namespace: string,
  store: ControlPlaneCacheStore,
  resourceVersions: CacheResourceVersionMap,
) => {
  const writer = createControlPlaneCacheWriter({
    store,
    logPrefix: getLogPrefix(),
    maxPendingWrites: resolveControlPlaneCacheConfig().maxPendingWrites,
  })
  cacheWriters.push(writer)

  for (const entry of CACHE_RESOURCES) {
    watchHandles.push(
      startResourceWatch({
        resource: entry.resource,
        namespace,
        resourceVersion: resourceVersions.get(cacheResourceVersionKey(namespace, entry.resource)),
        logPrefix: getLogPrefix(),
        onEvent: (event) => {
          const payload = asRecord(event.object) ?? {}
          const summary = toSummary(payload)
          const metadata = asRecord(summary.metadata) ?? {}
          const resourceNamespace = asString(metadata.namespace) ?? namespace
          const name = asString(metadata.name)
          if (!name) return

          const key = { cluster: resolveClusterId(), kind: entry.kind, namespace: resourceNamespace, name }
          if (event.type === 'DELETED') {
            writer.enqueueDelete(key)
            return
          }

          const fingerprint = buildResourceFingerprint(summary)
          const fields = extractFields(entry.kind, summary)
          writer.enqueueUpsert({
            key,
            uid: fields.uid,
            apiVersion: fields.apiVersion,
            resourceVersion: fields.resourceVersion,
            generation: fields.generation,
            labels: fields.labels,
            annotations: fields.annotations,
            resource: summary,
            fingerprint,
            resourceCreatedAt: fields.resourceCreatedAt,
            resourceUpdatedAt: fields.resourceUpdatedAt,
            statusPhase: fields.statusPhase,
            specRuntimeType: fields.specRuntimeType,
            specAgentRefName: fields.specAgentRefName,
            specImplementationSpecRefName: fields.specImplementationSpecRefName,
            specSourceProvider: fields.specSourceProvider,
            specSourceExternalId: fields.specSourceExternalId,
            specSummary: fields.specSummary,
            specLabels: fields.specLabels,
          })
        },
        onError: (error) => {
          console.warn(`${getLogPrefix()} watch failed`, { kind: entry.kind, namespace, error })
        },
      }),
    )
  }
}

const scheduleNamespaceResync = (namespace: string, store: ControlPlaneCacheStore) => {
  const intervalMs = resolveControlPlaneCacheConfig().resyncSeconds * 1000
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      void listOnce(namespace, store).finally(schedule)
    }, intervalMs)
    timer.unref?.()
  }

  schedule()
  resyncHandles.push({
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  })
}

export const startControlPlaneCache = async () => {
  if (started || !shouldStart()) return
  started = true

  let store: ReturnType<typeof createControlPlaneCacheStore> | null = null
  try {
    store = createControlPlaneCacheStore()
    await store.ready

    const namespaces = parseNamespaces()
    for (const namespace of namespaces) {
      const resourceVersions = await listOnce(namespace, store)
      startNamespaceWatches(namespace, store, resourceVersions)
      scheduleNamespaceResync(namespace, store)
    }
  } catch (error) {
    console.warn(`${getLogPrefix()} failed to start`, error)
    try {
      stopControlPlaneCache()
    } catch {
      // ignore
    }
    try {
      await store?.close()
    } catch {
      // ignore
    }
  }
}

export const stopControlPlaneCache = () => {
  for (const handle of watchHandles) {
    handle.stop()
  }
  for (const handle of resyncHandles) {
    handle.stop()
  }
  for (const writer of cacheWriters) {
    writer.stop()
  }
  watchHandles = []
  resyncHandles = []
  cacheWriters = []
  started = false
}

export const __test__ = {
  createControlPlaneCacheWriter,
  extractFields,
  listOnce,
  resolveResourceUpdatedAt,
}

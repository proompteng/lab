import { startResourceWatch } from '~/server/kube-watch'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { buildResourceFingerprint } from '~/server/status-utils'

import { createControlPlaneCacheStore } from './control-plane-cache-store'

type CacheKind =
  | 'Agent'
  | 'AgentRun'
  | 'AgentProvider'
  | 'ImplementationSpec'
  | 'ImplementationSource'
  | 'VersionControlProvider'

type CacheResource = { kind: CacheKind; resource: string }

const DEFAULT_NAMESPACE = 'agents'
const DEFAULT_CLUSTER_ID = 'default'

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

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  const flag = (process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED ?? '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
}

const parseNamespaces = () => {
  const raw =
    process.env.JANGAR_CONTROL_PLANE_CACHE_NAMESPACES?.trim() || process.env.JANGAR_PRIMITIVES_NAMESPACES?.trim()
  if (!raw) return [DEFAULT_NAMESPACE]
  const namespaces = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return namespaces.length > 0 ? namespaces : [DEFAULT_NAMESPACE]
}

const resolveClusterId = () => process.env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER?.trim() || DEFAULT_CLUSTER_ID

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

const listOnce = async (namespace: string, store: ReturnType<typeof createControlPlaneCacheStore>) => {
  const kube = createKubernetesClient()

  for (const entry of CACHE_RESOURCES) {
    try {
      const list = await kube.list(entry.resource, namespace)
      const items = Array.isArray(list.items) ? list.items : []
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
    } catch (error) {
      console.warn('[jangar][control-plane-cache] list failed', { kind: entry.kind, namespace, error })
    }
  }
}

const startNamespaceWatches = (namespace: string, store: ReturnType<typeof createControlPlaneCacheStore>) => {
  for (const entry of CACHE_RESOURCES) {
    watchHandles.push(
      startResourceWatch({
        resource: entry.resource,
        namespace,
        logPrefix: '[jangar][control-plane-cache]',
        onEvent: async (event) => {
          const payload = asRecord(event.object) ?? {}
          const summary = toSummary(payload)
          const metadata = asRecord(summary.metadata) ?? {}
          const resourceNamespace = asString(metadata.namespace) ?? namespace
          const name = asString(metadata.name)
          if (!name) return

          const key = { cluster: resolveClusterId(), kind: entry.kind, namespace: resourceNamespace, name }
          if (event.type === 'DELETED') {
            await store.markDeleted(key)
            return
          }

          const fingerprint = buildResourceFingerprint(summary)
          const fields = extractFields(entry.kind, summary)
          await store.upsertResource({
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
          console.warn('[jangar][control-plane-cache] watch failed', { kind: entry.kind, namespace, error })
        },
      }),
    )
  }
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
      await listOnce(namespace, store)
      startNamespaceWatches(namespace, store)
    }
  } catch (error) {
    console.warn('[jangar][control-plane-cache] failed to start', error)
    try {
      await store?.close()
    } catch {
      // ignore
    }
    store = null
  }
}

export const stopControlPlaneCache = () => {
  for (const handle of watchHandles) {
    handle.stop()
  }
  watchHandles = []
  started = false
}

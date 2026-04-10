import { type V1Lease } from '@kubernetes/client-node'

import { asRecord, asString } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP, type KubernetesClient } from '~/server/primitives-kube'

type KubeGatewayErrorKind = 'invalid_payload' | 'transport'

export class KubeGatewayError extends Error {
  kind: KubeGatewayErrorKind

  constructor(kind: KubeGatewayErrorKind, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'KubeGatewayError'
    this.kind = kind
    if (options && 'cause' in options) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

export type KubeGatewayCondition = {
  type: string | null
  status: string | null
  reason: string | null
  lastTransitionTime: string | null
}

export type KubeGatewayMetadata = {
  name: string
  namespace: string | null
  generation: number | null
  labels: Record<string, string>
  creationTimestamp: string | null
}

export type KubeGatewayDeployment = {
  metadata: KubeGatewayMetadata
  spec: {
    replicas: number | null
  }
  status: {
    readyReplicas: number | null
    availableReplicas: number | null
    updatedReplicas: number | null
    unavailableReplicas: number | null
    conditions: KubeGatewayCondition[]
  }
}

export type KubeGatewayJob = {
  metadata: KubeGatewayMetadata
  status: {
    active: number | null
    failed: number | null
    startTime: string | null
    completionTime: string | null
    conditions: KubeGatewayCondition[]
  }
}

export type KubeGatewaySwarm = {
  metadata: KubeGatewayMetadata
  status: Record<string, unknown>
}

export type KubeGatewayResourceAccess = 'ok' | 'missing' | 'forbidden'

export type KubeGateway = {
  listDeployments: (namespace: string) => Promise<KubeGatewayDeployment[]>
  listJobs: (namespace: string, labelSelector?: string) => Promise<KubeGatewayJob[]>
  listNamespaces: () => Promise<string[]>
  listCustomResourceDefinitions: () => Promise<string[]>
  getLease: (namespace: string, name: string) => Promise<V1Lease | null>
  createLease: (namespace: string, lease: V1Lease) => Promise<V1Lease>
  replaceLease: (namespace: string, lease: V1Lease) => Promise<V1Lease>
  probeNamespacedResource: (resource: string, namespace: string) => Promise<KubeGatewayResourceAccess>
  serviceExists: (namespace: string, name: string) => Promise<boolean>
  listSwarms: (namespace: string) => Promise<KubeGatewaySwarm[]>
}

const normalizeMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const isForbiddenMessage = (value: string) => value.includes('forbidden') || value.includes('unauthorized')

const asNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null
  }
  return null
}

const parseLabels = (value: unknown) => {
  const record = asRecord(value)
  if (!record) return {}

  return Object.fromEntries(
    Object.entries(record)
      .map(([key, candidate]) => [key, asString(candidate)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== null),
  )
}

const parseMetadata = (value: unknown): KubeGatewayMetadata | null => {
  const record = asRecord(value)
  const name = asString(record?.name)
  if (!record || !name) return null

  return {
    name,
    namespace: asString(record.namespace),
    generation: asNonNegativeInteger(record.generation),
    labels: parseLabels(record.labels),
    creationTimestamp: asString(record.creationTimestamp),
  }
}

const parseCondition = (value: unknown): KubeGatewayCondition | null => {
  const record = asRecord(value)
  if (!record) return null

  return {
    type: asString(record.type),
    status: asString(record.status),
    reason: asString(record.reason),
    lastTransitionTime: asString(record.lastTransitionTime),
  }
}

const parseConditions = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map((entry) => parseCondition(entry))
    .filter((entry): entry is KubeGatewayCondition => entry !== null)

const parseListItems = (payload: unknown, context: string) => {
  const record = asRecord(payload)
  if (!record || !Array.isArray(record.items)) {
    throw new KubeGatewayError('invalid_payload', `${context} returned invalid list payload`)
  }

  return record.items.filter((item): item is Record<string, unknown> => {
    return item !== null && typeof item === 'object' && !Array.isArray(item)
  })
}

const wrapTransport = async <T>(context: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    if (error instanceof KubeGatewayError) throw error
    throw new KubeGatewayError('transport', `${context}: ${normalizeMessage(error)}`, { cause: error })
  }
}

const parseItemNames = (items: Record<string, unknown>[]) =>
  items
    .map((item) => parseMetadata(item.metadata)?.name ?? asString(asRecord(item.metadata)?.name))
    .filter((entry): entry is string => Boolean(entry))

const withLeaseNamespace = (namespace: string, lease: V1Lease) => ({
  ...lease,
  metadata: {
    ...(asRecord(lease.metadata) ?? {}),
    namespace,
  },
})

export const createKubeGateway = (client: KubernetesClient = createKubernetesClient()): KubeGateway => ({
  listDeployments: async (namespace) =>
    wrapTransport('kube deployments list failed', async () => {
      const items = parseListItems(await client.list('deployments', namespace), 'kube deployments list')

      return items
        .map((item): KubeGatewayDeployment | null => {
          const metadata = parseMetadata(item.metadata)
          if (!metadata) return null

          const spec = asRecord(item.spec) ?? {}
          const status = asRecord(item.status) ?? {}

          return {
            metadata,
            spec: {
              replicas: asNonNegativeInteger(spec.replicas),
            },
            status: {
              readyReplicas: asNonNegativeInteger(status.readyReplicas),
              availableReplicas: asNonNegativeInteger(status.availableReplicas),
              updatedReplicas: asNonNegativeInteger(status.updatedReplicas),
              unavailableReplicas: asNonNegativeInteger(status.unavailableReplicas),
              conditions: parseConditions(status.conditions),
            },
          }
        })
        .filter((entry): entry is KubeGatewayDeployment => entry !== null)
    }),
  listJobs: async (namespace, labelSelector) =>
    wrapTransport('kube jobs list failed', async () => {
      const items = parseListItems(await client.list('jobs.batch', namespace, labelSelector), 'kube jobs list')

      return items
        .map((item): KubeGatewayJob | null => {
          const metadata = parseMetadata(item.metadata)
          if (!metadata) return null

          const status = asRecord(item.status) ?? {}

          return {
            metadata,
            status: {
              active: asNonNegativeInteger(status.active),
              failed: asNonNegativeInteger(status.failed),
              startTime: asString(status.startTime),
              completionTime: asString(status.completionTime),
              conditions: parseConditions(status.conditions),
            },
          }
        })
        .filter((entry): entry is KubeGatewayJob => entry !== null)
    }),
  listNamespaces: async () =>
    wrapTransport('kube namespaces list failed', async () => {
      const items = parseListItems(await client.list('namespaces', ''), 'kube namespaces list')
      return parseItemNames(items)
    }),
  listCustomResourceDefinitions: async () =>
    wrapTransport('kube crds list failed', async () => {
      const items = parseListItems(await client.list('crd', ''), 'kube crds list')
      return parseItemNames(items)
    }),
  getLease: async (namespace, name) =>
    wrapTransport('kube lease get failed', async () => {
      return (await client.get('lease', name, namespace)) as V1Lease | null
    }).catch((error) => {
      const message = normalizeMessage(error).toLowerCase()
      if (message.includes('notfound') || message.includes('not found')) {
        return null
      }
      throw error
    }),
  createLease: async (namespace, lease) =>
    wrapTransport('kube lease create failed', async () => {
      return (await client.createManifest(JSON.stringify(withLeaseNamespace(namespace, lease)), namespace)) as V1Lease
    }),
  replaceLease: async (namespace, lease) =>
    wrapTransport('kube lease replace failed', async () => {
      return (await client.apply(withLeaseNamespace(namespace, lease) as unknown as Record<string, unknown>)) as V1Lease
    }),
  probeNamespacedResource: async (resource, namespace) => {
    try {
      await client.list(resource, namespace)
      return 'ok'
    } catch (error) {
      const message = normalizeMessage(error).toLowerCase()
      if (isForbiddenMessage(message)) return 'forbidden'
      return 'missing'
    }
  },
  serviceExists: async (namespace, name) =>
    wrapTransport('kube service get failed', async () => {
      const service = await client.get('service', name, namespace)
      return service !== null
    }),
  listSwarms: async (namespace) =>
    wrapTransport('kube swarms list failed', async () => {
      const items = parseListItems(await client.list(RESOURCE_MAP.Swarm, namespace), 'kube swarms list')

      return items
        .map((item): KubeGatewaySwarm | null => {
          const metadata = parseMetadata(item.metadata)
          if (!metadata) return null

          return {
            metadata,
            status: asRecord(item.status) ?? {},
          }
        })
        .filter((entry): entry is KubeGatewaySwarm => entry !== null)
    }),
})

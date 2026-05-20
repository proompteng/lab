import { type V1Lease } from '@kubernetes/client-node'

import {
  fetchAgentRunResourcesFromAgentsService,
  type AgentsAgentRunResourceListInput,
  fetchControlPlaneResourcesFromAgentsService,
  type AgentsControlPlaneResourceListInput,
} from '~/server/agents-service-client'
import { asRecord, asString } from '~/server/primitives-http'
import { createKubernetesClient, type KubernetesClient } from '~/server/primitives-kube'

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
  message?: string | null
}

export type KubeGatewayMetadata = {
  name: string
  namespace: string | null
  generation: number | null
  labels: Record<string, string>
  annotations?: Record<string, string>
  creationTimestamp: string | null
  deletionTimestamp?: string | null
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

export type KubeGatewayAgentRun = {
  metadata: KubeGatewayMetadata
  spec: {
    parameters: Record<string, string>
    agentRefName: string | null
    implementationSpecRefName: string | null
    runtimeType: string | null
  }
  status: {
    phase: string | null
    reason: string | null
    message: string | null
    startedAt: string | null
    finishedAt: string | null
    conditions: KubeGatewayCondition[]
  }
}

export type KubeGatewayContainerState = {
  waiting?: {
    reason: string | null
    message: string | null
  }
  terminated?: {
    reason: string | null
    message: string | null
    exitCode: number | null
  }
  running?: boolean
}

export type KubeGatewayContainerStatus = {
  name: string
  image: string | null
  image_id?: string | null
  ready: boolean
  state: KubeGatewayContainerState
}

export type KubeGatewayPod = {
  metadata: KubeGatewayMetadata
  status: {
    phase: string | null
    conditions: KubeGatewayCondition[]
    containerStatuses: KubeGatewayContainerStatus[]
  }
}

export type KubeGatewayEvent = {
  metadata: KubeGatewayMetadata
  type: string | null
  reason: string | null
  message: string | null
  firstTimestamp: string | null
  lastTimestamp: string | null
  eventTime: string | null
  involvedObject: {
    kind: string | null
    name: string | null
    namespace: string | null
  }
}

export type KubeGatewaySwarm = {
  metadata: KubeGatewayMetadata
  status: Record<string, unknown>
}

export type KubeGateway = {
  listAgentRuns: (namespace: string, labelSelector?: string) => Promise<KubeGatewayAgentRun[]>
  listJobs: (namespace: string, labelSelector?: string) => Promise<KubeGatewayJob[]>
  listPods: (namespace: string, labelSelector?: string) => Promise<KubeGatewayPod[]>
  listEvents: (namespace: string, fieldSelector?: string) => Promise<KubeGatewayEvent[]>
  listNamespaces: () => Promise<string[]>
  listCustomResourceDefinitions: () => Promise<string[]>
  getLease: (namespace: string, name: string) => Promise<V1Lease | null>
  createLease: (namespace: string, lease: V1Lease) => Promise<V1Lease>
  replaceLease: (namespace: string, lease: V1Lease) => Promise<V1Lease>
  serviceExists: (namespace: string, name: string) => Promise<boolean>
  listSwarms: (namespace: string) => Promise<KubeGatewaySwarm[]>
}

type AgentRunResourceLister = (
  input: AgentsAgentRunResourceListInput,
) => ReturnType<typeof fetchAgentRunResourcesFromAgentsService>

type KubeGatewayDeps = {
  listAgentRunResources?: AgentRunResourceLister
  listControlPlaneResources?: (
    input: AgentsControlPlaneResourceListInput,
  ) => ReturnType<typeof fetchControlPlaneResourcesFromAgentsService>
}

const normalizeMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

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

const parseAnnotations = parseLabels

const parseMetadata = (value: unknown): KubeGatewayMetadata | null => {
  const record = asRecord(value)
  const name = asString(record?.name)
  if (!record || !name) return null

  const deletionTimestamp = asString(record.deletionTimestamp)
  const metadata: KubeGatewayMetadata = {
    name,
    namespace: asString(record.namespace),
    generation: asNonNegativeInteger(record.generation),
    labels: parseLabels(record.labels),
    annotations: parseAnnotations(record.annotations),
    creationTimestamp: asString(record.creationTimestamp),
  }

  if (deletionTimestamp !== null) {
    metadata.deletionTimestamp = deletionTimestamp
  }

  return metadata
}

const parseCondition = (value: unknown): KubeGatewayCondition | null => {
  const record = asRecord(value)
  if (!record) return null

  const message = asString(record.message)
  const condition: KubeGatewayCondition = {
    type: asString(record.type),
    status: asString(record.status),
    reason: asString(record.reason),
    lastTransitionTime: asString(record.lastTransitionTime),
  }

  if (message !== null) {
    condition.message = message
  }

  return condition
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

const parseContainerState = (value: unknown): KubeGatewayContainerState => {
  const record = asRecord(value) ?? {}
  const waiting = asRecord(record.waiting)
  const terminated = asRecord(record.terminated)
  const state: KubeGatewayContainerState = {}

  if (waiting) {
    state.waiting = {
      reason: asString(waiting.reason),
      message: asString(waiting.message),
    }
  }
  if (terminated) {
    state.terminated = {
      reason: asString(terminated.reason),
      message: asString(terminated.message),
      exitCode: asNonNegativeInteger(terminated.exitCode),
    }
  }
  if (asRecord(record.running)) {
    state.running = true
  }

  return state
}

const parseContainerStatuses = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map((entry): KubeGatewayContainerStatus | null => {
      const record = asRecord(entry)
      const name = asString(record?.name)
      if (!record || !name) return null

      return {
        name,
        image: asString(record.image),
        image_id: asString(record.imageID),
        ready: record.ready === true,
        state: parseContainerState(record.state),
      }
    })
    .filter((entry): entry is KubeGatewayContainerStatus => entry !== null)

const parseStringMap = (value: unknown) => {
  const record = asRecord(value)
  if (!record) return {}

  return Object.fromEntries(
    Object.entries(record)
      .map(([key, candidate]) => [key, asString(candidate)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== null),
  )
}

const parseInvolvedObject = (value: unknown) => {
  const record = asRecord(value) ?? {}
  return {
    kind: asString(record.kind),
    name: asString(record.name),
    namespace: asString(record.namespace),
  }
}

const withLeaseNamespace = (namespace: string, lease: V1Lease) => ({
  ...lease,
  metadata: {
    ...asRecord(lease.metadata),
    namespace,
  },
})

const parseAgentRunResource = (item: Record<string, unknown>): KubeGatewayAgentRun | null => {
  const metadata = parseMetadata(item.metadata)
  if (!metadata) return null

  const spec = asRecord(item.spec) ?? {}
  const status = asRecord(item.status) ?? {}
  const agentRef = asRecord(spec.agentRef)
  const implementationSpecRef = asRecord(spec.implementationSpecRef)
  const runtime = asRecord(spec.runtime)

  return {
    metadata,
    spec: {
      parameters: parseStringMap(spec.parameters),
      agentRefName: asString(agentRef?.name),
      implementationSpecRefName: asString(implementationSpecRef?.name),
      runtimeType: asString(runtime?.type),
    },
    status: {
      phase: asString(status.phase),
      reason: asString(status.reason),
      message: asString(status.message),
      startedAt: asString(status.startedAt),
      finishedAt: asString(status.finishedAt),
      conditions: parseConditions(status.conditions),
    },
  }
}

export const createKubeGateway = (
  client: KubernetesClient = createKubernetesClient(),
  deps: KubeGatewayDeps = {},
): KubeGateway => ({
  listAgentRuns: async (namespace, labelSelector) =>
    wrapTransport('agents service agentruns list failed', async () => {
      const listAgentRunResources = deps.listAgentRunResources ?? fetchAgentRunResourcesFromAgentsService
      const result = await listAgentRunResources({ namespace, labelSelector })
      if (!result.ok) {
        throw new Error(result.error ?? `Agents service returned HTTP ${result.status}`)
      }
      const items = parseListItems(result.body, 'agents service agentruns list')
      return items
        .map((item) => parseAgentRunResource(item))
        .filter((entry): entry is KubeGatewayAgentRun => entry !== null)
    }),
  listJobs: async (namespace, labelSelector) =>
    wrapTransport('agents service jobs list failed', async () => {
      const listControlPlaneResources = deps.listControlPlaneResources ?? fetchControlPlaneResourcesFromAgentsService
      const result = await listControlPlaneResources({ kind: 'Job', namespace, labelSelector })
      if (!result.ok) {
        throw new Error(result.error ?? `Agents service returned HTTP ${result.status}`)
      }
      const items = parseListItems(result.body, 'agents service jobs list')

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
  listPods: async (namespace, labelSelector) =>
    wrapTransport('agents service pods list failed', async () => {
      const listControlPlaneResources = deps.listControlPlaneResources ?? fetchControlPlaneResourcesFromAgentsService
      const result = await listControlPlaneResources({ kind: 'Pod', namespace, labelSelector })
      if (!result.ok) {
        throw new Error(result.error ?? `Agents service returned HTTP ${result.status}`)
      }
      const items = parseListItems(result.body, 'agents service pods list')

      return items
        .map((item): KubeGatewayPod | null => {
          const metadata = parseMetadata(item.metadata)
          if (!metadata) return null

          const status = asRecord(item.status) ?? {}

          return {
            metadata,
            status: {
              phase: asString(status.phase),
              conditions: parseConditions(status.conditions),
              containerStatuses: parseContainerStatuses(status.containerStatuses),
            },
          }
        })
        .filter((entry): entry is KubeGatewayPod => entry !== null)
    }),
  listEvents: async (namespace, fieldSelector) =>
    wrapTransport('kube events list failed', async () => {
      const items = parseListItems(await client.listEvents(namespace, fieldSelector), 'kube events list')

      return items
        .map((item): KubeGatewayEvent | null => {
          const metadata = parseMetadata(item.metadata)
          if (!metadata) return null

          return {
            metadata,
            type: asString(item.type),
            reason: asString(item.reason),
            message: asString(item.message),
            firstTimestamp: asString(item.firstTimestamp),
            lastTimestamp: asString(item.lastTimestamp),
            eventTime: asString(item.eventTime),
            involvedObject: parseInvolvedObject(item.involvedObject),
          }
        })
        .filter((entry): entry is KubeGatewayEvent => entry !== null)
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
      return (await client.apply(withLeaseNamespace(namespace, lease) as unknown as Record<string, unknown>)) as V1Lease
    }),
  replaceLease: async (namespace, lease) =>
    wrapTransport('kube lease replace failed', async () => {
      return (await client.apply(withLeaseNamespace(namespace, lease) as unknown as Record<string, unknown>)) as V1Lease
    }),
  serviceExists: async (namespace, name) =>
    wrapTransport('kube service get failed', async () => {
      const service = await client.get('service', name, namespace)
      return service !== null
    }),
  listSwarms: async (namespace) =>
    wrapTransport('agents service swarms list failed', async () => {
      const listControlPlaneResources = deps.listControlPlaneResources ?? fetchControlPlaneResourcesFromAgentsService
      const result = await listControlPlaneResources({ kind: 'Swarm', namespace })
      if (!result.ok) {
        throw new Error(result.error ?? `Agents service returned HTTP ${result.status}`)
      }
      const items = parseListItems(result.body, 'agents service swarms list')

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

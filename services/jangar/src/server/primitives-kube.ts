import { CoreV1Api, KubeConfig, KubernetesObjectApi, PatchStrategy, loadAllYaml } from '@kubernetes/client-node'

import { asRecord, asString } from '~/server/primitives-http'

export type KubernetesClient = {
  apply: (resource: Record<string, unknown>) => Promise<Record<string, unknown>>
  applyManifest: (manifest: string, namespace?: string | null) => Promise<Record<string, unknown>>
  applyStatus: (resource: Record<string, unknown>) => Promise<Record<string, unknown>>
  createManifest: (manifest: string, namespace?: string | null) => Promise<Record<string, unknown>>
  delete: (
    resource: string,
    name: string,
    namespace: string,
    options?: { wait?: boolean; timeoutSeconds?: number },
  ) => Promise<Record<string, unknown> | null>
  patch: (
    resource: string,
    name: string,
    namespace: string,
    patch: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  get: (resource: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
  list: (resource: string, namespace: string, labelSelector?: string) => Promise<Record<string, unknown>>
  listEvents: (namespace: string, fieldSelector?: string) => Promise<Record<string, unknown>>
  logs: (params: {
    pod: string
    namespace: string
    container?: string | null
    tailLines?: number | null
  }) => Promise<string>
}

type BuiltinResourceTarget = {
  apiVersion: string
  kind: string
  plural: string
  namespaceScoped: boolean
}

type KubeClients = {
  kubeConfig: KubeConfig
  objects: KubernetesObjectApi
  core: CoreV1Api
}

const globalState = globalThis as typeof globalThis & {
  __jangarNativeKubeClients?: KubeClients
}

const BUILTIN_RESOURCE_TARGETS: Record<string, BuiltinResourceTarget> = {
  configmap: { apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaceScoped: true },
  configmaps: { apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaceScoped: true },
  crd: {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    plural: 'customresourcedefinitions',
    namespaceScoped: false,
  },
  crds: {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    plural: 'customresourcedefinitions',
    namespaceScoped: false,
  },
  cronjob: { apiVersion: 'batch/v1', kind: 'CronJob', plural: 'cronjobs', namespaceScoped: true },
  cronjobs: { apiVersion: 'batch/v1', kind: 'CronJob', plural: 'cronjobs', namespaceScoped: true },
  deployment: { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaceScoped: true },
  deployments: { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaceScoped: true },
  event: { apiVersion: 'v1', kind: 'Event', plural: 'events', namespaceScoped: true },
  events: { apiVersion: 'v1', kind: 'Event', plural: 'events', namespaceScoped: true },
  job: { apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaceScoped: true },
  'jobs.batch': { apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaceScoped: true },
  jobs: { apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaceScoped: true },
  lease: { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', plural: 'leases', namespaceScoped: true },
  leases: { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', plural: 'leases', namespaceScoped: true },
  namespace: { apiVersion: 'v1', kind: 'Namespace', plural: 'namespaces', namespaceScoped: false },
  namespaces: { apiVersion: 'v1', kind: 'Namespace', plural: 'namespaces', namespaceScoped: false },
  pod: { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaceScoped: true },
  pods: { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaceScoped: true },
  secret: { apiVersion: 'v1', kind: 'Secret', plural: 'secrets', namespaceScoped: true },
  secrets: { apiVersion: 'v1', kind: 'Secret', plural: 'secrets', namespaceScoped: true },
  service: { apiVersion: 'v1', kind: 'Service', plural: 'services', namespaceScoped: true },
  services: { apiVersion: 'v1', kind: 'Service', plural: 'services', namespaceScoped: true },
}

const apiVersionToGroupVersion = (apiVersion: string) => {
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/', 2) : ['', apiVersion]
  return { group, version }
}

const normalizeKubeErrorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  const body = asRecord((error as Error & { body?: unknown }).body)
  const bodyMessage = asString(body?.message)
  return bodyMessage ?? error.message
}

const isNotFound = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 404) {
    return true
  }
  const message = normalizeKubeErrorMessage(error).toLowerCase()
  return message.includes('not found') || message.includes('notfound')
}

const parseJson = (raw: string, context: string) => {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const cloneRecord = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>

const toManifestObjects = (manifest: string, namespace?: string | null) => {
  const objects = loadAllYaml(manifest)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => cloneRecord(entry))

  for (const object of objects) {
    if (!namespace) continue
    const metadata = (asRecord(object.metadata) ?? {}) as Record<string, unknown>
    if (!asString(metadata.namespace)) {
      metadata.namespace = namespace
      object.metadata = metadata
    }
  }

  return objects
}

const resolveCustomApiVersion = (resource: string) => {
  const separator = resource.indexOf('.')
  if (separator === -1) return null
  const plural = resource.slice(0, separator)
  const group = resource.slice(separator + 1)
  if (!plural || !group || group === 'batch') return null
  return `${group}/v1alpha1`
}

const RESOURCE_KIND_LOOKUP = Object.fromEntries(
  Object.entries({
    Agent: 'agents.agents.proompteng.ai',
    AgentRun: 'agentruns.agents.proompteng.ai',
    AgentProvider: 'agentproviders.agents.proompteng.ai',
    ImplementationSpec: 'implementationspecs.agents.proompteng.ai',
    ImplementationSource: 'implementationsources.agents.proompteng.ai',
    VersionControlProvider: 'versioncontrolproviders.agents.proompteng.ai',
    Memory: 'memories.agents.proompteng.ai',
    Tool: 'tools.tools.proompteng.ai',
    ToolRun: 'toolruns.tools.proompteng.ai',
    Orchestration: 'orchestrations.orchestration.proompteng.ai',
    OrchestrationRun: 'orchestrationruns.orchestration.proompteng.ai',
    ApprovalPolicy: 'approvalpolicies.approvals.proompteng.ai',
    Budget: 'budgets.budgets.proompteng.ai',
    SecretBinding: 'secretbindings.security.proompteng.ai',
    Signal: 'signals.signals.proompteng.ai',
    SignalDelivery: 'signaldeliveries.signals.proompteng.ai',
    Schedule: 'schedules.schedules.proompteng.ai',
    Swarm: 'swarms.swarm.proompteng.ai',
    Artifact: 'artifacts.artifacts.proompteng.ai',
    Workspace: 'workspaces.workspaces.proompteng.ai',
  }).map(([kind, resource]) => [resource, kind]),
)

const resolveTargetFromResource = (resource: string): BuiltinResourceTarget => {
  const normalized = resource.trim().toLowerCase()
  const builtin = BUILTIN_RESOURCE_TARGETS[normalized]
  if (builtin) return builtin

  const kind = RESOURCE_KIND_LOOKUP[resource]
  const apiVersion = resolveCustomApiVersion(resource)
  if (kind && apiVersion) {
    return {
      apiVersion,
      kind,
      plural: resource.slice(0, resource.indexOf('.')),
      namespaceScoped: true,
    }
  }

  throw new Error(`unsupported kubernetes resource: ${resource}`)
}

const resolveTargetFromObject = (resource: Record<string, unknown>) => {
  const apiVersion = asString(resource.apiVersion)
  const kind = asString(resource.kind)
  if (!apiVersion || !kind) {
    throw new Error('resource is missing apiVersion or kind')
  }
  const metadata = (asRecord(resource.metadata) ?? {}) as Record<string, unknown>
  return {
    apiVersion,
    kind,
    namespace: asString(metadata.namespace),
    name: asString(metadata.name),
    generateName: asString(metadata.generateName),
  }
}

const ensureResourceVersion = async (
  objects: KubernetesObjectApi,
  resource: Record<string, unknown>,
  target: ReturnType<typeof resolveTargetFromObject>,
) => {
  if (!target.name) return resource

  try {
    const existing = await objects.read({
      apiVersion: target.apiVersion,
      kind: target.kind,
      metadata: {
        name: target.name,
        ...(target.namespace ? { namespace: target.namespace } : {}),
      },
    })
    const existingVersion = asString(asRecord(existing.metadata)?.resourceVersion)
    if (!existingVersion) return resource

    const metadata = (asRecord(resource.metadata) ?? {}) as Record<string, unknown>
    metadata.resourceVersion = existingVersion
    return { ...resource, metadata }
  } catch (error) {
    if (isNotFound(error)) return resource
    throw error
  }
}

const getKubeClients = (): KubeClients => {
  if (globalState.__jangarNativeKubeClients) return globalState.__jangarNativeKubeClients

  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromDefault()

  globalState.__jangarNativeKubeClients = {
    kubeConfig,
    objects: KubernetesObjectApi.makeApiClient(kubeConfig),
    core: kubeConfig.makeApiClient(CoreV1Api),
  }

  return globalState.__jangarNativeKubeClients
}

const readObject = async (objects: KubernetesObjectApi, resource: string, name: string, namespace: string) => {
  const target = resolveTargetFromResource(resource)
  return objects.read({
    apiVersion: target.apiVersion,
    kind: target.kind,
    metadata: {
      name,
      ...(target.namespaceScoped ? { namespace } : {}),
    },
  })
}

const listObjects = async (
  objects: KubernetesObjectApi,
  resource: string,
  namespace: string,
  labelSelector?: string,
  fieldSelector?: string,
) => {
  const target = resolveTargetFromResource(resource)
  return objects.list(
    target.apiVersion,
    target.kind,
    target.namespaceScoped ? namespace : undefined,
    undefined,
    undefined,
    undefined,
    fieldSelector,
    labelSelector,
  )
}

const createObject = async (objects: KubernetesObjectApi, resource: Record<string, unknown>) => {
  return objects.create(resource)
}

const replaceObject = async (objects: KubernetesObjectApi, resource: Record<string, unknown>) => {
  return objects.replace(resource)
}

const upsertObject = async (objects: KubernetesObjectApi, resource: Record<string, unknown>) => {
  const target = resolveTargetFromObject(resource)
  const hasGeneratedName = Boolean(target.generateName && !target.name)
  if (hasGeneratedName) {
    return createObject(objects, resource)
  }

  if (!target.name) {
    throw new Error('resource.metadata.name or resource.metadata.generateName is required')
  }

  const next = await ensureResourceVersion(objects, resource, target)
  const metadata = asRecord(next.metadata)
  if (asString(metadata?.resourceVersion)) {
    return replaceObject(objects, next)
  }

  return createObject(objects, next)
}

const isCustomObjectTarget = (apiVersion: string) => apiVersion.includes('/')

const applyStatusResource = async (objects: KubernetesObjectApi, resource: Record<string, unknown>) => {
  const target = resolveTargetFromObject(resource)
  if (!target.name) throw new Error('status resource.metadata.name is required')

  const current = await readObject(
    objects,
    RESOURCE_MAP[target.kind as keyof typeof RESOURCE_MAP] ?? `${target.kind.toLowerCase()}s`,
    target.name,
    target.namespace ?? 'default',
  )
  const resourceVersion = asString(asRecord(current.metadata)?.resourceVersion)
  const metadata = {
    name: target.name,
    ...(target.namespace ? { namespace: target.namespace } : {}),
    ...(resourceVersion ? { resourceVersion } : {}),
  }
  const statusResource = {
    apiVersion: target.apiVersion,
    kind: target.kind,
    metadata,
    status: asRecord(resource.status) ?? resource.status ?? {},
  }

  if (!isCustomObjectTarget(target.apiVersion)) {
    return objects.patch(statusResource, undefined, undefined, undefined, undefined, PatchStrategy.MergePatch)
  }

  return objects.patch(statusResource, undefined, undefined, 'jangar-status', true, PatchStrategy.MergePatch)
}

export const createKubernetesClient = (): KubernetesClient => ({
  apply: async (resource) => {
    const objects = getKubeClients().objects
    return upsertObject(objects, cloneRecord(resource)) as Promise<Record<string, unknown>>
  },
  applyManifest: async (manifest, namespace) => {
    const objects = getKubeClients().objects
    const resources = toManifestObjects(manifest, namespace)
    let last: Record<string, unknown> | null = null
    for (const resource of resources) {
      last = (await upsertObject(objects, resource)) as Record<string, unknown>
    }
    if (!last) {
      throw new Error('kubernetes apply failed: manifest did not contain any kubernetes objects')
    }
    return last
  },
  applyStatus: async (resource) => {
    const objects = getKubeClients().objects
    return applyStatusResource(objects, cloneRecord(resource)) as Promise<Record<string, unknown>>
  },
  createManifest: async (manifest, namespace) => {
    const objects = getKubeClients().objects
    const resources = toManifestObjects(manifest, namespace)
    let last: Record<string, unknown> | null = null
    for (const resource of resources) {
      last = (await createObject(objects, resource)) as Record<string, unknown>
    }
    if (!last) {
      throw new Error('kubernetes create failed: manifest did not contain any kubernetes objects')
    }
    return last
  },
  delete: async (resource, name, namespace, options) => {
    const objects = getKubeClients().objects
    const target = resolveTargetFromResource(resource)
    try {
      return (await objects.delete(
        {
          apiVersion: target.apiVersion,
          kind: target.kind,
          metadata: {
            name,
            ...(target.namespaceScoped ? { namespace } : {}),
          },
        },
        undefined,
        undefined,
        options?.wait === false ? 0 : undefined,
        undefined,
        'Background',
        {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          ...(options?.timeoutSeconds ? { gracePeriodSeconds: options.timeoutSeconds } : {}),
        },
      )) as Record<string, unknown>
    } catch (error) {
      if (isNotFound(error)) return null
      throw new Error(`kubernetes delete failed: ${normalizeKubeErrorMessage(error)}`)
    }
  },
  patch: async (resource, name, namespace, patch) => {
    const objects = getKubeClients().objects
    const target = resolveTargetFromResource(resource)
    const body = {
      apiVersion: target.apiVersion,
      kind: target.kind,
      metadata: {
        name,
        ...(target.namespaceScoped ? { namespace } : {}),
      },
      ...cloneRecord(patch),
    }
    try {
      return (await objects.patch(
        body,
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.MergePatch,
      )) as Record<string, unknown>
    } catch (error) {
      throw new Error(`kubernetes patch failed: ${normalizeKubeErrorMessage(error)}`)
    }
  },
  get: async (resource, name, namespace) => {
    const objects = getKubeClients().objects
    try {
      return (await readObject(objects, resource, name, namespace)) as Record<string, unknown>
    } catch (error) {
      if (isNotFound(error)) return null
      throw new Error(`kubernetes get failed: ${normalizeKubeErrorMessage(error)}`)
    }
  },
  list: async (resource, namespace, labelSelector) => {
    const objects = getKubeClients().objects
    try {
      return (await listObjects(objects, resource, namespace, labelSelector)) as unknown as Record<string, unknown>
    } catch (error) {
      throw new Error(`kubernetes list failed: ${normalizeKubeErrorMessage(error)}`)
    }
  },
  listEvents: async (namespace, fieldSelector) => {
    const objects = getKubeClients().objects
    try {
      return (await listObjects(objects, 'events', namespace, undefined, fieldSelector)) as unknown as Record<
        string,
        unknown
      >
    } catch (error) {
      throw new Error(`kubernetes events failed: ${normalizeKubeErrorMessage(error)}`)
    }
  },
  logs: async ({ pod, namespace, container, tailLines }) => {
    const core = getKubeClients().core
    try {
      const logs = await core.readNamespacedPodLog({
        name: pod,
        namespace,
        ...(container ? { container } : {}),
        ...(tailLines && Number.isFinite(tailLines) ? { tailLines: Math.max(1, Math.floor(tailLines)) } : {}),
      })
      return typeof logs === 'string' ? logs : JSON.stringify(logs)
    } catch (error) {
      throw new Error(`kubernetes logs failed: ${normalizeKubeErrorMessage(error)}`)
    }
  },
})

export const RESOURCE_MAP = {
  Agent: 'agents.agents.proompteng.ai',
  AgentRun: 'agentruns.agents.proompteng.ai',
  AgentProvider: 'agentproviders.agents.proompteng.ai',
  ImplementationSpec: 'implementationspecs.agents.proompteng.ai',
  ImplementationSource: 'implementationsources.agents.proompteng.ai',
  VersionControlProvider: 'versioncontrolproviders.agents.proompteng.ai',
  Memory: 'memories.agents.proompteng.ai',
  Tool: 'tools.tools.proompteng.ai',
  ToolRun: 'toolruns.tools.proompteng.ai',
  Orchestration: 'orchestrations.orchestration.proompteng.ai',
  OrchestrationRun: 'orchestrationruns.orchestration.proompteng.ai',
  ApprovalPolicy: 'approvalpolicies.approvals.proompteng.ai',
  Budget: 'budgets.budgets.proompteng.ai',
  SecretBinding: 'secretbindings.security.proompteng.ai',
  Signal: 'signals.signals.proompteng.ai',
  SignalDelivery: 'signaldeliveries.signals.proompteng.ai',
  Schedule: 'schedules.schedules.proompteng.ai',
  Swarm: 'swarms.swarm.proompteng.ai',
  Artifact: 'artifacts.artifacts.proompteng.ai',
  Workspace: 'workspaces.workspaces.proompteng.ai',
} as const

export const getNativeKubeClients = getKubeClients
export const resolveKubernetesResourceTarget = resolveTargetFromResource
export const splitKubernetesApiVersion = apiVersionToGroupVersion
export const buildKubernetesResourceCollectionPath = (resource: string, namespace: string) => {
  const target = resolveTargetFromResource(resource)
  const { group, version } = apiVersionToGroupVersion(target.apiVersion)
  if (group) {
    return target.namespaceScoped
      ? `/apis/${group}/${version}/namespaces/${namespace}/${target.plural}`
      : `/apis/${group}/${version}/${target.plural}`
  }
  return target.namespaceScoped
    ? `/api/${version}/namespaces/${namespace}/${target.plural}`
    : `/api/${version}/${target.plural}`
}

export const __private = {
  apiVersionToGroupVersion,
  buildKubernetesResourceCollectionPath,
  getKubeClients,
  isNotFound,
  normalizeKubeErrorMessage,
  parseJson,
  resolveTargetFromObject,
  resolveTargetFromResource,
  toManifestObjects,
}

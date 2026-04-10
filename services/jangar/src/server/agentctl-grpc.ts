import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import { status as GrpcStatus, ServerCredentials, type ServerUnaryCall, type ServerWritableStream } from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'
import { KubeConfig, Log } from '@kubernetes/client-node'
import { postAgentRunsHandler } from '~/routes/v1/agent-runs'
import { resolveAgentctlGrpcConfig } from '~/server/agentctl-grpc-config'
import { buildControlPlaneStatus, type GrpcStatus as ControlPlaneGrpcStatus } from '~/server/control-plane-status'
import { startResourceWatch } from '~/server/kube-watch'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { asRecord, asString } from '~/server/primitives-http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const DEFAULT_NAMESPACE = 'agents'
const DEFAULT_WORKFLOW_STEP = 'implement'
const SERVICE_NAME = 'jangar'

type AgentctlServer = {
  server: grpc.Server
  address: string
}

type RuntimeEntry = { key: string; value: string }

type AgentctlPackage = {
  AgentctlService: grpc.ServiceDefinition | grpc.ServiceClientConstructor
}

type UnaryCallback = grpc.sendUnaryData<unknown>
type UnaryCall<Request> = ServerUnaryCall<Request, unknown>
type ReadableCall<Request> = grpc.ServerReadableStream<Request, unknown>
type WritableCall<Request> = grpc.ServerWritableStream<Request, unknown>

type AgentRunPodSelection = {
  podName: string
  containerName: string | null
}

const logState = globalThis as typeof globalThis & {
  __jangarGrpcLogHelper?: Log
}

const buildServiceError = (code: grpc.status, message: string): grpc.ServiceError => {
  const error = new Error(message) as grpc.ServiceError
  error.code = code
  error.details = message
  error.metadata = new grpc.Metadata()
  return error
}

type ListRequest = { namespace?: string; label_selector?: string; phase?: string; runtime?: string }
type NameRequest = { namespace?: string; name?: string }
type ApplyRequest = { namespace?: string; manifest_yaml?: string }
type CreateImplRequest = {
  namespace?: string
  text?: string
  summary?: string
  source?: { provider?: string; external_id?: string; url?: string }
}
type SubmitRunRequest = {
  namespace?: string
  agent_name?: string
  implementation_name?: string
  runtime_type?: string
  runtime_config?: RuntimeEntry[]
  parameters?: RuntimeEntry[]
  idempotency_key?: string
  workload?: { image?: string; cpu?: string; memory?: string }
  memory_ref?: string
  vcs_ref?: string
  vcs_policy_mode?: string
  vcs_policy_required?: boolean
}
type LogsRequest = { namespace?: string; name?: string; follow?: boolean }
type StatusStreamRequest = { namespace?: string; name?: string }
type ControlPlaneStatusRequest = { namespace?: string }

const resolveProtoPath = () => {
  const config = resolveAgentctlGrpcConfig()
  if (config.protoPathOverride && existsSync(config.protoPathOverride)) return config.protoPathOverride

  const cwd = process.cwd()
  const moduleDir = resolve(fileURLToPath(import.meta.url), '..')

  const candidates = [
    resolve(cwd, 'proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, '.output/server/proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, '../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, '../../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, 'proto/agentctl.proto'),
    resolve(moduleDir, '../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(moduleDir, '../../../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(moduleDir, '../../../../proto/proompteng/jangar/v1/agentctl.proto'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

const loadAgentctlPackage = (): AgentctlPackage => {
  const protoPath = resolveProtoPath()
  if (!protoPath) {
    throw new Error('agentctl proto not found; set JANGAR_GRPC_PROTO_PATH or copy proto to runtime assets')
  }

  const packageDefinition = loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    proompteng?: { jangar?: { v1?: AgentctlPackage } }
  }

  const pkg = loaded.proompteng?.jangar?.v1
  if (!pkg?.AgentctlService) {
    throw new Error('agentctl proto missing AgentctlService definition')
  }
  return pkg
}

const normalizeNamespace = (value?: string | null) => {
  if (!value) return DEFAULT_NAMESPACE
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_NAMESPACE
}

const normalizeFilter = (value?: string | null) => {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const parseEntryMap = (entries: RuntimeEntry[]) => {
  const map: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry?.key) continue
    map[entry.key] = entry.value ?? ''
  }
  return map
}

const resolveAuthToken = (metadata: grpc.Metadata) => {
  const values = [metadata.get('authorization'), metadata.get('x-jangar-token')].flat()
  const raw = values.find((value) => typeof value === 'string')
  if (!raw) return null
  if (raw.toLowerCase().startsWith('bearer ')) return raw.slice(7).trim()
  return raw.trim()
}

const requireAuth = (call: UnaryCall<unknown> | ReadableCall<unknown> | WritableCall<unknown>) => {
  const expected = resolveAgentctlGrpcConfig().authToken
  if (!expected) return null
  const provided = resolveAuthToken(call.metadata)
  if (!provided || provided !== expected) {
    return buildServiceError(GrpcStatus.UNAUTHENTICATED, 'invalid or missing agentctl token')
  }
  return null
}

const handleUnaryError = (callback: UnaryCallback, error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    callback(error as grpc.ServiceError, null)
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  callback(buildServiceError(GrpcStatus.INTERNAL, message), null)
}

const requireLeaderForMutation = (): grpc.ServiceError | null => {
  const leaderElection = getLeaderElectionStatus()
  if (!leaderElection.enabled || !leaderElection.required) return null
  if (leaderElection.isLeader) return null
  return buildServiceError(GrpcStatus.UNAVAILABLE, 'Not leader; retry on the elected controller replica.')
}

const createListHandler =
  (kube: KubernetesClient, resource: string) => async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    try {
      const namespace = normalizeNamespace(call.request?.namespace)
      const result = await kube.list(resource, namespace, call.request?.label_selector || undefined)
      callback(null, { json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  }

const createGetHandler =
  (kube: KubernetesClient, resource: string, notFoundMessage: string) =>
  async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    try {
      const namespace = normalizeNamespace(call.request?.namespace)
      const name = call.request?.name ?? ''
      const result = await kube.get(resource, name, namespace)
      if (!result) {
        return callback({ code: GrpcStatus.NOT_FOUND, message: notFoundMessage }, null)
      }
      callback(null, { json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  }

const createApplyHandler =
  (kube: KubernetesClient) => async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    const leaderError = requireLeaderForMutation()
    if (leaderError) return callback(leaderError, null)
    try {
      const namespace = call.request?.namespace ? normalizeNamespace(call.request.namespace) : null
      const manifest = call.request?.manifest_yaml ?? ''
      const result = await kube.applyManifest(manifest, namespace)
      callback(null, { json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  }

const createDeleteHandler =
  (kube: KubernetesClient, resource: string, notFoundMessage: string) =>
  async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    const leaderError = requireLeaderForMutation()
    if (leaderError) return callback(leaderError, null)
    try {
      const namespace = normalizeNamespace(call.request?.namespace)
      const name = call.request?.name ?? ''
      const result = await kube.delete(resource, name, namespace)
      if (!result) {
        return callback({ code: GrpcStatus.NOT_FOUND, message: notFoundMessage }, null)
      }
      callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  }

const resolveAgentRunRuntime = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  const runtimeRef = asRecord(status?.runtimeRef)
  const runtimeType = asString(runtimeRef?.type) ?? asString(readNested(resource, ['spec', 'runtime', 'type']))
  const runtimeName = asString(runtimeRef?.name)
  return { runtimeType, runtimeName }
}

const matchesAgentRunFilters = (resource: Record<string, unknown>, phase?: string, runtime?: string) => {
  if (phase) {
    const status = asRecord(resource.status) ?? {}
    const itemPhase = asString(status.phase)
    if (itemPhase !== phase) return false
  }
  if (runtime) {
    const spec = asRecord(resource.spec) ?? {}
    const runtimeSpec = asRecord(spec.runtime) ?? {}
    const runtimeType = asString(runtimeSpec.type)
    if (runtimeType !== runtime) return false
  }
  return true
}

const resolveStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status) ?? {}
  const keys = ['phase', 'status', 'state', 'result']
  for (const key of keys) {
    const value = asString(status[key])
    if (value?.trim()) {
      return value
    }
  }
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  const ready = conditions.find((entry) => asString(asRecord(entry)?.type) === 'Ready')
  const readyStatus = asString(asRecord(ready)?.status)
  return readyStatus ?? ''
}

const isTerminalPhase = (phase: string) => {
  const normalized = phase.trim().toLowerCase()
  return (
    normalized === 'succeeded' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled'
  )
}

const readNested = (value: unknown, path: string[]) => {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}

const isJobRuntime = (runtimeType: string | null) => runtimeType === 'job' || runtimeType === 'workflow'

const getGrpcLogHelper = () => {
  if (logState.__jangarGrpcLogHelper) return logState.__jangarGrpcLogHelper
  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromDefault()
  logState.__jangarGrpcLogHelper = new Log(kubeConfig)
  return logState.__jangarGrpcLogHelper
}

const listAgentRunPods = async (
  kube: KubernetesClient,
  runName: string,
  namespace: string,
  runtimeType: string | null,
  runtimeName: string | null,
) => {
  const labelSelector =
    isJobRuntime(runtimeType) && runtimeName ? `job-name=${runtimeName}` : `agents.proompteng.ai/agent-run=${runName}`
  const list = await kube.list('pods', namespace, labelSelector)
  const items = Array.isArray(list.items) ? list.items : []
  return items.map((item) => asRecord(item) ?? {}).filter((item) => Object.keys(item).length > 0)
}

const resolvePodContainer = (pod: Record<string, unknown>): AgentRunPodSelection | null => {
  const metadata = asRecord(pod.metadata) ?? {}
  const spec = asRecord(pod.spec) ?? {}
  const status = asRecord(pod.status) ?? {}
  const podName = asString(metadata.name)
  if (!podName) return null

  const runningContainerStatuses = (Array.isArray(status.containerStatuses) ? status.containerStatuses : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => Boolean(asRecord(entry.state)?.running))
    .map((entry) => asString(entry.name))
    .filter((entry): entry is string => Boolean(entry))

  const mainContainers = (Array.isArray(spec.containers) ? spec.containers : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => asString(entry.name))
    .filter((entry): entry is string => Boolean(entry))

  return {
    podName,
    containerName: runningContainerStatuses[0] ?? mainContainers[0] ?? null,
  }
}

const comparePods = (left: Record<string, unknown>, right: Record<string, unknown>) => {
  const leftStatus = asRecord(left.status) ?? {}
  const rightStatus = asRecord(right.status) ?? {}
  const leftRunning = asString(leftStatus.phase) === 'Running'
  const rightRunning = asString(rightStatus.phase) === 'Running'
  if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
  const leftTime = asString(asRecord(left.metadata)?.creationTimestamp) ?? ''
  const rightTime = asString(asRecord(right.metadata)?.creationTimestamp) ?? ''
  return rightTime.localeCompare(leftTime)
}

const selectAgentRunPod = async (
  kube: KubernetesClient,
  runName: string,
  namespace: string,
  runtimeType: string | null,
  runtimeName: string | null,
) => {
  const pods = await listAgentRunPods(kube, runName, namespace, runtimeType, runtimeName)
  if (pods.length === 0) return null
  const selected =
    [...pods]
      .sort(comparePods)
      .map((pod) => resolvePodContainer(pod))
      .find((pod) => pod !== null) ?? null
  return selected
}

const resolveCancellableJobNames = async (
  kube: KubernetesClient,
  runtimeType: string | null,
  runtimeName: string | null,
  runName: string,
  namespace: string,
) => {
  if (runtimeType === 'workflow') {
    const list = await kube.list('jobs.batch', namespace, `agents.proompteng.ai/agent-run=${runName}`)
    const items = Array.isArray(list.items) ? list.items : []
    return items
      .map((entry) => asString(asRecord(asRecord(entry)?.metadata)?.name))
      .filter((entry): entry is string => Boolean(entry))
  }
  if (isJobRuntime(runtimeType) && runtimeName) {
    return [runtimeName]
  }
  return []
}

const buildServerInfo = () => ({
  version: resolveAgentctlGrpcConfig().version,
  build_sha: resolveAgentctlGrpcConfig().buildSha,
  build_time: resolveAgentctlGrpcConfig().buildTime,
  service: SERVICE_NAME,
})

const resolveComponent = () => {
  if (resolveAgentctlGrpcConfig().agentsControllerEnabled) {
    return 'controllers'
  }
  return 'control plane'
}

export const startAgentctlGrpcServer = (): AgentctlServer | null => {
  const component = resolveComponent()
  const config = resolveAgentctlGrpcConfig()
  if (!config.enabled) {
    console.info(`[jangar] agentctl grpc not enabled for ${component}; set JANGAR_GRPC_ENABLED=true to start listener`)
    return null
  }

  const pkg = loadAgentctlPackage()
  const server = new grpc.Server()

  const kube = createKubernetesClient()

  const serviceDefinition =
    (pkg.AgentctlService as grpc.ServiceClientConstructor & { service?: grpc.ServiceDefinition }).service ??
    pkg.AgentctlService

  server.addService(serviceDefinition as grpc.ServiceDefinition, {
    GetServerInfo: (call: UnaryCall<Record<string, never>>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      callback(null, buildServerInfo())
    },

    ListAgents: async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const result = await kube.list(RESOURCE_MAP.Agent, namespace, call.request?.label_selector || undefined)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    GetAgent: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.get(RESOURCE_MAP.Agent, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'Agent not found' }, null)
        }
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    ApplyAgent: async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = call.request?.namespace ? normalizeNamespace(call.request.namespace) : null
        const manifest = call.request?.manifest_yaml ?? ''
        const result = await kube.applyManifest(manifest, namespace)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    DeleteAgent: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.delete(RESOURCE_MAP.Agent, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'Agent not found' }, null)
        }
        callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    ListAgentProviders: createListHandler(kube, RESOURCE_MAP.AgentProvider),
    GetAgentProvider: createGetHandler(kube, RESOURCE_MAP.AgentProvider, 'AgentProvider not found'),
    ApplyAgentProvider: createApplyHandler(kube),
    DeleteAgentProvider: createDeleteHandler(kube, RESOURCE_MAP.AgentProvider, 'AgentProvider not found'),

    ListImplementationSpecs: async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const result = await kube.list(
          RESOURCE_MAP.ImplementationSpec,
          namespace,
          call.request?.label_selector || undefined,
        )
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    GetImplementationSpec: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.get(RESOURCE_MAP.ImplementationSpec, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'ImplementationSpec not found' }, null)
        }
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    ApplyImplementationSpec: async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = call.request?.namespace ? normalizeNamespace(call.request.namespace) : null
        const manifest = call.request?.manifest_yaml ?? ''
        const result = await kube.applyManifest(manifest, namespace)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    DeleteImplementationSpec: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.delete(RESOURCE_MAP.ImplementationSpec, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'ImplementationSpec not found' }, null)
        }
        callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    CreateImplementationSpec: async (call: UnaryCall<CreateImplRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const text = call.request?.text ?? ''
        if (!text.trim()) {
          return callback({ code: GrpcStatus.INVALID_ARGUMENT, message: 'text is required' }, null)
        }
        const summary = call.request?.summary ?? undefined
        const source = call.request?.source ?? undefined
        const manifest = {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'ImplementationSpec',
          metadata: { generateName: 'impl-', namespace },
          spec: {
            text,
            ...(summary ? { summary } : {}),
            ...(source?.provider
              ? {
                  source: {
                    provider: source.provider,
                    ...(source.external_id ? { externalId: source.external_id } : {}),
                    ...(source.url ? { url: source.url } : {}),
                  },
                }
              : {}),
          },
        }
        const result = await kube.createManifest(JSON.stringify(manifest), namespace)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    ListImplementationSources: async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const result = await kube.list(
          RESOURCE_MAP.ImplementationSource,
          namespace,
          call.request?.label_selector || undefined,
        )
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    GetImplementationSource: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.get(RESOURCE_MAP.ImplementationSource, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'ImplementationSource not found' }, null)
        }
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    ApplyImplementationSource: async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = call.request?.namespace ? normalizeNamespace(call.request.namespace) : null
        const manifest = call.request?.manifest_yaml ?? ''
        const result = await kube.applyManifest(manifest, namespace)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    DeleteImplementationSource: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.delete(RESOURCE_MAP.ImplementationSource, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'ImplementationSource not found' }, null)
        }
        callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    ListVersionControlProviders: createListHandler(kube, RESOURCE_MAP.VersionControlProvider),
    GetVersionControlProvider: createGetHandler(
      kube,
      RESOURCE_MAP.VersionControlProvider,
      'VersionControlProvider not found',
    ),
    ApplyVersionControlProvider: createApplyHandler(kube),
    DeleteVersionControlProvider: createDeleteHandler(
      kube,
      RESOURCE_MAP.VersionControlProvider,
      'VersionControlProvider not found',
    ),

    ListMemories: async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const result = await kube.list(RESOURCE_MAP.Memory, namespace, call.request?.label_selector || undefined)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    GetMemory: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.get(RESOURCE_MAP.Memory, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'Memory not found' }, null)
        }
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    ApplyMemory: async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = call.request?.namespace ? normalizeNamespace(call.request.namespace) : null
        const manifest = call.request?.manifest_yaml ?? ''
        const result = await kube.applyManifest(manifest, namespace)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    DeleteMemory: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.delete(RESOURCE_MAP.Memory, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'Memory not found' }, null)
        }
        callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    ListTools: createListHandler(kube, RESOURCE_MAP.Tool),
    GetTool: createGetHandler(kube, RESOURCE_MAP.Tool, 'Tool not found'),
    ApplyTool: createApplyHandler(kube),
    DeleteTool: createDeleteHandler(kube, RESOURCE_MAP.Tool, 'Tool not found'),

    ListToolRuns: createListHandler(kube, RESOURCE_MAP.ToolRun),
    GetToolRun: createGetHandler(kube, RESOURCE_MAP.ToolRun, 'ToolRun not found'),
    ApplyToolRun: createApplyHandler(kube),
    DeleteToolRun: createDeleteHandler(kube, RESOURCE_MAP.ToolRun, 'ToolRun not found'),

    ListOrchestrations: createListHandler(kube, RESOURCE_MAP.Orchestration),
    GetOrchestration: createGetHandler(kube, RESOURCE_MAP.Orchestration, 'Orchestration not found'),
    ApplyOrchestration: createApplyHandler(kube),
    DeleteOrchestration: createDeleteHandler(kube, RESOURCE_MAP.Orchestration, 'Orchestration not found'),

    ListOrchestrationRuns: createListHandler(kube, RESOURCE_MAP.OrchestrationRun),
    GetOrchestrationRun: createGetHandler(kube, RESOURCE_MAP.OrchestrationRun, 'OrchestrationRun not found'),
    ApplyOrchestrationRun: createApplyHandler(kube),
    DeleteOrchestrationRun: createDeleteHandler(kube, RESOURCE_MAP.OrchestrationRun, 'OrchestrationRun not found'),

    ListApprovalPolicies: createListHandler(kube, RESOURCE_MAP.ApprovalPolicy),
    GetApprovalPolicy: createGetHandler(kube, RESOURCE_MAP.ApprovalPolicy, 'ApprovalPolicy not found'),
    ApplyApprovalPolicy: createApplyHandler(kube),
    DeleteApprovalPolicy: createDeleteHandler(kube, RESOURCE_MAP.ApprovalPolicy, 'ApprovalPolicy not found'),

    ListBudgets: createListHandler(kube, RESOURCE_MAP.Budget),
    GetBudget: createGetHandler(kube, RESOURCE_MAP.Budget, 'Budget not found'),
    ApplyBudget: createApplyHandler(kube),
    DeleteBudget: createDeleteHandler(kube, RESOURCE_MAP.Budget, 'Budget not found'),

    ListSecretBindings: createListHandler(kube, RESOURCE_MAP.SecretBinding),
    GetSecretBinding: createGetHandler(kube, RESOURCE_MAP.SecretBinding, 'SecretBinding not found'),
    ApplySecretBinding: createApplyHandler(kube),
    DeleteSecretBinding: createDeleteHandler(kube, RESOURCE_MAP.SecretBinding, 'SecretBinding not found'),

    ListSignals: createListHandler(kube, RESOURCE_MAP.Signal),
    GetSignal: createGetHandler(kube, RESOURCE_MAP.Signal, 'Signal not found'),
    ApplySignal: createApplyHandler(kube),
    DeleteSignal: createDeleteHandler(kube, RESOURCE_MAP.Signal, 'Signal not found'),

    ListSignalDeliveries: createListHandler(kube, RESOURCE_MAP.SignalDelivery),
    GetSignalDelivery: createGetHandler(kube, RESOURCE_MAP.SignalDelivery, 'SignalDelivery not found'),
    ApplySignalDelivery: createApplyHandler(kube),
    DeleteSignalDelivery: createDeleteHandler(kube, RESOURCE_MAP.SignalDelivery, 'SignalDelivery not found'),

    ListSchedules: createListHandler(kube, RESOURCE_MAP.Schedule),
    GetSchedule: createGetHandler(kube, RESOURCE_MAP.Schedule, 'Schedule not found'),
    ApplySchedule: createApplyHandler(kube),
    DeleteSchedule: createDeleteHandler(kube, RESOURCE_MAP.Schedule, 'Schedule not found'),

    ListArtifacts: createListHandler(kube, RESOURCE_MAP.Artifact),
    GetArtifact: createGetHandler(kube, RESOURCE_MAP.Artifact, 'Artifact not found'),
    ApplyArtifact: createApplyHandler(kube),
    DeleteArtifact: createDeleteHandler(kube, RESOURCE_MAP.Artifact, 'Artifact not found'),

    ListWorkspaces: createListHandler(kube, RESOURCE_MAP.Workspace),
    GetWorkspace: createGetHandler(kube, RESOURCE_MAP.Workspace, 'Workspace not found'),
    ApplyWorkspace: createApplyHandler(kube),
    DeleteWorkspace: createDeleteHandler(kube, RESOURCE_MAP.Workspace, 'Workspace not found'),

    ListAgentRuns: async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const phase = normalizeFilter(call.request?.phase)
        const runtime = normalizeFilter(call.request?.runtime)
        const result = await kube.list(RESOURCE_MAP.AgentRun, namespace, call.request?.label_selector || undefined)
        if (phase || runtime) {
          const items = Array.isArray(result.items) ? result.items : []
          const filtered = items.filter((item) => matchesAgentRunFilters(asRecord(item) ?? {}, phase, runtime))
          callback(null, { json: JSON.stringify({ ...result, items: filtered }) })
        } else {
          callback(null, { json: JSON.stringify(result) })
        }
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    GetAgentRun: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'AgentRun not found' }, null)
        }
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    ApplyAgentRun: async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = call.request?.namespace ? normalizeNamespace(call.request.namespace) : null
        const manifest = call.request?.manifest_yaml ?? ''
        const result = await kube.applyManifest(manifest, namespace)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
    DeleteAgentRun: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const result = await kube.delete(RESOURCE_MAP.AgentRun, name, namespace)
        if (!result) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'AgentRun not found' }, null)
        }
        callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    SubmitAgentRun: async (call: UnaryCall<SubmitRunRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const agentName = call.request?.agent_name ?? ''
        const implementationName = call.request?.implementation_name ?? ''
        const runtimeType = call.request?.runtime_type ?? ''
        if (!agentName || !implementationName || !runtimeType) {
          return callback(
            {
              code: GrpcStatus.INVALID_ARGUMENT,
              message: 'agent_name, implementation_name, and runtime_type are required',
            },
            null,
          )
        }

        const idempotencyKey = call.request?.idempotency_key ?? ''
        const runtimeConfig = parseEntryMap(call.request?.runtime_config ?? [])
        const parameters = parseEntryMap(call.request?.parameters ?? [])
        let stageValue: string | null = null
        if (runtimeType === 'workflow') {
          stageValue = asString(parameters.stage) ?? asString(runtimeConfig.stage) ?? DEFAULT_WORKFLOW_STEP
          if (!asString(parameters.stage)) {
            parameters.stage = stageValue
          }
        }

        const workload = call.request?.workload
        const payload: Record<string, unknown> = {
          agentRef: { name: agentName },
          namespace,
          implementationSpecRef: { name: implementationName },
          runtime: {
            type: runtimeType,
            ...(Object.keys(runtimeConfig).length > 0 ? { config: runtimeConfig } : {}),
          },
          ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        }

        if (runtimeType === 'workflow') {
          payload.workflow = {
            steps: [
              {
                name: stageValue ?? DEFAULT_WORKFLOW_STEP,
                parameters: { stage: stageValue ?? DEFAULT_WORKFLOW_STEP },
              },
            ],
          }
        }

        if (workload?.image || workload?.cpu || workload?.memory) {
          const workloadSpec: Record<string, unknown> = {}
          if (workload.image) workloadSpec.image = workload.image
          if (workload.cpu || workload.memory) {
            workloadSpec.resources = { requests: {} as Record<string, string> }
            if (workload.cpu)
              (workloadSpec.resources as { requests: Record<string, string> }).requests.cpu = workload.cpu
            if (workload.memory)
              (workloadSpec.resources as { requests: Record<string, string> }).requests.memory = workload.memory
          }
          payload.workload = workloadSpec
        }

        if (call.request?.memory_ref) {
          payload.memoryRef = { name: call.request.memory_ref }
        }

        if (call.request?.vcs_ref) {
          payload.vcsRef = { name: call.request.vcs_ref }
        }

        const vcsPolicy: Record<string, unknown> = {}
        if (call.request?.vcs_policy_mode) {
          vcsPolicy.mode = call.request.vcs_policy_mode
        }
        if (call.request?.vcs_policy_required) {
          vcsPolicy.required = true
        }
        if (Object.keys(vcsPolicy).length > 0) {
          payload.vcsPolicy = vcsPolicy
        }

        const request = new Request('http://localhost/v1/agent-runs', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey || randomUUID(),
          },
          body: JSON.stringify(payload),
        })

        const response = await postAgentRunsHandler(request, { kubeClient: kube })
        const body = (await response.json()) as Record<string, unknown>

        if (!response.ok) {
          const errorMessage = asString(body.error) ?? 'agent run submit failed'
          const status = response.status === 404 ? GrpcStatus.NOT_FOUND : GrpcStatus.FAILED_PRECONDITION
          return callback({ code: status, message: errorMessage }, null)
        }

        callback(null, {
          resource_json: body.resource ? JSON.stringify(body.resource) : '',
          record_json: body.agentRun ? JSON.stringify(body.agentRun) : '',
          idempotent: Boolean(body.idempotent),
        })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    CancelAgentRun: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      const leaderError = requireLeaderForMutation()
      if (leaderError) return callback(leaderError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const resource = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
        if (!resource) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'AgentRun not found' }, null)
        }
        const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
        const jobNames = await resolveCancellableJobNames(kube, runtimeType, runtimeName, name, namespace)
        if (jobNames.length === 0) {
          return callback(
            { code: GrpcStatus.FAILED_PRECONDITION, message: 'No cancellable runtime found for this AgentRun' },
            null,
          )
        }
        for (const jobName of jobNames) {
          await kube.delete('job', jobName, namespace, { wait: false })
        }
        callback(null, { ok: true, message: 'cancelled' })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    StreamAgentRunLogs: async (call: ServerWritableStream<LogsRequest, unknown>) => {
      const authError = requireAuth(call)
      if (authError) {
        call.destroy(Object.assign(new Error(authError.message), { code: authError.code }))
        return
      }
      const namespace = normalizeNamespace(call.request?.namespace)
      const name = call.request?.name ?? ''
      const resource = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
      if (!resource) {
        call.destroy(Object.assign(new Error('AgentRun not found'), { code: GrpcStatus.NOT_FOUND }))
        return
      }
      const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
      const pod = await selectAgentRunPod(kube, name, namespace, runtimeType, runtimeName)
      if (!pod) {
        call.end()
        return
      }
      if (!call.request?.follow) {
        const logs = await kube.logs({
          pod: pod.podName,
          namespace,
          container: pod.containerName,
        })
        if (logs.length > 0) {
          call.write({ stream: 'stdout', message: logs })
        }
        call.end()
        return
      }

      const stream = new PassThrough()
      stream.on('data', (chunk) => {
        call.write({
          stream: 'stdout',
          message: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
        })
      })
      stream.on('end', () => {
        call.end()
      })
      stream.on('error', (error) => {
        call.destroy(Object.assign(new Error(error.message), { code: GrpcStatus.INTERNAL }))
      })
      void getGrpcLogHelper()
        .log(namespace, pod.podName, pod.containerName ?? '', stream, {
          follow: true,
          pretty: false,
          timestamps: false,
        })
        .catch((error) => {
          call.destroy(
            Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
              code: GrpcStatus.INTERNAL,
            }),
          )
        })

      call.on('cancelled', () => {
        stream.destroy()
      })
      call.on('close', () => {
        stream.destroy()
      })
    },

    StreamAgentRunStatus: async (call: ServerWritableStream<StatusStreamRequest, unknown>) => {
      const authError = requireAuth(call)
      if (authError) {
        call.destroy(Object.assign(new Error(authError.message), { code: authError.code }))
        return
      }

      const namespace = normalizeNamespace(call.request?.namespace)
      const name = call.request?.name ?? ''
      if (!name) {
        call.destroy(Object.assign(new Error('AgentRun name is required'), { code: GrpcStatus.INVALID_ARGUMENT }))
        return
      }

      const existing = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
      if (!existing) {
        call.destroy(Object.assign(new Error('AgentRun not found'), { code: GrpcStatus.NOT_FOUND }))
        return
      }

      let ended = false
      let watchHandle: { stop: () => void } | null = null

      const stop = () => {
        if (ended) return
        ended = true
        watchHandle?.stop()
        watchHandle = null
        call.end()
      }

      const writeResource = (resource: Record<string, unknown>, isTerminal = false) => {
        if (ended) return
        const phase = resolveStatusPhase(resource)
        call.write({ json: JSON.stringify(resource), phase })
        if (isTerminal || (phase && isTerminalPhase(phase))) {
          stop()
        }
      }

      writeResource(existing)
      if (ended) {
        return
      }

      watchHandle = startResourceWatch({
        resource: RESOURCE_MAP.AgentRun,
        namespace,
        fieldSelector: `metadata.name=${name}`,
        logPrefix: '[jangar][agentctl][watch]',
        onEvent: (event) => {
          if (ended) return
          const resource = event.object
          if (!resource) return
          const isDeleted = event.type === 'DELETED'
          writeResource(resource, isDeleted)
        },
        onError: (error) => {
          if (ended) return
          ended = true
          watchHandle?.stop()
          watchHandle = null
          call.destroy(Object.assign(new Error(error.message), { code: GrpcStatus.INTERNAL }))
        },
      })

      call.on('cancelled', () => {
        stop()
      })
      call.on('close', () => {
        stop()
      })
    },

    GetControlPlaneStatus: async (call: UnaryCall<ControlPlaneStatusRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const grpcConfig = resolveAgentctlGrpcConfig()
        const grpcStatus: ControlPlaneGrpcStatus = {
          enabled: true,
          address: grpcConfig.address,
          status: 'healthy',
          message: '',
        }
        const status = await buildControlPlaneStatus({
          namespace,
          service: SERVICE_NAME,
          grpc: grpcStatus,
        })
        callback(null, status)
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },
  })

  server.bindAsync(config.address, ServerCredentials.createInsecure(), (error) => {
    if (error) {
      console.error('[jangar] agentctl grpc failed to bind', error)
      return
    }
    console.info(`[jangar] agentctl grpc listening on ${config.address} for ${component}`)
  })

  return { server, address: config.address }
}

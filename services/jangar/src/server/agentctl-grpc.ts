import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import { status as GrpcStatus, ServerCredentials, type ServerUnaryCall, type ServerWritableStream } from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'
import { postAgentRunsHandler } from '~/routes/v1/agent-runs'
import { postOrchestrationRunsHandler } from '~/routes/v1/orchestration-runs'
import { asRecord, asString } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const DEFAULT_NAMESPACE = 'agents'
const DEFAULT_GRPC_PORT = 50051
const SERVICE_NAME = 'jangar'

type AgentctlServer = {
  server: grpc.Server
  address: string
}

type RuntimeEntry = { key: string; value: string }

type AgentctlPackage = {
  AgentctlService: grpc.ServiceDefinition
}

type UnaryCallback = grpc.sendUnaryData<unknown>
type UnaryCall<Request> = ServerUnaryCall<Request, unknown>
type ReadableCall<Request> = grpc.ServerReadableStream<Request, unknown>

type ListRequest = { namespace?: string; label_selector?: string }
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
}
type SubmitOrchestrationRunRequest = {
  namespace?: string
  orchestration_name?: string
  parameters?: RuntimeEntry[]
  idempotency_key?: string
  budget_ref?: string
}
type SubmitToolRunRequest = {
  namespace?: string
  tool_name?: string
  parameters?: RuntimeEntry[]
  retry_limit?: number
  timeout_seconds?: number
}
type LogsRequest = { namespace?: string; name?: string; follow?: boolean }

const resolveProtoPath = () => {
  const envPath = process.env.JANGAR_GRPC_PROTO_PATH?.trim()
  if (envPath && existsSync(envPath)) return envPath

  const cwd = process.cwd()
  const moduleDir = resolve(fileURLToPath(import.meta.url), '..')

  const candidates = [
    resolve(cwd, 'proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, '../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, '../../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(cwd, 'proto/agentctl.proto'),
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

const requireAuth = (call: UnaryCall<unknown> | ReadableCall<unknown>) => {
  const expected = process.env.JANGAR_GRPC_TOKEN?.trim()
  if (!expected) return null
  const provided = resolveAuthToken(call.metadata)
  if (!provided || provided !== expected) {
    return {
      code: GrpcStatus.UNAUTHENTICATED,
      message: 'invalid or missing agentctl token',
    }
  }
  return null
}

const handleUnaryError = (callback: UnaryCallback, error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    callback(error as grpc.ServiceError, null)
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  callback({ code: GrpcStatus.INTERNAL, message }, null)
}

const spawnKubectl = (args: string[]) =>
  spawn('kubectl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const resolveAgentRunRuntime = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  const runtimeRef = asRecord(status?.runtimeRef)
  const runtimeType = asString(runtimeRef?.type) ?? asString(readNested(resource, ['spec', 'runtime', 'type']))
  const runtimeName = asString(runtimeRef?.name)
  return { runtimeType, runtimeName }
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

const buildLogArgs = (runName: string, namespace: string, runtimeType: string | null, runtimeName: string | null) => {
  if (isJobRuntime(runtimeType) && runtimeName) {
    return ['logs', `job/${runtimeName}`, '-n', namespace]
  }
  return ['logs', '-l', `agents.proompteng.ai/agent-run=${runName}`, '-n', namespace]
}

const buildCancelArgs = (
  runtimeType: string | null,
  runtimeName: string | null,
  runName: string,
  namespace: string,
) => {
  if (runtimeType === 'workflow') {
    return ['delete', 'job', '-l', `agents.proompteng.ai/agent-run=${runName}`, '-n', namespace, '--ignore-not-found']
  }
  if (isJobRuntime(runtimeType) && runtimeName) {
    return ['delete', 'job', runtimeName, '-n', namespace]
  }
  return null
}

const buildServerInfo = () => ({
  version: process.env.JANGAR_VERSION ?? 'dev',
  build_sha: process.env.JANGAR_BUILD_SHA ?? '',
  build_time: process.env.JANGAR_BUILD_TIME ?? '',
  service: SERVICE_NAME,
})

const createCrudHandlers = (kube: ReturnType<typeof createKubernetesClient>, resource: string, kindLabel: string) => ({
  list: async (call: UnaryCall<ListRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    try {
      const namespace = normalizeNamespace(call.request?.namespace)
      const result = await kube.list(resource, namespace, call.request?.label_selector || undefined)
      callback(null, { json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  },
  get: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    try {
      const namespace = normalizeNamespace(call.request?.namespace)
      const name = call.request?.name ?? ''
      const result = await kube.get(resource, name, namespace)
      if (!result) {
        return callback({ code: GrpcStatus.NOT_FOUND, message: `${kindLabel} not found` }, null)
      }
      callback(null, { json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  },
  apply: async (call: UnaryCall<ApplyRequest>, callback: UnaryCallback) => {
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
  del: async (call: UnaryCall<NameRequest>, callback: UnaryCallback) => {
    const authError = requireAuth(call)
    if (authError) return callback(authError, null)
    try {
      const namespace = normalizeNamespace(call.request?.namespace)
      const name = call.request?.name ?? ''
      const result = await kube.delete(resource, name, namespace)
      if (!result) {
        return callback({ code: GrpcStatus.NOT_FOUND, message: `${kindLabel} not found` }, null)
      }
      callback(null, { ok: true, message: 'deleted', json: JSON.stringify(result) })
    } catch (error) {
      handleUnaryError(callback, error)
    }
  },
})

export const startAgentctlGrpcServer = (): AgentctlServer | null => {
  const enabled = (process.env.JANGAR_GRPC_ENABLED ?? '').trim().toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(enabled)) {
    return null
  }

  const host = (process.env.JANGAR_GRPC_HOST ?? '').trim() || '127.0.0.1'
  const port = Number.parseInt(process.env.JANGAR_GRPC_PORT ?? '', 10) || DEFAULT_GRPC_PORT
  const address = process.env.JANGAR_GRPC_ADDRESS?.trim() || `${host}:${port}`

  const pkg = loadAgentctlPackage()
  const server = new grpc.Server()

  const kube = createKubernetesClient()
  const agentHandlers = createCrudHandlers(kube, RESOURCE_MAP.Agent, 'Agent')
  const implementationSpecHandlers = createCrudHandlers(kube, RESOURCE_MAP.ImplementationSpec, 'ImplementationSpec')
  const implementationSourceHandlers = createCrudHandlers(
    kube,
    RESOURCE_MAP.ImplementationSource,
    'ImplementationSource',
  )
  const memoryHandlers = createCrudHandlers(kube, RESOURCE_MAP.Memory, 'Memory')
  const orchestrationHandlers = createCrudHandlers(kube, RESOURCE_MAP.Orchestration, 'Orchestration')
  const orchestrationRunHandlers = createCrudHandlers(kube, RESOURCE_MAP.OrchestrationRun, 'OrchestrationRun')
  const toolHandlers = createCrudHandlers(kube, RESOURCE_MAP.Tool, 'Tool')
  const toolRunHandlers = createCrudHandlers(kube, RESOURCE_MAP.ToolRun, 'ToolRun')
  const signalHandlers = createCrudHandlers(kube, RESOURCE_MAP.Signal, 'Signal')
  const signalDeliveryHandlers = createCrudHandlers(kube, RESOURCE_MAP.SignalDelivery, 'SignalDelivery')
  const approvalPolicyHandlers = createCrudHandlers(kube, RESOURCE_MAP.ApprovalPolicy, 'ApprovalPolicy')
  const budgetHandlers = createCrudHandlers(kube, RESOURCE_MAP.Budget, 'Budget')
  const secretBindingHandlers = createCrudHandlers(kube, RESOURCE_MAP.SecretBinding, 'SecretBinding')
  const scheduleHandlers = createCrudHandlers(kube, RESOURCE_MAP.Schedule, 'Schedule')
  const artifactHandlers = createCrudHandlers(kube, RESOURCE_MAP.Artifact, 'Artifact')
  const workspaceHandlers = createCrudHandlers(kube, RESOURCE_MAP.Workspace, 'Workspace')
  const agentRunHandlers = createCrudHandlers(kube, RESOURCE_MAP.AgentRun, 'AgentRun')

  server.addService(pkg.AgentctlService, {
    GetServerInfo: (call: UnaryCall<Record<string, never>>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      callback(null, buildServerInfo())
    },

    ListAgents: agentHandlers.list,
    GetAgent: agentHandlers.get,
    ApplyAgent: agentHandlers.apply,
    DeleteAgent: agentHandlers.del,

    ListImplementationSpecs: implementationSpecHandlers.list,
    GetImplementationSpec: implementationSpecHandlers.get,
    ApplyImplementationSpec: implementationSpecHandlers.apply,
    DeleteImplementationSpec: implementationSpecHandlers.del,
    CreateImplementationSpec: async (call: UnaryCall<CreateImplRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
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

    ListImplementationSources: implementationSourceHandlers.list,
    GetImplementationSource: implementationSourceHandlers.get,
    ApplyImplementationSource: implementationSourceHandlers.apply,
    DeleteImplementationSource: implementationSourceHandlers.del,

    ListMemories: memoryHandlers.list,
    GetMemory: memoryHandlers.get,
    ApplyMemory: memoryHandlers.apply,
    DeleteMemory: memoryHandlers.del,

    ListOrchestrations: orchestrationHandlers.list,
    GetOrchestration: orchestrationHandlers.get,
    ApplyOrchestration: orchestrationHandlers.apply,
    DeleteOrchestration: orchestrationHandlers.del,

    ListOrchestrationRuns: orchestrationRunHandlers.list,
    GetOrchestrationRun: orchestrationRunHandlers.get,
    ApplyOrchestrationRun: orchestrationRunHandlers.apply,
    DeleteOrchestrationRun: orchestrationRunHandlers.del,

    SubmitOrchestrationRun: async (call: UnaryCall<SubmitOrchestrationRunRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const orchestrationName = call.request?.orchestration_name ?? ''
        if (!orchestrationName) {
          return callback({ code: GrpcStatus.INVALID_ARGUMENT, message: 'orchestration_name is required' }, null)
        }

        const idempotencyKey = call.request?.idempotency_key ?? ''
        const parameters = parseEntryMap(call.request?.parameters ?? [])
        const budgetRef = call.request?.budget_ref ?? ''
        const payload: Record<string, unknown> = {
          orchestrationRef: { name: orchestrationName },
          namespace,
          ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
          ...(budgetRef ? { policy: { budgetRef } } : {}),
        }

        const request = new Request('http://localhost/v1/orchestration-runs', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey || randomUUID(),
          },
          body: JSON.stringify(payload),
        })

        const response = await postOrchestrationRunsHandler(request, { kubeClient: kube })
        const body = (await response.json()) as Record<string, unknown>

        if (!response.ok) {
          const errorMessage = asString(body.error) ?? 'orchestration run submit failed'
          const status = response.status === 404 ? GrpcStatus.NOT_FOUND : GrpcStatus.FAILED_PRECONDITION
          return callback({ code: status, message: errorMessage }, null)
        }

        callback(null, {
          resource_json: body.resource ? JSON.stringify(body.resource) : '',
          record_json: body.orchestrationRun ? JSON.stringify(body.orchestrationRun) : '',
          idempotent: Boolean(body.idempotent),
        })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    ListTools: toolHandlers.list,
    GetTool: toolHandlers.get,
    ApplyTool: toolHandlers.apply,
    DeleteTool: toolHandlers.del,

    ListToolRuns: toolRunHandlers.list,
    GetToolRun: toolRunHandlers.get,
    ApplyToolRun: toolRunHandlers.apply,
    DeleteToolRun: toolRunHandlers.del,

    SubmitToolRun: async (call: UnaryCall<SubmitToolRunRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const toolName = call.request?.tool_name ?? ''
        if (!toolName) {
          return callback({ code: GrpcStatus.INVALID_ARGUMENT, message: 'tool_name is required' }, null)
        }
        const parameters = parseEntryMap(call.request?.parameters ?? [])
        const retryLimit = call.request?.retry_limit ?? 0
        const timeoutSeconds = call.request?.timeout_seconds ?? 0

        const manifest: Record<string, unknown> = {
          apiVersion: 'tools.proompteng.ai/v1alpha1',
          kind: 'ToolRun',
          metadata: {
            generateName: `${toolName}-`,
            namespace,
          },
          spec: {
            toolRef: { name: toolName },
            ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
            ...(retryLimit > 0 ? { retryPolicy: { limit: retryLimit } } : {}),
            ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
          },
        }

        const result = await kube.apply(manifest)
        callback(null, { json: JSON.stringify(result) })
      } catch (error) {
        handleUnaryError(callback, error)
      }
    },

    ListSignals: signalHandlers.list,
    GetSignal: signalHandlers.get,
    ApplySignal: signalHandlers.apply,
    DeleteSignal: signalHandlers.del,

    ListSignalDeliveries: signalDeliveryHandlers.list,
    GetSignalDelivery: signalDeliveryHandlers.get,
    ApplySignalDelivery: signalDeliveryHandlers.apply,
    DeleteSignalDelivery: signalDeliveryHandlers.del,

    ListApprovalPolicies: approvalPolicyHandlers.list,
    GetApprovalPolicy: approvalPolicyHandlers.get,
    ApplyApprovalPolicy: approvalPolicyHandlers.apply,
    DeleteApprovalPolicy: approvalPolicyHandlers.del,

    ListBudgets: budgetHandlers.list,
    GetBudget: budgetHandlers.get,
    ApplyBudget: budgetHandlers.apply,
    DeleteBudget: budgetHandlers.del,

    ListSecretBindings: secretBindingHandlers.list,
    GetSecretBinding: secretBindingHandlers.get,
    ApplySecretBinding: secretBindingHandlers.apply,
    DeleteSecretBinding: secretBindingHandlers.del,

    ListSchedules: scheduleHandlers.list,
    GetSchedule: scheduleHandlers.get,
    ApplySchedule: scheduleHandlers.apply,
    DeleteSchedule: scheduleHandlers.del,

    ListArtifacts: artifactHandlers.list,
    GetArtifact: artifactHandlers.get,
    ApplyArtifact: artifactHandlers.apply,
    DeleteArtifact: artifactHandlers.del,

    ListWorkspaces: workspaceHandlers.list,
    GetWorkspace: workspaceHandlers.get,
    ApplyWorkspace: workspaceHandlers.apply,
    DeleteWorkspace: workspaceHandlers.del,

    ListAgentRuns: agentRunHandlers.list,
    GetAgentRun: agentRunHandlers.get,
    ApplyAgentRun: agentRunHandlers.apply,
    DeleteAgentRun: agentRunHandlers.del,

    SubmitAgentRun: async (call: UnaryCall<SubmitRunRequest>, callback: UnaryCallback) => {
      const authError = requireAuth(call)
      if (authError) return callback(authError, null)
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
      try {
        const namespace = normalizeNamespace(call.request?.namespace)
        const name = call.request?.name ?? ''
        const resource = await kube.get(RESOURCE_MAP.AgentRun, name, namespace)
        if (!resource) {
          return callback({ code: GrpcStatus.NOT_FOUND, message: 'AgentRun not found' }, null)
        }
        const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
        const args = buildCancelArgs(runtimeType, runtimeName, name, namespace)
        if (!args) {
          return callback(
            { code: GrpcStatus.FAILED_PRECONDITION, message: 'No cancellable runtime found for this AgentRun' },
            null,
          )
        }
        const child = spawnKubectl(args)
        child.on('close', (code) => {
          if (code === 0) {
            callback(null, { ok: true, message: 'cancelled' })
          } else {
            callback({ code: GrpcStatus.INTERNAL, message: 'Failed to cancel AgentRun runtime' }, null)
          }
        })
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
      const args = buildLogArgs(name, namespace, runtimeType, runtimeName)
      if (call.request?.follow) {
        args.push('-f')
      }

      const child = spawnKubectl(args)
      const onData = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        call.write({ stream, message: chunk.toString('utf8') })
      }
      child.stdout?.on('data', (chunk) => onData(chunk as Buffer, 'stdout'))
      child.stderr?.on('data', (chunk) => onData(chunk as Buffer, 'stderr'))
      const onClose = () => {
        call.end()
      }

      child.on('close', onClose)
      child.on('error', (error) => {
        call.destroy(Object.assign(new Error(error.message), { code: GrpcStatus.INTERNAL }))
      })

      call.on('cancelled', () => {
        child.kill('SIGTERM')
      })
      call.on('close', () => {
        child.kill('SIGTERM')
      })
    },
  })

  server.bindAsync(address, ServerCredentials.createInsecure(), (error) => {
    if (error) {
      console.error('[jangar] agentctl grpc failed to bind', error)
      return
    }
    server.start()
    console.info(`[jangar] agentctl grpc listening on ${address}`)
  })

  return { server, address }
}

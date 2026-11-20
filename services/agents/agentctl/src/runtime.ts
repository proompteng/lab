#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import { fromJSON } from '@grpc/proto-loader'
import * as protobuf from 'protobufjs'
import YAML from 'yaml'

import { EMBEDDED_AGENTCTL_PROTO } from './embedded-proto'
import type { KubeBackend } from './kube/backend'
import { PACKAGE_VERSION } from './version'

const EXIT_VALIDATION = 2
const EXIT_RUNTIME = 4
const EXIT_UNKNOWN = 5

const DEFAULT_NAMESPACE = 'agents'
const DEFAULT_ADDRESS = 'agents-grpc.agents.svc.cluster.local:50051'
const DEFAULT_WATCH_INTERVAL_MS = 5000
const REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
  'orchestrations.orchestration.proompteng.ai',
  'orchestrationruns.orchestration.proompteng.ai',
  'approvalpolicies.approvals.proompteng.ai',
  'budgets.budgets.proompteng.ai',
  'secretbindings.security.proompteng.ai',
  'signals.signals.proompteng.ai',
  'signaldeliveries.signals.proompteng.ai',
  'tools.tools.proompteng.ai',
  'toolruns.tools.proompteng.ai',
  'schedules.schedules.proompteng.ai',
  'artifacts.artifacts.proompteng.ai',
  'workspaces.workspaces.proompteng.ai',
]

type ResourceSpec = {
  kind: string
  group: string
  version: string
  plural: string
}

type RuntimeEntry = { key: string; value: string }
type ControlPlaneStatus = {
  service?: string
  generated_at?: string
  controllers?: ControllerHealth[]
  runtime_adapters?: RuntimeAdapterHealth[]
  database?: DatabaseHealth
  grpc?: GrpcHealth
  namespaces?: NamespaceHealth[]
}

type ControllerHealth = {
  name?: string
  enabled?: boolean
  started?: boolean
  crds_ready?: boolean
  missing_crds?: string[]
  last_checked_at?: string
  status?: string
  message?: string
}

type RuntimeAdapterHealth = {
  name?: string
  available?: boolean
  status?: string
  message?: string
  endpoint?: string
}

type DatabaseHealth = {
  configured?: boolean
  connected?: boolean
  status?: string
  message?: string
  latency_ms?: number
}

type GrpcHealth = {
  enabled?: boolean
  address?: string
  status?: string
  message?: string
}

type NamespaceHealth = {
  namespace?: string
  status?: string
  degraded_components?: string[]
}

type AgentctlPackage = {
  AgentctlService: grpc.ServiceClientConstructor
}

const RESOURCE_SPECS: Record<string, ResourceSpec> = {
  agent: {
    kind: 'Agent',
    group: 'agents.proompteng.ai',
    version: 'v1alpha1',
    plural: 'agents',
  },
  provider: {
    kind: 'AgentProvider',
    group: 'agents.proompteng.ai',
    version: 'v1alpha1',
    plural: 'agentproviders',
  },
  impl: {
    kind: 'ImplementationSpec',
    group: 'agents.proompteng.ai',
    version: 'v1alpha1',
    plural: 'implementationspecs',
  },
  source: {
    kind: 'ImplementationSource',
    group: 'agents.proompteng.ai',
    version: 'v1alpha1',
    plural: 'implementationsources',
  },
  vcs: {
    kind: 'VersionControlProvider',
    group: 'agents.proompteng.ai',
    version: 'v1alpha1',
    plural: 'versioncontrolproviders',
  },
  memory: {
    kind: 'Memory',
    group: 'agents.proompteng.ai',
    version: 'v1alpha1',
    plural: 'memories',
  },
  tool: {
    kind: 'Tool',
    group: 'tools.proompteng.ai',
    version: 'v1alpha1',
    plural: 'tools',
  },
  toolrun: {
    kind: 'ToolRun',
    group: 'tools.proompteng.ai',
    version: 'v1alpha1',
    plural: 'toolruns',
  },
  orchestration: {
    kind: 'Orchestration',
    group: 'orchestration.proompteng.ai',
    version: 'v1alpha1',
    plural: 'orchestrations',
  },
  orchestrationrun: {
    kind: 'OrchestrationRun',
    group: 'orchestration.proompteng.ai',
    version: 'v1alpha1',
    plural: 'orchestrationruns',
  },
  approval: {
    kind: 'ApprovalPolicy',
    group: 'approvals.proompteng.ai',
    version: 'v1alpha1',
    plural: 'approvalpolicies',
  },
  budget: {
    kind: 'Budget',
    group: 'budgets.proompteng.ai',
    version: 'v1alpha1',
    plural: 'budgets',
  },
  secretbinding: {
    kind: 'SecretBinding',
    group: 'security.proompteng.ai',
    version: 'v1alpha1',
    plural: 'secretbindings',
  },
  signal: {
    kind: 'Signal',
    group: 'signals.proompteng.ai',
    version: 'v1alpha1',
    plural: 'signals',
  },
  signaldelivery: {
    kind: 'SignalDelivery',
    group: 'signals.proompteng.ai',
    version: 'v1alpha1',
    plural: 'signaldeliveries',
  },
  schedule: {
    kind: 'Schedule',
    group: 'schedules.proompteng.ai',
    version: 'v1alpha1',
    plural: 'schedules',
  },
  artifact: {
    kind: 'Artifact',
    group: 'artifacts.proompteng.ai',
    version: 'v1alpha1',
    plural: 'artifacts',
  },
  workspace: {
    kind: 'Workspace',
    group: 'workspaces.proompteng.ai',
    version: 'v1alpha1',
    plural: 'workspaces',
  },
}

const AGENT_RUN_SPEC: ResourceSpec = {
  kind: 'AgentRun',
  group: 'agents.proompteng.ai',
  version: 'v1alpha1',
  plural: 'agentruns',
}

const KIND_SPECS = Object.values(RESOURCE_SPECS).reduce<Record<string, ResourceSpec>>((acc, spec) => {
  acc[spec.kind.toLowerCase()] = spec
  return acc
}, {})

KIND_SPECS[AGENT_RUN_SPEC.kind.toLowerCase()] = AGENT_RUN_SPEC

const RPC_RESOURCE_MAP: Record<string, { list: string; get: string; apply: string; del: string; create?: string }> = {
  agent: {
    list: 'ListAgents',
    get: 'GetAgent',
    apply: 'ApplyAgent',
    del: 'DeleteAgent',
  },
  provider: {
    list: 'ListAgentProviders',
    get: 'GetAgentProvider',
    apply: 'ApplyAgentProvider',
    del: 'DeleteAgentProvider',
  },
  impl: {
    list: 'ListImplementationSpecs',
    get: 'GetImplementationSpec',
    apply: 'ApplyImplementationSpec',
    del: 'DeleteImplementationSpec',
    create: 'CreateImplementationSpec',
  },
  source: {
    list: 'ListImplementationSources',
    get: 'GetImplementationSource',
    apply: 'ApplyImplementationSource',
    del: 'DeleteImplementationSource',
  },
  vcs: {
    list: 'ListVersionControlProviders',
    get: 'GetVersionControlProvider',
    apply: 'ApplyVersionControlProvider',
    del: 'DeleteVersionControlProvider',
  },
  memory: {
    list: 'ListMemories',
    get: 'GetMemory',
    apply: 'ApplyMemory',
    del: 'DeleteMemory',
  },
  tool: {
    list: 'ListTools',
    get: 'GetTool',
    apply: 'ApplyTool',
    del: 'DeleteTool',
  },
  toolrun: {
    list: 'ListToolRuns',
    get: 'GetToolRun',
    apply: 'ApplyToolRun',
    del: 'DeleteToolRun',
  },
  orchestration: {
    list: 'ListOrchestrations',
    get: 'GetOrchestration',
    apply: 'ApplyOrchestration',
    del: 'DeleteOrchestration',
  },
  orchestrationrun: {
    list: 'ListOrchestrationRuns',
    get: 'GetOrchestrationRun',
    apply: 'ApplyOrchestrationRun',
    del: 'DeleteOrchestrationRun',
  },
  approval: {
    list: 'ListApprovalPolicies',
    get: 'GetApprovalPolicy',
    apply: 'ApplyApprovalPolicy',
    del: 'DeleteApprovalPolicy',
  },
  budget: {
    list: 'ListBudgets',
    get: 'GetBudget',
    apply: 'ApplyBudget',
    del: 'DeleteBudget',
  },
  secretbinding: {
    list: 'ListSecretBindings',
    get: 'GetSecretBinding',
    apply: 'ApplySecretBinding',
    del: 'DeleteSecretBinding',
  },
  signal: {
    list: 'ListSignals',
    get: 'GetSignal',
    apply: 'ApplySignal',
    del: 'DeleteSignal',
  },
  signaldelivery: {
    list: 'ListSignalDeliveries',
    get: 'GetSignalDelivery',
    apply: 'ApplySignalDelivery',
    del: 'DeleteSignalDelivery',
  },
  schedule: {
    list: 'ListSchedules',
    get: 'GetSchedule',
    apply: 'ApplySchedule',
    del: 'DeleteSchedule',
  },
  artifact: {
    list: 'ListArtifacts',
    get: 'GetArtifact',
    apply: 'ApplyArtifact',
    del: 'DeleteArtifact',
  },
  workspace: {
    list: 'ListWorkspaces',
    get: 'GetWorkspace',
    apply: 'ApplyWorkspace',
    del: 'DeleteWorkspace',
  },
}

const getVersion = () => {
  const env = process.env.AGENTCTL_VERSION?.trim()
  if (env) return env
  if (PACKAGE_VERSION && PACKAGE_VERSION !== 'dev') return PACKAGE_VERSION
  try {
    const moduleDir = resolve(fileURLToPath(import.meta.url), '..')
    const pkgCandidates = [
      resolve(moduleDir, '..', 'package.json'),
      resolve(dirname(process.argv[0] ?? ''), '..', 'package.json'),
      resolve(dirname(process.execPath ?? ''), '..', 'package.json'),
    ]

    for (const candidate of pkgCandidates) {
      if (!candidate || !existsSync(candidate)) continue
      const raw = readFileSync(candidate, 'utf8')
      const pkg = JSON.parse(raw) as { version?: string }
      if (pkg?.version) return pkg.version
    }
  } catch {
    // ignore
  }
  return PACKAGE_VERSION
}

const maskSecret = (value?: string) => {
  if (!value) return value
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}****${value.slice(-2)}`
}

const resolveProtoPath = () => {
  const envPath = process.env.AGENTCTL_PROTO_PATH?.trim()
  if (envPath && existsSync(envPath)) return envPath

  const moduleDir = resolve(fileURLToPath(import.meta.url), '..')
  const packageRoot = resolve(moduleDir, '..')

  const candidates = [
    resolve(packageRoot, 'proto/proompteng/agents/v1/agentctl.proto'),
    resolve(packageRoot, '../../proto/proompteng/agents/v1/agentctl.proto'),
    resolve(process.cwd(), 'proto/proompteng/agents/v1/agentctl.proto'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const loadAgentctlPackage = (): AgentctlPackage => {
  const protoPath = resolveProtoPath()
  const protoContents = protoPath ? readFileSync(protoPath, 'utf8') : EMBEDDED_AGENTCTL_PROTO
  if (!protoContents) {
    throw new Error('agentctl proto not found; set AGENTCTL_PROTO_PATH')
  }
  const root = protobuf.parse(protoContents, { keepCase: true }).root
  const packageDefinition = fromJSON(root.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    proompteng?: { agents?: { v1?: AgentctlPackage } }
  }

  const pkg = loaded.proompteng?.agents?.v1
  if (!pkg?.AgentctlService) {
    throw new Error('agentctl proto missing AgentctlService definition')
  }
  return pkg
}

const resolveCredentials = async (tlsEnabled: boolean) => {
  if (!tlsEnabled) return grpc.credentials.createInsecure()

  const caPath = process.env.AGENTCTL_CA_CERT
  const certPath = process.env.AGENTCTL_CLIENT_CERT
  const keyPath = process.env.AGENTCTL_CLIENT_KEY

  const rootCert = caPath ? await readFile(caPath) : undefined
  const clientCert = certPath ? await readFile(certPath) : undefined
  const clientKey = keyPath ? await readFile(keyPath) : undefined

  return grpc.credentials.createSsl(rootCert, clientKey, clientCert)
}

const createClient = async (address: string, tlsEnabled: boolean) => {
  const pkg = loadAgentctlPackage()
  const creds = await resolveCredentials(tlsEnabled)
  return new pkg.AgentctlService(address, creds) as grpc.Client
}

const createMetadata = (token?: string) => {
  const metadata = new grpc.Metadata()
  if (token) {
    metadata.add('authorization', `Bearer ${token}`)
  }
  return metadata
}

const callUnary = <Response>(
  client: grpc.Client,
  method: string,
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const fn = (client as unknown as Record<string, (...args: unknown[]) => void>)[method]
    if (!fn) {
      reject(new Error(`Unknown RPC method ${method}`))
      return
    }
    fn.call(client, request, metadata, (error: grpc.ServiceError | null, response: Response) => {
      if (error) {
        reject(error)
      } else {
        resolve(response)
      }
    })
  })

const parseJson = (value: string) => {
  if (!value) return null
  return JSON.parse(value) as Record<string, unknown>
}

const parseYamlDocuments = (content: string) =>
  YAML.parseAllDocuments(content)
    .map((doc) => doc.toJSON() as Record<string, unknown>)
    .filter((doc) => doc && Object.keys(doc).length > 0)

const isNotFoundError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  if ('statusCode' in error && (error as { statusCode?: number }).statusCode === 404) return true
  if (
    'body' in error &&
    typeof (error as { body?: { code?: number; reason?: string } }).body === 'object' &&
    (error as { body?: { code?: number; reason?: string } }).body?.code === 404
  ) {
    return true
  }
  if (
    'body' in error &&
    typeof (error as { body?: { reason?: string } }).body === 'object' &&
    (error as { body?: { reason?: string } }).body?.reason === 'NotFound'
  ) {
    return true
  }
  if ('message' in error && typeof (error as { message?: string }).message === 'string') {
    const message = (error as { message: string }).message.toLowerCase()
    return message.includes('notfound') || message.includes('not found')
  }
  return false
}

const listCustomObjects = async (backend: KubeBackend, spec: ResourceSpec, namespace: string, labelSelector?: string) =>
  backend.listCustomObjects(spec, namespace, labelSelector)

const getCustomObjectOptional = async (backend: KubeBackend, spec: ResourceSpec, name: string, namespace: string) => {
  try {
    return await backend.getCustomObject(spec, namespace, name)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

const createCustomObject = async (
  backend: KubeBackend,
  spec: ResourceSpec,
  namespace: string,
  body: Record<string, unknown>,
) => backend.createCustomObject(spec, namespace, body)

const replaceCustomObject = async (
  backend: KubeBackend,
  spec: ResourceSpec,
  namespace: string,
  name: string,
  body: Record<string, unknown>,
) => backend.replaceCustomObject(spec, namespace, name, body)

const deleteCustomObject = async (backend: KubeBackend, spec: ResourceSpec, namespace: string, name: string) => {
  try {
    return await backend.deleteCustomObject(spec, namespace, name)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

const resolveSpecFromManifest = (resource: Record<string, unknown>) => {
  const kind = typeof resource.kind === 'string' ? resource.kind : ''
  const apiVersion = typeof resource.apiVersion === 'string' ? resource.apiVersion : ''
  if (!kind || !apiVersion) {
    throw new Error('manifest must include apiVersion and kind')
  }
  if (!apiVersion.includes('/')) {
    throw new Error(`unsupported apiVersion: ${apiVersion}`)
  }
  const [group, version] = apiVersion.split('/', 2)
  const baseSpec = KIND_SPECS[kind.toLowerCase()]
  if (!baseSpec) {
    throw new Error(`unsupported kind: ${kind}`)
  }
  if (baseSpec.group !== group) {
    throw new Error(`unsupported group for ${kind}: ${group}`)
  }
  return { ...baseSpec, version }
}

const applyManifest = async (backend: KubeBackend, manifest: string, namespace: string) => {
  const documents = parseYamlDocuments(manifest)
  const applied: Record<string, unknown>[] = []

  for (const doc of documents) {
    const spec = resolveSpecFromManifest(doc)
    const metadata = (doc.metadata ?? {}) as Record<string, unknown>
    const name = typeof metadata.name === 'string' ? metadata.name : ''
    const generateName = typeof metadata.generateName === 'string' ? metadata.generateName : ''
    const resolvedNamespace = (metadata.namespace as string | undefined) || namespace
    metadata.namespace = resolvedNamespace
    doc.metadata = metadata

    if (name) {
      const existing = await getCustomObjectOptional(backend, spec, name, resolvedNamespace)
      if (existing) {
        const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
        if (existingMeta.resourceVersion) {
          metadata.resourceVersion = existingMeta.resourceVersion
        }
        applied.push(await replaceCustomObject(backend, spec, resolvedNamespace, name, doc))
      } else {
        applied.push(await createCustomObject(backend, spec, resolvedNamespace, doc))
      }
      continue
    }

    if (!generateName) {
      throw new Error('manifest metadata.name or metadata.generateName is required')
    }
    applied.push(await createCustomObject(backend, spec, resolvedNamespace, doc))
  }

  return applied
}

const readNestedValue = (value: unknown, path: Array<string | number>) => {
  let cursor: unknown = value
  for (const key of path) {
    if (Array.isArray(cursor)) {
      if (typeof key !== 'number') return null
      cursor = cursor[key]
      continue
    }
    if (!cursor || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[key as keyof Record<string, unknown>]
  }
  return cursor ?? null
}

const resolveAgentRunRuntime = (resource: Record<string, unknown>) => {
  const runtimeRef = readNestedValue(resource, ['status', 'runtimeRef'])
  const runtimeType =
    (readNestedValue(runtimeRef, ['type']) as string | null) ??
    (readNestedValue(resource, ['spec', 'runtime', 'type']) as string | null)
  const runtimeName = readNestedValue(runtimeRef, ['name']) as string | null
  return { runtimeType, runtimeName }
}

const isJobRuntime = (runtimeType: string | null) => runtimeType === 'job' || runtimeType === 'workflow'

const runLabelSelector = (runName: string) => `agents.proompteng.ai/agent-run=${runName}`

const listPodsForSelector = async (backend: KubeBackend, namespace: string, selector: string) => {
  const body = (await backend.listPods(namespace, selector)) as { items?: Record<string, unknown>[] }
  return Array.isArray(body.items) ? body.items : []
}

const pickPodForRun = async (
  backend: KubeBackend,
  namespace: string,
  selector: string,
): Promise<Record<string, unknown> | null> => {
  const items = await listPodsForSelector(backend, namespace, selector)
  if (items.length === 0) return null
  const running = items.find((pod) => readNestedValue(pod, ['status', 'phase']) === 'Running')
  return running ?? items[0] ?? null
}

const resolvePodContainerName = (pod: Record<string, unknown>) => {
  const containers = readNestedValue(pod, ['spec', 'containers'])
  if (!Array.isArray(containers) || containers.length === 0) return undefined
  const first = containers[0] as Record<string, unknown>
  return typeof first?.name === 'string' ? first.name : undefined
}

const streamPodLogs = async (
  backend: KubeBackend,
  namespace: string,
  podName: string,
  container: string | undefined,
  follow: boolean,
) => {
  await backend.streamPodLogs(namespace, podName, container, follow)
}

const deleteJobByName = async (backend: KubeBackend, namespace: string, name: string) => {
  try {
    await backend.deleteJob(namespace, name)
    return true
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

const deleteJobsBySelector = async (backend: KubeBackend, namespace: string, selector: string) => {
  await backend.deleteJobsBySelector(namespace, selector)
}

const normalizeOutput = (value: string | undefined) => {
  if (!value) return 'table'
  const normalized = value.trim().toLowerCase()
  if (['json', 'yaml', 'yaml-stream', 'table', 'text', 'wide'].includes(normalized)) return normalized
  return 'table'
}

const formatAge = (timestamp?: string) => {
  if (!timestamp) return ''
  const created = Date.parse(timestamp)
  if (Number.isNaN(created)) return ''
  const diffMs = Date.now() - created
  const seconds = Math.max(0, Math.floor(diffMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

const toCell = (value: unknown) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

type TableColumn<T> = {
  label: string
  value: (row: T) => string
}

const renderTable = <T>(rows: T[], columns: TableColumn<T>[]) => {
  const widths = columns.map((column) => column.label.length)
  const values = rows.map((row) =>
    columns.map((column, index) => {
      const cell = column.value(row)
      const safe = cell ?? ''
      const len = safe.length
      widths[index] = Math.max(widths[index] ?? 0, len)
      return safe
    }),
  )

  const pad = (value: string, width: number) => value.padEnd(width, ' ')
  const header = columns.map((column, index) => pad(column.label, widths[index] ?? 0)).join('  ')
  console.log(header)

  for (const row of values) {
    const line = row.map((cell, index) => pad(cell, widths[index] ?? 0)).join('  ')
    console.log(line)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const clearScreen = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H')
  }
}

const resolveStatusPhase = (resource: Record<string, unknown>) => {
  const status = (resource.status ?? {}) as Record<string, unknown>
  const statusKeys = ['phase', 'status', 'state', 'result']
  for (const key of statusKeys) {
    const value = status[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  const ready = conditions.find((item) => (item as { type?: string }).type === 'Ready') as
    | { status?: string }
    | undefined
  if (ready?.status) {
    return ready.status
  }
  return ''
}

const formatLabels = (resource: Record<string, unknown>) => {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const labels = metadata.labels as Record<string, string> | undefined
  if (!labels || typeof labels !== 'object') return ''
  const entries = Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
  return entries
}

const extractDetails = (resource: Record<string, unknown>) => {
  const kind = typeof resource.kind === 'string' ? resource.kind.toLowerCase() : ''
  if (kind === 'agentrun') {
    return toCell(readNestedValue(resource, ['spec', 'runtime', 'type']))
  }
  if (kind === 'implementationspec') {
    return toCell(readNestedValue(resource, ['spec', 'summary']))
  }
  if (kind === 'implementationsource') {
    return toCell(readNestedValue(resource, ['spec', 'provider']))
  }
  if (kind === 'schedule') {
    return toCell(readNestedValue(resource, ['spec', 'schedule']))
  }
  if (kind === 'toolrun') {
    return toCell(readNestedValue(resource, ['spec', 'toolRef', 'name']))
  }
  if (kind === 'agent') {
    return toCell(readNestedValue(resource, ['spec', 'providerRef', 'name']))
  }
  return ''
}

const toRow = (resource: Record<string, unknown>) => {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const phase = resolveStatusPhase(resource)
  return {
    name: toCell(metadata.name ?? metadata.generateName ?? ''),
    namespace: toCell(metadata.namespace ?? ''),
    kind: toCell(resource.kind ?? ''),
    age: formatAge(typeof metadata.creationTimestamp === 'string' ? metadata.creationTimestamp : undefined),
    status: phase,
    labels: formatLabels(resource),
    details: extractDetails(resource),
  }
}

const toResourceName = (row: ReturnType<typeof toRow>) => {
  const kind = row.kind ? String(row.kind).toLowerCase() : ''
  if (kind && row.name) return `${kind}/${row.name}`
  return row.name
}

const renderRows = (rows: ReturnType<typeof toRow>[], output: string) => {
  if (output === 'wide') {
    renderTable(rows, [
      { label: 'NAME', value: (entry) => entry.name },
      { label: 'NAMESPACE', value: (entry) => entry.namespace },
      { label: 'KIND', value: (entry) => entry.kind },
      { label: 'AGE', value: (entry) => entry.age },
      { label: 'STATUS', value: (entry) => entry.status },
      { label: 'LABELS', value: (entry) => entry.labels ?? '' },
      { label: 'DETAILS', value: (entry) => entry.details ?? '' },
    ])
    return
  }
  renderTable(rows, [
    { label: 'NAME', value: (entry) => entry.name },
    { label: 'NAMESPACE', value: (entry) => entry.namespace },
    { label: 'STATUS', value: (entry) => entry.status },
  ])
}

const outputResource = (resource: Record<string, unknown>, output: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(resource, null, 2))
    return
  }
  if (output === 'yaml' || output === 'yaml-stream') {
    console.log(YAML.stringify(resource))
    return
  }
  if (output === 'text') {
    const row = toRow(resource)
    console.log(toResourceName(row))
    return
  }
  const row = toRow(resource)
  renderRows([row], output)
}

const outputList = (resource: Record<string, unknown>, output: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(resource, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(resource))
    return
  }
  if (output === 'yaml-stream') {
    const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
    const docs = items.map((item) => YAML.stringify(item).trim()).filter(Boolean)
    console.log(docs.map((doc) => `---\n${doc}`).join('\n'))
    return
  }
  if (output === 'text') {
    const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
    const rows = items.map(toRow)
    for (const row of rows) {
      console.log(toResourceName(row))
    }
    return
  }
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  const rows = items.map(toRow)
  renderRows(rows, output)
}

const outputResources = (resources: Record<string, unknown>[], output: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(resources, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(resources))
    return
  }
  if (output === 'yaml-stream') {
    const docs = resources.map((item) => YAML.stringify(item).trim()).filter(Boolean)
    console.log(docs.map((doc) => `---\n${doc}`).join('\n'))
    return
  }
  if (output === 'text') {
    const rows = resources.map(toRow)
    for (const row of rows) {
      console.log(toResourceName(row))
    }
    return
  }
  const rows = resources.map(toRow)
  renderRows(rows, output)
}

const parseKeyValueList = (values: readonly string[]) => {
  const output: RuntimeEntry[] = []
  for (const item of values) {
    const [key, ...rest] = item.split('=')
    if (!key) continue
    output.push({ key, value: rest.join('=') })
  }
  return output
}

const toKeyValueMap = (entries: RuntimeEntry[]) => {
  const output: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.key) continue
    output[entry.key] = entry.value
  }
  return output
}

const toKeyValueEntries = (entries: RuntimeEntry[]) =>
  entries.filter((entry) => entry.key).map((entry) => ({ key: entry.key, value: entry.value }))

const parseSource = (raw?: string) => {
  if (!raw) return undefined
  const fields = raw.split(',').map((entry) => entry.trim())
  const source: Record<string, string> = {}
  for (const field of fields) {
    const [key, ...rest] = field.split('=')
    if (!key) continue
    source[key] = rest.join('=')
  }
  if (!source.provider) return undefined
  if (!source.externalId && source.external_id) {
    source.externalId = source.external_id
  }
  return source
}

const waitForRunCompletion = async (
  client: grpc.Client,
  metadata: grpc.Metadata,
  name: string,
  namespace: string,
  output: string,
) => {
  const stream = (client as unknown as Record<string, (...args: unknown[]) => grpc.ClientReadableStream<unknown>>)
    .StreamAgentRunStatus
  if (!stream) {
    throw new Error('StreamAgentRunStatus not available')
  }
  let latest: Record<string, unknown> | null = null

  return await new Promise<number>((resolve, reject) => {
    const call = stream.call(client, { name, namespace }, metadata)
    call.on('data', (entry: { json?: string }) => {
      if (!entry?.json) return
      const resource = parseJson(entry.json)
      if (resource) {
        latest = resource
      }
    })
    call.on('end', () => {
      if (latest) {
        outputResource(latest, output)
        resolve(0)
      } else {
        console.error('AgentRun status stream closed without updates')
        resolve(EXIT_RUNTIME)
      }
    })
    call.on('error', (error) => reject(error))
  })
}

const outputStatus = (status: ControlPlaneStatus, output: string, namespace: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(status, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(status))
    return
  }

  const rows: Array<{ component: string; namespace: string; status: string; message: string }> = []
  const namespaces = status.namespaces ?? []
  if (namespaces.length > 0) {
    for (const entry of namespaces) {
      rows.push({
        component: 'namespace',
        namespace: entry.namespace ?? namespace,
        status: entry.status ?? '',
        message: (entry.degraded_components ?? []).join(', '),
      })
    }
  }

  for (const controller of status.controllers ?? []) {
    rows.push({
      component: controller.name ?? 'controller',
      namespace,
      status: controller.status ?? '',
      message: controller.message ?? '',
    })
  }

  for (const adapter of status.runtime_adapters ?? []) {
    const message = adapter.message ?? adapter.endpoint ?? ''
    rows.push({
      component: `runtime:${adapter.name ?? 'unknown'}`,
      namespace,
      status: adapter.status ?? '',
      message,
    })
  }

  if (status.database) {
    rows.push({
      component: 'database',
      namespace,
      status: status.database.status ?? '',
      message: status.database.message ?? '',
    })
  }

  if (status.grpc) {
    rows.push({
      component: 'grpc',
      namespace,
      status: status.grpc.status ?? '',
      message: status.grpc.message || status.grpc.address || '',
    })
  }

  renderTable(rows, [
    { label: 'COMPONENT', value: (entry) => entry.component },
    { label: 'NAMESPACE', value: (entry) => entry.namespace },
    { label: 'STATUS', value: (entry) => entry.status },
    { label: 'MESSAGE', value: (entry) => entry.message },
  ])
}

const resolveAgentRunPhase = (resource: Record<string, unknown>) => {
  const phase = readNestedValue(resource, ['status', 'phase'])
  if (typeof phase === 'string' && phase.trim()) return phase
  const conditions = readNestedValue(resource, ['status', 'conditions'])
  if (Array.isArray(conditions)) {
    const ready = conditions.find((entry) => readNestedValue(entry, ['type']) === 'Ready')
    const readyStatus = readNestedValue(ready, ['status'])
    if (typeof readyStatus === 'string') return readyStatus
  }
  return ''
}

const isTerminalPhase = (phase: string) => {
  const normalized = phase.trim().toLowerCase()
  return (
    normalized === 'succeeded' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled'
  )
}

const matchesAgentRunFilters = (resource: Record<string, unknown>, phase?: string, runtime?: string) => {
  if (phase) {
    const itemPhase = resolveAgentRunPhase(resource)
    if (itemPhase !== phase) return false
  }
  if (runtime) {
    const runtimeType = readNestedValue(resource, ['spec', 'runtime', 'type'])
    if (runtimeType !== runtime) return false
  }
  return true
}

const filterAgentRunsList = (list: Record<string, unknown>, phase?: string, runtime?: string) => {
  if (!phase && !runtime) return list
  const items = Array.isArray(list.items) ? list.items : []
  const filtered = items.filter((item) => matchesAgentRunFilters(item as Record<string, unknown>, phase, runtime))
  return { ...list, items: filtered }
}

const waitForRunCompletionKube = async (backend: KubeBackend, name: string, namespace: string, output: string) => {
  while (true) {
    const resource = await getCustomObjectOptional(backend, AGENT_RUN_SPEC, name, namespace)
    if (!resource) {
      throw new Error('AgentRun not found')
    }
    const phase = resolveAgentRunPhase(resource)
    if (phase && isTerminalPhase(phase)) {
      outputResource(resource, output)
      return 0
    }
    await sleep(2000)
  }
}

const outputStatusKube = async (backend: KubeBackend, namespace: string, output: string) => {
  const generatedAt = new Date().toISOString()
  let namespaceStatus = 'unknown'
  let namespaceMessage = ''
  try {
    await backend.readNamespace(namespace)
    namespaceStatus = 'healthy'
  } catch (_error) {
    namespaceStatus = 'missing'
    namespaceMessage = _error instanceof Error ? _error.message : String(_error)
  }

  let deploymentStatus = 'unknown'
  let deploymentMessage = ''
  let deploymentName = 'agents'
  try {
    const body = (await backend.listDeployments(namespace, 'app.kubernetes.io/name=agents')) as {
      items?: Record<string, unknown>[]
    }
    const items = Array.isArray(body.items) ? body.items : []
    const deployment = (items[0] ?? null) as Record<string, unknown> | null
    if (!deployment) {
      deploymentStatus = 'missing'
    } else {
      deploymentName = (readNestedValue(deployment, ['metadata', 'name']) as string) || deploymentName
      const desired = Number(readNestedValue(deployment, ['spec', 'replicas']) ?? 0)
      const ready = Number(readNestedValue(deployment, ['status', 'readyReplicas']) ?? 0)
      const available = Number(readNestedValue(deployment, ['status', 'availableReplicas']) ?? 0)
      const image = readNestedValue(deployment, ['spec', 'template', 'spec', 'containers', 0, 'image'])
      const healthy = desired > 0 ? ready >= desired : ready > 0
      deploymentStatus = healthy ? 'healthy' : 'degraded'
      deploymentMessage = `ready ${ready}/${desired}`
      if (available) deploymentMessage = `${deploymentMessage} available ${available}`
      if (typeof image === 'string' && image) deploymentMessage = `${deploymentMessage} image ${image}`
    }
  } catch (_error) {
    deploymentStatus = 'unknown'
    deploymentMessage = _error instanceof Error ? _error.message : String(_error)
  }

  let missingCrds: string[] = []
  try {
    const body = (await backend.listCrds()) as { items?: Record<string, unknown>[] }
    const items = Array.isArray(body.items) ? body.items : []
    const found = new Set(
      items
        .map((item) => readNestedValue(item, ['metadata', 'name']))
        .filter((value): value is string => typeof value === 'string'),
    )
    missingCrds = REQUIRED_CRDS.filter((name) => !found.has(name))
  } catch {
    missingCrds = [...REQUIRED_CRDS]
  }

  const statusPayload = {
    mode: 'kube',
    generated_at: generatedAt,
    namespace,
    deployment: {
      name: deploymentName,
      status: deploymentStatus,
      message: deploymentMessage,
    },
    crds: {
      status: missingCrds.length === 0 ? 'healthy' : 'degraded',
      missing: missingCrds,
    },
    namespace_status: {
      status: namespaceStatus,
      message: namespaceMessage,
    },
  }

  if (output === 'json') {
    console.log(JSON.stringify(statusPayload, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(statusPayload))
    return
  }

  const rows = [
    {
      component: 'namespace',
      namespace,
      status: namespaceStatus,
      message: namespaceMessage,
    },
    {
      component: `deployment/${deploymentName}`,
      namespace,
      status: deploymentStatus,
      message: deploymentMessage,
    },
    {
      component: 'crds',
      namespace,
      status: missingCrds.length === 0 ? 'healthy' : 'degraded',
      message: missingCrds.length === 0 ? 'all present' : `missing: ${missingCrds.join(', ')}`,
    },
  ]

  renderTable(rows, [
    { label: 'COMPONENT', value: (entry) => entry.component },
    { label: 'NAMESPACE', value: (entry) => entry.namespace },
    { label: 'STATUS', value: (entry) => entry.status },
    { label: 'MESSAGE', value: (entry) => entry.message },
  ])
}

const readFileContent = async (file: string) => {
  if (file === '-') {
    const content = await readStdinContent()
    if (!content.trim()) throw new Error('stdin is empty')
    return content
  }
  const content = await readFile(file, 'utf8')
  if (!content.trim()) throw new Error(`File ${file} is empty`)
  return content
}

const readStdinContent = async () =>
  await new Promise<string>((resolve, reject) => {
    let content = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      content += chunk
    })
    process.stdin.on('end', () => resolve(content))
    process.stdin.on('error', (error) => reject(error))
    if (process.stdin.isTTY) {
      process.stdin.resume()
    }
  })

const readTextInput = async (value: string) => {
  if (value === '-') return await readStdinContent()
  if (value.startsWith('@')) return await readFileContent(value.slice(1))
  return value
}

export {
  AGENT_RUN_SPEC,
  DEFAULT_ADDRESS,
  DEFAULT_NAMESPACE,
  DEFAULT_WATCH_INTERVAL_MS,
  EXIT_RUNTIME,
  EXIT_UNKNOWN,
  EXIT_VALIDATION,
  RESOURCE_SPECS,
  RPC_RESOURCE_MAP,
  applyManifest,
  callUnary,
  clearScreen,
  createClient,
  createCustomObject,
  createMetadata,
  deleteCustomObject,
  deleteJobByName,
  deleteJobsBySelector,
  filterAgentRunsList,
  getCustomObjectOptional,
  getVersion,
  isJobRuntime,
  listCustomObjects,
  maskSecret,
  normalizeOutput,
  outputList,
  outputResource,
  outputResources,
  outputStatus,
  outputStatusKube,
  parseJson,
  parseKeyValueList,
  parseSource,
  parseYamlDocuments,
  pickPodForRun,
  readFileContent,
  readNestedValue,
  readTextInput,
  resolveAgentRunRuntime,
  resolvePodContainerName,
  runLabelSelector,
  streamPodLogs,
  toKeyValueMap,
  toKeyValueEntries,
  waitForRunCompletion,
  waitForRunCompletionKube,
}

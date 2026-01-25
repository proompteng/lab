#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import { fromJSON } from '@grpc/proto-loader'
import {
  ApiextensionsV1Api,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  Log,
} from '@kubernetes/client-node'
import * as protobuf from 'protobufjs'
import YAML from 'yaml'
import { EMBEDDED_AGENTCTL_PROTO } from './embedded-proto'

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

type Config = {
  namespace?: string
  address?: string
  token?: string
  tls?: boolean
  kubeconfig?: string
  context?: string
}

type GlobalFlags = {
  namespace?: string
  address?: string
  token?: string
  output?: string
  tls?: boolean
  kube?: boolean
  grpc?: boolean
  kubeconfig?: string
  context?: string
}

type TransportMode = 'grpc' | 'kube'

type KubeOptions = {
  kubeconfig?: string
  context?: string
}

type KubeClients = {
  kubeConfig: KubeConfig
  core: CoreV1Api
  custom: CustomObjectsApi
  apps: AppsV1Api
  batch: BatchV1Api
  crd: ApiextensionsV1Api
  log: Log
}

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
  return 'dev'
}

const usage = (version: string) =>
  `
agentctl ${version}

Usage:
  agentctl version [--client]
  agentctl config view|set --namespace <ns> [--server <addr>] [--address <addr>] [--token <token>]
  agentctl completion <shell>
  agentctl status [--output json|yaml|table]
  agentctl diagnose [--output json|yaml|table]

  agentctl agent get <name>
  agentctl agent describe <name>
  agentctl agent list
  agentctl agent watch
  agentctl agent apply -f <file>
  agentctl agent delete <name>

  agentctl provider list
  agentctl provider get <name>
  agentctl provider describe <name>
  agentctl provider watch
  agentctl provider apply -f <file>
  agentctl provider delete <name>

  agentctl impl get <name>
  agentctl impl describe <name>
  agentctl impl list
  agentctl impl watch
  agentctl impl create --text <text> [--summary <text>] [--source provider=github,externalId=...,url=...]
  agentctl impl apply -f <file>
  agentctl impl delete <name>

  agentctl source list
  agentctl source get <name>
  agentctl source describe <name>
  agentctl source watch
  agentctl source apply -f <file>
  agentctl source delete <name>

  agentctl memory list
  agentctl memory get <name>
  agentctl memory describe <name>
  agentctl memory watch
  agentctl memory apply -f <file>
  agentctl memory delete <name>

  agentctl tool list
  agentctl tool get <name>
  agentctl tool describe <name>
  agentctl tool watch
  agentctl tool apply -f <file>
  agentctl tool delete <name>

  agentctl toolrun list
  agentctl toolrun get <name>
  agentctl toolrun describe <name>
  agentctl toolrun watch
  agentctl toolrun apply -f <file>
  agentctl toolrun delete <name>

  agentctl orchestration list
  agentctl orchestration get <name>
  agentctl orchestration describe <name>
  agentctl orchestration watch
  agentctl orchestration apply -f <file>
  agentctl orchestration delete <name>

  agentctl orchestrationrun list
  agentctl orchestrationrun get <name>
  agentctl orchestrationrun describe <name>
  agentctl orchestrationrun watch
  agentctl orchestrationrun apply -f <file>
  agentctl orchestrationrun delete <name>

  agentctl approval list
  agentctl approval get <name>
  agentctl approval describe <name>
  agentctl approval watch
  agentctl approval apply -f <file>
  agentctl approval delete <name>

  agentctl budget list
  agentctl budget get <name>
  agentctl budget describe <name>
  agentctl budget watch
  agentctl budget apply -f <file>
  agentctl budget delete <name>

  agentctl secretbinding list
  agentctl secretbinding get <name>
  agentctl secretbinding describe <name>
  agentctl secretbinding watch
  agentctl secretbinding apply -f <file>
  agentctl secretbinding delete <name>

  agentctl signal list
  agentctl signal get <name>
  agentctl signal describe <name>
  agentctl signal watch
  agentctl signal apply -f <file>
  agentctl signal delete <name>

  agentctl signaldelivery list
  agentctl signaldelivery get <name>
  agentctl signaldelivery describe <name>
  agentctl signaldelivery watch
  agentctl signaldelivery apply -f <file>
  agentctl signaldelivery delete <name>

  agentctl schedule list
  agentctl schedule get <name>
  agentctl schedule describe <name>
  agentctl schedule watch
  agentctl schedule apply -f <file>
  agentctl schedule delete <name>

  agentctl artifact list
  agentctl artifact get <name>
  agentctl artifact describe <name>
  agentctl artifact watch
  agentctl artifact apply -f <file>
  agentctl artifact delete <name>

  agentctl workspace list
  agentctl workspace get <name>
  agentctl workspace describe <name>
  agentctl workspace watch
  agentctl workspace apply -f <file>
  agentctl workspace delete <name>

  agentctl run submit --agent <name> --impl <name> --runtime <type> [flags]
  agentctl run apply -f <file>
  agentctl run get <name>
  agentctl run describe <name>
  agentctl run status <name>
  agentctl run wait <name>
  agentctl run list
  agentctl run watch
  agentctl run logs <name> [--follow]
  agentctl run cancel <name>

Global flags:
  --namespace, -n <ns>
  --server, --address <host:port>
  --kube
  --grpc
  --kubeconfig <path>
  --context <name>
  --token <token>
  --output, -o <yaml|json|table>
  --tls

Version flags:
  --client

Run submit flags:
  --workload-image <image>
  --cpu <value>
  --memory <value>
  --memory-ref <name>
  --param key=value
  --runtime-config key=value
  --idempotency-key <value>
  --wait

Watch flags:
  --interval <seconds>

List flags:
  --selector, -l <selector>

Run list flags:
  --phase <phase>
  --runtime <runtime>
  --selector, -l <selector>
`.trim()

const parseBoolean = (raw: string | undefined) => {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  return undefined
}

const resolveConfigPath = () => {
  const base = process.env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config')
  return resolve(base, 'agentctl', 'config.json')
}

const loadConfig = async (): Promise<Config> => {
  const path = resolveConfigPath()
  if (!existsSync(path)) return {}
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as Config
  } catch {
    return {}
  }
}

const saveConfig = async (config: Config) => {
  const path = resolveConfigPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

const parseGlobalFlags = (argv: string[]) => {
  const flags: GlobalFlags = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--namespace' || arg === '-n') {
      flags.namespace = argv[++i]
      continue
    }
    if (arg.startsWith('--namespace=')) {
      flags.namespace = arg.slice('--namespace='.length)
      continue
    }
    if (arg === '--address' || arg === '--server') {
      flags.address = argv[++i]
      continue
    }
    if (arg.startsWith('--address=')) {
      flags.address = arg.slice('--address='.length)
      continue
    }
    if (arg.startsWith('--server=')) {
      flags.address = arg.slice('--server='.length)
      continue
    }
    if (arg === '--token') {
      flags.token = argv[++i]
      continue
    }
    if (arg.startsWith('--token=')) {
      flags.token = arg.slice('--token='.length)
      continue
    }
    if (arg === '--output' || arg === '-o') {
      flags.output = argv[++i]
      continue
    }
    if (arg.startsWith('--output=')) {
      flags.output = arg.slice('--output='.length)
      continue
    }
    if (arg === '--tls') {
      flags.tls = true
      continue
    }
    if (arg === '--kube') {
      flags.kube = true
      continue
    }
    if (arg === '--grpc') {
      flags.grpc = true
      continue
    }
    if (arg === '--kubeconfig') {
      flags.kubeconfig = argv[++i]
      continue
    }
    if (arg.startsWith('--kubeconfig=')) {
      flags.kubeconfig = arg.slice('--kubeconfig='.length)
      continue
    }
    if (arg === '--context') {
      flags.context = argv[++i]
      continue
    }
    if (arg.startsWith('--context=')) {
      flags.context = arg.slice('--context='.length)
      continue
    }
    rest.push(arg)
  }
  return { flags, rest }
}

const resolveNamespace = (flags: GlobalFlags, config: Config) =>
  flags.namespace || process.env.AGENTCTL_NAMESPACE || config.namespace || DEFAULT_NAMESPACE

const resolveExplicitAddress = (flags: GlobalFlags, config: Config) =>
  flags.address ||
  process.env.AGENTCTL_SERVER ||
  process.env.AGENTCTL_ADDRESS ||
  process.env.JANGAR_GRPC_ADDRESS ||
  config.address ||
  ''

const resolveMode = (flags: GlobalFlags, config: Config): TransportMode => {
  if (flags.kube) return 'kube'
  if (flags.grpc) return 'grpc'
  const envMode = process.env.AGENTCTL_MODE?.trim().toLowerCase()
  if (envMode === 'kube' || envMode === 'grpc') return envMode
  const explicitAddress = resolveExplicitAddress(flags, config)
  if (explicitAddress) return 'grpc'
  return 'kube'
}

const resolveAddress = (flags: GlobalFlags, config: Config, mode: TransportMode) => {
  const explicit = resolveExplicitAddress(flags, config)
  if (explicit) return explicit
  if (mode === 'grpc') return DEFAULT_ADDRESS
  return ''
}

const resolveToken = (flags: GlobalFlags, config: Config) =>
  flags.token || process.env.AGENTCTL_TOKEN || process.env.JANGAR_GRPC_TOKEN || config.token

const resolveTls = (flags: GlobalFlags, config: Config) => {
  if (flags.tls !== undefined) return flags.tls
  const env = parseBoolean(process.env.AGENTCTL_TLS)
  if (env !== undefined) return env
  return config.tls ?? false
}

const resolveKubeconfig = (flags: GlobalFlags, config: Config) =>
  flags.kubeconfig || process.env.AGENTCTL_KUBECONFIG || config.kubeconfig

const resolveKubeContext = (flags: GlobalFlags, config: Config) =>
  flags.context || process.env.AGENTCTL_CONTEXT || config.context

const resolveProtoPath = () => {
  const envPath = process.env.AGENTCTL_PROTO_PATH?.trim()
  if (envPath && existsSync(envPath)) return envPath

  const moduleDir = resolve(fileURLToPath(import.meta.url), '..')
  const packageRoot = resolve(moduleDir, '..')

  const candidates = [
    resolve(packageRoot, 'proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(packageRoot, '../../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(process.cwd(), 'proto/proompteng/jangar/v1/agentctl.proto'),
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
    proompteng?: { jangar?: { v1?: AgentctlPackage } }
  }

  const pkg = loaded.proompteng?.jangar?.v1
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

const loadKubeConfig = (options: KubeOptions) => {
  const kubeConfig = new KubeConfig()
  if (options.kubeconfig) {
    if (!existsSync(options.kubeconfig)) {
      throw new Error(`kubeconfig not found: ${options.kubeconfig}`)
    }
    kubeConfig.loadFromFile(options.kubeconfig)
  } else {
    kubeConfig.loadFromDefault()
  }
  if (options.context) {
    kubeConfig.setCurrentContext(options.context)
  }
  return kubeConfig
}

const createKubeClients = (options: KubeOptions): KubeClients => {
  const kubeConfig = loadKubeConfig(options)
  return {
    kubeConfig,
    core: kubeConfig.makeApiClient(CoreV1Api),
    custom: kubeConfig.makeApiClient(CustomObjectsApi),
    apps: kubeConfig.makeApiClient(AppsV1Api),
    batch: kubeConfig.makeApiClient(BatchV1Api),
    crd: kubeConfig.makeApiClient(ApiextensionsV1Api),
    log: new Log(kubeConfig),
  }
}

const unwrapResponse = <T>(response: T | { body: T }) =>
  (typeof response === 'object' && response !== null && 'body' in response
    ? (response as { body: T }).body
    : response) as T

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

const listCustomObjects = async (
  clients: KubeClients,
  spec: ResourceSpec,
  namespace: string,
  labelSelector?: string,
) => {
  const response = await clients.custom.listNamespacedCustomObject({
    group: spec.group,
    version: spec.version,
    namespace,
    plural: spec.plural,
    labelSelector,
  })
  return unwrapResponse(response) as Record<string, unknown>
}

const getCustomObjectOptional = async (clients: KubeClients, spec: ResourceSpec, name: string, namespace: string) => {
  try {
    const response = await clients.custom.getNamespacedCustomObject({
      group: spec.group,
      version: spec.version,
      namespace,
      plural: spec.plural,
      name,
    })
    return unwrapResponse(response) as Record<string, unknown>
  } catch (_error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

const createCustomObject = async (
  clients: KubeClients,
  spec: ResourceSpec,
  namespace: string,
  body: Record<string, unknown>,
) => {
  const response = await clients.custom.createNamespacedCustomObject({
    group: spec.group,
    version: spec.version,
    namespace,
    plural: spec.plural,
    body,
  })
  return unwrapResponse(response) as Record<string, unknown>
}

const replaceCustomObject = async (
  clients: KubeClients,
  spec: ResourceSpec,
  namespace: string,
  name: string,
  body: Record<string, unknown>,
) => {
  const response = await clients.custom.replaceNamespacedCustomObject({
    group: spec.group,
    version: spec.version,
    namespace,
    plural: spec.plural,
    name,
    body,
  })
  return unwrapResponse(response) as Record<string, unknown>
}

const deleteCustomObject = async (clients: KubeClients, spec: ResourceSpec, namespace: string, name: string) => {
  try {
    const response = await clients.custom.deleteNamespacedCustomObject({
      group: spec.group,
      version: spec.version,
      namespace,
      plural: spec.plural,
      name,
    })
    return unwrapResponse(response) as Record<string, unknown>
  } catch (_error) {
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

const applyManifest = async (clients: KubeClients, manifest: string, namespace: string) => {
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
      const existing = await getCustomObjectOptional(clients, spec, name, resolvedNamespace)
      if (existing) {
        const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>
        if (existingMeta.resourceVersion) {
          metadata.resourceVersion = existingMeta.resourceVersion
        }
        applied.push(await replaceCustomObject(clients, spec, resolvedNamespace, name, doc))
      } else {
        applied.push(await createCustomObject(clients, spec, resolvedNamespace, doc))
      }
      continue
    }

    if (!generateName) {
      throw new Error('manifest metadata.name or metadata.generateName is required')
    }
    applied.push(await createCustomObject(clients, spec, resolvedNamespace, doc))
  }

  return applied
}

const readNestedValue = (value: unknown, path: string[]) => {
  let cursor: unknown = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
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

const listPodsForSelector = async (clients: KubeClients, namespace: string, selector: string) => {
  const response = await clients.core.listNamespacedPod({ namespace, labelSelector: selector })
  const body = unwrapResponse(response) as { items?: Record<string, unknown>[] }
  return Array.isArray(body.items) ? body.items : []
}

const pickPodForRun = async (
  clients: KubeClients,
  namespace: string,
  selector: string,
): Promise<Record<string, unknown> | null> => {
  const items = await listPodsForSelector(clients, namespace, selector)
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
  clients: KubeClients,
  namespace: string,
  podName: string,
  container: string | undefined,
  follow: boolean,
) => {
  if (!follow) {
    const response = await clients.core.readNamespacedPodLog({
      name: podName,
      namespace,
      container,
      follow: false,
    })
    const body = unwrapResponse(response) as string
    process.stdout.write(body ?? '')
    return
  }

  const logClient = clients.log as unknown as {
    log: (...args: unknown[]) => Promise<void>
  }
  if (typeof logClient.log !== 'function') {
    const fallback = await clients.core.readNamespacedPodLog({
      name: podName,
      namespace,
      container,
      follow: false,
    })
    const body = unwrapResponse(fallback) as string
    process.stdout.write(body ?? '')
    return
  }

  try {
    await logClient.log(namespace, podName, container ?? '', process.stdout, { follow: true })
  } catch (_error) {
    const fallback = await clients.core.readNamespacedPodLog({
      name: podName,
      namespace,
      container,
      follow: false,
    })
    const body = unwrapResponse(fallback) as string
    process.stdout.write(body ?? '')
  }
}

const deleteJobByName = async (clients: KubeClients, namespace: string, name: string) => {
  try {
    await clients.batch.deleteNamespacedJob({ name, namespace })
    return true
  } catch (_error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

const deleteJobsBySelector = async (clients: KubeClients, namespace: string, selector: string) => {
  await clients.batch.deleteCollectionNamespacedJob({ namespace, labelSelector: selector })
}

const normalizeOutput = (value: string | undefined) => {
  if (!value) return 'table'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'json' || normalized === 'yaml' || normalized === 'table') return normalized
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

const parseWatchInterval = (args: string[]) => {
  let intervalMs = DEFAULT_WATCH_INTERVAL_MS
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--interval') {
      intervalMs = Math.floor(Number.parseFloat(args[++i] ?? '') * 1000)
      continue
    }
    if (arg.startsWith('--interval=')) {
      intervalMs = Math.floor(Number.parseFloat(arg.slice('--interval='.length)) * 1000)
    }
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return DEFAULT_WATCH_INTERVAL_MS
  }
  return intervalMs
}

const normalizeFilterValue = (value: string | undefined) => {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const parseLabelSelector = (args: string[]) => {
  let selector: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--selector' || arg === '-l') {
      selector = args[++i]
      continue
    }
    if (arg.startsWith('--selector=')) {
      selector = arg.slice('--selector='.length)
      continue
    }
    if (arg.startsWith('-l=')) {
      selector = arg.slice('-l='.length)
    }
  }
  return normalizeFilterValue(selector)
}

const parseRunListFilters = (args: string[]) => {
  const labelSelector = parseLabelSelector(args)
  let phase: string | undefined
  let runtime: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--phase') {
      phase = args[++i]
      continue
    }
    if (arg.startsWith('--phase=')) {
      phase = arg.slice('--phase='.length)
      continue
    }
    if (arg === '--runtime') {
      runtime = args[++i]
      continue
    }
    if (arg.startsWith('--runtime=')) {
      runtime = arg.slice('--runtime='.length)
    }
  }
  return {
    labelSelector,
    phase: normalizeFilterValue(phase),
    runtime: normalizeFilterValue(runtime),
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

const toRow = (resource: Record<string, unknown>) => {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const phase = resolveStatusPhase(resource)
  return {
    name: toCell(metadata.name ?? metadata.generateName ?? ''),
    namespace: toCell(metadata.namespace ?? ''),
    kind: toCell(resource.kind ?? ''),
    age: formatAge(typeof metadata.creationTimestamp === 'string' ? metadata.creationTimestamp : undefined),
    status: phase,
  }
}

const outputResource = (resource: Record<string, unknown>, output: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(resource, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(resource))
    return
  }
  const row = toRow(resource)
  renderTable(
    [row],
    [
      { label: 'NAME', value: (entry) => entry.name },
      { label: 'NAMESPACE', value: (entry) => entry.namespace },
      { label: 'KIND', value: (entry) => entry.kind },
      { label: 'AGE', value: (entry) => entry.age },
      { label: 'STATUS', value: (entry) => entry.status },
    ],
  )
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
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  const rows = items.map(toRow)
  renderTable(rows, [
    { label: 'NAME', value: (entry) => entry.name },
    { label: 'NAMESPACE', value: (entry) => entry.namespace },
    { label: 'KIND', value: (entry) => entry.kind },
    { label: 'AGE', value: (entry) => entry.age },
    { label: 'STATUS', value: (entry) => entry.status },
  ])
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
  const rows = resources.map(toRow)
  renderTable(rows, [
    { label: 'NAME', value: (entry) => entry.name },
    { label: 'NAMESPACE', value: (entry) => entry.namespace },
    { label: 'KIND', value: (entry) => entry.kind },
    { label: 'AGE', value: (entry) => entry.age },
    { label: 'STATUS', value: (entry) => entry.status },
  ])
}

const parseKeyValueList = (values: string[]) => {
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

const handleCompletion = (shell: string) => {
  if (shell === 'bash' || shell === 'zsh') {
    console.log(`# ${shell} completion for agentctl
_agentctl_complete() {
  COMPREPLY=()
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local cmds="version config completion status diagnose agent provider impl source memory tool toolrun orchestration orchestrationrun approval budget secretbinding signal signaldelivery schedule artifact workspace run"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _agentctl_complete agentctl
`)
    return 0
  }
  if (shell === 'fish') {
    console.log(
      'complete -c agentctl -f -a "version config completion status diagnose agent provider impl source memory tool toolrun orchestration orchestrationrun approval budget secretbinding signal signaldelivery schedule artifact workspace run"',
    )
    return 0
  }
  console.error(`Unsupported shell: ${shell}`)
  return EXIT_VALIDATION
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
      message: status.grpc.message ?? status.grpc.address ?? '',
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

const waitForRunCompletionKube = async (clients: KubeClients, name: string, namespace: string, output: string) => {
  while (true) {
    const resource = await getCustomObjectOptional(clients, AGENT_RUN_SPEC, name, namespace)
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

const outputStatusKube = async (clients: KubeClients, namespace: string, output: string) => {
  const generatedAt = new Date().toISOString()
  let namespaceStatus = 'unknown'
  let namespaceMessage = ''
  try {
    await clients.core.readNamespace({ name: namespace })
    namespaceStatus = 'healthy'
  } catch (_error) {
    namespaceStatus = 'missing'
    namespaceMessage = error instanceof Error ? error.message : String(error)
  }

  let deploymentStatus = 'unknown'
  let deploymentMessage = ''
  let deploymentName = 'agents'
  try {
    const response = await clients.apps.listNamespacedDeployment({
      namespace,
      labelSelector: 'app.kubernetes.io/name=agents',
    })
    const body = unwrapResponse(response) as { items?: Record<string, unknown>[] }
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
    deploymentMessage = error instanceof Error ? error.message : String(error)
  }

  let missingCrds: string[] = []
  try {
    const response = await clients.crd.listCustomResourceDefinition()
    const body = unwrapResponse(response) as { items?: Record<string, unknown>[] }
    const items = Array.isArray(body.items) ? body.items : []
    const found = new Set(
      items
        .map((item) => readNestedValue(item, ['metadata', 'name']))
        .filter((value): value is string => typeof value === 'string'),
    )
    missingCrds = REQUIRED_CRDS.filter((name) => !found.has(name))
  } catch (_error) {
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
  const content = await readFile(file, 'utf8')
  if (!content.trim()) throw new Error(`File ${file} is empty`)
  return content
}

const main = async () => {
  const version = getVersion()
  try {
    const { flags, rest } = parseGlobalFlags(process.argv.slice(2))
    const [command, subcommand, ...args] = rest

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      console.log(usage(version))
      return 0
    }

    const config = await loadConfig()
    const output = normalizeOutput(flags.output)
    const describeOutput = flags.output ? output : 'yaml'

    if (command === 'config') {
      if (subcommand === 'view') {
        console.log(JSON.stringify(config, null, 2))
        return 0
      }
      if (subcommand === 'set') {
        const next: Config = { ...config }
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--namespace' || args[i] === '-n') {
            next.namespace = args[++i]
          }
          if (args[i]?.startsWith('--namespace=')) {
            next.namespace = args[i].slice('--namespace='.length)
          }
          if (args[i] === '--address' || args[i] === '--server') {
            next.address = args[++i]
          }
          if (args[i]?.startsWith('--address=')) {
            next.address = args[i].slice('--address='.length)
          }
          if (args[i]?.startsWith('--server=')) {
            next.address = args[i].slice('--server='.length)
          }
          if (args[i] === '--token') {
            next.token = args[++i]
          }
          if (args[i]?.startsWith('--token=')) {
            next.token = args[i].slice('--token='.length)
          }
          if (args[i] === '--kubeconfig') {
            next.kubeconfig = args[++i]
          }
          if (args[i]?.startsWith('--kubeconfig=')) {
            next.kubeconfig = args[i].slice('--kubeconfig='.length)
          }
          if (args[i] === '--context') {
            next.context = args[++i]
          }
          if (args[i]?.startsWith('--context=')) {
            next.context = args[i].slice('--context='.length)
          }
        }
        if (!next.namespace && !next.address && !next.token && !next.kubeconfig && !next.context) {
          throw new Error(
            'config set requires at least one of --namespace, --server, --token, --kubeconfig, or --context',
          )
        }
        await saveConfig(next)
        console.log(`Updated ${resolveConfigPath()}`)
        return 0
      }
    }

    if (command === 'completion') {
      const shell = subcommand ?? ''
      return handleCompletion(shell)
    }

    const versionArgs = command === 'version' ? [subcommand, ...args].filter(Boolean) : []
    const clientOnly = versionArgs.includes('--client') || versionArgs.includes('--client-only')

    if (command === 'version' && clientOnly) {
      console.log(`agentctl ${version}`)
      return 0
    }

    const namespace = resolveNamespace(flags, config)
    const mode = resolveMode(flags, config)

    if (mode === 'kube') {
      const kubeOptions: KubeOptions = {
        kubeconfig: resolveKubeconfig(flags, config),
        context: resolveKubeContext(flags, config),
      }
      const clients = createKubeClients(kubeOptions)

      if (command === 'version') {
        console.log(`agentctl ${version}`)
        try {
          const response = await clients.apps.listNamespacedDeployment({
            namespace,
            labelSelector: 'app.kubernetes.io/name=agents',
          })
          const body = unwrapResponse(response) as { items?: Record<string, unknown>[] }
          const items = Array.isArray(body.items) ? body.items : []
          const deployment = (items[0] ?? null) as Record<string, unknown> | null
          const image = deployment
            ? readNestedValue(deployment, ['spec', 'template', 'spec', 'containers', 0, 'image'])
            : null
          if (typeof image === 'string' && image) {
            console.log(`server image ${image}`)
          } else {
            console.log('server info unavailable (kube mode)')
          }
        } catch {
          console.log('server info unavailable (kube mode)')
        }
        return 0
      }

      if (command === 'status' || command === 'diagnose') {
        await outputStatusKube(clients, namespace, output)
        return 0
      }

      const spec = RESOURCE_SPECS[command]
      if (spec) {
        if (subcommand === 'get' || subcommand === 'describe' || subcommand === 'status') {
          const name = args[0]
          if (!name) {
            throw new Error('name is required')
          }
          const resource = await getCustomObjectOptional(clients, spec, name, namespace)
          if (!resource) {
            throw new Error(`${command} ${name} not found`)
          }
          outputResource(resource, subcommand === 'describe' ? describeOutput : output)
          return 0
        }
        if (subcommand === 'list') {
          const labelSelector = parseLabelSelector(args)
          const resource = await listCustomObjects(clients, spec, namespace, labelSelector)
          outputList(resource, output)
          return 0
        }
        if (subcommand === 'watch') {
          const intervalMs = parseWatchInterval(args)
          let iteration = 0
          const stop = () => process.exit(0)
          process.on('SIGINT', stop)
          while (true) {
            const labelSelector = parseLabelSelector(args)
            const resource = await listCustomObjects(clients, spec, namespace, labelSelector)
            if (output === 'table') {
              clearScreen()
            } else if (iteration > 0) {
              console.log('')
            }
            outputList(resource, output)
            iteration += 1
            await sleep(intervalMs)
          }
        }
        if (subcommand === 'apply') {
          const fileIndex = args.indexOf('-f')
          const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
          if (!file) {
            throw new Error('apply requires -f <file>')
          }
          const manifest = await readFileContent(file)
          const resources = await applyManifest(clients, manifest, namespace)
          outputResources(resources, output)
          return 0
        }
        if (subcommand === 'delete') {
          const name = args[0]
          if (!name) {
            throw new Error('name is required')
          }
          const result = await deleteCustomObject(clients, spec, namespace, name)
          if (!result) {
            throw new Error(`${command} ${name} not found`)
          }
          console.log('deleted')
          return 0
        }
        if (command === 'impl' && subcommand === 'create') {
          let text = ''
          let summary: string | undefined
          let source: Record<string, string> | undefined
          for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--text') text = args[++i]
            if (args[i] === '--summary') summary = args[++i]
            if (args[i] === '--source') source = parseSource(args[++i])
          }
          if (!text) {
            throw new Error('--text is required')
          }
          const manifest: Record<string, unknown> = {
            apiVersion: `${spec.group}/${spec.version}`,
            kind: spec.kind,
            metadata: { generateName: 'impl-', namespace },
            spec: {
              text,
              ...(summary ? { summary } : {}),
              ...(source?.provider
                ? {
                    source: {
                      provider: source.provider,
                      ...(source.externalId ? { externalId: source.externalId } : {}),
                      ...(source.url ? { url: source.url } : {}),
                    },
                  }
                : {}),
            },
          }
          const resource = await createCustomObject(clients, spec, namespace, manifest)
          outputResource(resource, output)
          return 0
        }
      }

      if (command === 'run') {
        if (subcommand === 'submit') {
          const params: Record<string, string[]> = { param: [], runtimeConfig: [] }
          const options: Record<string, string> = {}

          for (let i = 0; i < args.length; i += 1) {
            const arg = args[i]
            if (!arg) continue
            if (arg === '--agent' || arg === '--impl' || arg === '--runtime' || arg === '--workload-image') {
              options[arg.slice(2)] = args[++i]
              continue
            }
            if (arg === '--cpu' || arg === '--memory' || arg === '--idempotency-key' || arg === '--memory-ref') {
              options[arg.slice(2)] = args[++i]
              continue
            }
            if (arg === '--param') {
              params.param.push(args[++i])
              continue
            }
            if (arg === '--runtime-config') {
              params.runtimeConfig.push(args[++i])
              continue
            }
            if (arg === '--wait') {
              options.wait = 'true'
            }
          }

          if (!options.agent || !options.impl || !options.runtime) {
            throw new Error('--agent, --impl, and --runtime are required')
          }

          const runtimeConfig = toKeyValueMap(parseKeyValueList(params.runtimeConfig))
          const parameters = toKeyValueMap(parseKeyValueList(params.param))
          const deliveryId = options['idempotency-key'] || randomUUID()
          const runSpec: Record<string, unknown> = {
            agentRef: { name: options.agent },
            implementationSpecRef: { name: options.impl },
            runtime: {
              type: options.runtime,
              ...(Object.keys(runtimeConfig).length > 0 ? { config: runtimeConfig } : {}),
            },
            ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
          }

          if (options['memory-ref']) {
            runSpec.memoryRef = { name: options['memory-ref'] }
          }

          if (options.runtime === 'workflow') {
            runSpec.workflow = { steps: [{ name: 'implement' }] }
          }

          if (options['workload-image'] || options.cpu || options.memory) {
            const workload: Record<string, unknown> = {}
            if (options['workload-image']) {
              workload.image = options['workload-image']
            }
            if (options.cpu || options.memory) {
              workload.resources = { requests: {} as Record<string, string> }
              if (options.cpu) (workload.resources as { requests: Record<string, string> }).requests.cpu = options.cpu
              if (options.memory)
                (workload.resources as { requests: Record<string, string> }).requests.memory = options.memory
            }
            runSpec.workload = workload
          }

          const manifest: Record<string, unknown> = {
            apiVersion: `${AGENT_RUN_SPEC.group}/${AGENT_RUN_SPEC.version}`,
            kind: AGENT_RUN_SPEC.kind,
            metadata: {
              generateName: `${options.agent}-`,
              namespace,
              labels: {
                'jangar.proompteng.ai/delivery-id': deliveryId,
              },
            },
            spec: runSpec,
          }

          const resource = await createCustomObject(clients, AGENT_RUN_SPEC, namespace, manifest)
          outputResource(resource, output)
          if (options.wait === 'true') {
            const runName = readNestedValue(resource, ['metadata', 'name'])
            if (typeof runName !== 'string' || !runName) {
              throw new Error('AgentRun name not available for wait')
            }
            return await waitForRunCompletionKube(clients, runName, namespace, output)
          }
          return 0
        }
        if (subcommand === 'apply') {
          const fileIndex = args.indexOf('-f')
          const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
          if (!file) {
            throw new Error('apply requires -f <file>')
          }
          const manifest = await readFileContent(file)
          const resources = await applyManifest(clients, manifest, namespace)
          outputResources(resources, output)
          return 0
        }
        if (subcommand === 'get' || subcommand === 'describe' || subcommand === 'status') {
          const name = args[0]
          if (!name) {
            throw new Error('name is required')
          }
          const resource = await getCustomObjectOptional(clients, AGENT_RUN_SPEC, name, namespace)
          if (!resource) {
            throw new Error('AgentRun not found')
          }
          outputResource(resource, subcommand === 'describe' ? describeOutput : output)
          return 0
        }
        if (subcommand === 'list') {
          const filters = parseRunListFilters(args)
          const resource = await listCustomObjects(clients, AGENT_RUN_SPEC, namespace, filters.labelSelector)
          outputList(filterAgentRunsList(resource, filters.phase, filters.runtime), output)
          return 0
        }
        if (subcommand === 'watch') {
          const intervalMs = parseWatchInterval(args)
          let iteration = 0
          const stop = () => process.exit(0)
          process.on('SIGINT', stop)
          while (true) {
            const filters = parseRunListFilters(args)
            const resource = await listCustomObjects(clients, AGENT_RUN_SPEC, namespace, filters.labelSelector)
            if (output === 'table') {
              clearScreen()
            } else if (iteration > 0) {
              console.log('')
            }
            outputList(filterAgentRunsList(resource, filters.phase, filters.runtime), output)
            iteration += 1
            await sleep(intervalMs)
          }
        }
        if (subcommand === 'wait') {
          const name = args[0]
          if (!name) {
            throw new Error('name is required')
          }
          return await waitForRunCompletionKube(clients, name, namespace, output)
        }
        if (subcommand === 'logs') {
          const name = args[0]
          if (!name) {
            throw new Error('name is required')
          }
          const follow = args.includes('--follow')
          const resource = await getCustomObjectOptional(clients, AGENT_RUN_SPEC, name, namespace)
          if (!resource) {
            throw new Error('AgentRun not found')
          }
          const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
          const selector = isJobRuntime(runtimeType) && runtimeName ? `job-name=${runtimeName}` : runLabelSelector(name)
          const pod = await pickPodForRun(clients, namespace, selector)
          if (!pod) {
            throw new Error('No pods found for AgentRun')
          }
          const podName = readNestedValue(pod, ['metadata', 'name'])
          if (typeof podName !== 'string' || !podName) {
            throw new Error('Pod name not available for logs')
          }
          const containerName = resolvePodContainerName(pod)
          await streamPodLogs(clients, namespace, podName, containerName, follow)
          return 0
        }
        if (subcommand === 'cancel') {
          const name = args[0]
          if (!name) {
            throw new Error('name is required')
          }
          const resource = await getCustomObjectOptional(clients, AGENT_RUN_SPEC, name, namespace)
          if (!resource) {
            throw new Error('AgentRun not found')
          }
          const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
          if (runtimeType === 'workflow') {
            await deleteJobsBySelector(clients, namespace, runLabelSelector(name))
            console.log('cancelled')
            return 0
          }
          if (isJobRuntime(runtimeType) && runtimeName) {
            const deleted = await deleteJobByName(clients, namespace, runtimeName)
            if (!deleted) {
              console.log('job not found')
            } else {
              console.log('cancelled')
            }
            return 0
          }
          if (isJobRuntime(runtimeType)) {
            await deleteJobsBySelector(clients, namespace, runLabelSelector(name))
            console.log('cancelled')
            return 0
          }
          throw new Error('No cancellable runtime found for this AgentRun')
        }
      }

      console.error('Unknown command')
      console.log(usage(version))
      return EXIT_VALIDATION
    }

    const address = resolveAddress(flags, config, mode)
    const token = resolveToken(flags, config)
    const tlsEnabled = resolveTls(flags, config)
    const metadata = createMetadata(token)
    const client = await createClient(address, tlsEnabled)

    if (command === 'version') {
      console.log(`agentctl ${version}`)
      const response = await callUnary<{ version: string; build_sha?: string; build_time?: string }>(
        client,
        'GetServerInfo',
        {},
        metadata,
      )
      console.log(`server ${response.version}`)
      if (response.build_sha) {
        console.log(`build ${response.build_sha}${response.build_time ? ` (${response.build_time})` : ''}`)
      }
      return 0
    }

    if (command === 'status' || command === 'diagnose') {
      const response = await callUnary<ControlPlaneStatus>(client, 'GetControlPlaneStatus', { namespace }, metadata)
      outputStatus(response, output, namespace)
      return 0
    }

    const rpc = RPC_RESOURCE_MAP[command]
    if (rpc) {
      if (subcommand === 'get' || subcommand === 'describe') {
        const response = await callUnary<{ json: string }>(client, rpc.get, { name: args[0], namespace }, metadata)
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, subcommand === 'describe' ? describeOutput : output)
        return 0
      }
      if (subcommand === 'list') {
        const labelSelector = parseLabelSelector(args)
        const request: Record<string, string> = { namespace }
        if (labelSelector) {
          request.label_selector = labelSelector
        }
        const response = await callUnary<{ json: string }>(client, rpc.list, request, metadata)
        const resource = parseJson(response.json)
        if (resource) outputList(resource, output)
        return 0
      }
      if (subcommand === 'watch') {
        const intervalMs = parseWatchInterval(args)
        let iteration = 0
        const stop = () => process.exit(0)
        process.on('SIGINT', stop)
        while (true) {
          const labelSelector = parseLabelSelector(args)
          const request: Record<string, string> = { namespace }
          if (labelSelector) {
            request.label_selector = labelSelector
          }
          const response = await callUnary<{ json: string }>(client, rpc.list, request, metadata)
          const resource = parseJson(response.json)
          if (resource) {
            if (output === 'table') {
              clearScreen()
            } else if (iteration > 0) {
              console.log('')
            }
            outputList(resource, output)
            iteration += 1
          }
          await sleep(intervalMs)
        }
      }
      if (subcommand === 'apply') {
        const fileIndex = args.indexOf('-f')
        const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
        if (!file) {
          throw new Error('apply requires -f <file>')
        }
        const manifest = await readFileContent(file)
        const response = await callUnary<{ json: string }>(
          client,
          rpc.apply,
          { namespace, manifest_yaml: manifest },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
      if (subcommand === 'delete') {
        const response = await callUnary<{ ok: boolean; message?: string }>(
          client,
          rpc.del,
          { name: args[0], namespace },
          metadata,
        )
        console.log(response.message ?? 'deleted')
        return 0
      }
      if (command === 'impl' && subcommand === 'create') {
        let text = ''
        let summary: string | undefined
        let source: Record<string, string> | undefined
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--text') text = args[++i]
          if (args[i] === '--summary') summary = args[++i]
          if (args[i] === '--source') source = parseSource(args[++i])
        }
        if (!text) {
          throw new Error('--text is required')
        }
        const response = await callUnary<{ json: string }>(
          client,
          rpc.create ?? 'CreateImplementationSpec',
          {
            namespace,
            text,
            summary: summary ?? '',
            source: source
              ? {
                  provider: source.provider,
                  external_id: source.externalId ?? '',
                  url: source.url ?? '',
                }
              : undefined,
          },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
    }

    if (command === 'run') {
      if (subcommand === 'submit') {
        const params: Record<string, string[]> = { param: [], runtimeConfig: [] }
        const options: Record<string, string> = {}

        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i]
          if (!arg) continue
          if (arg === '--agent' || arg === '--impl' || arg === '--runtime' || arg === '--workload-image') {
            options[arg.slice(2)] = args[++i]
            continue
          }
          if (arg === '--cpu' || arg === '--memory' || arg === '--idempotency-key' || arg === '--memory-ref') {
            options[arg.slice(2)] = args[++i]
            continue
          }
          if (arg === '--param') {
            params.param.push(args[++i])
            continue
          }
          if (arg === '--runtime-config') {
            params.runtimeConfig.push(args[++i])
            continue
          }
          if (arg === '--wait') {
            options.wait = 'true'
          }
        }

        if (!options.agent || !options.impl || !options.runtime) {
          throw new Error('--agent, --impl, and --runtime are required')
        }

        const response = await callUnary<{
          resource_json: string
          record_json: string
          idempotent?: boolean
        }>(
          client,
          'SubmitAgentRun',
          {
            namespace,
            agent_name: options.agent,
            implementation_name: options.impl,
            runtime_type: options.runtime,
            runtime_config: toKeyValueMap(parseKeyValueList(params.runtimeConfig)),
            parameters: toKeyValueMap(parseKeyValueList(params.param)),
            idempotency_key: options['idempotency-key'] ?? '',
            workload: {
              image: options['workload-image'] ?? '',
              cpu: options.cpu ?? '',
              memory: options.memory ?? '',
            },
            memory_ref: options['memory-ref'] ?? '',
          },
          metadata,
        )

        if (response.resource_json) {
          const resource = parseJson(response.resource_json)
          const runName = ((resource?.metadata ?? {}) as { name?: string }).name
          if (options.wait === 'true' && runName) {
            return await waitForRunCompletion(client, metadata, runName, namespace, output)
          }
          if (resource) outputResource(resource, output)
        }
        return 0
      }
      if (subcommand === 'apply') {
        const fileIndex = args.indexOf('-f')
        const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
        if (!file) {
          throw new Error('apply requires -f <file>')
        }
        const manifest = await readFileContent(file)
        const response = await callUnary<{ json: string }>(
          client,
          'ApplyAgentRun',
          { namespace, manifest_yaml: manifest },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
      if (subcommand === 'get' || subcommand === 'status' || subcommand === 'describe') {
        if (!args[0]) {
          throw new Error('run get requires a name')
        }
        const response = await callUnary<{ json: string }>(
          client,
          'GetAgentRun',
          { name: args[0], namespace },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, subcommand === 'describe' ? describeOutput : output)
        return 0
      }
      if (subcommand === 'wait') {
        if (!args[0]) {
          throw new Error('run wait requires a name')
        }
        return await waitForRunCompletion(client, metadata, args[0], namespace, output)
      }
      if (subcommand === 'list') {
        const filters = parseRunListFilters(args)
        const request: Record<string, string> = { namespace }
        if (filters.labelSelector) {
          request.label_selector = filters.labelSelector
        }
        if (filters.phase) {
          request.phase = filters.phase
        }
        if (filters.runtime) {
          request.runtime = filters.runtime
        }
        const response = await callUnary<{ json: string }>(client, 'ListAgentRuns', request, metadata)
        const resource = parseJson(response.json)
        if (resource) outputList(resource, output)
        return 0
      }
      if (subcommand === 'watch') {
        const intervalMs = parseWatchInterval(args)
        let iteration = 0
        const stop = () => process.exit(0)
        process.on('SIGINT', stop)
        while (true) {
          const filters = parseRunListFilters(args)
          const request: Record<string, string> = { namespace }
          if (filters.labelSelector) {
            request.label_selector = filters.labelSelector
          }
          if (filters.phase) {
            request.phase = filters.phase
          }
          if (filters.runtime) {
            request.runtime = filters.runtime
          }
          const response = await callUnary<{ json: string }>(client, 'ListAgentRuns', request, metadata)
          const resource = parseJson(response.json)
          if (resource) {
            if (output === 'table') {
              clearScreen()
            } else if (iteration > 0) {
              console.log('')
            }
            outputList(resource, output)
            iteration += 1
          }
          await sleep(intervalMs)
        }
      }
      if (subcommand === 'logs') {
        const stream = (client as unknown as Record<string, (...args: unknown[]) => grpc.ClientReadableStream<unknown>>)
          .StreamAgentRunLogs
        if (!stream) throw new Error('StreamAgentRunLogs not available')
        const follow = args.includes('--follow')
        const call = stream.call(client, { name: args[0], namespace, follow }, metadata)
        call.on('data', (entry: { stream?: string; message?: string }) => {
          const message = entry.message ?? ''
          if (entry.stream === 'stderr') {
            process.stderr.write(message)
          } else {
            process.stdout.write(message)
          }
        })
        await new Promise<void>((resolve, reject) => {
          call.on('end', () => resolve())
          call.on('error', (error) => reject(error))
        })
        return 0
      }
      if (subcommand === 'cancel') {
        const response = await callUnary<{ ok: boolean; message?: string }>(
          client,
          'CancelAgentRun',
          { name: args[0], namespace },
          metadata,
        )
        console.log(response.message ?? 'cancelled')
        return 0
      }
    }

    console.error('Unknown command')
    console.log(usage(version))
    return EXIT_VALIDATION
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as grpc.ServiceError).code
      if (code === grpc.status.INVALID_ARGUMENT) return EXIT_VALIDATION
      if (code === grpc.status.FAILED_PRECONDITION || code === grpc.status.NOT_FOUND) return EXIT_RUNTIME
    }
    return EXIT_UNKNOWN
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code))
}

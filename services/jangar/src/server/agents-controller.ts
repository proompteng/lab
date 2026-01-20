import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createTemporalClient, loadTemporalConfig, temporalCallOptions } from '@proompteng/temporal-bun-sdk'
import { startResourceWatch } from '~/server/kube-watch'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_CONCURRENCY = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
}
const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const PARAMETERS_MAX_ENTRIES = 100
const PARAMETERS_MAX_VALUE_BYTES = 2048

const REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
]

type CrdCheckState = {
  ok: boolean
  missing: string[]
  checkedAt: string
}

let crdCheckState: CrdCheckState | null = null

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

type RuntimeRef = Record<string, unknown>

type WorkflowStepSpec = {
  name: string
  implementationSpecRefName: string | null
  implementationInline: Record<string, unknown> | null
  parameters: Record<string, string>
  workload: Record<string, unknown> | null
  retries: number
  retryBackoffSeconds: number
}

type WorkflowStepStatus = {
  name: string
  phase: string
  attempt: number
  startedAt?: string
  finishedAt?: string
  lastTransitionTime: string
  message?: string
  jobRef?: Record<string, unknown>
  nextRetryAt?: string
}

type WorkflowStatus = {
  phase: string
  lastTransitionTime: string
  steps: WorkflowStepStatus[]
}

type NamespaceState = {
  agents: Map<string, Record<string, unknown>>
  providers: Map<string, Record<string, unknown>>
  specs: Map<string, Record<string, unknown>>
  memories: Map<string, Record<string, unknown>>
  runs: Map<string, Record<string, unknown>>
}

type ControllerState = {
  namespaces: Map<string, NamespaceState>
}

let started = false
let reconciling = false
let temporalClientPromise: ReturnType<typeof createTemporalClient> | null = null
let watchHandles: Array<{ stop: () => void }> = []
let _controllerState: ControllerState | null = null
const namespaceQueues = new Map<string, Promise<void>>()

const nowIso = () => new Date().toISOString()

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  const flag = (process.env.JANGAR_AGENTS_CONTROLLER_ENABLED ?? '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false'
}

const parseNamespaces = () => {
  const raw = process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  if (!raw) return DEFAULT_NAMESPACES
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return list.length > 0 ? list : DEFAULT_NAMESPACES
}

const resolveCrdCheckNamespace = () => {
  const namespaces = parseNamespaces()
  if (namespaces.includes('*')) return 'default'
  return namespaces[0] ?? 'default'
}

const resolveNamespaces = async () => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) {
    return namespaces
  }
  const result = await runKubectl(['get', 'namespace', '-o', 'json'])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to list namespaces')
  }
  const payload = JSON.parse(result.stdout) as Record<string, unknown>
  const items = Array.isArray(payload.items) ? payload.items : []
  const resolved = items
    .map((item) => {
      const metadata = item && typeof item === 'object' ? (item as Record<string, unknown>).metadata : null
      const name = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).name : null
      return typeof name === 'string' ? name : null
    })
    .filter((value): value is string => Boolean(value))
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kubectl')
  }
  return resolved
}

const parseConcurrency = () => ({
  perNamespace:
    Number.parseInt(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE ?? '', 10) ||
    DEFAULT_CONCURRENCY.perNamespace,
  perAgent:
    Number.parseInt(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT ?? '', 10) || DEFAULT_CONCURRENCY.perAgent,
  cluster:
    Number.parseInt(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER ?? '', 10) || DEFAULT_CONCURRENCY.cluster,
})

const runKubectl = (args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : String(error)),
        code: 1,
      })
    })
    child.on('close', (code) => finish({ stdout, stderr, code }))
  })

const checkCrds = async (): Promise<CrdCheckState> => {
  const namespace = resolveCrdCheckNamespace()
  const missing: string[] = []
  const forbidden: string[] = []
  for (const name of REQUIRED_CRDS) {
    const resource = name.split('.')[0] ?? name
    const result = await runKubectl(['get', resource, '-n', namespace, '-o', 'json'])
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || '').toLowerCase()
      if (details.includes('forbidden') || details.includes('unauthorized')) {
        forbidden.push(name)
      } else {
        missing.push(name)
      }
    }
  }
  const state = {
    ok: missing.length === 0 && forbidden.length === 0,
    missing: [...missing, ...forbidden],
    checkedAt: nowIso(),
  }
  crdCheckState = state
  if (!state.ok) {
    if (missing.length > 0) {
      console.error('[jangar] missing required Agents CRDs:', missing.join(', '))
    }
    if (forbidden.length > 0) {
      console.error(`[jangar] insufficient RBAC to read Agents CRDs in namespace ${namespace}: ${forbidden.join(', ')}`)
      console.error('[jangar] ensure the Jangar service account can list Agents CRDs in this namespace')
    }
    console.error(
      '[jangar] install the Agents Helm chart (charts/agents) or apply charts/agents/crds/*.yaml before starting the controller',
    )
  }
  return state
}

export const getAgentsControllerHealth = () => ({
  enabled: shouldStart(),
  started,
  crdsReady: crdCheckState?.ok ?? null,
  missingCrds: crdCheckState?.missing ?? [],
  lastCheckedAt: crdCheckState?.checkedAt ?? null,
})

const normalizeConditions = (raw: unknown): Condition[] => {
  if (!Array.isArray(raw)) return []
  const output: Condition[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const type = asString(record.type)
    const status = asString(record.status)
    if (!type || !status) continue
    output.push({
      type,
      status: status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown',
      reason: asString(record.reason) ?? undefined,
      message: asString(record.message) ?? undefined,
      lastTransitionTime: asString(record.lastTransitionTime) ?? nowIso(),
    })
  }
  return output
}

const upsertCondition = (conditions: Condition[], update: Omit<Condition, 'lastTransitionTime'>): Condition[] => {
  const next = [...conditions]
  const index = next.findIndex((cond) => cond.type === update.type)
  if (index === -1) {
    next.push({ ...update, lastTransitionTime: nowIso() })
    return next
  }
  const existing = next[index]
  if (existing.status !== update.status || existing.reason !== update.reason || existing.message !== update.message) {
    next[index] = { ...existing, ...update, lastTransitionTime: nowIso() }
  }
  return next
}

const setStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
) => {
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!name || !namespace) return
  const apiVersion = asString(resource.apiVersion)
  const kind = asString(resource.kind)
  if (!apiVersion || !kind) return
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status })
}

const parseRuntimeRef = (raw: unknown): RuntimeRef | null => asRecord(raw) ?? null

const resolveJobImage = (workload: Record<string, unknown>) =>
  asString(workload.image) ?? process.env.JANGAR_AGENT_RUNNER_IMAGE ?? process.env.JANGAR_AGENT_IMAGE ?? null

const parseWorkflowSteps = (agentRun: Record<string, unknown>): WorkflowStepSpec[] => {
  const workflow = asRecord(readNested(agentRun, ['spec', 'workflow'])) ?? {}
  const steps = Array.isArray(workflow.steps) ? (workflow.steps as Record<string, unknown>[]) : []
  return steps
    .map((step) => {
      const name = asString(step.name) ?? ''
      const parameters = asRecord(step.parameters) ?? {}
      const parsedParameters: Record<string, string> = {}
      for (const [key, value] of Object.entries(parameters)) {
        if (typeof value !== 'string') continue
        parsedParameters[key] = value
      }
      const retries = parseOptionalNumber(step.retries)
      const retryBackoffSeconds = parseOptionalNumber(step.retryBackoffSeconds)
      return {
        name,
        implementationSpecRefName: asString(readNested(step, ['implementationSpecRef', 'name'])) ?? null,
        implementationInline: asRecord(readNested(step, ['implementation', 'inline'])) ?? null,
        parameters: parsedParameters,
        workload: asRecord(step.workload) ?? null,
        retries: Number.isFinite(retries) ? Math.max(0, Math.trunc(retries ?? 0)) : 0,
        retryBackoffSeconds: Number.isFinite(retryBackoffSeconds)
          ? Math.max(0, Math.trunc(retryBackoffSeconds ?? 0))
          : 0,
      }
    })
    .filter((step) => step.name.length > 0)
}

const validateWorkflowSteps = (steps: WorkflowStepSpec[]) => {
  if (steps.length === 0) {
    return {
      ok: false as const,
      reason: 'MissingWorkflowSteps',
      message: 'spec.workflow.steps must include at least one step for workflow runtime',
    }
  }
  const seen = new Set<string>()
  for (const step of steps) {
    if (!step.name) {
      return {
        ok: false as const,
        reason: 'WorkflowStepMissingName',
        message: 'workflow steps must include a name',
      }
    }
    if (seen.has(step.name)) {
      return {
        ok: false as const,
        reason: 'WorkflowStepDuplicate',
        message: `workflow step name ${step.name} is duplicated`,
      }
    }
    seen.add(step.name)
    const paramsCheck = validateParameters(step.parameters as Record<string, unknown>)
    if (!paramsCheck.ok) {
      return {
        ok: false as const,
        reason: paramsCheck.reason,
        message: `workflow step ${step.name}: ${paramsCheck.message}`,
      }
    }
  }
  return { ok: true as const }
}

const normalizeWorkflowStatus = (
  existing: Record<string, unknown> | null,
  steps: WorkflowStepSpec[],
): WorkflowStatus => {
  const existingSteps = Array.isArray(existing?.steps) ? (existing?.steps as Record<string, unknown>[]) : []
  const byName = new Map<string, Record<string, unknown>>()
  for (const item of existingSteps) {
    const name = asString(item.name)
    if (name) byName.set(name, item)
  }
  return {
    phase: asString(existing?.phase) ?? 'Pending',
    lastTransitionTime: asString(existing?.lastTransitionTime) ?? nowIso(),
    steps: steps.map((step) => {
      const current = byName.get(step.name) ?? {}
      return {
        name: step.name,
        phase: asString(current.phase) ?? 'Pending',
        attempt: Number(current.attempt ?? 0) || 0,
        startedAt: asString(current.startedAt) ?? undefined,
        finishedAt: asString(current.finishedAt) ?? undefined,
        lastTransitionTime: asString(current.lastTransitionTime) ?? nowIso(),
        message: asString(current.message) ?? undefined,
        jobRef: asRecord(current.jobRef) ?? undefined,
        nextRetryAt: asString(current.nextRetryAt) ?? undefined,
      }
    }),
  }
}

const setWorkflowPhase = (workflow: WorkflowStatus, phase: string) => {
  if (workflow.phase !== phase) {
    workflow.phase = phase
    workflow.lastTransitionTime = nowIso()
  }
}

const setWorkflowStepPhase = (step: WorkflowStepStatus, phase: string, message?: string) => {
  if (step.phase !== phase) {
    step.phase = phase
    step.lastTransitionTime = nowIso()
  }
  if (message !== undefined) {
    step.message = message
  }
}

const shouldRetryStep = (step: WorkflowStepStatus, now: number) => {
  if (!step.nextRetryAt) return true
  const retryAt = Date.parse(step.nextRetryAt)
  return Number.isNaN(retryAt) ? true : retryAt <= now
}

const renderTemplate = (template: string, context: Record<string, unknown>) =>
  template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path) => {
    const value = resolvePath(context, String(path))
    if (value == null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })

const resolvePath = (value: Record<string, unknown>, path: string) => {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  let cursor: unknown = value
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor ?? null
}

const getTemporalClient = async () => {
  if (!temporalClientPromise) {
    temporalClientPromise = (async () => {
      const config = await loadTemporalConfig({
        defaults: {
          host: DEFAULT_TEMPORAL_HOST,
          port: DEFAULT_TEMPORAL_PORT,
          address: DEFAULT_TEMPORAL_ADDRESS,
        },
      })
      return createTemporalClient({ config })
    })()
  }
  const { client } = await temporalClientPromise
  return client
}

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const isTemporalPollPending = (error: unknown) => {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    const message = error.message.toLowerCase()
    if (message.includes('deadline') || message.includes('timeout')) return true
  }
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'number' && code === 4) return true
  if (typeof code === 'string' && code.toLowerCase().includes('deadline')) return true
  return false
}

const classifyTemporalResult = (error: unknown) => {
  if (isTemporalPollPending(error)) {
    return { kind: 'pending' as const }
  }
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('workflow canceled')) {
    return { kind: 'cancelled' as const, reason: 'Cancelled', message }
  }
  if (lower.includes('workflow terminated')) {
    return { kind: 'failed' as const, reason: 'Terminated', message }
  }
  if (lower.includes('workflow timed out')) {
    return { kind: 'failed' as const, reason: 'TimedOut', message }
  }
  if (lower.includes('workflow failed')) {
    return { kind: 'failed' as const, reason: 'Failed', message }
  }
  if (lower.includes('connect') || lower.includes('unavailable') || lower.includes('handshake')) {
    return { kind: 'pending' as const }
  }
  return { kind: 'failed' as const, reason: 'TemporalError', message }
}

const makeName = (base: string, suffix: string) => {
  const normalized = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const combined = `${normalized}-${suffix}`.replace(/^-+|-+$/g, '')
  if (combined.length <= 63) return combined
  const hash = createHash('sha1').update(combined).digest('hex').slice(0, 8)
  const trimmed = combined.slice(0, 63 - hash.length - 1)
  return `${trimmed}-${hash}`
}

const normalizeLabelValue = (value: string) => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  const trimmed = normalized.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '')
  if (!trimmed) return 'unknown'
  return trimmed.length <= 63 ? trimmed : trimmed.slice(0, 63)
}

const buildRunSpecContext = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const agentSpec = asRecord(agent?.spec) ?? {}
  return {
    agentRun: {
      name: asString(metadata.name) ?? '',
      uid: asString(metadata.uid) ?? '',
      namespace: asString(metadata.namespace) ?? '',
    },
    agent: {
      name: asString(readNested(agent, ['metadata', 'name'])) ?? '',
      config: asRecord(agentSpec.config) ?? {},
      env: Array.isArray(agentSpec.env) ? agentSpec.env : [],
    },
    implementation,
    parameters,
    memory: memory ?? {},
  }
}

const resolveImplementation = (agentRun: Record<string, unknown>) => {
  const spec = asRecord(agentRun.spec) ?? {}
  const inline = asRecord(readNested(spec, ['implementation', 'inline']))
  if (inline) return inline
  return null
}

const resolveParameters = (agentRun: Record<string, unknown>) => {
  const spec = asRecord(agentRun.spec) ?? {}
  const params = asRecord(spec.parameters) ?? {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue
    output[key] = value
  }
  return output
}

const parseStringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const validateParameters = (params: Record<string, unknown>) => {
  const entries = Object.entries(params)
  if (entries.length > PARAMETERS_MAX_ENTRIES) {
    return {
      ok: false,
      reason: 'ParametersTooLarge',
      message: `spec.parameters exceeds ${PARAMETERS_MAX_ENTRIES} entries`,
    }
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        reason: 'ParameterNotString',
        message: `spec.parameters.${key} must be a string`,
      }
    }
    if (Buffer.byteLength(value, 'utf8') > PARAMETERS_MAX_VALUE_BYTES) {
      return {
        ok: false,
        reason: 'ParameterValueTooLarge',
        message: `spec.parameters.${key} exceeds ${PARAMETERS_MAX_VALUE_BYTES} bytes`,
      }
    }
  }
  return { ok: true as const }
}

const listItems = (resource: Record<string, unknown>) => {
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  return items
}

const selectDefaultMemory = (memories: Record<string, unknown>[]) => {
  return memories.find((memory) => readNested(memory, ['spec', 'default']) === true) ?? null
}

const resolveMemory = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  memories: Record<string, unknown>[],
) => {
  const runRef = asString(readNested(agentRun, ['spec', 'memoryRef', 'name']))
  if (runRef) {
    return memories.find((memory) => asString(readNested(memory, ['metadata', 'name'])) === runRef) ?? null
  }
  const agentRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
  if (agentRef) {
    return memories.find((memory) => asString(readNested(memory, ['metadata', 'name'])) === agentRef) ?? null
  }
  return selectDefaultMemory(memories)
}

const createNamespaceState = (): NamespaceState => ({
  agents: new Map(),
  providers: new Map(),
  specs: new Map(),
  memories: new Map(),
  runs: new Map(),
})

const ensureNamespaceState = (state: ControllerState, namespace: string) => {
  const existing = state.namespaces.get(namespace)
  if (existing) return existing
  const created = createNamespaceState()
  state.namespaces.set(namespace, created)
  return created
}

const updateStateMap = (
  map: Map<string, Record<string, unknown>>,
  eventType: string | undefined,
  resource: Record<string, unknown>,
) => {
  const name = asString(readNested(resource, ['metadata', 'name']))
  if (!name) return
  if (eventType === 'DELETED') {
    map.delete(name)
    return
  }
  map.set(name, resource)
}

const snapshotNamespace = (state: NamespaceState) => ({
  agents: Array.from(state.agents.values()),
  providers: Array.from(state.providers.values()),
  specs: Array.from(state.specs.values()),
  memories: Array.from(state.memories.values()),
  runs: Array.from(state.runs.values()),
})

const buildInFlightCounts = (state: ControllerState, namespace: string) => {
  const perAgent = new Map<string, number>()
  let total = 0
  let cluster = 0
  for (const [ns, nsState] of state.namespaces.entries()) {
    for (const run of nsState.runs.values()) {
      const phase = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
      if (phase !== 'Running') continue
      cluster += 1
      if (ns !== namespace) continue
      total += 1
      const agentName = asString(readNested(run, ['spec', 'agentRef', 'name'])) ?? 'unknown'
      perAgent.set(agentName, (perAgent.get(agentName) ?? 0) + 1)
    }
  }
  return { total, perAgent, cluster }
}

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  const current = namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.warn('[jangar] agents controller task failed', error)
    })
  namespaceQueues.set(namespace, next)
}

const buildRuntimeRef = (
  type: string,
  name: string,
  namespace: string,
  extra?: Record<string, unknown>,
): RuntimeRef => ({
  type,
  name,
  namespace,
  ...(extra ?? {}),
})

const deleteRuntimeResource = async (kind: string, name: string, namespace: string) => {
  const result = await runKubectl(['delete', kind, name, '-n', namespace])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to delete ${kind}/${name}`)
  }
}

const cancelRuntime = async (runtimeRef: RuntimeRef, namespace: string) => {
  const type = asString(runtimeRef.type) ?? ''
  const name = asString(runtimeRef.name) ?? ''
  const runtimeNamespace = asString(runtimeRef.namespace) ?? namespace
  if (!name) return
  if (type === 'job') {
    await deleteRuntimeResource('job', name, runtimeNamespace)
    return
  }
  if (type === 'workflow') {
    const runName = asString(runtimeRef.runName) ?? name
    const result = await runKubectl([
      'delete',
      'job',
      '-n',
      runtimeNamespace,
      '-l',
      `agents.proompteng.ai/agent-run=${runName}`,
      '--ignore-not-found',
    ])
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `failed to delete workflow jobs for ${runName}`)
    }
    return
  }
  if (type === 'temporal') {
    const client = await getTemporalClient()
    const handle = {
      workflowId: asString(runtimeRef.workflowId) ?? name,
      runId: asString(runtimeRef.runId) ?? undefined,
      namespace: asString(runtimeRef.namespace) ?? undefined,
    }
    await client.workflow.cancel(handle)
  }
}

const buildConditions = (resource: Record<string, unknown>) =>
  normalizeConditions(readNested(resource, ['status', 'conditions']))

const reconcileAgent = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agent: Record<string, unknown>,
  namespace: string,
  providers: Record<string, unknown>[],
  memories: Record<string, unknown>[],
) => {
  const conditions = buildConditions(agent)
  const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
  let updated = conditions

  if (!providerName) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingProviderRef',
      message: 'spec.providerRef.name is required',
    })
  } else {
    const provider = providers.find((item) => asString(readNested(item, ['metadata', 'name'])) === providerName)
    if (!provider) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProvider',
        message: `agent provider ${providerName} not found`,
      })
    } else {
      updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
    }
  }

  const memoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
  if (memoryRef) {
    const memory = memories.find((item) => asString(readNested(item, ['metadata', 'name'])) === memoryRef)
    if (!memory) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingMemory',
        message: `memory ${memoryRef} not found in ${namespace}`,
      })
    }
  }

  await setStatus(kube, agent, {
    observedGeneration: asRecord(agent.metadata)?.generation ?? 0,
    conditions: updated,
  })
}

const reconcileAgentProvider = async (
  kube: ReturnType<typeof createKubernetesClient>,
  provider: Record<string, unknown>,
) => {
  const spec = asRecord(provider.spec) ?? {}
  const conditions = buildConditions(provider)
  const binary = asString(spec.binary)
  let updated = conditions
  if (!binary) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingBinary',
      message: 'spec.binary is required',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }
  await setStatus(kube, provider, {
    observedGeneration: asRecord(provider.metadata)?.generation ?? 0,
    conditions: updated,
  })
}

const reconcileImplementationSpec = async (
  kube: ReturnType<typeof createKubernetesClient>,
  impl: Record<string, unknown>,
) => {
  const spec = asRecord(impl.spec) ?? {}
  const conditions = buildConditions(impl)
  const text = asString(spec.text) ?? ''
  const summary = asString(spec.summary) ?? ''
  const description = asString(spec.description) ?? ''
  const acceptanceCriteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : []
  let updated = conditions
  if (!text) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingText',
      message: 'spec.text is required',
    })
  } else if (text.length > 131072) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'TextTooLarge',
      message: 'spec.text exceeds 128KB',
    })
  } else if (summary && summary.length > 256) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'SummaryTooLong',
      message: 'spec.summary exceeds 256 characters',
    })
  } else if (description && description.length > IMPLEMENTATION_TEXT_LIMIT) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'DescriptionTooLarge',
      message: 'spec.description exceeds 128KB',
    })
  } else if (acceptanceCriteria.length > 50) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'AcceptanceCriteriaTooLong',
      message: 'spec.acceptanceCriteria exceeds 50 entries',
    })
  } else {
    updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'ValidSpec' })
  }

  await setStatus(kube, impl, {
    observedGeneration: asRecord(impl.metadata)?.generation ?? 0,
    syncedAt: asString(readNested(impl, ['status', 'syncedAt'])) ?? nowIso(),
    sourceVersion: asString(readNested(impl, ['status', 'sourceVersion'])) ?? undefined,
    conditions: updated,
  })
}

const reconcileMemory = async (
  kube: ReturnType<typeof createKubernetesClient>,
  memory: Record<string, unknown>,
  namespace: string,
) => {
  const conditions = buildConditions(memory)
  const memoryType = asString(readNested(memory, ['spec', 'type']))
  const secretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
  const secretKey = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'key']))
  let updated = conditions
  if (!memoryType) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingType',
      message: 'spec.type is required',
    })
  } else if (!secretName) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSecretRef',
      message: 'spec.connection.secretRef.name is required',
    })
  } else {
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret) {
      updated = upsertCondition(updated, {
        type: 'Unreachable',
        status: 'True',
        reason: 'SecretNotFound',
        message: `secret ${secretName} not found`,
      })
    } else if (secretKey) {
      const data = asRecord(secret.data) ?? {}
      const stringData = asRecord(secret.stringData) ?? {}
      if (!(secretKey in data) && !(secretKey in stringData)) {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretKeyMissing',
          message: `secret ${secretName} missing key ${secretKey}`,
        })
      } else {
        updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'SecretResolved' })
      }
    } else {
      updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'SecretResolved' })
    }
  }
  await setStatus(kube, memory, {
    observedGeneration: asRecord(memory.metadata)?.generation ?? 0,
    lastCheckedAt: nowIso(),
    conditions: updated,
  })
}

const buildJobResources = (workload: Record<string, unknown>) => {
  const resources = asRecord(workload.resources) ?? {}
  const requests = asRecord(resources.requests) ?? {}
  const limits = asRecord(resources.limits) ?? {}
  return {
    requests,
    limits,
  }
}

const buildRunSpec = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
  artifacts?: Array<Record<string, unknown>>,
) => {
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory)
  return {
    agentRun: context.agentRun,
    implementation,
    parameters,
    memory:
      memory == null
        ? null
        : {
            type: asString(readNested(memory, ['spec', 'type'])) ?? 'custom',
            connectionRef: asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name'])) ?? '',
          },
    artifacts: artifacts ?? [],
  }
}

const buildVolumeSpecs = (workload: Record<string, unknown>) => {
  const volumes = Array.isArray(workload.volumes) ? (workload.volumes as Record<string, unknown>[]) : []
  const volumeSpecs: Array<{ name: string; spec: Record<string, unknown> }> = []
  const volumeMounts: Array<Record<string, unknown>> = []

  for (const volume of volumes) {
    const type = asString(volume.type)
    const name = asString(volume.name)
    const mountPath = asString(volume.mountPath)
    if (!type || !name || !mountPath) continue
    const readOnly = Boolean(volume.readOnly)

    if (type === 'emptyDir') {
      const emptyDir: Record<string, unknown> = {}
      const medium = asString(volume.medium)
      if (medium) emptyDir.medium = medium
      const sizeLimit = asString(volume.sizeLimit)
      if (sizeLimit) emptyDir.sizeLimit = sizeLimit
      volumeSpecs.push({ name, spec: { emptyDir } })
    }

    if (type === 'pvc') {
      const claimName = asString(volume.claimName)
      if (claimName) {
        volumeSpecs.push({ name, spec: { persistentVolumeClaim: { claimName, readOnly } } })
      }
    }

    if (type === 'secret') {
      const secretName = asString(volume.secretName)
      if (secretName) {
        volumeSpecs.push({ name, spec: { secret: { secretName } } })
      }
    }

    volumeMounts.push({ name, mountPath, readOnly })
  }

  return { volumeSpecs, volumeMounts }
}

const createInputFilesConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  agentRun: Record<string, unknown>,
  inputFiles: Array<{ path: string; content: string }>,
  labels: Record<string, string>,
  suffix?: string,
) => {
  if (inputFiles.length === 0) return null
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, suffix ? `inputs-${suffix}` : 'inputs')
  const data: Record<string, string> = {}
  inputFiles.forEach((file, index) => {
    data[`input-${index}`] = file.content
  })
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configName,
      namespace,
      labels: { ...labels },
      ...(uid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid,
              },
            ],
          }
        : {}),
    },
    data,
  }
  await kube.apply(configMap)
  return { name: configName, files: inputFiles }
}

const createRunSpecConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  agentRun: Record<string, unknown>,
  runSpec: Record<string, unknown>,
  labels: Record<string, string>,
  suffix?: string,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, suffix ? `spec-${suffix}` : 'spec')
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configName,
      namespace,
      labels: { ...labels },
      ...(uid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid,
              },
            ],
          }
        : {}),
    },
    data: {
      'run.json': JSON.stringify(runSpec, null, 2),
    },
  }
  await kube.apply(configMap)
  return configName
}

const submitJobRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown>,
  provider: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
  namespace: string,
  workloadImage: string,
  runtimeType: 'job' | 'workflow',
  options: {
    nameSuffix?: string
    labels?: Record<string, string>
    workload?: Record<string, unknown>
    parameters?: Record<string, string>
    runtimeConfig?: Record<string, unknown>
  } = {},
) => {
  const workload = options.workload ?? asRecord(readNested(agentRun, ['spec', 'workload'])) ?? {}
  if (!workloadImage) {
    throw new Error('spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime')
  }

  const providerSpec = asRecord(provider.spec) ?? {}
  const inputFiles = Array.isArray(providerSpec.inputFiles) ? providerSpec.inputFiles : []
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const binary = asString(providerSpec.binary) ?? '/usr/local/bin/agent-runner'
  const providerName = asString(readNested(provider, ['metadata', 'name'])) ?? ''

  const parameters = options.parameters ?? resolveParameters(agentRun)
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory)

  const argsTemplate = Array.isArray(providerSpec.argsTemplate) ? providerSpec.argsTemplate : []
  const args = argsTemplate.map((arg) => renderTemplate(String(arg), context))

  const envTemplate = asRecord(providerSpec.envTemplate) ?? {}
  const env = Object.entries(envTemplate).map(([key, value]) => ({
    name: key,
    value: renderTemplate(String(value), context),
  }))
  if (providerName) {
    env.push({ name: 'AGENT_PROVIDER', value: providerName })
  }

  const runSpec = buildRunSpec(
    agentRun,
    agent,
    implementation,
    parameters,
    memory,
    Array.isArray(outputArtifacts) ? outputArtifacts : [],
  )

  const inputEntries = inputFiles
    .map((file: Record<string, unknown>) => ({
      path: asString(file.path) ?? '',
      content: asString(file.content) ?? '',
    }))
    .filter((file) => file.path && file.content)

  const runtimeConfig = options.runtimeConfig ?? asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const serviceAccount = asString(runtimeConfig.serviceAccount)
  const ttlSeconds = runtimeConfig.ttlSecondsAfterFinished

  const metadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'agentrun'
  const runUid = asString(metadata.uid)
  const jobName = makeName(runName, options.nameSuffix ?? 'job')
  const agentName = asString(readNested(agent, ['metadata', 'name']))
  const implName = asString(readNested(agentRun, ['spec', 'implementationSpecRef', 'name']))
  const labels: Record<string, string> = {
    'agents.proompteng.ai/agent-run': runName,
  }
  if (agentName) {
    labels['agents.proompteng.ai/agent'] = normalizeLabelValue(agentName)
  }
  if (providerName) {
    labels['agents.proompteng.ai/provider'] = normalizeLabelValue(providerName)
  }
  if (implName) {
    labels['agents.proompteng.ai/implementation'] = normalizeLabelValue(implName)
  }

  const mergedLabels = { ...labels, ...(options.labels ?? {}) }
  const inputsConfig = await createInputFilesConfigMap(
    kube,
    namespace,
    agentRun,
    inputEntries,
    mergedLabels,
    options.nameSuffix,
  )
  const specConfigName = await createRunSpecConfigMap(
    kube,
    namespace,
    agentRun,
    runSpec,
    mergedLabels,
    options.nameSuffix,
  )

  const { volumeSpecs, volumeMounts } = buildVolumeSpecs(workload)

  const configVolumeMounts = [] as Record<string, unknown>[]
  const volumes = [...volumeSpecs]

  if (inputsConfig) {
    const volumeName = makeName(inputsConfig.name, 'vol')
    volumes.push({ name: volumeName, spec: { configMap: { name: inputsConfig.name } } })
    inputsConfig.files.forEach((file, index) => {
      configVolumeMounts.push({
        name: volumeName,
        mountPath: file.path,
        subPath: `input-${index}`,
      })
    })
  }

  const specVolumeName = makeName(specConfigName, 'vol')
  volumes.push({ name: specVolumeName, spec: { configMap: { name: specConfigName } } })
  configVolumeMounts.push({ name: specVolumeName, mountPath: '/workspace/run.json', subPath: 'run.json' })

  const jobResource = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: mergedLabels,
      ...(runUid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid: runUid,
              },
            ],
          }
        : {}),
    },
    spec: {
      ttlSecondsAfterFinished: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
      template: {
        metadata: {
          labels: mergedLabels,
        },
        spec: {
          serviceAccountName: serviceAccount ?? undefined,
          restartPolicy: 'Never',
          containers: [
            {
              name: 'agent-runner',
              image: workloadImage,
              command: [binary],
              args,
              env: [{ name: 'AGENT_RUN_SPEC', value: '/workspace/run.json' }, ...env],
              resources: buildJobResources(workload),
              volumeMounts: [...volumeMounts, ...configVolumeMounts],
            },
          ],
          volumes: volumes.map((volume) => ({ name: volume.name, ...volume.spec })),
        },
      },
    },
  }

  const applied = await kube.apply(jobResource)
  return buildRuntimeRef(runtimeType, jobName, namespace, { uid: asString(readNested(applied, ['metadata', 'uid'])) })
}

const submitCustomRun = async (
  agentRun: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
) => {
  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const endpoint = asString(runtimeConfig.endpoint)
  if (!endpoint) {
    throw new Error('spec.runtime.config.endpoint is required for custom runtime')
  }
  const payload = runtimeConfig.payload ?? {
    agentRun,
    implementation,
    memory,
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`custom runtime POST failed: ${response.status} ${response.statusText}`)
  }
  let data: Record<string, unknown> | null = null
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    data = null
  }
  return buildRuntimeRef('custom', endpoint, 'external', { response: data ?? {} })
}

const submitTemporalRun = async (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown>,
  provider: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
) => {
  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const workflowType = asString(runtimeConfig.workflowType)
  const taskQueue = asString(runtimeConfig.taskQueue)
  if (!workflowType) {
    throw new Error('spec.runtime.config.workflowType is required for temporal runtime')
  }
  if (!taskQueue) {
    throw new Error('spec.runtime.config.taskQueue is required for temporal runtime')
  }

  const namespace = asString(runtimeConfig.namespace) ?? undefined
  const workflowId =
    asString(runtimeConfig.workflowId) ??
    asString(readNested(agentRun, ['spec', 'idempotencyKey'])) ??
    makeName(asString(readNested(agentRun, ['metadata', 'name'])) ?? 'agentrun', 'temporal')

  const timeouts = asRecord(runtimeConfig.timeouts) ?? {}

  const parameters = resolveParameters(agentRun)
  const providerSpec = asRecord(provider.spec) ?? {}
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const payload = buildRunSpec(agentRun, agent, implementation, parameters, memory, outputArtifacts)

  const client = await getTemporalClient()
  const result = await client.workflow.start({
    workflowId,
    workflowType,
    taskQueue,
    namespace,
    args: [payload],
    workflowExecutionTimeoutMs: parseOptionalNumber(timeouts.workflowExecutionTimeoutMs),
    workflowRunTimeoutMs: parseOptionalNumber(timeouts.workflowRunTimeoutMs),
    workflowTaskTimeoutMs: parseOptionalNumber(timeouts.workflowTaskTimeoutMs),
  })

  return buildRuntimeRef('temporal', result.workflowId, result.namespace, {
    workflowId: result.workflowId,
    runId: result.runId,
    taskQueue,
  })
}

const reconcileTemporalRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  runtimeRef: RuntimeRef,
) => {
  const workflowId = asString(runtimeRef.workflowId) ?? asString(runtimeRef.name)
  if (!workflowId) return
  const client = await getTemporalClient()
  const handle = {
    workflowId,
    runId: asString(runtimeRef.runId) ?? undefined,
    namespace: asString(runtimeRef.namespace) ?? undefined,
  }
  try {
    await client.workflow.result(handle, temporalCallOptions({ timeoutMs: 500 }))
    const conditions = buildConditions(agentRun)
    const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
    await setStatus(kube, agentRun, {
      observedGeneration: asRecord(agentRun.metadata)?.generation ?? 0,
      phase: 'Succeeded',
      finishedAt: nowIso(),
      runtimeRef,
      conditions: updated,
    })
  } catch (error) {
    const outcome = classifyTemporalResult(error)
    if (outcome.kind === 'pending') {
      return
    }
    const conditions = buildConditions(agentRun)
    const updated = upsertCondition(conditions, {
      type: 'Failed',
      status: 'True',
      reason: outcome.reason,
      message: outcome.message,
    })
    await setStatus(kube, agentRun, {
      observedGeneration: asRecord(agentRun.metadata)?.generation ?? 0,
      phase: outcome.kind === 'cancelled' ? 'Cancelled' : 'Failed',
      finishedAt: nowIso(),
      runtimeRef,
      conditions: updated,
    })
  }
}

const loadWorkflowDependencies = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  runtimeConfig: Record<string, unknown>,
) => {
  const spec = asRecord(agentRun.spec) ?? {}
  const agentName = asString(readNested(spec, ['agentRef', 'name']))
  if (!agentName) {
    return {
      ok: false as const,
      reason: 'MissingAgent',
      message: 'spec.agentRef.name is required',
    }
  }
  const agent = await kube.get(RESOURCE_MAP.Agent, agentName, namespace)
  if (!agent) {
    return {
      ok: false as const,
      reason: 'MissingAgent',
      message: `agent ${agentName} not found`,
    }
  }

  const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
  const provider = providerName ? await kube.get(RESOURCE_MAP.AgentProvider, providerName, namespace) : null
  if (!provider) {
    return {
      ok: false as const,
      reason: 'MissingProvider',
      message: `agent provider ${providerName ?? 'unknown'} not found`,
    }
  }

  let implResource = resolveImplementation(agentRun)
  if (!implResource) {
    const implRefName = asString(readNested(spec, ['implementationSpecRef', 'name']))
    if (implRefName) {
      const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, implRefName, namespace)
      implResource = asRecord(impl?.spec) ?? null
    }
  }
  if (!implResource) {
    return {
      ok: false as const,
      reason: 'MissingImplementation',
      message: 'implementationSpecRef or implementation.inline is required',
    }
  }

  const memory = resolveMemory(agentRun, agent, memories)
  const runMemoryRef = asString(readNested(spec, ['memoryRef', 'name']))
  const agentMemoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
  if ((runMemoryRef || agentMemoryRef) && !memory) {
    const missingName = runMemoryRef || agentMemoryRef || 'unknown'
    return {
      ok: false as const,
      reason: 'MissingMemory',
      message: `memory ${missingName} not found`,
    }
  }

  const security = asRecord(readNested(agent, ['spec', 'security'])) ?? {}
  const allowedSecrets = parseStringList(security.allowedSecrets)
  const allowedServiceAccounts = parseStringList(security.allowedServiceAccounts)
  const runSecrets = parseStringList(spec.secrets)

  if (allowedSecrets.length > 0) {
    const forbidden = runSecrets.filter((secret) => !allowedSecrets.includes(secret))
    if (forbidden.length > 0) {
      return {
        ok: false as const,
        reason: 'SecretNotAllowed',
        message: `spec.secrets contains disallowed entries: ${forbidden.join(', ')}`,
      }
    }
  }

  const memorySecretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
  if (memorySecretName) {
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(memorySecretName)) {
      return {
        ok: false as const,
        reason: 'SecretNotAllowed',
        message: `memory secret ${memorySecretName} is not allowlisted by the Agent`,
      }
    }
    if (runSecrets.length > 0 && !runSecrets.includes(memorySecretName)) {
      return {
        ok: false as const,
        reason: 'SecretNotAllowed',
        message: `memory secret ${memorySecretName} is not included in spec.secrets`,
      }
    }
  }

  if (allowedServiceAccounts.length > 0) {
    const rawServiceAccount = asString(runtimeConfig.serviceAccount)
    const effectiveServiceAccount = rawServiceAccount || 'default'
    if (!allowedServiceAccounts.includes(effectiveServiceAccount)) {
      return {
        ok: false as const,
        reason: 'ServiceAccountNotAllowed',
        message: `serviceAccount ${effectiveServiceAccount} is not allowlisted`,
      }
    }
  }

  return {
    ok: true as const,
    agent,
    provider,
    implementation: implResource,
    memory,
  }
}

const resolveWorkflowStepImplementation = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  step: WorkflowStepSpec,
  fallback: Record<string, unknown>,
) => {
  if (step.implementationInline) return step.implementationInline
  if (step.implementationSpecRefName) {
    const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, step.implementationSpecRefName, namespace)
    return asRecord(impl?.spec) ?? null
  }
  const inline = resolveImplementation(agentRun)
  if (inline) return inline
  return fallback
}

const reconcileWorkflowRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  options: { initialSubmit?: boolean } = {},
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'agentrun'
  const status = asRecord(agentRun.status) ?? {}
  const observedGeneration = asRecord(agentRun.metadata)?.generation ?? 0
  const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const workflowSteps = parseWorkflowSteps(agentRun)
  const workflowValidation = validateWorkflowSteps(workflowSteps)
  const conditions = buildConditions(agentRun)

  if (!workflowValidation.ok) {
    const updated = upsertCondition(conditions, {
      type: 'InvalidSpec',
      status: 'True',
      reason: workflowValidation.reason,
      message: workflowValidation.message,
    })
    await setStatus(kube, agentRun, {
      observedGeneration,
      phase: 'Failed',
      finishedAt: nowIso(),
      conditions: updated,
    })
    return
  }

  const dependencies = await loadWorkflowDependencies(kube, agentRun, namespace, memories, runtimeConfig)
  if (!dependencies.ok) {
    const updated = upsertCondition(conditions, {
      type: 'InvalidSpec',
      status: 'True',
      reason: dependencies.reason,
      message: dependencies.message,
    })
    await setStatus(kube, agentRun, {
      observedGeneration,
      phase: 'Failed',
      finishedAt: nowIso(),
      conditions: updated,
    })
    return
  }

  const baseParameters = resolveParameters(agentRun)
  const baseWorkload = asRecord(readNested(agentRun, ['spec', 'workload'])) ?? {}
  const workflowStatus = normalizeWorkflowStatus(asRecord(status.workflow) ?? null, workflowSteps)
  let runtimeRefUpdate: RuntimeRef | null = null
  let workflowFailure: { reason: string; message: string } | null = null
  let workflowRunning = false
  const now = Date.now()

  for (let index = 0; index < workflowSteps.length; index += 1) {
    const stepSpec = workflowSteps[index]
    const stepStatus = workflowStatus.steps[index]
    if (stepStatus.phase === 'Succeeded') {
      continue
    }
    const maxAttempts = stepSpec.retries + 1

    if (stepStatus.phase === 'Failed') {
      workflowFailure = {
        reason: 'WorkflowStepFailed',
        message: `workflow step ${stepSpec.name} failed`,
      }
      break
    }

    if (stepStatus.phase === 'Retrying' && !shouldRetryStep(stepStatus, now)) {
      workflowRunning = true
      runtimeRefUpdate = buildRuntimeRef('workflow', asString(stepStatus.jobRef?.name) ?? '', namespace, {
        runName,
        stepName: stepSpec.name,
      })
      break
    }

    if (stepStatus.phase === 'Pending' || stepStatus.phase === 'Retrying') {
      const attempt = stepStatus.attempt + 1
      if (attempt > maxAttempts) {
        setWorkflowStepPhase(stepStatus, 'Failed', 'Retry limit exceeded')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'WorkflowStepRetriesExhausted',
          message: `workflow step ${stepSpec.name} exceeded retry limit`,
        }
        break
      }

      const implementation = await resolveWorkflowStepImplementation(
        kube,
        agentRun,
        namespace,
        stepSpec,
        dependencies.implementation,
      )
      if (!implementation) {
        setWorkflowStepPhase(stepStatus, 'Failed', 'Implementation not found')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'MissingImplementation',
          message: `workflow step ${stepSpec.name} implementation not found`,
        }
        break
      }

      const stepWorkload = stepSpec.workload ?? baseWorkload
      const workloadImage = resolveJobImage(stepWorkload)
      if (!workloadImage) {
        setWorkflowStepPhase(stepStatus, 'Failed', 'Missing workload image')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'MissingWorkloadImage',
          message:
            'spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for workflow runtime',
        }
        break
      }

      const stepParameters = { ...baseParameters, ...stepSpec.parameters }
      const jobSuffix = `step-${index + 1}-attempt-${attempt}`
      const stepLabels = {
        'agents.proompteng.ai/step': normalizeLabelValue(stepSpec.name),
        'agents.proompteng.ai/step-index': String(index + 1),
      }
      const stepRuntimeRef = await submitJobRun(
        kube,
        agentRun,
        dependencies.agent,
        dependencies.provider,
        implementation,
        dependencies.memory,
        namespace,
        workloadImage,
        'workflow',
        {
          nameSuffix: jobSuffix,
          labels: stepLabels,
          workload: stepWorkload,
          parameters: stepParameters,
          runtimeConfig,
        },
      )

      stepStatus.attempt = attempt
      stepStatus.startedAt = nowIso()
      stepStatus.finishedAt = undefined
      stepStatus.nextRetryAt = undefined
      stepStatus.jobRef = {
        name: asString(stepRuntimeRef.name) ?? '',
        namespace: asString(stepRuntimeRef.namespace) ?? namespace,
        uid: asString(stepRuntimeRef.uid) ?? undefined,
      }
      setWorkflowStepPhase(stepStatus, 'Running')
      runtimeRefUpdate = buildRuntimeRef('workflow', asString(stepRuntimeRef.name) ?? '', namespace, {
        uid: asString(stepRuntimeRef.uid) ?? undefined,
        runName,
        stepName: stepSpec.name,
      })
      workflowRunning = true
      break
    }

    if (stepStatus.phase === 'Running') {
      const jobName = asString(stepStatus.jobRef?.name) ?? ''
      if (!jobName) {
        setWorkflowStepPhase(stepStatus, 'Failed', 'Job reference missing')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'WorkflowJobMissing',
          message: `workflow step ${stepSpec.name} is missing a job reference`,
        }
        break
      }
      const jobNamespace = asString(stepStatus.jobRef?.namespace) ?? namespace
      const job = await kube.get('job', jobName, jobNamespace)
      if (!job) {
        if (stepStatus.attempt < maxAttempts) {
          setWorkflowStepPhase(stepStatus, 'Retrying', 'Job missing; retrying')
          stepStatus.finishedAt = nowIso()
          stepStatus.nextRetryAt =
            stepSpec.retryBackoffSeconds > 0
              ? new Date(now + stepSpec.retryBackoffSeconds * 1000).toISOString()
              : nowIso()
          workflowRunning = true
          break
        }
        setWorkflowStepPhase(stepStatus, 'Failed', 'Job missing')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'WorkflowJobMissing',
          message: `workflow step ${stepSpec.name} job ${jobName} not found`,
        }
        break
      }
      const jobStatus = asRecord(job.status) ?? {}
      const succeeded = Number(jobStatus.succeeded ?? 0)
      const failed = Number(jobStatus.failed ?? 0)
      if (succeeded > 0) {
        setWorkflowStepPhase(stepStatus, 'Succeeded')
        stepStatus.startedAt = asString(jobStatus.startTime) ?? stepStatus.startedAt ?? undefined
        stepStatus.finishedAt = asString(jobStatus.completionTime) ?? nowIso()
        stepStatus.nextRetryAt = undefined
        continue
      }
      if (failed > 0) {
        if (stepStatus.attempt < maxAttempts) {
          setWorkflowStepPhase(stepStatus, 'Retrying', 'Step failed; retrying')
          stepStatus.finishedAt = nowIso()
          stepStatus.nextRetryAt =
            stepSpec.retryBackoffSeconds > 0
              ? new Date(now + stepSpec.retryBackoffSeconds * 1000).toISOString()
              : nowIso()
          workflowRunning = true
          break
        }
        setWorkflowStepPhase(stepStatus, 'Failed', 'Step failed')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'WorkflowStepFailed',
          message: `workflow step ${stepSpec.name} failed`,
        }
        break
      }
      runtimeRefUpdate = buildRuntimeRef('workflow', jobName, jobNamespace, {
        uid: asString(readNested(job, ['metadata', 'uid'])) ?? undefined,
        runName,
        stepName: stepSpec.name,
      })
      workflowRunning = true
      break
    }
  }

  if (workflowFailure) {
    setWorkflowPhase(workflowStatus, 'Failed')
    const updated = upsertCondition(conditions, {
      type: 'Failed',
      status: 'True',
      reason: workflowFailure.reason,
      message: workflowFailure.message,
    })
    await setStatus(kube, agentRun, {
      observedGeneration,
      phase: 'Failed',
      finishedAt: nowIso(),
      runtimeRef: runtimeRefUpdate ?? parseRuntimeRef(status.runtimeRef) ?? undefined,
      workflow: workflowStatus,
      conditions: updated,
    })
    return
  }

  const allSucceeded = workflowStatus.steps.every((step) => step.phase === 'Succeeded')
  if (allSucceeded) {
    setWorkflowPhase(workflowStatus, 'Succeeded')
    const updated = upsertCondition(conditions, {
      type: 'Succeeded',
      status: 'True',
      reason: 'Completed',
    })
    await setStatus(kube, agentRun, {
      observedGeneration,
      phase: 'Succeeded',
      finishedAt: nowIso(),
      runtimeRef: runtimeRefUpdate ?? parseRuntimeRef(status.runtimeRef) ?? undefined,
      workflow: workflowStatus,
      conditions: updated,
    })
    return
  }

  if (workflowRunning) {
    setWorkflowPhase(workflowStatus, 'Running')
    let updated = conditions
    if (options.initialSubmit) {
      updated = upsertCondition(updated, { type: 'Accepted', status: 'True', reason: 'Submitted' })
    }
    updated = upsertCondition(updated, { type: 'InProgress', status: 'True', reason: 'Running' })
    await setStatus(kube, agentRun, {
      observedGeneration,
      phase: 'Running',
      startedAt: asString(status.startedAt) ?? nowIso(),
      runtimeRef: runtimeRefUpdate ?? parseRuntimeRef(status.runtimeRef) ?? undefined,
      workflow: workflowStatus,
      conditions: updated,
    })
  }
}

const reconcileAgentRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  concurrency: ReturnType<typeof parseConcurrency>,
  inFlight: { total: number; perAgent: Map<string, number> },
  globalInFlight: number,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const name = asString(metadata.name) ?? ''
  const spec = asRecord(agentRun.spec) ?? {}
  const status = asRecord(agentRun.status) ?? {}
  const phase = asString(status.phase) ?? 'Pending'
  const agentName = asString(readNested(spec, ['agentRef', 'name']))
  const finalizer = 'agents.proompteng.ai/runtime-cleanup'
  const finalizers = Array.isArray(metadata.finalizers)
    ? metadata.finalizers.filter((item): item is string => typeof item === 'string')
    : []
  const hasFinalizer = finalizers.includes(finalizer)
  const deleting = Boolean(metadata.deletionTimestamp)

  const conditions = buildConditions(agentRun)
  const observedGeneration = asRecord(agentRun.metadata)?.generation ?? 0
  const runtimeType = asString(readNested(spec, ['runtime', 'type']))
  const runtimeConfig = asRecord(readNested(spec, ['runtime', 'config'])) ?? {}
  const workload = asRecord(readNested(spec, ['workload'])) ?? {}
  let workloadImage: string | null = null

  if (deleting) {
    if (hasFinalizer) {
      const runtimeRef = parseRuntimeRef(status.runtimeRef)
      if (runtimeRef) {
        try {
          await cancelRuntime(runtimeRef, namespace)
        } catch (error) {
          console.warn('[jangar] runtime cleanup failed', error)
        }
      }
      await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
        metadata: { finalizers: finalizers.filter((item) => item !== finalizer) },
      })
    }
    return
  }

  if (!hasFinalizer) {
    await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
      metadata: { finalizers: [...finalizers, finalizer] },
    })
    return
  }

  const runtimeRef = parseRuntimeRef(status.runtimeRef)
  const shouldSubmit = !runtimeRef && phase !== 'Running' && phase !== 'Succeeded' && phase !== 'Failed'

  if (shouldSubmit && agentName && (inFlight.perAgent.get(agentName) ?? 0) >= concurrency.perAgent) {
    const updated = upsertCondition(conditions, {
      type: 'Blocked',
      status: 'True',
      reason: 'ConcurrencyLimit',
      message: `Agent ${agentName} reached concurrency limit`,
    })
    await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
    return
  }

  if (shouldSubmit && inFlight.total >= concurrency.perNamespace) {
    const updated = upsertCondition(conditions, {
      type: 'Blocked',
      status: 'True',
      reason: 'ConcurrencyLimit',
      message: `Namespace ${namespace} reached concurrency limit`,
    })
    await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
    return
  }

  if (shouldSubmit && globalInFlight >= concurrency.cluster) {
    const updated = upsertCondition(conditions, {
      type: 'Blocked',
      status: 'True',
      reason: 'ConcurrencyLimit',
      message: 'Cluster concurrency limit reached',
    })
    await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
    return
  }

  if (shouldSubmit) {
    if (!runtimeType) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingRuntime',
        message: 'spec.runtime.type is required',
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const parameterCheck = validateParameters(asRecord(spec.parameters) ?? {})
    if (!parameterCheck.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: parameterCheck.reason,
        message: parameterCheck.message,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    if (runtimeType === 'job') {
      workloadImage = resolveJobImage(workload)
      if (!workloadImage) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingWorkloadImage',
          message: 'spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (runtimeType === 'custom') {
      const endpoint = asString(runtimeConfig.endpoint)
      if (!endpoint) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingEndpoint',
          message: 'spec.runtime.config.endpoint is required for custom runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (runtimeType === 'temporal') {
      const workflowType = asString(runtimeConfig.workflowType)
      const taskQueue = asString(runtimeConfig.taskQueue)
      if (!workflowType || !taskQueue) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingTemporalConfig',
          message:
            'spec.runtime.config.workflowType and spec.runtime.config.taskQueue are required for temporal runtime',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (runtimeType === 'workflow') {
      await reconcileWorkflowRun(kube, agentRun, namespace, memories, { initialSubmit: true })
      return
    }

    const agent = agentName ? await kube.get(RESOURCE_MAP.Agent, agentName, namespace) : null
    if (!agent) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingAgent',
        message: `agent ${agentName} not found`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
    const provider = providerName ? await kube.get(RESOURCE_MAP.AgentProvider, providerName, namespace) : null
    if (!provider) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingProvider',
        message: `agent provider ${providerName ?? 'unknown'} not found`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const security = asRecord(readNested(agent, ['spec', 'security'])) ?? {}
    const allowedSecrets = parseStringList(security.allowedSecrets)
    const allowedServiceAccounts = parseStringList(security.allowedServiceAccounts)
    const runSecrets = parseStringList(spec.secrets)

    if (allowedSecrets.length > 0) {
      const forbidden = runSecrets.filter((secret) => !allowedSecrets.includes(secret))
      if (forbidden.length > 0) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretNotAllowed',
          message: `spec.secrets contains disallowed entries: ${forbidden.join(', ')}`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    if (allowedServiceAccounts.length > 0 && (runtimeType === 'job' || runtimeType === 'workflow')) {
      const rawServiceAccount = asString(runtimeConfig.serviceAccount)
      const effectiveServiceAccount = rawServiceAccount || 'default'
      if (!allowedServiceAccounts.includes(effectiveServiceAccount)) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'ServiceAccountNotAllowed',
          message: `serviceAccount ${effectiveServiceAccount} is not allowlisted`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    const implementation = resolveImplementation(agentRun)
    let implResource = implementation
    if (!implementation) {
      const implRefName = asString(readNested(spec, ['implementationSpecRef', 'name']))
      if (implRefName) {
        const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, implRefName, namespace)
        implResource = asRecord(impl?.spec) ?? null
      }
    }

    if (!implResource) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingImplementation',
        message: 'implementationSpecRef or implementation.inline is required',
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const memory = resolveMemory(agentRun, agent, memories)
    const runMemoryRef = asString(readNested(spec, ['memoryRef', 'name']))
    const agentMemoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
    if ((runMemoryRef || agentMemoryRef) && !memory) {
      const missingName = runMemoryRef || agentMemoryRef || 'unknown'
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingMemory',
        message: `memory ${missingName} not found`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }
    const memorySecretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
    if (memorySecretName) {
      if (allowedSecrets.length > 0 && !allowedSecrets.includes(memorySecretName)) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretNotAllowed',
          message: `memory secret ${memorySecretName} is not allowlisted by the Agent`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
      if (runSecrets.length > 0 && !runSecrets.includes(memorySecretName)) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretNotAllowed',
          message: `memory secret ${memorySecretName} is not included in spec.secrets`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
    }

    let newRuntimeRef: RuntimeRef | null = null
    try {
      if (runtimeType === 'job') {
        newRuntimeRef = await submitJobRun(
          kube,
          agentRun,
          agent,
          provider,
          implResource,
          memory,
          namespace,
          workloadImage ?? '',
          runtimeType,
        )
      } else if (runtimeType === 'custom') {
        newRuntimeRef = await submitCustomRun(agentRun, implResource, memory)
      } else if (runtimeType === 'temporal') {
        newRuntimeRef = await submitTemporalRun(agentRun, agent, provider, implResource, memory)
      } else {
        throw new Error(`unknown runtime type: ${runtimeType}`)
      }

      const updated = upsertCondition(conditions, {
        type: 'Accepted',
        status: 'True',
        reason: 'Submitted',
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        runtimeRef: newRuntimeRef,
        phase: 'Running',
        startedAt: nowIso(),
        conditions: upsertCondition(updated, { type: 'InProgress', status: 'True', reason: 'Running' }),
      })
    } catch (error) {
      const updated = upsertCondition(conditions, {
        type: 'Failed',
        status: 'True',
        reason: 'SubmitFailed',
        message: error instanceof Error ? error.message : String(error),
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: nowIso(),
        conditions: updated,
      })
    }
    return
  }

  if (phase !== 'Running') return

  if (runtimeType === 'workflow' || runtimeRef?.type === 'workflow') {
    await reconcileWorkflowRun(kube, agentRun, namespace, memories)
    return
  }

  if (!runtimeRef) return

  if (runtimeRef.type === 'job') {
    const job = await kube.get('job', asString(runtimeRef.name) ?? '', asString(runtimeRef.namespace) ?? namespace)
    if (!job) return
    const jobStatus = asRecord(job.status) ?? {}
    const succeeded = Number(jobStatus.succeeded ?? 0)
    const failed = Number(jobStatus.failed ?? 0)
    if (succeeded > 0) {
      const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Succeeded',
        startedAt: asString(jobStatus.startTime) ?? asString(status.startedAt) ?? undefined,
        finishedAt: asString(jobStatus.completionTime) ?? nowIso(),
        runtimeRef,
        conditions: updated,
      })
    } else if (failed > 0) {
      const updated = upsertCondition(conditions, {
        type: 'Failed',
        status: 'True',
        reason: 'JobFailed',
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: nowIso(),
        runtimeRef,
        conditions: updated,
      })
    }
  }

  if (runtimeRef.type === 'temporal') {
    await reconcileTemporalRun(kube, agentRun, runtimeRef)
  }
}

const reconcileNamespaceSnapshot = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  snapshot: ReturnType<typeof snapshotNamespace>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const { agents, providers, specs, memories, runs } = snapshot

  for (const memory of memories) {
    await reconcileMemory(kube, memory, namespace)
  }

  for (const agent of agents) {
    await reconcileAgent(kube, agent, namespace, providers, memories)
  }

  for (const provider of providers) {
    await reconcileAgentProvider(kube, provider)
  }

  for (const spec of specs) {
    await reconcileImplementationSpec(kube, spec)
  }

  const counts = buildInFlightCounts(state, namespace)
  const inFlight = {
    total: counts.total,
    perAgent: counts.perAgent,
  }

  for (const run of runs) {
    await reconcileAgentRun(kube, run, namespace, memories, concurrency, inFlight, counts.cluster)
  }
}

const reconcileRunWithState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  run: Record<string, unknown>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const snapshot = snapshotNamespace(ensureNamespaceState(state, namespace))
  const counts = buildInFlightCounts(state, namespace)
  const inFlight = {
    total: counts.total,
    perAgent: counts.perAgent,
  }
  await reconcileAgentRun(kube, run, namespace, snapshot.memories, concurrency, inFlight, counts.cluster)
}

const reconcileNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const snapshot = snapshotNamespace(ensureNamespaceState(state, namespace))
  await reconcileNamespaceSnapshot(kube, namespace, snapshot, state, concurrency)
}

const _reconcileAll = async (
  kube: ReturnType<typeof createKubernetesClient>,
  state: ControllerState,
  namespaces: string[],
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  if (reconciling) return
  reconciling = true
  try {
    for (const namespace of namespaces) {
      await reconcileNamespaceState(kube, namespace, state, concurrency)
    }
  } catch (error) {
    console.warn('[jangar] agents controller failed', error)
  } finally {
    reconciling = false
  }
}

const seedNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const memories = listItems(await kube.list(RESOURCE_MAP.Memory, namespace))
  const agents = listItems(await kube.list(RESOURCE_MAP.Agent, namespace))
  const specs = listItems(await kube.list(RESOURCE_MAP.ImplementationSpec, namespace))
  const providers = listItems(await kube.list(RESOURCE_MAP.AgentProvider, namespace))
  const runs = listItems(await kube.list(RESOURCE_MAP.AgentRun, namespace))

  for (const resource of memories) updateStateMap(nsState.memories, 'ADDED', resource)
  for (const resource of agents) updateStateMap(nsState.agents, 'ADDED', resource)
  for (const resource of specs) updateStateMap(nsState.specs, 'ADDED', resource)
  for (const resource of providers) updateStateMap(nsState.providers, 'ADDED', resource)
  for (const resource of runs) updateStateMap(nsState.runs, 'ADDED', resource)

  await reconcileNamespaceSnapshot(kube, namespace, snapshotNamespace(nsState), state, concurrency)
}

const startNamespaceWatches = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const enqueueFull = () =>
    enqueueNamespaceTask(namespace, () => reconcileNamespaceState(kube, namespace, state, concurrency))

  const handleAgentRunEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.runs, event.type, resource)
    if (event.type === 'DELETED') return
    enqueueNamespaceTask(namespace, () => reconcileRunWithState(kube, namespace, resource, state, concurrency))
  }

  const handleAgentEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.agents, event.type, resource)
    enqueueFull()
  }

  const handleProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.providers, event.type, resource)
    enqueueFull()
  }

  const handleSpecEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.specs, event.type, resource)
    enqueueFull()
  }

  const handleMemoryEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.memories, event.type, resource)
    enqueueFull()
  }

  const handleJobEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const runName = asString(readNested(resource, ['metadata', 'labels', 'agents.proompteng.ai/agent-run']))
    if (!runName) return
    enqueueNamespaceTask(namespace, async () => {
      const existing = nsState.runs.get(runName)
      const run = existing ?? (await kube.get(RESOURCE_MAP.AgentRun, runName, namespace))
      if (!run) return
      nsState.runs.set(runName, run)
      await reconcileRunWithState(kube, namespace, run, state, concurrency)
    })
  }

  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentRun,
      namespace,
      onEvent: handleAgentRunEvent,
      onError: (error) => console.warn('[jangar] agent run watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Agent,
      namespace,
      onEvent: handleAgentEvent,
      onError: (error) => console.warn('[jangar] agent watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentProvider,
      namespace,
      onEvent: handleProviderEvent,
      onError: (error) => console.warn('[jangar] provider watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSpec,
      namespace,
      onEvent: handleSpecEvent,
      onError: (error) => console.warn('[jangar] implementation spec watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Memory,
      namespace,
      onEvent: handleMemoryEvent,
      onError: (error) => console.warn('[jangar] memory watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: 'job',
      namespace,
      labelSelector: 'agents.proompteng.ai/agent-run',
      onEvent: handleJobEvent,
      onError: (error) => console.warn('[jangar] agent job watch failed', error),
    }),
  )
}

export const startAgentsController = async () => {
  if (started || !shouldStart()) return
  const crdsReady = await checkCrds()
  if (!crdsReady.ok) {
    console.error('[jangar] agents controller will not start without CRDs')
    return
  }
  try {
    const namespaces = await resolveNamespaces()
    const kube = createKubernetesClient()
    const concurrency = parseConcurrency()
    const state: ControllerState = { namespaces: new Map() }
    _controllerState = state
    for (const namespace of namespaces) {
      await seedNamespaceState(kube, namespace, state, concurrency)
    }
    for (const namespace of namespaces) {
      startNamespaceWatches(kube, namespace, state, concurrency)
    }
    started = true
  } catch (error) {
    console.error('[jangar] agents controller failed to start', error)
  }
}

export const stopAgentsController = () => {
  for (const handle of watchHandles) {
    handle.stop()
  }
  watchHandles = []
  _controllerState = null
  namespaceQueues.clear()
  started = false
}

export const __test = {
  checkCrds,
  reconcileAgentRun,
  reconcileMemory,
  resolveJobImage,
}

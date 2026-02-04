import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, createSign } from 'node:crypto'

import { createTemporalClient, loadTemporalConfig, temporalCallOptions } from '@proompteng/temporal-bun-sdk'

import { startResourceWatch } from '~/server/kube-watch'
import { assertClusterScopedForWildcard } from '~/server/namespace-scope'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { shouldApplyStatus } from '~/server/status-utils'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_CONCURRENCY = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
}
const DEFAULT_AGENTRUN_RETENTION_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const PARAMETERS_MAX_ENTRIES = 100
const PARAMETERS_MAX_VALUE_BYTES = 2048
const DEFAULT_AUTH_SECRET_KEY = 'auth.json'
const DEFAULT_AUTH_SECRET_MOUNT_PATH = '/root/.codex'
const DEFAULT_GITHUB_APP_TOKEN_TTL_SECONDS = 3600
const DEFAULT_RUNNER_JOB_TTL_SECONDS = 600
const MIN_RUNNER_JOB_TTL_SECONDS = 30
const MAX_RUNNER_JOB_TTL_SECONDS = 7 * 24 * 60 * 60

const BASE_REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
]
const VCS_PROVIDER_CRD = 'versioncontrolproviders.agents.proompteng.ai'

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const isVcsProvidersEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED, true)

const resolveRequiredCrds = () => {
  if (!isVcsProvidersEnabled()) return BASE_REQUIRED_CRDS
  return [...BASE_REQUIRED_CRDS.slice(0, 5), VCS_PROVIDER_CRD, ...BASE_REQUIRED_CRDS.slice(5)]
}

type CrdCheckState = {
  ok: boolean
  missing: string[]
  checkedAt: string
}

type ControllerHealthState = {
  started: boolean
  crdCheckState: CrdCheckState | null
}

const globalState = globalThis as typeof globalThis & {
  __jangarAgentsControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__jangarAgentsControllerState) return globalState.__jangarAgentsControllerState
  const initial = { started: false, crdCheckState: null }
  globalState.__jangarAgentsControllerState = initial
  return initial
})()

let _crdCheckState: CrdCheckState | null = controllerState.crdCheckState

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

type RuntimeRef = Record<string, unknown>

type VcsMode = 'read-write' | 'read-only' | 'none'
type VcsAuthMethod = 'token' | 'app' | 'ssh' | 'none'
type VcsTokenType = 'pat' | 'fine_grained' | 'api_token' | 'access_token'

type VcsAuthAdapter = {
  provider: string
  allowedMethods: VcsAuthMethod[]
  tokenTypes?: VcsTokenType[]
  deprecatedTokenTypes?: VcsTokenType[]
  defaultUsername?: string
  defaultTokenType?: VcsTokenType
}

type VcsRuntimeConfig = {
  env: Array<Record<string, unknown>>
  volumes: Array<{ name: string; spec: Record<string, unknown> }>
  volumeMounts: Array<Record<string, unknown>>
}

type VcsResolution = {
  ok: boolean
  skip: boolean
  reason?: string
  message?: string
  mode: VcsMode
  status?: Record<string, unknown> | null
  context?: Record<string, unknown> | null
  runtime?: VcsRuntimeConfig | null
  requiredSecrets: string[]
}

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
  sources: Map<string, Record<string, unknown>>
  vcsProviders: Map<string, Record<string, unknown>>
  memories: Map<string, Record<string, unknown>>
  runs: Map<string, Record<string, unknown>>
}

type ControllerState = {
  namespaces: Map<string, NamespaceState>
}

let started = controllerState.started
let reconciling = false
let temporalClientPromise: ReturnType<typeof createTemporalClient> | null = null
let watchHandles: Array<{ stop: () => void }> = []
let _controllerState: ControllerState | null = null
const namespaceQueues = new Map<string, Promise<void>>()
const githubAppTokenCache = new Map<string, { token: string; expiresAt: number }>()

const nowIso = () => new Date().toISOString()

const hasJobCondition = (job: Record<string, unknown>, conditionType: string) => {
  const status = asRecord(job.status) ?? {}
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  return conditions.some((entry) => {
    const record = asRecord(entry)
    if (!record) return false
    return asString(record.type) === conditionType && asString(record.status) === 'True'
  })
}

const isJobComplete = (job: Record<string, unknown>) => hasJobCondition(job, 'Complete')

const isJobFailed = (job: Record<string, unknown>) => hasJobCondition(job, 'Failed')

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
  const namespaces = list.length > 0 ? list : DEFAULT_NAMESPACES
  assertClusterScopedForWildcard(namespaces, 'agents controller')
  return namespaces
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
  for (const name of resolveRequiredCrds()) {
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
  _crdCheckState = state
  controllerState.crdCheckState = state
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
  started: controllerState.started,
  crdsReady: controllerState.crdCheckState?.ok ?? null,
  missingCrds: controllerState.crdCheckState?.missing ?? [],
  lastCheckedAt: controllerState.crdCheckState?.checkedAt ?? null,
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
    const reason = asString(record.reason)?.trim() || 'Reconciled'
    const message = asString(record.message) ?? ''
    output.push({
      type,
      status: status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown',
      reason,
      message,
      lastTransitionTime: asString(record.lastTransitionTime) ?? nowIso(),
    })
  }
  return output
}

const normalizeConditionUpdate = (update: Omit<Condition, 'lastTransitionTime'>) => ({
  ...update,
  reason: update.reason?.trim() || 'Reconciled',
  message: update.message ?? '',
})

const upsertCondition = (conditions: Condition[], update: Omit<Condition, 'lastTransitionTime'>): Condition[] => {
  const next = [...conditions]
  const normalized = normalizeConditionUpdate(update)
  const index = next.findIndex((cond) => cond.type === normalized.type)
  if (index === -1) {
    next.push({ ...normalized, lastTransitionTime: nowIso() })
    return next
  }
  const existing = next[index]
  if (
    existing.status !== normalized.status ||
    existing.reason !== normalized.reason ||
    existing.message !== normalized.message
  ) {
    next[index] = { ...existing, ...normalized, lastTransitionTime: nowIso() }
  }
  return next
}

const normalizeConditionStatus = (status?: string): Condition['status'] =>
  status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown'

const findCondition = (conditions: Condition[], types: string[]) =>
  conditions.find((condition) => types.includes(condition.type))

const phaseCategory = (phase: string | null) => (phase ?? '').toLowerCase()

const deriveStandardConditionUpdates = (conditions: Condition[], phase: string | null) => {
  const normalizedPhase = phaseCategory(phase)
  const failureCondition = findCondition(conditions, ['Failed', 'InvalidSpec', 'Unreachable', 'Cancelled'])
  const runningCondition = findCondition(conditions, ['Running', 'InProgress', 'Progressing'])
  const successCondition = findCondition(conditions, ['Succeeded', 'Completed'])
  const readyCondition = findCondition(conditions, ['Ready'])

  const phaseReady = ['ready', 'active', 'succeeded', 'success', 'completed'].includes(normalizedPhase)
  const phaseProgressing = ['pending', 'running', 'progressing', 'inprogress', 'queued'].includes(normalizedPhase)
  const phaseDegraded = ['failed', 'invalid', 'cancelled', 'error'].includes(normalizedPhase)

  let readyStatus: Condition['status'] = 'Unknown'
  let progressingStatus: Condition['status'] = 'Unknown'
  let degradedStatus: Condition['status'] = 'Unknown'
  let readyReason = readyCondition?.reason
  let readyMessage = readyCondition?.message
  let progressingReason = runningCondition?.reason
  const progressingMessage = runningCondition?.message
  let degradedReason = failureCondition?.reason
  let degradedMessage = failureCondition?.message

  if (phaseDegraded || failureCondition?.status === 'True') {
    degradedStatus = 'True'
    progressingStatus = 'False'
    readyStatus = 'False'
    degradedReason = degradedReason ?? 'Degraded'
  } else if (phaseProgressing || runningCondition?.status === 'True') {
    progressingStatus = 'True'
    degradedStatus = 'False'
    readyStatus = 'False'
    progressingReason = progressingReason ?? 'Progressing'
  } else if (phaseReady || successCondition?.status === 'True' || readyCondition?.status === 'True') {
    readyStatus = 'True'
    progressingStatus = 'False'
    degradedStatus = 'False'
    readyReason = readyReason ?? successCondition?.reason ?? 'Ready'
    readyMessage = readyMessage ?? successCondition?.message
  } else if (readyCondition?.status === 'False') {
    readyStatus = 'False'
    progressingStatus = 'False'
    degradedStatus = 'True'
    degradedReason = degradedReason ?? readyReason ?? 'NotReady'
    degradedMessage = degradedMessage ?? readyMessage
  } else if (readyCondition) {
    readyStatus = normalizeConditionStatus(readyCondition.status)
  }

  return [
    {
      type: 'Ready',
      status: readyStatus,
      reason: readyReason,
      message: readyMessage,
    },
    {
      type: 'Progressing',
      status: progressingStatus,
      reason: progressingReason ?? 'Progressing',
      message: progressingMessage,
    },
    {
      type: 'Degraded',
      status: degradedStatus,
      reason: degradedReason ?? 'Degraded',
      message: degradedMessage,
    },
  ] satisfies Array<Omit<Condition, 'lastTransitionTime'>>
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
  const phase = asString(status.phase) ?? null
  const baseConditions = normalizeConditions(status.conditions)
  const standardUpdates = deriveStandardConditionUpdates(baseConditions, phase)
  let conditions = baseConditions
  for (const update of standardUpdates) {
    conditions = upsertCondition(conditions, update)
  }
  const nextStatus = {
    ...status,
    updatedAt: nowIso(),
    conditions,
  }
  if (!shouldApplyStatus(asRecord(resource.status), nextStatus)) {
    return
  }
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status: nextStatus })
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

const normalizeRunnerJobTtlSeconds = (value: number, source: string) => {
  if (!Number.isFinite(value)) return null
  if (value <= 0) return null
  const floored = Math.floor(value)
  if (floored < MIN_RUNNER_JOB_TTL_SECONDS) {
    console.warn(
      `[jangar] runner job ttl ${floored}s from ${source} below minimum; clamping to ${MIN_RUNNER_JOB_TTL_SECONDS}s`,
    )
    return MIN_RUNNER_JOB_TTL_SECONDS
  }
  if (floored > MAX_RUNNER_JOB_TTL_SECONDS) {
    console.warn(
      `[jangar] runner job ttl ${floored}s from ${source} above maximum; clamping to ${MAX_RUNNER_JOB_TTL_SECONDS}s`,
    )
    return MAX_RUNNER_JOB_TTL_SECONDS
  }
  return floored
}

const resolveRunnerJobTtlSeconds = (runtimeConfig: Record<string, unknown>) => {
  const override = parseOptionalNumber(runtimeConfig.ttlSecondsAfterFinished)
  if (override !== undefined) {
    return normalizeRunnerJobTtlSeconds(override, 'spec.runtime.config.ttlSecondsAfterFinished')
  }
  const envDefault = parseOptionalNumber(process.env.JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS)
  if (envDefault !== undefined) {
    return normalizeRunnerJobTtlSeconds(envDefault, 'JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS')
  }
  return normalizeRunnerJobTtlSeconds(DEFAULT_RUNNER_JOB_TTL_SECONDS, 'default')
}

const parseAgentRunRetentionSeconds = () => {
  const parsed = parseOptionalNumber(process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS)
  if (parsed === undefined || parsed < 0) return DEFAULT_AGENTRUN_RETENTION_SECONDS
  return Math.floor(parsed)
}

const resolveAgentRunRetentionSeconds = (spec: Record<string, unknown>) => {
  const override = parseOptionalNumber(spec.ttlSecondsAfterFinished)
  if (override !== undefined && override >= 0) return Math.floor(override)
  return parseAgentRunRetentionSeconds()
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
  vcs?: Record<string, unknown> | null,
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
    vcs: vcs ?? {},
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
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : []

const parseEnvList = (name: string) => {
  const raw = process.env[name]
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

const resolveRunnerServiceAccount = (runtimeConfig: Record<string, unknown>) =>
  asString(runtimeConfig.serviceAccount) ?? asString(process.env.JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT)

type AuthSecretConfig = {
  name: string
  key: string
  mountPath: string
}

const resolveAuthSecretConfig = (): AuthSecretConfig | null => {
  const name = asString(process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME)?.trim()
  if (!name) return null
  const key = asString(process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY)?.trim() || DEFAULT_AUTH_SECRET_KEY
  const mountPath =
    asString(process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH)?.trim() || DEFAULT_AUTH_SECRET_MOUNT_PATH
  return { name, key, mountPath }
}

const buildAuthSecretPath = (config: AuthSecretConfig) => {
  const normalizedMountPath = config.mountPath.endsWith('/') ? config.mountPath.slice(0, -1) : config.mountPath
  return `${normalizedMountPath}/${config.key}`
}

const collectBlockedSecrets = (secrets: string[]) => {
  const blocked = parseEnvList('JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS')
  if (blocked.length === 0) return []
  const blockedSet = new Set(blocked)
  return Array.from(new Set(secrets.filter((secret) => blockedSet.has(secret))))
}

const validateAuthSecretPolicy = (allowedSecrets: string[], authSecret: AuthSecretConfig | null) => {
  if (!authSecret) return { ok: true as const }
  if (allowedSecrets.length > 0 && !allowedSecrets.includes(authSecret.name)) {
    return {
      ok: false as const,
      reason: 'SecretNotAllowed',
      message: `auth secret ${authSecret.name} is not allowlisted by the Agent`,
    }
  }
  return { ok: true as const }
}

const encodeBase64Url = (value: string | Buffer) =>
  Buffer.from(value).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')

const parseIntOrString = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

const resolveSecretValue = (secret: Record<string, unknown>, key: string) => {
  const stringData = asRecord(secret.stringData) ?? {}
  const stringValue = stringData[key]
  if (typeof stringValue === 'string') return stringValue
  const data = asRecord(secret.data) ?? {}
  const raw = data[key]
  if (typeof raw !== 'string') return null
  try {
    return Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return raw
  }
}

const secretHasKey = (secret: Record<string, unknown>, key: string) => {
  const data = asRecord(secret.data) ?? {}
  const stringData = asRecord(secret.stringData) ?? {}
  return key in data || key in stringData
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const matchesPattern = (value: string, pattern: string) => {
  if (pattern === '*') return true
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
  return regex.test(value)
}

const matchesAnyPattern = (value: string, patterns: string[]) =>
  patterns.some((pattern) => matchesPattern(value, pattern))

const normalizeVcsMode = (value: unknown): VcsMode => {
  const raw = asString(value)?.toLowerCase()
  if (raw === 'read-only' || raw === 'read-write' || raw === 'none') return raw
  return 'read-write'
}

const resolveVcsAuthMethod = (auth: Record<string, unknown>): VcsAuthMethod => {
  const explicit = asString(auth.method)?.toLowerCase()
  if (explicit === 'token' || explicit === 'app' || explicit === 'ssh' || explicit === 'none') {
    return explicit
  }
  const tokenSecret = asString(readNested(auth, ['token', 'secretRef', 'name']))
  if (tokenSecret) return 'token'
  const appSecret = asString(readNested(auth, ['app', 'privateKeySecretRef', 'name']))
  if (appSecret) return 'app'
  const sshSecret = asString(readNested(auth, ['ssh', 'privateKeySecretRef', 'name']))
  if (sshSecret) return 'ssh'
  return 'none'
}

const VCS_TOKEN_TYPE_ALIASES: Record<string, VcsTokenType> = {
  'personal-access-token': 'pat',
  personal_access_token: 'pat',
  'fine-grained': 'fine_grained',
  finegrained: 'fine_grained',
  api: 'api_token',
  access: 'access_token',
}

const DEFAULT_VCS_AUTH_ADAPTERS: Record<string, VcsAuthAdapter> = {
  github: {
    provider: 'github',
    allowedMethods: ['token', 'app', 'ssh', 'none'],
    tokenTypes: ['pat', 'fine_grained', 'access_token'],
    deprecatedTokenTypes: ['pat'],
    defaultUsername: 'x-access-token',
    defaultTokenType: 'fine_grained',
  },
  gitlab: {
    provider: 'gitlab',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['pat', 'access_token'],
    defaultUsername: 'oauth2',
    defaultTokenType: 'access_token',
  },
  bitbucket: {
    provider: 'bitbucket',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['access_token'],
    defaultUsername: 'x-token-auth',
    defaultTokenType: 'access_token',
  },
  gitea: {
    provider: 'gitea',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['api_token', 'access_token'],
    defaultUsername: 'git',
    defaultTokenType: 'api_token',
  },
  generic: {
    provider: 'generic',
    allowedMethods: ['token', 'ssh', 'none'],
    tokenTypes: ['pat', 'fine_grained', 'api_token', 'access_token'],
    defaultUsername: 'git',
  },
}

const normalizeTokenType = (value: unknown): VcsTokenType | null => {
  const raw = asString(value)?.trim().toLowerCase()
  if (!raw) return null
  const normalized = raw.replace(/-/g, '_')
  return VCS_TOKEN_TYPE_ALIASES[normalized] ?? (normalized as VcsTokenType)
}

const normalizeTokenTypeOverrides = (value: unknown) => {
  if (!Array.isArray(value)) return null
  const tokens = value.map((entry) => normalizeTokenType(entry)).filter((entry): entry is VcsTokenType => !!entry)
  return tokens.length > 0 ? tokens : []
}

const resolveDeprecatedTokenTypeOverrides = () => {
  const overrides = parseEnvRecord('JANGAR_AGENTS_CONTROLLER_VCS_DEPRECATED_TOKEN_TYPES')
  if (!overrides) return null
  const output: Record<string, VcsTokenType[]> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const normalized = normalizeTokenTypeOverrides(value)
    if (normalized) output[key] = normalized
  }
  return Object.keys(output).length > 0 ? output : null
}

const resolveVcsAuthAdapter = (providerType: string | null) => {
  const key = providerType ?? 'generic'
  const base = DEFAULT_VCS_AUTH_ADAPTERS[key] ?? DEFAULT_VCS_AUTH_ADAPTERS.generic
  const overrides = resolveDeprecatedTokenTypeOverrides()
  const deprecatedTokenTypes = overrides?.[key] ?? base.deprecatedTokenTypes ?? []
  return {
    ...base,
    deprecatedTokenTypes,
  }
}

const validateVcsAuthConfig = (providerType: string | null, auth: Record<string, unknown>) => {
  const adapter = resolveVcsAuthAdapter(providerType)
  const method = resolveVcsAuthMethod(auth)
  if (!adapter.allowedMethods.includes(method)) {
    return {
      ok: false as const,
      reason: 'UnsupportedAuth',
      message: `auth.method=${method} is not supported for ${adapter.provider} providers`,
    }
  }

  const warnings: Array<{ reason: string; message: string }> = []
  if (method === 'token') {
    const tokenType = normalizeTokenType(readNested(auth, ['token', 'type']))
    if (tokenType && adapter.tokenTypes && !adapter.tokenTypes.includes(tokenType)) {
      return {
        ok: false as const,
        reason: 'UnsupportedAuth',
        message: `auth.token.type=${tokenType} is not supported for ${adapter.provider} providers`,
      }
    }
    if (tokenType && (adapter.deprecatedTokenTypes ?? []).includes(tokenType)) {
      warnings.push({
        reason: 'DeprecatedAuth',
        message: `auth.token.type=${tokenType} is deprecated for ${adapter.provider} providers`,
      })
    }
  }

  return {
    ok: true as const,
    method,
    warnings,
    defaultUsername: adapter.defaultUsername ?? null,
  }
}

const fetchGithubAppToken = async (input: {
  apiBaseUrl: string
  appId: string
  installationId: string
  privateKey: string
  ttlSeconds?: number
}) => {
  const cacheKey = `${input.apiBaseUrl}|${input.installationId}`
  const cached = githubAppTokenCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expiresAt - now > 30_000) {
    return cached.token
  }

  const nowSeconds = Math.floor(now / 1000)
  const payload = {
    iat: nowSeconds - 30,
    exp: nowSeconds + 540,
    iss: input.appId,
  }
  const header = { alg: 'RS256', typ: 'JWT' }
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(createPrivateKey(input.privateKey))
  const jwt = `${signingInput}.${encodeBase64Url(signature)}`

  const response = await fetch(
    `${input.apiBaseUrl.replace(/\/+$/, '')}/app/installations/${input.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
      },
    },
  )

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(`GitHub App token request failed: ${response.status} ${response.statusText} ${details}`.trim())
  }

  const payloadResponse = (await response.json()) as Record<string, unknown>
  const token = asString(payloadResponse.token)
  if (!token) {
    throw new Error('GitHub App token response missing token')
  }

  const expiresAtRaw = asString(payloadResponse.expires_at)
  const ttlSeconds = typeof input.ttlSeconds === 'number' && input.ttlSeconds > 0 ? input.ttlSeconds : undefined
  const expiresAtMs = expiresAtRaw
    ? Date.parse(expiresAtRaw)
    : now + (ttlSeconds ?? DEFAULT_GITHUB_APP_TOKEN_TTL_SECONDS) * 1000
  githubAppTokenCache.set(cacheKey, {
    token,
    expiresAt: Number.isNaN(expiresAtMs) ? now + 30 * 60 * 1000 : expiresAtMs,
  })
  return token
}

const parseJsonEnv = (name: string) => {
  const raw = process.env[name]
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jangar] invalid ${name} JSON: ${message}`)
    return null
  }
}

const parseEnvRecord = (name: string) => asRecord(parseJsonEnv(name))

const parseEnvArray = (name: string) => {
  const parsed = parseJsonEnv(name)
  return Array.isArray(parsed) ? parsed : null
}

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
  sources: new Map(),
  vcsProviders: new Map(),
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
  sources: Array.from(state.sources.values()),
  vcsProviders: Array.from(state.vcsProviders.values()),
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
  ...extra,
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
  const contract = asRecord(spec.contract) ?? {}
  const requiredKeys = Array.isArray(contract.requiredKeys) ? contract.requiredKeys : []
  const mappings = Array.isArray(contract.mappings) ? contract.mappings : []
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
  } else if (requiredKeys.some((key) => typeof key !== 'string' || key.trim().length === 0)) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'InvalidContract',
      message: 'spec.contract.requiredKeys must be non-empty strings',
    })
  } else if (
    mappings.some((entry) => {
      const record = asRecord(entry)
      if (!record) return true
      const from = asString(record.from)?.trim()
      const to = asString(record.to)?.trim()
      return !from || !to
    })
  ) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'InvalidContract',
      message: 'spec.contract.mappings entries must include non-empty from and to',
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

const reconcileImplementationSource = async (
  kube: ReturnType<typeof createKubernetesClient>,
  source: Record<string, unknown>,
  namespace: string,
) => {
  const conditions = buildConditions(source)
  const provider = asString(readNested(source, ['spec', 'provider']))
  const secretRef = asRecord(readNested(source, ['spec', 'auth', 'secretRef']))
  const secretName = asString(secretRef?.name)
  const secretKey = asString(secretRef?.key) ?? 'token'
  const webhookEnabled = readNested(source, ['spec', 'webhook', 'enabled']) === true
  let updated = conditions

  if (!provider) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingProvider',
      message: 'spec.provider is required',
    })
  } else if (provider !== 'github' && provider !== 'linear') {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'UnsupportedProvider',
      message: `unsupported provider ${provider}`,
    })
  } else if (!secretName) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingSecretRef',
      message: 'spec.auth.secretRef.name is required',
    })
  } else if (!webhookEnabled) {
    updated = upsertCondition(updated, {
      type: 'Ready',
      status: 'False',
      reason: 'WebhookDisabled',
      message: 'spec.webhook.enabled must be true for webhook-only ingestion',
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
    } else {
      const data = asRecord(secret.data) ?? {}
      const stringData = asRecord(secret.stringData) ?? {}
      if (secretKey && !(secretKey in data) && !(secretKey in stringData)) {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretKeyMissing',
          message: `secret ${secretName} missing key ${secretKey}`,
        })
      } else {
        updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'WebhookReady' })
      }
    }
  }

  await setStatus(kube, source, {
    observedGeneration: asRecord(source.metadata)?.generation ?? 0,
    lastSyncedAt: asString(readNested(source, ['status', 'lastSyncedAt'])) ?? undefined,
    conditions: updated,
  })
}

const reconcileVersionControlProvider = async (
  kube: ReturnType<typeof createKubernetesClient>,
  provider: Record<string, unknown>,
  namespace: string,
) => {
  const conditions = buildConditions(provider)
  const spec = asRecord(provider.spec) ?? {}
  const providerType = asString(spec.provider)
  const auth = asRecord(spec.auth) ?? {}
  const method = resolveVcsAuthMethod(auth)
  let updated = conditions
  const warnings: Array<{ reason: string; message: string }> = []
  const markHealthy = () => {
    updated = upsertCondition(updated, { type: 'InvalidSpec', status: 'False', reason: 'Reconciled' })
    updated = upsertCondition(updated, { type: 'Unreachable', status: 'False', reason: 'Reconciled' })
  }

  if (!providerType) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'MissingProvider',
      message: 'spec.provider is required',
    })
  } else if (!['github', 'gitlab', 'bitbucket', 'gitea', 'generic'].includes(providerType)) {
    updated = upsertCondition(updated, {
      type: 'InvalidSpec',
      status: 'True',
      reason: 'UnsupportedProvider',
      message: `unsupported provider ${providerType}`,
    })
  } else {
    const authValidation = validateVcsAuthConfig(providerType, auth)
    if (!authValidation.ok) {
      updated = upsertCondition(updated, {
        type: 'InvalidSpec',
        status: 'True',
        reason: authValidation.reason,
        message: authValidation.message,
      })
    } else {
      warnings.push(...authValidation.warnings)
      if (method === 'token') {
        const tokenRef = asRecord(readNested(auth, ['token', 'secretRef'])) ?? {}
        const secretName = asString(tokenRef.name)
        const secretKey = asString(tokenRef.key) ?? 'token'
        if (!secretName) {
          updated = upsertCondition(updated, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingSecretRef',
            message: 'spec.auth.token.secretRef.name is required',
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
          } else if (!secretHasKey(secret, secretKey)) {
            updated = upsertCondition(updated, {
              type: 'InvalidSpec',
              status: 'True',
              reason: 'SecretKeyMissing',
              message: `secret ${secretName} missing key ${secretKey}`,
            })
          } else {
            updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'AuthReady' })
            markHealthy()
          }
        }
      } else if (method === 'app') {
        const appSpec = asRecord(readNested(auth, ['app'])) ?? {}
        const appId = parseIntOrString(appSpec.appId)
        const installationId = parseIntOrString(appSpec.installationId)
        const secretRef = asRecord(appSpec.privateKeySecretRef) ?? {}
        const secretName = asString(secretRef.name)
        const secretKey = asString(secretRef.key) ?? 'privateKey'
        if (!appId || !installationId || !secretName) {
          updated = upsertCondition(updated, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingAppAuth',
            message: 'spec.auth.app.appId, installationId, and privateKeySecretRef.name are required',
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
          } else if (!secretHasKey(secret, secretKey)) {
            updated = upsertCondition(updated, {
              type: 'InvalidSpec',
              status: 'True',
              reason: 'SecretKeyMissing',
              message: `secret ${secretName} missing key ${secretKey}`,
            })
          } else {
            updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'AuthReady' })
            markHealthy()
          }
        }
      } else if (method === 'ssh') {
        const sshSpec = asRecord(readNested(auth, ['ssh'])) ?? {}
        const secretRef = asRecord(sshSpec.privateKeySecretRef) ?? {}
        const secretName = asString(secretRef.name)
        const secretKey = asString(secretRef.key) ?? 'privateKey'
        const knownHostsRef = asRecord(sshSpec.knownHostsConfigMapRef) ?? {}
        const knownHostsName = asString(knownHostsRef.name)
        const knownHostsKey = asString(knownHostsRef.key) ?? 'known_hosts'
        if (!secretName) {
          updated = upsertCondition(updated, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingSecretRef',
            message: 'spec.auth.ssh.privateKeySecretRef.name is required',
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
          } else if (!secretHasKey(secret, secretKey)) {
            updated = upsertCondition(updated, {
              type: 'InvalidSpec',
              status: 'True',
              reason: 'SecretKeyMissing',
              message: `secret ${secretName} missing key ${secretKey}`,
            })
          } else {
            updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'AuthReady' })
            markHealthy()
          }
        }
        if (knownHostsName) {
          const configMap = await kube.get('configmap', knownHostsName, namespace)
          if (!configMap) {
            updated = upsertCondition(updated, {
              type: 'Unreachable',
              status: 'True',
              reason: 'ConfigMapNotFound',
              message: `configmap ${knownHostsName} not found`,
            })
          } else if (knownHostsKey) {
            const data = asRecord(configMap.data) ?? {}
            if (!(knownHostsKey in data)) {
              updated = upsertCondition(updated, {
                type: 'InvalidSpec',
                status: 'True',
                reason: 'ConfigMapKeyMissing',
                message: `configmap ${knownHostsName} missing key ${knownHostsKey}`,
              })
            }
          }
        }
      } else if (method === 'none') {
        updated = upsertCondition(updated, { type: 'Ready', status: 'True', reason: 'NoAuth' })
        markHealthy()
      } else {
        updated = upsertCondition(updated, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'UnsupportedAuth',
          message: `unsupported auth method ${method}`,
        })
      }
    }
  }

  if (warnings.length > 0) {
    updated = upsertCondition(updated, {
      type: 'Warning',
      status: 'True',
      reason: warnings[0]?.reason ?? 'Warning',
      message: warnings.map((warning) => warning.message).join('; '),
    })
  } else {
    updated = upsertCondition(updated, { type: 'Warning', status: 'False', reason: 'None', message: '' })
  }

  await setStatus(kube, provider, {
    observedGeneration: asRecord(provider.metadata)?.generation ?? 0,
    lastValidatedAt: nowIso(),
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

const resolveParam = (params: Record<string, string>, keys: string[]) => {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

const parseGithubExternalId = (externalId: string) => {
  const trimmed = externalId.trim()
  const [repo, number] = trimmed.split('#')
  if (!repo || !number) return null
  return { repository: repo.trim(), issueNumber: number.trim() }
}

type ImplementationContractMapping = { from: string; to: string }

const DEFAULT_METADATA_MAPPINGS: ImplementationContractMapping[] = [
  { from: 'repo', to: 'repository' },
  { from: 'issueRepository', to: 'repository' },
  { from: 'issue', to: 'issueNumber' },
  { from: 'issueId', to: 'issueNumber' },
  { from: 'issue_id', to: 'issueNumber' },
  { from: 'issue_number', to: 'issueNumber' },
  { from: 'title', to: 'issueTitle' },
  { from: 'body', to: 'issueBody' },
  { from: 'url', to: 'issueUrl' },
  { from: 'baseBranch', to: 'base' },
  { from: 'base_ref', to: 'base' },
  { from: 'baseRef', to: 'base' },
  { from: 'headBranch', to: 'head' },
  { from: 'head_ref', to: 'head' },
  { from: 'headRef', to: 'head' },
  { from: 'workflowStage', to: 'stage' },
  { from: 'codexStage', to: 'stage' },
]

const normalizeContractMappings = (value: unknown): ImplementationContractMapping[] => {
  if (!Array.isArray(value)) return []
  const mappings: ImplementationContractMapping[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const from = asString(record.from)?.trim()
    const to = asString(record.to)?.trim()
    if (!from || !to) continue
    mappings.push({ from, to })
  }
  return mappings
}

const normalizeRequiredKeys = (value: unknown) => {
  if (!Array.isArray(value)) return []
  const keys = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Array.from(new Set(keys))
}

const applyMetadataMappings = (metadata: Record<string, string>, mappings: ImplementationContractMapping[]) => {
  for (const mapping of mappings) {
    const fromValue = metadata[mapping.from]
    if (!fromValue || metadata[mapping.to]) continue
    metadata[mapping.to] = fromValue
  }
}

const setMetadataIfMissing = (metadata: Record<string, string>, key: string, value: string) => {
  if (!value || metadata[key]) return
  metadata[key] = value
}

const buildEventContext = (implementation: Record<string, unknown>, parameters: Record<string, string>) => {
  const source = asRecord(implementation.source) ?? {}
  const provider = asString(source.provider) ?? ''
  const externalId = asString(source.externalId) ?? ''
  const sourceUrl = asString(source.url) ?? ''

  const contract = asRecord(implementation.contract) ?? {}
  const contractMappings = normalizeContractMappings(contract.mappings)
  const requiredKeys = normalizeRequiredKeys(contract.requiredKeys)

  const summary = asString(implementation.summary) ?? ''
  const text = asString(implementation.text) ?? ''

  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    metadata[key] = trimmed
  }

  applyMetadataMappings(metadata, DEFAULT_METADATA_MAPPINGS)
  applyMetadataMappings(metadata, contractMappings)

  let repository = metadata.repository ?? resolveParam(parameters, ['repository'])
  let issueNumber = metadata.issueNumber ?? resolveParam(parameters, ['issueNumber'])

  const resolvedIssueTitle = metadata.issueTitle ?? resolveParam(parameters, ['issueTitle'])
  const issueTitle = resolvedIssueTitle || summary
  const resolvedIssueBody = metadata.issueBody ?? resolveParam(parameters, ['issueBody'])
  const issueBody = resolvedIssueBody || text
  const resolvedIssueUrl = metadata.issueUrl ?? resolveParam(parameters, ['issueUrl'])
  const issueUrl = resolvedIssueUrl || sourceUrl
  const resolvedPrompt = metadata.prompt ?? resolveParam(parameters, ['prompt'])
  const prompt = resolvedPrompt || text || summary
  const base = metadata.base ?? resolveParam(parameters, ['base'])
  const head = metadata.head ?? resolveParam(parameters, ['head'])
  const stage = metadata.stage ?? resolveParam(parameters, ['stage'])

  if ((!repository || !issueNumber) && provider === 'github' && externalId) {
    const parsed = parseGithubExternalId(externalId)
    if (parsed) {
      repository = repository || parsed.repository
      issueNumber = issueNumber || parsed.issueNumber
    }
  }

  setMetadataIfMissing(metadata, 'repository', repository)
  setMetadataIfMissing(metadata, 'issueNumber', issueNumber)
  setMetadataIfMissing(metadata, 'issueTitle', issueTitle)
  setMetadataIfMissing(metadata, 'issueBody', issueBody)
  setMetadataIfMissing(metadata, 'issueUrl', issueUrl)
  setMetadataIfMissing(metadata, 'url', issueUrl)
  setMetadataIfMissing(metadata, 'base', base)
  setMetadataIfMissing(metadata, 'head', head)
  setMetadataIfMissing(metadata, 'stage', stage)
  setMetadataIfMissing(metadata, 'prompt', prompt)

  const payload: Record<string, unknown> = {}
  if (prompt) payload.prompt = prompt
  if (repository) payload.repository = repository
  if (issueNumber) payload.issueNumber = issueNumber
  if (issueTitle) payload.issueTitle = issueTitle
  if (issueBody) payload.issueBody = issueBody
  if (issueUrl) payload.issueUrl = issueUrl
  if (base) payload.base = base
  if (head) payload.head = head
  if (stage) payload.stage = stage
  if (Object.keys(metadata).length > 0) {
    payload.metadata = { map: metadata }
  }

  const missingRequiredKeys = requiredKeys.filter((key) => !metadata[key])

  return { payload, metadata, missingRequiredKeys }
}

const buildEventPayload = (implementation: Record<string, unknown>, parameters: Record<string, string>) =>
  buildEventContext(implementation, parameters).payload

const validateImplementationContract = (
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
) => {
  const { missingRequiredKeys } = buildEventContext(implementation, parameters)
  if (missingRequiredKeys.length === 0) {
    return { ok: true as const }
  }
  return {
    ok: false as const,
    missing: missingRequiredKeys,
    message: `missing required metadata keys: ${missingRequiredKeys.join(', ')}`,
  }
}

const resolveVcsContext = async ({
  kube,
  namespace,
  agentRun,
  agent,
  implementation,
  parameters,
  allowedSecrets,
}: {
  kube: ReturnType<typeof createKubernetesClient>
  namespace: string
  agentRun: Record<string, unknown>
  agent: Record<string, unknown>
  implementation: Record<string, unknown>
  parameters: Record<string, string>
  allowedSecrets: string[]
}): Promise<VcsResolution> => {
  if (!isVcsProvidersEnabled()) {
    return {
      ok: true,
      skip: true,
      reason: 'VcsProvidersDisabled',
      message: 'vcs providers are disabled by configuration',
      mode: 'none',
      requiredSecrets: [],
    }
  }

  const spec = asRecord(agentRun.spec) ?? {}
  const policy = asRecord(spec.vcsPolicy) ?? {}
  const required = policy.required === true
  const desiredMode = normalizeVcsMode(policy.mode)

  const runMetadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(runMetadata.name) ?? 'agentrun'

  const eventContext = buildEventContext(implementation, parameters)
  const metadata = eventContext.metadata
  const repository = asString(metadata.repository) ?? ''

  const runVcsRef = asString(readNested(spec, ['vcsRef', 'name']))
  const implVcsRef = asString(readNested(implementation, ['vcsRef', 'name']))
  const agentVcsRef = asString(readNested(agent, ['spec', 'vcsRef', 'name']))
  const vcsRefName = runVcsRef || implVcsRef || agentVcsRef

  if (!vcsRefName) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'MissingVcsProvider',
        message: 'vcsRef is required when vcsPolicy.required is true',
        mode: 'none',
        requiredSecrets: [],
      }
    }
    return { ok: true, skip: true, mode: 'none', requiredSecrets: [] }
  }

  const provider = await kube.get(RESOURCE_MAP.VersionControlProvider, vcsRefName, namespace)
  if (!provider) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'MissingVcsProvider',
        message: `version control provider ${vcsRefName} not found`,
        mode: 'none',
        status: { provider: vcsRefName, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'MissingVcsProvider',
      message: `version control provider ${vcsRefName} not found`,
      status: { provider: vcsRefName, mode: 'none' },
      requiredSecrets: [],
    }
  }

  const providerSpec = asRecord(provider.spec) ?? {}
  const providerType = asString(providerSpec.provider) ?? 'generic'
  const apiBaseUrl = asString(providerSpec.apiBaseUrl) ?? (providerType === 'github' ? 'https://api.github.com' : null)
  const cloneBaseUrl = asString(providerSpec.cloneBaseUrl)
  const webBaseUrl = asString(providerSpec.webBaseUrl)
  const cloneProtocol = asString(providerSpec.cloneProtocol)
  const sshHost = asString(providerSpec.sshHost)
  const sshUser = asString(providerSpec.sshUser)

  if (!repository) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'MissingRepository',
        message: 'repository is required for version control operations',
        mode: 'none',
        status: { provider: vcsRefName, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'MissingRepository',
      message: 'repository is required for version control operations',
      status: { provider: vcsRefName, mode: 'none' },
      requiredSecrets: [],
    }
  }

  const repositoryPolicy = asRecord(providerSpec.repositoryPolicy) ?? {}
  const allowList = parseStringList(repositoryPolicy.allow)
  const denyList = parseStringList(repositoryPolicy.deny)
  if (matchesAnyPattern(repository, denyList)) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'VcsPolicyDenied',
        message: `repository ${repository} is denied by policy`,
        mode: 'none',
        status: { provider: vcsRefName, repository, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'VcsPolicyDenied',
      message: `repository ${repository} is denied by policy`,
      status: { provider: vcsRefName, repository, mode: 'none' },
      requiredSecrets: [],
    }
  }
  if (allowList.length > 0 && !matchesAnyPattern(repository, allowList)) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'VcsPolicyDenied',
        message: `repository ${repository} is not in the allow list`,
        mode: 'none',
        status: { provider: vcsRefName, repository, mode: 'none' },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'VcsPolicyDenied',
      message: `repository ${repository} is not in the allow list`,
      status: { provider: vcsRefName, repository, mode: 'none' },
      requiredSecrets: [],
    }
  }

  if (desiredMode === 'none') {
    return {
      ok: true,
      skip: true,
      mode: 'none',
      reason: 'VcsDisabled',
      message: 'vcsPolicy.mode is none',
      status: { provider: vcsRefName, repository, mode: 'none' },
      requiredSecrets: [],
    }
  }

  const capabilities = asRecord(providerSpec.capabilities) ?? {}
  const canRead = readNested(capabilities, ['read']) !== false
  const canWrite = readNested(capabilities, ['write']) !== false
  const canPr = readNested(capabilities, ['pullRequests']) !== false

  let effectiveMode: VcsMode = desiredMode
  if (effectiveMode === 'read-write' && !canWrite) {
    effectiveMode = 'read-only'
  }
  if (effectiveMode === 'read-only' && !canRead) {
    effectiveMode = 'none'
  }

  if (required && desiredMode !== effectiveMode && desiredMode !== 'none') {
    return {
      ok: false,
      skip: false,
      reason: 'VcsCapabilityDenied',
      message: `provider ${vcsRefName} cannot satisfy ${desiredMode}`,
      mode: effectiveMode,
      status: { provider: vcsRefName, repository, mode: effectiveMode },
      requiredSecrets: [],
    }
  }

  const defaults = asRecord(providerSpec.defaults) ?? {}
  const pullRequestDefaults = asRecord(defaults.pullRequest) ?? {}
  const baseBranch = asString(metadata.base) ?? asString(defaults.baseBranch) ?? ''
  let headBranch = asString(metadata.head) ?? ''
  const branchTemplate = asString(defaults.branchTemplate)
  if (!headBranch && branchTemplate) {
    headBranch = renderTemplate(branchTemplate, {
      agentRun: {
        name: runName,
        namespace: asString(runMetadata.namespace) ?? namespace,
      },
      parameters,
      metadata,
      event: eventContext.payload,
    })
  }

  const auth = asRecord(providerSpec.auth) ?? {}
  const method = resolveVcsAuthMethod(auth)
  const username = asString(auth.username)
  const requiredSecrets: string[] = []
  const runtime: VcsRuntimeConfig = { env: [], volumes: [], volumeMounts: [] }

  const pushEnv = (name: string, value?: string | null) => {
    if (!value) return
    runtime.env.push({ name, value })
  }
  const pushEnvBool = (name: string, value: boolean) => {
    runtime.env.push({ name, value: value ? 'true' : 'false' })
  }
  const pushSecretEnv = (name: string, secretName: string, secretKey: string) => {
    runtime.env.push({
      name,
      valueFrom: { secretKeyRef: { name: secretName, key: secretKey } },
    })
  }

  let authAvailable = false
  let tokenValue: string | null = null

  const authValidation = validateVcsAuthConfig(providerType, auth)
  if (!authValidation.ok) {
    if (required && desiredMode !== 'none') {
      return {
        ok: false,
        skip: false,
        reason: 'UnsupportedVcsAuth',
        message: authValidation.message,
        mode: effectiveMode,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    return {
      ok: true,
      skip: true,
      mode: effectiveMode,
      reason: 'UnsupportedVcsAuth',
      message: authValidation.message,
      status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
      requiredSecrets: [],
    }
  }

  const resolvedUsername =
    (method === 'token' || method === 'app') && !username ? authValidation.defaultUsername : username

  if (method === 'token') {
    const secretRef = asRecord(readNested(auth, ['token', 'secretRef'])) ?? {}
    const secretName = asString(secretRef.name)
    const secretKey = asString(secretRef.key) ?? 'token'
    if (!secretName) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'MissingVcsAuth',
          message: 'spec.auth.token.secretRef.name is required',
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'MissingVcsAuth',
        message: 'spec.auth.token.secretRef.name is required',
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const blocked = collectBlockedSecrets([secretName])
    if (blocked.length > 0) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'SecretBlocked',
          message: `vcs secret ${secretName} is blocked by controller policy`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretBlocked',
        message: `vcs secret ${secretName} is blocked by controller policy`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(secretName)) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'SecretNotAllowed',
          message: `vcs secret ${secretName} is not allowlisted by the Agent`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretNotAllowed',
        message: `vcs secret ${secretName} is not allowlisted by the Agent`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret || !secretHasKey(secret, secretKey)) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    requiredSecrets.push(secretName)
    pushSecretEnv('VCS_TOKEN', secretName, secretKey)
    if (providerType === 'github') {
      pushSecretEnv('GITHUB_TOKEN', secretName, secretKey)
      pushSecretEnv('GH_TOKEN', secretName, secretKey)
    }
    authAvailable = true
  }

  if (method === 'app') {
    const appSpec = asRecord(readNested(auth, ['app'])) ?? {}
    const appId = parseIntOrString(appSpec.appId)
    const installationId = parseIntOrString(appSpec.installationId)
    const secretRef = asRecord(appSpec.privateKeySecretRef) ?? {}
    const secretName = asString(secretRef.name)
    const secretKey = asString(secretRef.key) ?? 'privateKey'
    const tokenTtlSeconds = Number(appSpec.tokenTtlSeconds)
    if (!appId || !installationId || !secretName) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'MissingVcsAuth',
          message: 'spec.auth.app.appId, installationId, and privateKeySecretRef.name are required',
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'MissingVcsAuth',
        message: 'spec.auth.app.appId, installationId, and privateKeySecretRef.name are required',
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const blocked = collectBlockedSecrets([secretName])
    if (blocked.length > 0) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'SecretBlocked',
          message: `vcs secret ${secretName} is blocked by controller policy`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretBlocked',
        message: `vcs secret ${secretName} is blocked by controller policy`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(secretName)) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'SecretNotAllowed',
          message: `vcs secret ${secretName} is not allowlisted by the Agent`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretNotAllowed',
        message: `vcs secret ${secretName} is not allowlisted by the Agent`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret || !secretHasKey(secret, secretKey)) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const privateKey = resolveSecretValue(secret, secretKey)
    if (!privateKey) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    requiredSecrets.push(secretName)
    tokenValue = await fetchGithubAppToken({
      apiBaseUrl: apiBaseUrl ?? 'https://api.github.com',
      appId,
      installationId,
      privateKey,
      ttlSeconds: Number.isFinite(tokenTtlSeconds) ? tokenTtlSeconds : undefined,
    })
    pushEnv('VCS_TOKEN', tokenValue)
    pushEnv('GITHUB_TOKEN', tokenValue)
    pushEnv('GH_TOKEN', tokenValue)
    authAvailable = true
  }

  if (method === 'ssh') {
    const sshSpec = asRecord(readNested(auth, ['ssh'])) ?? {}
    const secretRef = asRecord(sshSpec.privateKeySecretRef) ?? {}
    const secretName = asString(secretRef.name)
    const secretKey = asString(secretRef.key) ?? 'privateKey'
    const knownHostsRef = asRecord(sshSpec.knownHostsConfigMapRef) ?? {}
    const knownHostsName = asString(knownHostsRef.name)
    const knownHostsKey = asString(knownHostsRef.key) ?? 'known_hosts'
    if (!secretName) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'MissingVcsAuth',
          message: 'spec.auth.ssh.privateKeySecretRef.name is required',
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'MissingVcsAuth',
        message: 'spec.auth.ssh.privateKeySecretRef.name is required',
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const blocked = collectBlockedSecrets([secretName])
    if (blocked.length > 0) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'SecretBlocked',
          message: `vcs secret ${secretName} is blocked by controller policy`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretBlocked',
        message: `vcs secret ${secretName} is blocked by controller policy`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    if (allowedSecrets.length > 0 && !allowedSecrets.includes(secretName)) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'SecretNotAllowed',
          message: `vcs secret ${secretName} is not allowlisted by the Agent`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'SecretNotAllowed',
        message: `vcs secret ${secretName} is not allowlisted by the Agent`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    const secret = await kube.get('secret', secretName, namespace)
    if (!secret || !secretHasKey(secret, secretKey)) {
      if (required && desiredMode !== 'none') {
        return {
          ok: false,
          skip: false,
          reason: 'VcsAuthUnavailable',
          message: `secret ${secretName} missing key ${secretKey}`,
          mode: effectiveMode,
          status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
          requiredSecrets: [],
        }
      }
      return {
        ok: true,
        skip: true,
        mode: effectiveMode,
        reason: 'VcsAuthUnavailable',
        message: `secret ${secretName} missing key ${secretKey}`,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets: [],
      }
    }
    requiredSecrets.push(secretName)
    const sshDir = '/var/run/secrets/agents/vcs/ssh'
    const sshKeyPath = `${sshDir}/${secretKey}`
    runtime.volumes.push({
      name: makeName(runName, 'vcs-ssh'),
      spec: { secret: { secretName, items: [{ key: secretKey, path: secretKey }] } },
    })
    runtime.volumeMounts.push({ name: makeName(runName, 'vcs-ssh'), mountPath: sshDir, readOnly: true })
    pushEnv('VCS_SSH_KEY_PATH', sshKeyPath)

    if (knownHostsName) {
      const knownHostsDir = '/var/run/secrets/agents/vcs/known-hosts'
      const knownHostsPath = `${knownHostsDir}/${knownHostsKey}`
      runtime.volumes.push({
        name: makeName(runName, 'vcs-known-hosts'),
        spec: {
          configMap: {
            name: knownHostsName,
            items: [{ key: knownHostsKey, path: knownHostsKey }],
          },
        },
      })
      runtime.volumeMounts.push({
        name: makeName(runName, 'vcs-known-hosts'),
        mountPath: knownHostsDir,
        readOnly: true,
      })
      pushEnv('VCS_SSH_KNOWN_HOSTS_PATH', knownHostsPath)
    }
    authAvailable = true
  }

  let writeEnabled = effectiveMode === 'read-write' && canWrite
  if (writeEnabled && !authAvailable) {
    writeEnabled = false
  }

  if (desiredMode === 'read-write' && !writeEnabled) {
    if (required) {
      return {
        ok: false,
        skip: false,
        reason: 'VcsAuthUnavailable',
        message: 'vcs write access is unavailable',
        mode: effectiveMode,
        status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
        requiredSecrets,
      }
    }
    effectiveMode = 'read-only'
  }

  if (effectiveMode === 'none') {
    return {
      ok: true,
      skip: true,
      mode: effectiveMode,
      reason: 'VcsDisabled',
      message: 'vcs mode resolved to none',
      status: { provider: vcsRefName, repository, baseBranch, headBranch, mode: effectiveMode },
      requiredSecrets,
    }
  }

  const prEnabledDefault = readNested(pullRequestDefaults, ['enabled']) !== false
  const prDraft = readNested(pullRequestDefaults, ['draft']) === true
  const prTitleTemplate = asString(pullRequestDefaults.titleTemplate)
  const prBodyTemplate = asString(pullRequestDefaults.bodyTemplate)
  const pullRequestsEnabled = writeEnabled && canPr && prEnabledDefault

  pushEnv('VCS_PROVIDER', providerType)
  pushEnv('VCS_PROVIDER_NAME', vcsRefName)
  pushEnv('VCS_API_BASE_URL', apiBaseUrl)
  pushEnv('VCS_CLONE_BASE_URL', cloneBaseUrl)
  pushEnv('VCS_WEB_BASE_URL', webBaseUrl)
  pushEnv('VCS_REPOSITORY', repository)
  pushEnv('VCS_BASE_BRANCH', baseBranch)
  pushEnv('VCS_HEAD_BRANCH', headBranch)
  pushEnv('VCS_CLONE_PROTOCOL', cloneProtocol)
  pushEnv('VCS_SSH_HOST', sshHost)
  pushEnv('VCS_SSH_USER', sshUser)
  if (resolvedUsername) {
    pushEnv('VCS_USERNAME', resolvedUsername)
    pushEnv('GIT_ASKPASS_USERNAME', resolvedUsername)
  }
  pushEnv('VCS_BRANCH_TEMPLATE', branchTemplate)
  pushEnv('VCS_COMMIT_AUTHOR_NAME', asString(defaults.commitAuthorName))
  pushEnv('VCS_COMMIT_AUTHOR_EMAIL', asString(defaults.commitAuthorEmail))
  if (asString(defaults.commitAuthorName)) {
    pushEnv('GIT_AUTHOR_NAME', asString(defaults.commitAuthorName))
    pushEnv('GIT_COMMITTER_NAME', asString(defaults.commitAuthorName))
  }
  if (asString(defaults.commitAuthorEmail)) {
    pushEnv('GIT_AUTHOR_EMAIL', asString(defaults.commitAuthorEmail))
    pushEnv('GIT_COMMITTER_EMAIL', asString(defaults.commitAuthorEmail))
  }
  pushEnv('VCS_PR_TITLE_TEMPLATE', prTitleTemplate)
  pushEnv('VCS_PR_BODY_TEMPLATE', prBodyTemplate)
  pushEnvBool('VCS_PR_DRAFT', prDraft)
  pushEnvBool('VCS_WRITE_ENABLED', writeEnabled)
  pushEnvBool('VCS_PULL_REQUESTS_ENABLED', pullRequestsEnabled)
  pushEnv('VCS_MODE', effectiveMode)

  const context = {
    provider: providerType,
    providerName: vcsRefName,
    repository,
    baseBranch,
    headBranch,
    mode: effectiveMode,
    writeEnabled,
    pullRequestsEnabled,
    apiBaseUrl,
    cloneBaseUrl,
    webBaseUrl,
    cloneProtocol,
    sshHost,
    sshUser,
    defaults: {
      baseBranch: asString(defaults.baseBranch),
      branchTemplate,
      commitAuthorName: asString(defaults.commitAuthorName),
      commitAuthorEmail: asString(defaults.commitAuthorEmail),
      pullRequest: {
        enabled: prEnabledDefault,
        draft: prDraft,
        titleTemplate: prTitleTemplate,
        bodyTemplate: prBodyTemplate,
      },
    },
  }

  const status = {
    provider: vcsRefName,
    repository,
    baseBranch,
    headBranch,
    mode: effectiveMode,
  }

  return {
    ok: true,
    skip: false,
    mode: effectiveMode,
    status,
    context,
    runtime,
    requiredSecrets,
  }
}

const buildRunSpec = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
  artifacts?: Array<Record<string, unknown>>,
  providerName?: string,
  vcs?: Record<string, unknown> | null,
) => {
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory, vcs ?? null)
  const eventPayload = buildEventPayload(implementation, parameters)
  return {
    provider: providerName ?? asString(readNested(agent, ['spec', 'providerRef', 'name'])) ?? '',
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
    ...(vcs ? { vcs } : {}),
    ...eventPayload,
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
  agentRunnerSpec?: Record<string, unknown>,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, suffix ? `spec-${suffix}` : 'spec')
  const data: Record<string, string> = {
    'run.json': JSON.stringify(runSpec, null, 2),
  }
  if (agentRunnerSpec) {
    data['agent-runner.json'] = JSON.stringify(agentRunnerSpec, null, 2)
  }
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
  return configName
}

const buildAgentRunnerSpec = (
  _runSpec: Record<string, unknown>,
  parameters: Record<string, string>,
  providerName: string,
) => ({
  provider: providerName,
  inputs: parameters,
  payloads: {
    eventFilePath: '/workspace/run.json',
  },
  artifacts: {
    statusPath: '/workspace/.agent/status.json',
    logPath: '/workspace/.agent/runner.log',
  },
})

const applyJobTtlAfterStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  job: Record<string, unknown>,
  namespace: string,
  runtimeConfig: Record<string, unknown>,
) => {
  const ttlSeconds = resolveRunnerJobTtlSeconds(runtimeConfig)
  if (ttlSeconds === null) return
  const name = asString(readNested(job, ['metadata', 'name'])) ?? ''
  if (!name) return
  const currentTtl = parseOptionalNumber(readNested(job, ['spec', 'ttlSecondsAfterFinished']))
  if (currentTtl === ttlSeconds) return
  await kube.patch('job', name, namespace, { spec: { ttlSecondsAfterFinished: ttlSeconds } })
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
    vcs?: VcsResolution
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
  const vcsContext = options.vcs?.context ?? null
  const vcsRuntime = options.vcs?.runtime ?? null
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory, vcsContext)

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
  if (vcsRuntime?.env?.length) {
    env.push(...vcsRuntime.env)
  }

  const runSpec = buildRunSpec(
    agentRun,
    agent,
    implementation,
    parameters,
    memory,
    Array.isArray(outputArtifacts) ? outputArtifacts : [],
    providerName,
    vcsContext,
  )
  const agentRunnerSpec = providerName ? buildAgentRunnerSpec(runSpec, parameters, providerName) : null
  const runSecrets = parseStringList(readNested(agentRun, ['spec', 'secrets']))
  const envFrom = runSecrets.map((name) => ({ secretRef: { name } }))
  const authSecret = resolveAuthSecretConfig()

  const inputEntries = inputFiles
    .map((file: Record<string, unknown>) => ({
      path: asString(file.path) ?? '',
      content: asString(file.content) ?? '',
    }))
    .filter((file) => file.path && file.content)

  const runtimeConfig = options.runtimeConfig ?? asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const serviceAccount = resolveRunnerServiceAccount(runtimeConfig)
  const nodeSelector = asRecord(runtimeConfig.nodeSelector) ?? parseEnvRecord('JANGAR_AGENT_RUNNER_NODE_SELECTOR')
  const tolerations =
    (Array.isArray(runtimeConfig.tolerations) ? runtimeConfig.tolerations : null) ??
    parseEnvArray('JANGAR_AGENT_RUNNER_TOLERATIONS')
  const topologySpreadConstraints =
    (Array.isArray(runtimeConfig.topologySpreadConstraints) ? runtimeConfig.topologySpreadConstraints : null) ??
    parseEnvArray('JANGAR_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS')
  const affinity = asRecord(runtimeConfig.affinity) ?? parseEnvRecord('JANGAR_AGENT_RUNNER_AFFINITY')
  const podSecurityContext =
    asRecord(runtimeConfig.podSecurityContext) ?? parseEnvRecord('JANGAR_AGENT_RUNNER_POD_SECURITY_CONTEXT')
  const priorityClassName =
    asString(runtimeConfig.priorityClassName) ?? asString(process.env.JANGAR_AGENT_RUNNER_PRIORITY_CLASS)
  const schedulerName =
    asString(runtimeConfig.schedulerName) ?? asString(process.env.JANGAR_AGENT_RUNNER_SCHEDULER_NAME)
  const imagePullSecrets = (() => {
    const candidates = Array.isArray(runtimeConfig.imagePullSecrets)
      ? runtimeConfig.imagePullSecrets
      : parseEnvArray('JANGAR_AGENT_RUNNER_IMAGE_PULL_SECRETS')
    if (!candidates) return null
    const resolved = candidates
      .map((entry) => {
        if (typeof entry === 'string') {
          const trimmed = entry.trim()
          return trimmed ? { name: trimmed } : null
        }
        const record = asRecord(entry)
        const name = record ? asString(record.name) : null
        return name ? { name } : null
      })
      .filter((entry): entry is { name: string } => Boolean(entry))
    return resolved.length > 0 ? resolved : null
  })()
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

  const mergedLabels = { ...labels, ...options.labels }
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
    agentRunnerSpec ?? undefined,
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
  if (agentRunnerSpec) {
    configVolumeMounts.push({
      name: specVolumeName,
      mountPath: '/workspace/agent-runner.json',
      subPath: 'agent-runner.json',
    })
  }

  if (authSecret) {
    const authHomeVolumeName = makeName(runName, options.nameSuffix ? `auth-home-${options.nameSuffix}` : 'auth-home')
    const authSecretVolumeName = makeName(
      runName,
      options.nameSuffix ? `auth-secret-${options.nameSuffix}` : 'auth-secret',
    )
    volumes.push({
      name: authHomeVolumeName,
      spec: { emptyDir: {} },
    })
    volumes.push({
      name: authSecretVolumeName,
      spec: {
        secret: {
          secretName: authSecret.name,
          items: [{ key: authSecret.key, path: authSecret.key }],
        },
      },
    })
    configVolumeMounts.push({
      name: authHomeVolumeName,
      mountPath: authSecret.mountPath,
    })
    configVolumeMounts.push({
      name: authSecretVolumeName,
      mountPath: buildAuthSecretPath(authSecret),
      subPath: authSecret.key,
      readOnly: true,
    })
  }

  if (vcsRuntime?.volumes?.length) {
    for (const volume of vcsRuntime.volumes) {
      volumes.push(volume)
    }
  }
  if (vcsRuntime?.volumeMounts?.length) {
    configVolumeMounts.push(...vcsRuntime.volumeMounts)
  }

  const jobPodSpec: Record<string, unknown> = {
    serviceAccountName: serviceAccount ?? undefined,
    restartPolicy: 'Never',
    containers: [
      {
        name: 'agent-runner',
        image: workloadImage,
        command: [binary],
        args,
        env: [
          { name: 'AGENT_RUN_SPEC', value: '/workspace/run.json' },
          { name: 'AGENT_RUNNER_SPEC_PATH', value: '/workspace/agent-runner.json' },
          ...(authSecret
            ? [
                { name: 'CODEX_HOME', value: authSecret.mountPath },
                { name: 'CODEX_AUTH', value: buildAuthSecretPath(authSecret) },
              ]
            : []),
          ...env,
        ],
        envFrom: envFrom.length > 0 ? envFrom : undefined,
        resources: buildJobResources(workload),
        volumeMounts: [...volumeMounts, ...configVolumeMounts],
      },
    ],
    volumes: volumes.map((volume) => ({ name: volume.name, ...volume.spec })),
  }

  if (nodeSelector && Object.keys(nodeSelector).length > 0) {
    jobPodSpec.nodeSelector = nodeSelector
  }
  if (tolerations && tolerations.length > 0) {
    jobPodSpec.tolerations = tolerations
  }
  if (topologySpreadConstraints && topologySpreadConstraints.length > 0) {
    jobPodSpec.topologySpreadConstraints = topologySpreadConstraints
  }
  if (affinity && Object.keys(affinity).length > 0) {
    jobPodSpec.affinity = affinity
  }
  if (podSecurityContext && Object.keys(podSecurityContext).length > 0) {
    jobPodSpec.securityContext = podSecurityContext
  }
  if (imagePullSecrets && imagePullSecrets.length > 0) {
    jobPodSpec.imagePullSecrets = imagePullSecrets
  }
  if (priorityClassName) {
    jobPodSpec.priorityClassName = priorityClassName
  }
  if (schedulerName) {
    jobPodSpec.schedulerName = schedulerName
  }

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
      template: {
        metadata: {
          labels: mergedLabels,
        },
        spec: jobPodSpec,
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
  vcs?: Record<string, unknown> | null,
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
  const providerName = asString(readNested(provider, ['metadata', 'name'])) ?? ''
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const payload = buildRunSpec(agentRun, agent, implementation, parameters, memory, outputArtifacts, providerName, vcs)

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
      vcs: asRecord(agentRun.status)?.vcs ?? undefined,
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
      vcs: asRecord(agentRun.status)?.vcs ?? undefined,
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
  const authSecret = resolveAuthSecretConfig()
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
  const blockedSecrets = collectBlockedSecrets([
    ...runSecrets,
    ...(memorySecretName ? [memorySecretName] : []),
    ...(authSecret ? [authSecret.name] : []),
  ])
  if (blockedSecrets.length > 0) {
    return {
      ok: false as const,
      reason: 'SecretBlocked',
      message: `secrets blocked by controller policy: ${blockedSecrets.join(', ')}`,
    }
  }

  const authSecretPolicy = validateAuthSecretPolicy(allowedSecrets, authSecret)
  if (!authSecretPolicy.ok) {
    return authSecretPolicy
  }
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
    const rawServiceAccount = resolveRunnerServiceAccount(runtimeConfig)
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
    allowedSecrets,
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

  let baseConditions = conditions
  let vcsStatus: Record<string, unknown> | undefined

  const baseParameters = resolveParameters(agentRun)
  const baseWorkload = asRecord(readNested(agentRun, ['spec', 'workload'])) ?? {}
  const allowedSecrets = dependencies.allowedSecrets
  const workflowStatus = normalizeWorkflowStatus(asRecord(status.workflow) ?? null, workflowSteps)
  let runtimeRefUpdate: RuntimeRef | null = null
  let workflowFailure: { reason: string; message: string } | null = null
  let workflowRunning = false
  const now = Date.now()
  const completedJobs: Array<{ job: Record<string, unknown>; namespace: string }> = []

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
      const contractCheck = validateImplementationContract(implementation, stepParameters)
      if (!contractCheck.ok) {
        setWorkflowStepPhase(stepStatus, 'Failed', contractCheck.message)
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: 'MissingRequiredMetadata',
          message: `workflow step ${stepSpec.name} ${contractCheck.message}`,
        }
        break
      }

      const stepVcs = await resolveVcsContext({
        kube,
        namespace,
        agentRun,
        agent: dependencies.agent,
        implementation,
        parameters: stepParameters,
        allowedSecrets,
      })
      if (!stepVcs.ok) {
        setWorkflowStepPhase(stepStatus, 'Failed', stepVcs.message ?? 'vcs provider unavailable')
        stepStatus.finishedAt = nowIso()
        workflowFailure = {
          reason: stepVcs.reason ?? 'VcsUnavailable',
          message: `workflow step ${stepSpec.name} ${stepVcs.message ?? 'vcs provider unavailable'}`,
        }
        break
      }
      if (stepVcs.skip && stepVcs.reason) {
        baseConditions = upsertCondition(baseConditions, {
          type: 'VcsSkipped',
          status: 'True',
          reason: stepVcs.reason,
          message: stepVcs.message ?? '',
        })
      }
      if (stepVcs.status) {
        vcsStatus = stepVcs.status
      }
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
          vcs: stepVcs,
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
      if (succeeded > 0 || isJobComplete(job)) {
        setWorkflowStepPhase(stepStatus, 'Succeeded')
        stepStatus.startedAt = asString(jobStatus.startTime) ?? stepStatus.startedAt ?? undefined
        stepStatus.finishedAt = asString(jobStatus.completionTime) ?? nowIso()
        stepStatus.nextRetryAt = undefined
        completedJobs.push({ job, namespace: jobNamespace })
        continue
      }
      if (failed > 0 && isJobFailed(job)) {
        if (stepStatus.attempt < maxAttempts) {
          setWorkflowStepPhase(stepStatus, 'Retrying', 'Step failed; retrying')
          stepStatus.finishedAt = nowIso()
          stepStatus.nextRetryAt =
            stepSpec.retryBackoffSeconds > 0
              ? new Date(now + stepSpec.retryBackoffSeconds * 1000).toISOString()
              : nowIso()
          completedJobs.push({ job, namespace: jobNamespace })
          workflowRunning = true
          break
        }
        setWorkflowStepPhase(stepStatus, 'Failed', 'Step failed')
        stepStatus.finishedAt = nowIso()
        completedJobs.push({ job, namespace: jobNamespace })
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
    const updated = upsertCondition(baseConditions, {
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
      vcs: vcsStatus ?? undefined,
    })
    for (const entry of completedJobs) {
      await applyJobTtlAfterStatus(kube, entry.job, entry.namespace, runtimeConfig)
    }
    return
  }

  const allSucceeded = workflowStatus.steps.every((step) => step.phase === 'Succeeded')
  if (allSucceeded) {
    setWorkflowPhase(workflowStatus, 'Succeeded')
    const updated = upsertCondition(baseConditions, {
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
      vcs: vcsStatus ?? undefined,
    })
    for (const entry of completedJobs) {
      await applyJobTtlAfterStatus(kube, entry.job, entry.namespace, runtimeConfig)
    }
    return
  }

  if (workflowRunning) {
    setWorkflowPhase(workflowStatus, 'Running')
    let updated = baseConditions
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
      vcs: vcsStatus ?? undefined,
    })
    for (const entry of completedJobs) {
      await applyJobTtlAfterStatus(kube, entry.job, entry.namespace, runtimeConfig)
    }
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
  const finishedAt = asString(status.finishedAt)
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

  if (phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled') {
    const retentionSeconds = resolveAgentRunRetentionSeconds(spec)
    if (retentionSeconds > 0 && finishedAt) {
      const finishedAtMs = Date.parse(finishedAt)
      if (!Number.isNaN(finishedAtMs)) {
        const expiresAtMs = finishedAtMs + retentionSeconds * 1000
        if (Date.now() >= expiresAtMs) {
          await kube.delete(RESOURCE_MAP.AgentRun, name, namespace)
          return
        }
      }
    }
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
    const parameters = resolveParameters(agentRun)

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
    const authSecret = resolveAuthSecretConfig()

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
      const rawServiceAccount = resolveRunnerServiceAccount(runtimeConfig)
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

    const contractCheck = validateImplementationContract(implResource, parameters)
    if (!contractCheck.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingRequiredMetadata',
        message: contractCheck.message,
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
    const blockedSecrets = collectBlockedSecrets([
      ...runSecrets,
      ...(memorySecretName ? [memorySecretName] : []),
      ...(authSecret ? [authSecret.name] : []),
    ])
    if (blockedSecrets.length > 0) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'SecretBlocked',
        message: `secrets blocked by controller policy: ${blockedSecrets.join(', ')}`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }

    const authSecretPolicy = validateAuthSecretPolicy(allowedSecrets, authSecret)
    if (!authSecretPolicy.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: authSecretPolicy.reason,
        message: authSecretPolicy.message,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
      return
    }
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

    const vcsResolution = await resolveVcsContext({
      kube,
      namespace,
      agentRun,
      agent,
      implementation: implResource,
      parameters,
      allowedSecrets,
    })
    if (!vcsResolution.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: vcsResolution.reason ?? 'VcsUnavailable',
        message: vcsResolution.message ?? 'vcs provider unavailable',
      })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: nowIso(),
        conditions: updated,
        vcs: vcsResolution.status ?? undefined,
      })
      return
    }
    const baseConditions =
      vcsResolution.skip && vcsResolution.reason
        ? upsertCondition(conditions, {
            type: 'VcsSkipped',
            status: 'True',
            reason: vcsResolution.reason,
            message: vcsResolution.message ?? '',
          })
        : conditions
    const vcsContext = vcsResolution.context ?? null
    const vcsStatus = vcsResolution.status ?? undefined

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
          {
            vcs: vcsResolution,
          },
        )
      } else if (runtimeType === 'custom') {
        newRuntimeRef = await submitCustomRun(agentRun, implResource, memory)
      } else if (runtimeType === 'temporal') {
        newRuntimeRef = await submitTemporalRun(agentRun, agent, provider, implResource, memory, vcsContext)
      } else {
        throw new Error(`unknown runtime type: ${runtimeType}`)
      }

      const updated = upsertCondition(baseConditions, {
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
        vcs: vcsStatus ?? undefined,
      })
    } catch (error) {
      const updated = upsertCondition(baseConditions, {
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
        vcs: vcsStatus ?? undefined,
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
    if (succeeded > 0 || isJobComplete(job)) {
      const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
      await setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Succeeded',
        startedAt: asString(jobStatus.startTime) ?? asString(status.startedAt) ?? undefined,
        finishedAt: asString(jobStatus.completionTime) ?? nowIso(),
        runtimeRef,
        conditions: updated,
        vcs: asRecord(status.vcs) ?? undefined,
      })
      await applyJobTtlAfterStatus(
        kube,
        job,
        asString(runtimeRef.namespace) ?? namespace,
        runtimeConfig,
      )
    } else if (failed > 0 && isJobFailed(job)) {
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
        vcs: asRecord(status.vcs) ?? undefined,
      })
      await applyJobTtlAfterStatus(
        kube,
        job,
        asString(runtimeRef.namespace) ?? namespace,
        runtimeConfig,
      )
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
  const { agents, providers, specs, sources, vcsProviders, memories, runs } = snapshot

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

  for (const source of sources) {
    await reconcileImplementationSource(kube, source, namespace)
  }

  if (isVcsProvidersEnabled()) {
    for (const vcsProvider of vcsProviders) {
      await reconcileVersionControlProvider(kube, vcsProvider, namespace)
    }
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
  const sources = listItems(await kube.list(RESOURCE_MAP.ImplementationSource, namespace))
  const vcsProviders = isVcsProvidersEnabled()
    ? listItems(await kube.list(RESOURCE_MAP.VersionControlProvider, namespace))
    : []
  const providers = listItems(await kube.list(RESOURCE_MAP.AgentProvider, namespace))
  const runs = listItems(await kube.list(RESOURCE_MAP.AgentRun, namespace))

  for (const resource of memories) updateStateMap(nsState.memories, 'ADDED', resource)
  for (const resource of agents) updateStateMap(nsState.agents, 'ADDED', resource)
  for (const resource of specs) updateStateMap(nsState.specs, 'ADDED', resource)
  for (const resource of sources) updateStateMap(nsState.sources, 'ADDED', resource)
  for (const resource of vcsProviders) updateStateMap(nsState.vcsProviders, 'ADDED', resource)
  for (const resource of providers) updateStateMap(nsState.providers, 'ADDED', resource)
  for (const resource of runs) updateStateMap(nsState.runs, 'ADDED', resource)

  enqueueNamespaceTask(namespace, () =>
    reconcileNamespaceSnapshot(kube, namespace, snapshotNamespace(nsState), state, concurrency),
  )
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

  const handleSourceEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.sources, event.type, resource)
    enqueueFull()
  }

  const handleVcsProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.vcsProviders, event.type, resource)
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
      resource: RESOURCE_MAP.ImplementationSource,
      namespace,
      onEvent: handleSourceEvent,
      onError: (error) => console.warn('[jangar] implementation source watch failed', error),
    }),
  )
  if (isVcsProvidersEnabled()) {
    watchHandles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.VersionControlProvider,
        namespace,
        onEvent: handleVcsProviderEvent,
        onError: (error) => console.warn('[jangar] vcs provider watch failed', error),
      }),
    )
  }
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
    controllerState.started = true
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
  controllerState.started = false
}

export const __test = {
  checkCrds,
  reconcileAgentRun,
  reconcileVersionControlProvider,
  reconcileMemory,
  resolveJobImage,
}

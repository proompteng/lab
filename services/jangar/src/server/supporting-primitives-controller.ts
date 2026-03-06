import { spawn } from 'node:child_process'

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { startResourceWatch } from '~/server/kube-watch'
import { assertClusterScopedForWildcard } from '~/server/namespace-scope'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { shouldApplyStatus } from '~/server/status-utils'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY = 'jangar.supporting_controller.enabled'
const SWARM_CRD_REFRESH_INTERVAL_MS = 15_000

const REQUIRED_CRDS = [
  RESOURCE_MAP.Tool,
  RESOURCE_MAP.ToolRun,
  RESOURCE_MAP.ApprovalPolicy,
  RESOURCE_MAP.Budget,
  RESOURCE_MAP.SecretBinding,
  RESOURCE_MAP.Signal,
  RESOURCE_MAP.SignalDelivery,
  RESOURCE_MAP.Schedule,
  RESOURCE_MAP.Artifact,
  RESOURCE_MAP.Workspace,
]
const OPTIONAL_CRDS = [RESOURCE_MAP.Swarm]

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
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
  __jangarSupportingControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__jangarSupportingControllerState) return globalState.__jangarSupportingControllerState
  const initial = { started: false, crdCheckState: null }
  globalState.__jangarSupportingControllerState = initial
  return initial
})()

let started = controllerState.started
let starting = false
let lifecycleToken = 0
let reconciling = false
let swarmWatchersStarted = false
let _crdCheckState: CrdCheckState | null = controllerState.crdCheckState
let watchHandles: Array<{ stop: () => void }> = []
let swarmCrdsRefreshHandle: NodeJS.Timeout | null = null
const namespaceQueues = new Map<string, Promise<void>>()
const queuedResourceKeysByNamespace = new Map<string, Map<string, { rerun: boolean }>>()
const optionalCrdsReady = new Set<string>()
const swarmUnfreezeTimers = new Map<string, NodeJS.Timeout>()
const swarmStatusReconcileThrottleByKey = new Map<string, number>()
const scheduleRunnerStatusReconcileThrottleByKey = new Map<string, number>()

const SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS = 30_000
const SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS = 30_000

const nowIso = () => new Date().toISOString()

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  const flag = (process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED ?? '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false'
}

const shouldStartWithFeatureFlag = async () => {
  if (process.env.NODE_ENV === 'test') return false
  return resolveBooleanFeatureToggle({
    key: DEFAULT_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY,
    keyEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY',
    fallbackEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED',
    defaultValue: shouldStart(),
  })
}

const parseNamespaces = () => {
  const raw = process.env.JANGAR_SUPPORTING_CONTROLLER_NAMESPACES
  if (!raw) return DEFAULT_NAMESPACES
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const namespaces = list.length > 0 ? list : DEFAULT_NAMESPACES
  assertClusterScopedForWildcard(namespaces, 'supporting controller')
  return namespaces
}

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
  const optionalUnavailable: string[] = []
  optionalCrdsReady.clear()
  for (const name of OPTIONAL_CRDS) {
    const resource = name.split('.')[0] ?? name
    const result = await runKubectl(['get', resource, '-n', namespace, '-o', 'json'])
    if (result.code === 0) {
      optionalCrdsReady.add(name)
      continue
    }
    optionalUnavailable.push(name)
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
      console.error('[jangar] missing supporting primitives CRDs:', missing.join(', '))
    }
    if (forbidden.length > 0) {
      console.error(
        `[jangar] insufficient RBAC to read supporting primitives CRDs in namespace ${namespace}: ${forbidden.join(
          ', ',
        )}`,
      )
    }
  }
  if (optionalUnavailable.length > 0) {
    console.warn(
      `[jangar] optional supporting primitives CRDs unavailable in namespace ${namespace}: ${optionalUnavailable.join(', ')}`,
    )
  }
  return state
}

export const getSupportingControllerHealth = () => ({
  enabled: shouldStart(),
  started: controllerState.started,
  namespaces: null,
  crdsReady: controllerState.crdCheckState?.ok ?? null,
  missingCrds: controllerState.crdCheckState?.missing ?? [],
  lastCheckedAt: controllerState.crdCheckState?.checkedAt ?? null,
})

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  const current = namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.warn('[jangar] supporting controller task failed', error)
    })
  namespaceQueues.set(namespace, next)
}

const queueResourceTask = (namespace: string, key: string, task: () => Promise<void>) => {
  const keys = queuedResourceKeysByNamespace.get(namespace) ?? new Map<string, { rerun: boolean }>()
  const existing = keys.get(key)
  if (existing) {
    existing.rerun = true
    return
  }

  const state = { rerun: false }
  keys.set(key, state)
  queuedResourceKeysByNamespace.set(namespace, keys)

  const runTask = () => {
    enqueueNamespaceTask(namespace, async () => {
      try {
        await task()
      } finally {
        const currentKeys = queuedResourceKeysByNamespace.get(namespace)
        const currentState = currentKeys?.get(key)
        if (!currentKeys || !currentState) return
        if (currentState.rerun) {
          currentState.rerun = false
          runTask()
          return
        }
        currentKeys.delete(key)
        if (currentKeys.size === 0) {
          queuedResourceKeysByNamespace.delete(namespace)
        }
      }
    })
  }

  runTask()
}

const clearAllSwarmUnfreezeTimers = () => {
  for (const timer of swarmUnfreezeTimers.values()) {
    clearTimeout(timer)
  }
  swarmUnfreezeTimers.clear()
}

const clearSwarmUnfreezeTimer = (namespace: string, name: string) => {
  const key = `${namespace}/${name}`
  const timer = swarmUnfreezeTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  swarmUnfreezeTimers.delete(key)
}

const startSwarmWatchers = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespaces: string[],
  handles: Array<{ stop: () => void }>,
) => {
  for (const namespace of namespaces) {
    handles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.Swarm,
        namespace,
        onEvent: (event) => handleResourceEvent(kube, namespace, event),
        onError: (error) => console.warn('[jangar] swarm watch failed', error),
      }),
    )
  }
}

const refreshOptionalSwarmWatches = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespaces: string[],
  token: number,
) => {
  if (lifecycleToken !== token || !started) return
  if (swarmWatchersStarted) return
  const crds = await checkCrds()
  if (lifecycleToken !== token || !started) return
  if (!crds.ok || !optionalCrdsReady.has(RESOURCE_MAP.Swarm)) return
  startSwarmWatchers(kube, namespaces, watchHandles)
  swarmWatchersStarted = true
  void reconcileAll(kube, namespaces)
}

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

const buildReadyCondition = (ready: boolean, reason: string, message?: string) =>
  ({
    type: 'Ready',
    status: ready ? 'True' : 'False',
    reason,
    message,
  }) satisfies Omit<Condition, 'lastTransitionTime'>

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

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

const extractComparableValue = (actual: unknown, desired: unknown): unknown => {
  if (desired === null || typeof desired !== 'object') {
    return actual
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return actual
    return desired.map((entry, index) => extractComparableValue(actual[index], entry))
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return actual
  }
  const actualRecord = actual as Record<string, unknown>
  const desiredRecord = desired as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(desiredRecord)) {
    output[key] = extractComparableValue(actualRecord[key], desiredRecord[key])
  }
  return output
}

const normalizeResourceForApplyCompare = (input: Record<string, unknown>, desired: Record<string, unknown>) => {
  const next: Record<string, unknown> = {
    apiVersion: asString(input.apiVersion) ?? asString(desired.apiVersion),
    kind: asString(input.kind) ?? asString(desired.kind),
    metadata: extractComparableValue(asRecord(input.metadata) ?? {}, asRecord(desired.metadata) ?? {}),
  }

  for (const key of Object.keys(desired)) {
    if (key === 'apiVersion' || key === 'kind' || key === 'metadata' || key === 'status') continue
    next[key] = extractComparableValue(input[key], desired[key])
  }

  return next
}

const resolveComparableResource = (kind: string) => {
  if (kind === 'Schedule') return RESOURCE_MAP.Schedule
  if (kind === 'ConfigMap') return 'configmap'
  if (kind === 'CronJob') return 'cronjob'
  if (kind === 'PersistentVolumeClaim') return 'persistentvolumeclaim'
  return null
}

const resolveWatchedResourceForKind = (kind: string) => {
  if (kind === 'Tool') return RESOURCE_MAP.Tool
  if (kind === 'ApprovalPolicy') return RESOURCE_MAP.ApprovalPolicy
  if (kind === 'Budget') return RESOURCE_MAP.Budget
  if (kind === 'SecretBinding') return RESOURCE_MAP.SecretBinding
  if (kind === 'Signal') return RESOURCE_MAP.Signal
  if (kind === 'SignalDelivery') return RESOURCE_MAP.SignalDelivery
  if (kind === 'Schedule') return RESOURCE_MAP.Schedule
  if (kind === 'Swarm') return RESOURCE_MAP.Swarm
  if (kind === 'Workspace') return RESOURCE_MAP.Workspace
  if (kind === 'Artifact') return RESOURCE_MAP.Artifact
  return null
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

const isSwarmStatusOnlyEvent = (eventType: string | undefined, resource: Record<string, unknown>) => {
  if (eventType !== 'MODIFIED') return false
  if (asString(resource.kind) !== 'Swarm') return false
  const generation = asNumber(readNested(resource, ['metadata', 'generation']))
  const observedGeneration = asNumber(readNested(resource, ['status', 'observedGeneration']))
  return generation !== null && observedGeneration !== null && generation === observedGeneration
}

const shouldThrottleSwarmStatusReconcile = (resourceKey: string, nowMs = Date.now()) => {
  const last = swarmStatusReconcileThrottleByKey.get(resourceKey)
  if (last !== undefined && nowMs - last < SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS) {
    return true
  }
  swarmStatusReconcileThrottleByKey.set(resourceKey, nowMs)
  return false
}

const shouldThrottleScheduleRunnerStatusReconcile = (resourceKey: string, nowMs = Date.now()) => {
  const last = scheduleRunnerStatusReconcileThrottleByKey.get(resourceKey)
  if (last !== undefined && nowMs - last < SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS) {
    return true
  }
  scheduleRunnerStatusReconcileThrottleByKey.set(resourceKey, nowMs)
  return false
}

const applyResourceIfChanged = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
) => {
  const kind = asString(resource.kind)
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!kind || !name || !namespace) {
    return kube.apply(resource)
  }

  const comparableResource = resolveComparableResource(kind)
  if (!comparableResource) {
    return kube.apply(resource)
  }

  const existing = await kube.get(comparableResource, name, namespace)
  if (existing) {
    const normalizedExisting = normalizeResourceForApplyCompare(existing, resource)
    const normalizedDesired = normalizeResourceForApplyCompare(resource, resource)
    if (stableStringify(normalizedExisting) === stableStringify(normalizedDesired)) {
      return existing
    }
  }

  return kube.apply(resource)
}

const hashNameSuffix = (value: string) => {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36).padStart(8, '0').slice(0, 8)
}

const makeName = (base: string, suffix: string) => {
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const maxBaseLength = 45
  if (sanitized.length <= maxBaseLength) {
    return `${sanitized}-${suffix}`
  }
  const trimmed = sanitized.slice(0, maxBaseLength)
  return `${trimmed}-${suffix}`
}

const makeHashedName = (base: string, suffix: string) => {
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const maxBaseLength = 63 - 1 - suffix.length
  if (sanitized.length <= maxBaseLength) {
    return `${sanitized}-${suffix}`
  }
  const hash = hashNameSuffix(base)
  const separator = '-'
  const hashBaseLength = Math.max(1, maxBaseLength - hash.length - separator.length)
  const hashBase = sanitized.slice(0, hashBaseLength)
  return `${hashBase}-${hash}-${suffix}`
}

const buildOwnerRefs = (resource: Record<string, unknown>) => {
  const metadata = asRecord(resource.metadata) ?? {}
  const uid = asString(metadata.uid)
  const name = asString(metadata.name)
  if (!uid || !name) return undefined
  return [
    {
      apiVersion: asString(resource.apiVersion) ?? '',
      kind: asString(resource.kind) ?? '',
      name,
      uid,
      controller: true,
      blockOwnerDeletion: true,
    },
  ]
}

const resolveNamespace = (resource: Record<string, unknown>) =>
  asString(readNested(resource, ['metadata', 'namespace'])) ?? 'default'

const STAGE_NAMES = ['discover', 'plan', 'implement', 'verify'] as const
type StageName = (typeof STAGE_NAMES)[number]
type StageTargetRef = { kind: 'AgentRun' | 'OrchestrationRun'; name: string; namespace: string }

const STAGE_CADENCE_KEY: Record<StageName, string> = {
  discover: 'discoverEvery',
  plan: 'planEvery',
  implement: 'implementEvery',
  verify: 'verifyEvery',
}

const STAGE_AGENT_ROLE: Record<StageName, string> = {
  discover: 'architector',
  plan: 'architector',
  implement: 'engineer',
  verify: 'deployer',
}

const STAGE_LAST_RUN_KEY: Record<StageName, string> = {
  discover: 'lastDiscoverAt',
  plan: 'lastPlanAt',
  implement: 'lastImplementAt',
  verify: 'lastVerifyAt',
}

const STAGE_HOURLY_STAGGER_OFFSET: Record<StageName, number> = {
  discover: 0,
  plan: 15,
  implement: 30,
  verify: 45,
}

const TERMINAL_SUCCESS_PHASES = new Set(['succeeded', 'success', 'completed'])
const TERMINAL_FAILURE_PHASES = new Set(['failed', 'error', 'cancelled'])
const ACTIVE_PHASES = new Set(['pending', 'running', 'inprogress', 'progressing', 'queued'])
const SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE = (() => {
  const raw = Number(process.env.JANGAR_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE ?? '5')
  if (!Number.isFinite(raw) || raw < 1) return 5
  return Math.floor(raw)
})()
const SWARM_REQUIREMENT_LABEL_TYPE = 'swarm.proompteng.ai/type'
const SWARM_REQUIREMENT_LABEL_TO = 'swarm.proompteng.ai/to'
const SWARM_REQUIREMENT_LABEL_FROM = 'swarm.proompteng.ai/from'
const SWARM_REQUIREMENT_LABEL_ID = 'swarm.proompteng.ai/requirement-id'
const SWARM_REQUIREMENT_LABEL_ATTEMPT = 'swarm.proompteng.ai/requirement-attempt'
const SWARM_REQUIREMENT_LABEL_CHANNEL = 'swarm.proompteng.ai/requirement-channel'
const SWARM_REQUIREMENT_ANNOTATION_SIGNAL = 'swarm.proompteng.ai/requirement-signal'
const SWARM_AGENT_WORKER_ID_LABEL = 'swarm.proompteng.ai/worker-id'
const SWARM_SCHEDULE_ANNOTATION_WORKER_ID = 'swarm.proompteng.ai/worker-id'
const SWARM_SCHEDULE_ANNOTATION_IDENTITY = 'swarm.proompteng.ai/agent-identity'
const SWARM_SCHEDULE_ANNOTATION_ROLE = 'swarm.proompteng.ai/agent-role'
const SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL = 'swarm.proompteng.ai/owner-channel'
const SWARM_SCHEDULE_ANNOTATION_HULY_BASE_URL = 'swarm.proompteng.ai/huly-base-url'
const SWARM_SCHEDULE_ANNOTATION_HULY_WORKSPACE = 'swarm.proompteng.ai/huly-workspace'
const SWARM_SCHEDULE_ANNOTATION_HULY_PROJECT = 'swarm.proompteng.ai/huly-project'
const SWARM_SCHEDULE_ANNOTATION_HULY_SECRET = 'swarm.proompteng.ai/huly-secret'
const SWARM_SCHEDULE_ANNOTATION_HULY_SKILL_REF = 'swarm.proompteng.ai/huly-skill-ref'
const SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT = (() => {
  const raw = Number(process.env.JANGAR_SWARM_REQUIREMENT_MAX_PAYLOAD_BYTES ?? '16384')
  if (!Number.isFinite(raw) || raw < 1) return 16_384
  return Math.floor(raw)
})()
const SWARM_DEFAULT_HULY_BASE_URL = (() => {
  const value = asString(process.env.JANGAR_SWARM_HULY_BASE_URL)?.trim()
  return value && value.length > 0 ? value : 'https://huly.proompteng.ai'
})()
const SWARM_DEFAULT_HULY_SKILL_REF = (() => {
  const value = asString(process.env.JANGAR_SWARM_HULY_SKILL_REF)?.trim()
  return value && value.length > 0 ? value : 'skills/huly-api/SKILL.md'
})()
const SWARM_REQUIREMENT_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.JANGAR_SWARM_REQUIREMENT_MAX_ATTEMPTS ?? '3')
  if (!Number.isFinite(raw) || raw < 1) return 3
  return Math.floor(raw)
})()

const deriveStageStaggerMinute = (swarmName: string, stage: StageName) => {
  const base = Number.parseInt(hashNameSuffix(swarmName), 36)
  const swarmOffset = Number.isFinite(base) ? base % 15 : 0
  return (STAGE_HOURLY_STAGGER_OFFSET[stage] + swarmOffset) % 60
}

const normalizeRequirementPriority = (value: string | undefined) => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return 2
  if (
    normalized === 'p0' ||
    normalized === 'critical' ||
    normalized === 'urgent' ||
    normalized === 'blocker' ||
    normalized === 'highest'
  ) {
    return 0
  }
  if (normalized === 'p1' || normalized === 'high') {
    return 1
  }
  if (normalized === 'p2' || normalized === 'medium' || normalized === 'normal') {
    return 2
  }
  if (normalized === 'p3' || normalized === 'low') {
    return 3
  }
  return 2
}

const parseSignalPayloadRecord = (payload: unknown) => {
  const directRecord = asRecord(payload)
  if (directRecord) {
    return directRecord
  }
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown
      return asRecord(parsed)
    } catch {
      return null
    }
  }
  return null
}

const resolveRequirementPriorityScore = (signal: Record<string, unknown>) => {
  const signalSpec = asRecord(signal.spec) ?? {}
  const signalMetadata = asRecord(signal.metadata) ?? {}
  const payloadRecord = parseSignalPayloadRecord(signalSpec.payload)
  const payloadContextRecord = payloadRecord ? asRecord(payloadRecord.context) : null
  const candidates = [
    asString(signalSpec.priority),
    asString(signalSpec.severity),
    asString(payloadRecord?.priority),
    asString(payloadRecord?.severity),
    asString(payloadContextRecord?.priority),
    asString(asRecord(signalMetadata.labels)?.priority),
  ]
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return normalizeRequirementPriority(candidate)
    }
  }
  return 2
}

const sortRequirementSignalsForDispatch = (signals: Record<string, unknown>[]) => {
  return signals
    .map((signal) => {
      const metadata = asRecord(signal.metadata) ?? {}
      const signalName = asString(metadata.name) ?? ''
      const createdAt = asString(metadata.creationTimestamp)
      const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN
      return {
        signal,
        signalName,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Number.MAX_SAFE_INTEGER,
        priority: resolveRequirementPriorityScore(signal),
      }
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority
      }
      if (left.createdAtMs !== right.createdAtMs) {
        return left.createdAtMs - right.createdAtMs
      }
      return left.signalName.localeCompare(right.signalName)
    })
    .map((entry) => entry.signal)
}

type SwarmHulyIntegration = {
  baseUrl: string
  workspace?: string
  project?: string
  secretName: string
  skillRef: string
}

type SwarmAgentIdentity = {
  workerId: string
  identity: string
  role: string
}

const normalizeLabelValue = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  if (!normalized) return 'swarm'
  const trimmed = normalized
    .slice(0, 63)
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
  return trimmed || 'swarm'
}

const parseStringList = (raw: unknown) => {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0)
}

const mergeUniqueStrings = (...values: string[][]) => {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const list of values) {
    for (const value of list) {
      if (seen.has(value)) continue
      seen.add(value)
      merged.push(value)
    }
  }
  return merged
}

const GLOBAL_HULY_SECRET = 'huly-api'

const resolveSwarmRunSecrets = (existingSecrets: string[], explicitHulySecret?: string | null) => {
  const filtered = existingSecrets.filter((secret) => secret !== GLOBAL_HULY_SECRET)
  const explicit = explicitHulySecret?.trim()
  if (!explicit) return filtered
  return mergeUniqueStrings(filtered, [explicit])
}

const normalizeHulyBaseUrl = (value: string | null | undefined) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('huly://')) {
    return SWARM_DEFAULT_HULY_BASE_URL
  }
  try {
    const url = new URL(trimmed)
    if (!url.hostname.toLowerCase().includes('huly')) return ''
    // Frontend endpoints do not expose transactor REST routes in-cluster.
    if (url.hostname.toLowerCase().startsWith('front.')) {
      url.hostname = `transactor.${url.hostname.slice('front.'.length)}`
    }
    const origin = `${url.protocol}//${url.host}`
    return origin.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

const resolveSwarmHulyIntegration = (
  spec: Record<string, unknown>,
  owner: Record<string, unknown>,
): SwarmHulyIntegration => {
  const integrations = asRecord(spec.integrations) ?? {}
  const huly = asRecord(integrations.huly) ?? {}
  const authSecretRef = asRecord(huly.authSecretRef) ?? {}
  const baseUrl = normalizeHulyBaseUrl(asString(huly.baseUrl)) || SWARM_DEFAULT_HULY_BASE_URL
  // Avoid implicit global secret fallback; swarm runs should use explicit per-swarm auth secret refs.
  const secretName = asString(authSecretRef.name)?.trim() ?? ''
  const workspace = asString(huly.workspace)?.trim() || undefined
  const project = asString(huly.project)?.trim() || undefined
  const skillRef = asString(huly.skillRef)?.trim() || SWARM_DEFAULT_HULY_SKILL_REF
  return {
    baseUrl,
    workspace,
    project,
    secretName,
    skillRef,
  }
}

const buildSwarmAgentIdentity = (input: { swarmName: string; stage: StageName; seedSuffix?: string }) => {
  const seed = `${input.swarmName}:${input.stage}:${input.seedSuffix ?? ''}`
  const hash = hashNameSuffix(seed)
  const workerId = `worker-${hash.slice(0, 8)}`
  const swarmLabel = normalizeLabelValue(input.swarmName)
  const identity = `vw-${swarmLabel}-${input.stage}-${workerId}`.slice(0, 120)
  return {
    workerId,
    identity,
    role: STAGE_AGENT_ROLE[input.stage],
  } satisfies SwarmAgentIdentity
}

const buildSwarmRuntimeParameters = (input: {
  ownerChannel: string | null
  huly: SwarmHulyIntegration
  identity: SwarmAgentIdentity
}) => {
  const parameters: Record<string, string> = {
    swarmAgentWorkerId: input.identity.workerId,
    swarmAgentIdentity: input.identity.identity,
    swarmAgentRole: input.identity.role,
    hulyApiBaseUrl: input.huly.baseUrl,
    hulySkillRef: input.huly.skillRef,
  }
  if (input.ownerChannel) {
    parameters.ownerChannel = input.ownerChannel
  }
  if (input.huly.workspace) {
    parameters.hulyWorkspace = input.huly.workspace
  }
  if (input.huly.project) {
    parameters.hulyProject = input.huly.project
  }
  return parameters
}

const buildSwarmScheduleAnnotations = (input: {
  ownerChannel: string | null
  huly: SwarmHulyIntegration
  identity: SwarmAgentIdentity
}) => {
  const annotations: Record<string, string> = {
    [SWARM_SCHEDULE_ANNOTATION_WORKER_ID]: input.identity.workerId,
    [SWARM_SCHEDULE_ANNOTATION_IDENTITY]: input.identity.identity,
    [SWARM_SCHEDULE_ANNOTATION_ROLE]: input.identity.role,
    [SWARM_SCHEDULE_ANNOTATION_HULY_BASE_URL]: input.huly.baseUrl,
    [SWARM_SCHEDULE_ANNOTATION_HULY_SECRET]: input.huly.secretName,
    [SWARM_SCHEDULE_ANNOTATION_HULY_SKILL_REF]: input.huly.skillRef,
  }
  if (input.ownerChannel) {
    annotations[SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL] = input.ownerChannel
  }
  if (input.huly.workspace) {
    annotations[SWARM_SCHEDULE_ANNOTATION_HULY_WORKSPACE] = input.huly.workspace
  }
  if (input.huly.project) {
    annotations[SWARM_SCHEDULE_ANNOTATION_HULY_PROJECT] = input.huly.project
  }
  return annotations
}

const resolveScheduleRuntimeInjection = (schedule: Record<string, unknown>) => {
  const annotations = asRecord(readNested(schedule, ['metadata', 'annotations'])) ?? {}
  const ownerChannel = asString(annotations[SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL]) ?? null
  const workerId = asString(annotations[SWARM_SCHEDULE_ANNOTATION_WORKER_ID])
  const identity = asString(annotations[SWARM_SCHEDULE_ANNOTATION_IDENTITY])
  const role = asString(annotations[SWARM_SCHEDULE_ANNOTATION_ROLE])
  const hulyBaseUrl = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_BASE_URL])
  const hulyWorkspace = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_WORKSPACE])
  const hulyProject = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_PROJECT])
  const hulySecret = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_SECRET])
  const hulySkillRef = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_SKILL_REF])

  const parameters: Record<string, string> = {}
  if (ownerChannel) parameters.ownerChannel = ownerChannel
  if (workerId) parameters.swarmAgentWorkerId = workerId
  if (identity) parameters.swarmAgentIdentity = identity
  if (role) parameters.swarmAgentRole = role
  if (hulyBaseUrl) parameters.hulyApiBaseUrl = hulyBaseUrl
  if (hulyWorkspace) parameters.hulyWorkspace = hulyWorkspace
  if (hulyProject) parameters.hulyProject = hulyProject
  if (hulySkillRef) parameters.hulySkillRef = hulySkillRef

  return {
    parameters,
    hulySecret,
  }
}

const parseDurationToMs = (raw: string) => {
  const value = raw.trim().toLowerCase()
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(
    value,
  )
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = match[2]
  if (unit.startsWith('s')) return amount * 1000
  if (unit.startsWith('m')) return amount * 60 * 1000
  if (unit.startsWith('h')) return amount * 60 * 60 * 1000
  return amount * 24 * 60 * 60 * 1000
}

const cadenceToCron = (raw: string, options?: { swarmName?: string; stage?: StageName }) => {
  const durationMs = parseDurationToMs(raw)
  if (!durationMs) return null
  const durationMinutes = durationMs / (60 * 1000)

  if (durationMinutes < 1) {
    return null
  }

  if (durationMinutes < 60 && Number.isInteger(durationMinutes)) {
    return `*/${durationMinutes} * * * *`
  }

  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60
    if (hours >= 1 && hours <= 23 && Number.isInteger(hours)) {
      if (options?.swarmName && options?.stage) {
        const minute = deriveStageStaggerMinute(options.swarmName, options.stage)
        if (hours === 1) {
          return `${minute} * * * *`
        }
        return `${minute} */${hours} * * *`
      }
      return `0 */${hours} * * *`
    }
  }

  if (durationMinutes % (24 * 60) === 0) {
    const days = durationMinutes / (24 * 60)
    if (days >= 1 && days <= 28 && Number.isInteger(days)) {
      return `0 0 */${days} * *`
    }
  }

  return null
}

const collectStaleStageSignals = (
  stageConfigs: Array<{
    stage: StageName
    enabled: boolean
    every?: string
  }>,
  status: Record<string, unknown>,
  runs: Record<string, unknown>[],
  nowMs: number,
) => {
  const staleSignals = []
  for (const stageConfig of stageConfigs) {
    if (!stageConfig.enabled) continue
    if (!stageConfig.every) continue
    const cadenceMs = parseDurationToMs(stageConfig.every)
    if (cadenceMs === null || cadenceMs <= 0) continue
    const stageRuns = runs.filter(
      (run) => asString(readNested(run, ['metadata', 'labels', 'swarm.proompteng.ai/stage'])) === stageConfig.stage,
    )
    const latestRunTime = sortByMostRecentRun(stageRuns).at(0)
    const fromRuns = parseTimeOrNull(getRunTimestamp(latestRunTime ?? {}))
    const fromStatus = parseTimeOrNull(asString(readNested(status, [STAGE_LAST_RUN_KEY[stageConfig.stage]]) ?? null))
    const lastRunMs = [fromRuns, fromStatus]
      .filter((value): value is number => value !== null)
      .reduce((left, right) => Math.max(left, right), Number.NEGATIVE_INFINITY)
    if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) {
      continue
    }
    const ageMs = nowMs - lastRunMs
    const maxAgeMs = 2 * cadenceMs
    if (ageMs <= maxAgeMs) {
      continue
    }
    staleSignals.push({
      stage: stageConfig.stage,
      lastRunAt: new Date(lastRunMs).toISOString(),
      ageMs,
      configuredEveryMs: cadenceMs,
      configuredEvery: stageConfig.every,
      staleAfterMs: maxAgeMs,
    })
  }
  return staleSignals
}

const resolveStageEvery = (spec: Record<string, unknown>, stageSpec: Record<string, unknown>, stage: StageName) => {
  const stageEvery = asString(stageSpec.every)
  if (stageEvery) return stageEvery
  const cadence = asRecord(spec.cadence) ?? {}
  return asString(cadence[STAGE_CADENCE_KEY[stage]])
}

const resolveStageTargetRef = (stageSpec: Record<string, unknown>, defaultNamespace: string) => {
  const targetRef = asRecord(stageSpec.targetRef) ?? {}
  const kind = asString(targetRef.kind)
  const name = asString(targetRef.name)
  const namespace = asString(targetRef.namespace) ?? defaultNamespace
  if (!kind || !name) return null
  if (kind !== 'AgentRun' && kind !== 'OrchestrationRun') return null
  return { kind, name, namespace } satisfies StageTargetRef
}

const resolveStageApiVersion = (kind: string) => {
  if (kind === 'AgentRun') return 'agents.proompteng.ai/v1alpha1'
  if (kind === 'OrchestrationRun') return 'orchestration.proompteng.ai/v1alpha1'
  return ''
}

const stageScheduleName = (swarmName: string, stage: StageName) => makeHashedName(swarmName, `${stage}-sched`)

const getRunTimestamp = (resource: Record<string, unknown>) => {
  return (
    asString(readNested(resource, ['status', 'startedAt'])) ??
    asString(readNested(resource, ['status', 'finishedAt'])) ??
    asString(readNested(resource, ['metadata', 'creationTimestamp']))
  )
}

const parseTimeOrNull = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const scheduleSwarmUnfreezeReconcile = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  swarmName: string,
  freezeUntil: string,
) => {
  const untilMs = parseTimeOrNull(freezeUntil)
  if (untilMs === null) return

  clearSwarmUnfreezeTimer(namespace, swarmName)

  const key = `${namespace}/${swarmName}`
  const scheduleChunk = (delayMs: number) => {
    const clampedDelay = Math.min(Math.max(0, delayMs), 2_147_483_647)
    const timer = setTimeout(async () => {
      if (delayMs <= 2_147_483_647) {
        swarmUnfreezeTimers.delete(key)
        queueResourceTask(namespace, `Swarm/${namespace}/${swarmName}`, async () => {
          const latest = await kube.get(RESOURCE_MAP.Swarm, swarmName, namespace)
          if (!latest) return
          await reconcileSwarm(kube, latest, namespace)
        })
        return
      }
      scheduleChunk(delayMs - 2_147_483_647)
    }, clampedDelay)
    swarmUnfreezeTimers.set(key, timer)
  }

  scheduleChunk(Math.max(0, untilMs - Date.now()))
}

const sortByMostRecentRun = (resources: Record<string, unknown>[]) => {
  return [...resources].sort((left, right) => {
    const leftTs = parseTimeOrNull(getRunTimestamp(left))
    const rightTs = parseTimeOrNull(getRunTimestamp(right))
    if (leftTs === null && rightTs === null) return 0
    if (leftTs === null) return 1
    if (rightTs === null) return -1
    return rightTs - leftTs
  })
}

const isIdempotencyDuplicateRun = (resource: Record<string, unknown>) => {
  const rawConditions = readNested(resource, ['status', 'conditions'])
  const conditions = Array.isArray(rawConditions) ? rawConditions : []
  if (conditions.length === 0) return false
  return conditions.some((condition) => {
    const record = asRecord(condition)
    if (!record) return false
    const reason = (asString(record.reason) ?? '').toLowerCase()
    const type = (asString(record.type) ?? '').toLowerCase()
    return reason === 'idempotencykeyinuse' || type === 'duplicate'
  })
}

const countConsecutiveFailures = (resources: Record<string, unknown>[]) => {
  const sorted = sortByMostRecentRun(resources)
  let failures = 0
  for (const resource of sorted) {
    if (isIdempotencyDuplicateRun(resource)) continue
    const phase = (asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase()
    if (!phase) continue
    if (TERMINAL_FAILURE_PHASES.has(phase)) {
      failures += 1
      continue
    }
    if (TERMINAL_SUCCESS_PHASES.has(phase)) break
    if (ACTIVE_PHASES.has(phase)) break
  }
  return failures
}

const collectRecentFailureRuns = (resources: Record<string, unknown>[], limit = 5) => {
  const sorted = sortByMostRecentRun(resources)
  const failures = sorted
    .filter((resource) => {
      if (isIdempotencyDuplicateRun(resource)) return false
      const phase = (asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase()
      return TERMINAL_FAILURE_PHASES.has(phase)
    })
    .slice(0, limit)
  return failures.map((resource) => {
    const name = asString(readNested(resource, ['metadata', 'name'])) ?? 'unknown'
    const namespace = asString(readNested(resource, ['metadata', 'namespace'])) ?? ''
    const phase = (asString(readNested(resource, ['status', 'phase'])) ?? '').toLowerCase()
    const timestamp = getRunTimestamp(resource)
    const conclusion = asString(readNested(resource, ['status', 'conclusion']))
    const failedCondition = (
      Array.isArray(readNested(resource, ['status', 'conditions']))
        ? (readNested(resource, ['status', 'conditions']) as unknown[])
        : []
    )
      .map((entry) => asRecord(entry))
      .find((condition) => asString(condition?.type) === 'Failed' && asString(condition?.status) === 'True')
    const failedStep = (
      Array.isArray(readNested(resource, ['status', 'workflow', 'steps']))
        ? (readNested(resource, ['status', 'workflow', 'steps']) as unknown[])
        : []
    )
      .map((entry) => asRecord(entry))
      .find((step) => asString(step?.phase) === 'Failed')
    const reason =
      asString(readNested(resource, ['status', 'message'])) ??
      asString(readNested(resource, ['status', 'reason'])) ??
      asString(failedCondition?.message) ??
      asString(failedCondition?.reason) ??
      asString(failedStep?.message)
    return {
      name,
      namespace,
      phase,
      timestamp,
      conclusion: conclusion || null,
      reason: reason || null,
    }
  })
}

const filterRunsAfterTime = (resources: Record<string, unknown>[], timestampMs: number | null) => {
  if (timestampMs === null) return resources
  return resources.filter((resource) => {
    const runTimestamp = parseTimeOrNull(getRunTimestamp(resource))
    return runTimestamp !== null && runTimestamp > timestampMs
  })
}

const requirementIdForSignal = (signalNamespace: string, signalName: string) =>
  hashNameSuffix(`${signalNamespace}/${signalName}`)

const isHulyChannel = (channel: string | null | undefined) => {
  if (!channel) return false
  const value = channel.trim()
  if (!value) return false
  if (value.toLowerCase().startsWith('huly://')) return true
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().includes('huly')
  } catch {
    return false
  }
}

const stringifyUnknown = (value: unknown) => {
  if (typeof value === 'string') return value
  try {
    const result = JSON.stringify(value)
    return result === undefined ? '' : result
  } catch {
    return ''
  }
}

const truncateUtf8 = (value: string, maxBytes: number) => {
  const safeMaxBytes = Math.max(0, maxBytes)
  if (!value) return ''
  if (safeMaxBytes === 0) return ''

  let usedBytes = 0
  const encoder = new TextEncoder()
  let result = ''

  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength
    if (usedBytes + charBytes > safeMaxBytes) break
    usedBytes += charBytes
    result += char
  }

  return result
}

const clampUtf8 = (value: string, maxBytes: number) => {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(value)
  if (encoded.byteLength <= maxBytes) {
    return {
      value,
      bytes: encoded.byteLength,
      truncated: false,
    }
  }

  return {
    value: truncateUtf8(value, maxBytes),
    bytes: encoded.byteLength,
    truncated: true,
  }
}

const extractPayloadObjective = (payload: string) => {
  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ''
    }

    const objectiveValue = parsed.objective
    if (typeof objectiveValue === 'string') {
      const normalized = objectiveValue.trim()
      if (normalized.length > 0) return normalized
    }

    const acceptanceValue = parsed.acceptance
    if (typeof acceptanceValue === 'string') {
      const normalized = acceptanceValue.trim()
      if (normalized.length > 0) return `acceptance: ${normalized}`
    }
    if (Array.isArray(acceptanceValue)) {
      const acceptanceList = acceptanceValue
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
      if (acceptanceList.length > 0) {
        return `acceptance: ${acceptanceList.join(', ')}`
      }
    }

    const missionValue = parsed.mission
    if (typeof missionValue === 'string') {
      const normalized = missionValue.trim()
      if (normalized.length > 0) return `mission: ${normalized}`
    }

    const objectiveSource = extractPayloadObjectiveObject(parsed as Record<string, unknown>)
    if (objectiveSource) {
      return objectiveSource
    }
  } catch {
    // ignore malformed payloads
  }
  return ''
}

const extractPayloadObjectiveObject = (payload: Record<string, unknown>) => {
  const fields: Array<unknown> = [payload.objective, payload.scope, payload.goal, payload.summary]
  for (const value of fields) {
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (normalized.length > 0) return normalized
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
  }
  return ''
}

const makeRequirementObjective = (description: string, payload: string) => {
  const payloadObjective = payload ? extractPayloadObjective(payload) : ''
  const objectiveSource = payloadObjective || payload
  const parts = [description, objectiveSource].filter((value) => value.length > 0)
  if (parts.length === 0) return ''
  const combined = parts.join('\n\n')
  return clampUtf8(combined, SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT).value
}

const normalizeParameterMap = (raw: unknown) => {
  const record = asRecord(raw) ?? {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      output[key] = value
      continue
    }
    if (value === null || value === undefined) continue
    output[key] = stringifyUnknown(value)
  }
  return output
}

const makeGenerateName = (base: string, suffix: string) => {
  const candidate = makeHashedName(base, suffix)
  const trimmed = candidate.slice(0, 62).replace(/-+$/, '')
  return `${trimmed || 'run'}-`
}

const resolveStageTargetResource = async (
  kube: ReturnType<typeof createKubernetesClient>,
  targetRef: StageTargetRef,
) => {
  if (targetRef.kind === 'AgentRun') {
    return kube.get(RESOURCE_MAP.AgentRun, targetRef.name, targetRef.namespace)
  }
  return kube.get(RESOURCE_MAP.OrchestrationRun, targetRef.name, targetRef.namespace)
}

const reconcileTool = async (kube: ReturnType<typeof createKubernetesClient>, tool: Record<string, unknown>) => {
  const spec = asRecord(tool.spec) ?? {}
  const image = asString(spec.image)
  const command = Array.isArray(spec.command) ? spec.command : []
  const args = Array.isArray(spec.args) ? spec.args : []
  const isValid = Boolean(image) && (command.length > 0 || args.length > 0)
  const conditions = upsertCondition(
    normalizeConditions(asRecord(tool.status)?.conditions),
    buildReadyCondition(
      isValid,
      isValid ? 'Valid' : 'InvalidSpec',
      isValid ? 'tool is ready' : 'spec.image and command or args are required',
    ),
  )
  await setStatus(kube, tool, {
    observedGeneration: asRecord(tool.metadata)?.generation ?? 0,
    phase: isValid ? 'Ready' : 'Invalid',
    conditions,
  })
}

const reconcileApprovalPolicy = async (
  kube: ReturnType<typeof createKubernetesClient>,
  policy: Record<string, unknown>,
) => {
  const conditions = upsertCondition(
    normalizeConditions(asRecord(policy.status)?.conditions),
    buildReadyCondition(true, 'Active', 'approval policy active'),
  )
  await setStatus(kube, policy, {
    observedGeneration: asRecord(policy.metadata)?.generation ?? 0,
    phase: 'Active',
    conditions,
  })
}

const reconcileBudget = async (kube: ReturnType<typeof createKubernetesClient>, budget: Record<string, unknown>) => {
  const status = asRecord(budget.status) ?? {}
  const used = asRecord(status.used) ?? { tokens: '0', dollars: '0', cpu: '0', memory: '0', gpu: '0' }
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(true, 'Active', 'budget active'),
  )
  await setStatus(kube, budget, {
    observedGeneration: asRecord(budget.metadata)?.generation ?? 0,
    phase: asString(status.phase) ?? 'Active',
    used,
    conditions,
  })
}

const reconcileSecretBinding = async (
  kube: ReturnType<typeof createKubernetesClient>,
  binding: Record<string, unknown>,
) => {
  const spec = asRecord(binding.spec) ?? {}
  const subjects = Array.isArray(spec.subjects) ? spec.subjects : []
  const allowed = Array.isArray(spec.allowedSecrets) ? spec.allowedSecrets : []
  const isValid = subjects.length > 0 && allowed.length > 0
  const conditions = upsertCondition(
    normalizeConditions(asRecord(binding.status)?.conditions),
    buildReadyCondition(
      isValid,
      isValid ? 'Valid' : 'InvalidSpec',
      isValid ? 'secret binding ready' : 'subjects and allowedSecrets are required',
    ),
  )
  await setStatus(kube, binding, {
    observedGeneration: asRecord(binding.metadata)?.generation ?? 0,
    phase: isValid ? 'Ready' : 'Invalid',
    conditions,
  })
}

const reconcileSignal = async (kube: ReturnType<typeof createKubernetesClient>, signal: Record<string, unknown>) => {
  const status = asRecord(signal.status) ?? {}
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(true, 'Active', 'signal active'),
  )
  await setStatus(kube, signal, {
    observedGeneration: asRecord(signal.metadata)?.generation ?? 0,
    phase: asString(status.phase) ?? 'Active',
    lastDeliveryAt: asString(status.lastDeliveryAt) ?? undefined,
    conditions,
  })
}

const reconcileSignalDelivery = async (
  kube: ReturnType<typeof createKubernetesClient>,
  delivery: Record<string, unknown>,
) => {
  const namespace = resolveNamespace(delivery)
  const spec = asRecord(delivery.spec) ?? {}
  const signalName = asString(readNested(spec, ['signalRef', 'name']))
  const status = asRecord(delivery.status) ?? {}
  if (!signalName) {
    const conditions = upsertCondition(
      normalizeConditions(status.conditions),
      buildReadyCondition(false, 'InvalidSpec', 'spec.signalRef.name is required'),
    )
    await setStatus(kube, delivery, {
      observedGeneration: asRecord(delivery.metadata)?.generation ?? 0,
      phase: 'Invalid',
      conditions,
    })
    return
  }
  const signal = await kube.get(RESOURCE_MAP.Signal, signalName, namespace)
  if (!signal) {
    const conditions = upsertCondition(
      normalizeConditions(status.conditions),
      buildReadyCondition(false, 'SignalMissing', `signal ${signalName} not found`),
    )
    await setStatus(kube, delivery, {
      observedGeneration: asRecord(delivery.metadata)?.generation ?? 0,
      phase: 'Pending',
      conditions,
    })
    return
  }

  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(true, 'Delivered', 'signal delivered'),
  )
  await setStatus(kube, delivery, {
    observedGeneration: asRecord(delivery.metadata)?.generation ?? 0,
    phase: 'Delivered',
    deliveredAt: asString(status.deliveredAt) ?? nowIso(),
    conditions,
  })
}

const buildScheduleRunTemplate = (
  schedule: Record<string, unknown>,
  target: Record<string, unknown>,
  deliveryPlaceholder: string,
) => {
  const targetKind = asString(target.kind) ?? ''
  const targetNamespace = asString(readNested(target, ['metadata', 'namespace'])) ?? resolveNamespace(schedule)
  const scheduleName = asString(readNested(schedule, ['metadata', 'name'])) ?? 'schedule'
  const scheduleLabels = asRecord(readNested(schedule, ['metadata', 'labels'])) ?? {}
  const inheritedLabels = Object.fromEntries(
    Object.entries(scheduleLabels).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        key !== 'schedules.proompteng.ai/schedule' &&
        key !== 'jangar.proompteng.ai/delivery-id',
    ),
  ) as Record<string, string>
  const labels = {
    ...inheritedLabels,
    'schedules.proompteng.ai/schedule': scheduleName,
    'jangar.proompteng.ai/delivery-id': deliveryPlaceholder,
  }
  const runtimeInjection = resolveScheduleRuntimeInjection(schedule)

  if (targetKind === 'AgentRun') {
    const spec = asRecord(target.spec) ?? {}
    const existingParameters = normalizeParameterMap(spec.parameters)
    const existingSecrets = parseStringList(spec.secrets)
    const mergedSecrets = resolveSwarmRunSecrets(existingSecrets, runtimeInjection.hulySecret)
    return {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        generateName: `${scheduleName}-`,
        namespace: targetNamespace,
        labels,
      },
      spec: {
        ...spec,
        idempotencyKey: deliveryPlaceholder,
        parameters: {
          ...existingParameters,
          ...runtimeInjection.parameters,
        },
        ...(mergedSecrets.length > 0 ? { secrets: mergedSecrets } : {}),
      },
    }
  }

  if (targetKind === 'OrchestrationRun') {
    const spec = asRecord(target.spec) ?? {}
    const existingParameters = normalizeParameterMap(spec.parameters)
    return {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: {
        generateName: `${scheduleName}-`,
        namespace: targetNamespace,
        labels,
      },
      spec: {
        ...spec,
        deliveryId: deliveryPlaceholder,
        parameters: {
          ...existingParameters,
          ...runtimeInjection.parameters,
        },
      },
    }
  }

  throw new Error(`unsupported schedule target kind: ${targetKind || 'unknown'}`)
}

const resolveScheduleTarget = async (
  kube: ReturnType<typeof createKubernetesClient>,
  schedule: Record<string, unknown>,
) => {
  const spec = asRecord(schedule.spec) ?? {}
  const targetRef = asRecord(spec.targetRef) ?? {}
  const targetKind = asString(targetRef.kind)
  const targetName = asString(targetRef.name)
  const targetNamespace = asString(targetRef.namespace) ?? resolveNamespace(schedule)
  if (!targetKind || !targetName) {
    throw new Error('spec.targetRef.kind and spec.targetRef.name are required')
  }
  if (targetKind === 'AgentRun') {
    const target = await kube.get(RESOURCE_MAP.AgentRun, targetName, targetNamespace)
    if (!target) throw new Error(`agent run ${targetName} not found`)
    return target
  }
  if (targetKind === 'OrchestrationRun') {
    const target = await kube.get(RESOURCE_MAP.OrchestrationRun, targetName, targetNamespace)
    if (!target) throw new Error(`orchestration run ${targetName} not found`)
    return target
  }
  throw new Error(`unsupported schedule target kind: ${targetKind}`)
}

const buildScheduleRunnerCommand = (): string =>
  [
    'DELIVERY_ID=$(cat /proc/sys/kernel/random/uuid);',
    'sed "s/__JANGAR_DELIVERY_ID__/${DELIVERY_ID}/g" /config/run.json | kubectl create -f -',
  ].join(' ')

const reconcileScheduleRunnerStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  schedule: Record<string, unknown>,
  namespace: string,
) => {
  const status = asRecord(schedule.status) ?? {}
  const scheduleName = asString(readNested(schedule, ['metadata', 'name'])) ?? 'schedule'
  const cronJobName = makeName(scheduleName, 'cron')
  const cronResource = await kube.get('cronjob', cronJobName, namespace)
  const lastRunTime = asString(readNested(cronResource ?? {}, ['status', 'lastScheduleTime'])) ?? undefined
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(true, 'Active', 'schedule active'),
  )
  await setStatus(kube, schedule, {
    observedGeneration: asRecord(schedule.metadata)?.generation ?? 0,
    phase: 'Active',
    lastRunTime,
    conditions,
  })
}

const reconcileSchedule = async (
  kube: ReturnType<typeof createKubernetesClient>,
  schedule: Record<string, unknown>,
  namespace: string,
) => {
  const spec = asRecord(schedule.spec) ?? {}
  const cron = asString(spec.cron)
  const timezone = asString(spec.timezone)
  const status = asRecord(schedule.status) ?? {}
  const scheduleName = asString(readNested(schedule, ['metadata', 'name'])) ?? 'schedule'
  if (!cron) {
    const conditions = upsertCondition(
      normalizeConditions(status.conditions),
      buildReadyCondition(false, 'InvalidSpec', 'spec.cron is required'),
    )
    await setStatus(kube, schedule, {
      observedGeneration: asRecord(schedule.metadata)?.generation ?? 0,
      phase: 'Invalid',
      conditions,
    })
    return
  }

  try {
    const target = await resolveScheduleTarget(kube, schedule)
    const deliveryPlaceholder = '__JANGAR_DELIVERY_ID__'
    const template = buildScheduleRunTemplate(schedule, target, deliveryPlaceholder)
    const configName = makeName(scheduleName, 'template')
    const ownerReferences = buildOwnerRefs(schedule)
    const labels = { 'schedules.proompteng.ai/schedule': scheduleName }
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configName,
        namespace,
        labels,
        ...(ownerReferences ? { ownerReferences } : {}),
      },
      data: {
        'run.json': JSON.stringify(template, null, 2),
      },
    }
    await applyResourceIfChanged(kube, configMap)

    const image =
      process.env.JANGAR_SCHEDULE_RUNNER_IMAGE || process.env.JANGAR_IMAGE || 'ghcr.io/proompteng/jangar:latest'
    const podNamespace = process.env.JANGAR_POD_NAMESPACE
    const scheduleServiceAccount =
      process.env.JANGAR_SCHEDULE_SERVICE_ACCOUNT || process.env.JANGAR_SERVICE_ACCOUNT_NAME
    const serviceAccountName =
      scheduleServiceAccount && podNamespace === namespace
        ? scheduleServiceAccount
        : process.env.JANGAR_SCHEDULE_SERVICE_ACCOUNT || undefined
    const cronJobName = makeName(scheduleName, 'cron')
    const cronJob = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: {
        name: cronJobName,
        namespace,
        labels,
        ...(ownerReferences ? { ownerReferences } : {}),
      },
      spec: {
        schedule: cron,
        timeZone: timezone ?? undefined,
        concurrencyPolicy: 'Forbid',
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 1,
        jobTemplate: {
          spec: {
            template: {
              metadata: { labels },
              spec: {
                serviceAccountName,
                restartPolicy: 'Never',
                containers: [
                  {
                    name: 'schedule-runner',
                    image,
                    command: ['/bin/sh', '-ec', buildScheduleRunnerCommand()],
                    volumeMounts: [{ name: 'schedule-template', mountPath: '/config' }],
                  },
                ],
                volumes: [
                  {
                    name: 'schedule-template',
                    configMap: {
                      name: configName,
                    },
                  },
                ],
              },
            },
          },
        },
      },
    }
    await applyResourceIfChanged(kube, cronJob)
    await reconcileScheduleRunnerStatus(kube, schedule, namespace)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const conditions = upsertCondition(
      normalizeConditions(status.conditions),
      buildReadyCondition(false, 'InvalidSpec', message),
    )
    await setStatus(kube, schedule, {
      observedGeneration: asRecord(schedule.metadata)?.generation ?? 0,
      phase: 'Invalid',
      conditions,
    })
  }
}

const reconcileSwarm = async (
  kube: ReturnType<typeof createKubernetesClient>,
  swarm: Record<string, unknown>,
  namespace: string,
) => {
  const metadata = asRecord(swarm.metadata) ?? {}
  const spec = asRecord(swarm.spec) ?? {}
  const status = asRecord(swarm.status) ?? {}
  const conditionsBase = normalizeConditions(status.conditions)
  const swarmName = asString(metadata.name) ?? 'swarm'
  const swarmNamespace = asString(metadata.namespace) ?? namespace
  const swarmUid = asString(metadata.uid)
  const owner = asRecord(spec.owner) ?? {}
  const mode = asString(spec.mode) ?? ''
  const timezone = asString(spec.timezone) ?? 'UTC'
  const execution = asRecord(spec.execution) ?? {}
  const risk = asRecord(spec.risk) ?? {}
  const ownerChannel = asString(owner.channel) ?? null
  const huly = resolveSwarmHulyIntegration(spec, owner)

  const freezeAfterFailuresRaw = Number(risk.freezeAfterFailures)
  const freezeAfterFailures =
    Number.isFinite(freezeAfterFailuresRaw) && freezeAfterFailuresRaw >= 1 ? Math.floor(freezeAfterFailuresRaw) : 3
  const freezeDurationRaw = asString(risk.freezeDuration) ?? '60m'
  const freezeDurationMs = parseDurationToMs(freezeDurationRaw) ?? 60 * 60 * 1000

  const errors: string[] = []

  if (!asString(owner.id)) {
    errors.push('spec.owner.id is required')
  }
  if (!asString(owner.channel)) {
    errors.push('spec.owner.channel is required')
  }
  if (mode !== 'assisted' && mode !== 'lights-out') {
    errors.push('spec.mode must be assisted or lights-out')
  }

  const stageConfigs: Array<{
    stage: StageName
    enabled: boolean
    scheduleName: string
    every?: string
    cron?: string
    targetRef?: StageTargetRef
  }> = []

  for (const stage of STAGE_NAMES) {
    const stageSpec = asRecord(execution[stage]) ?? {}
    const enabled = stageSpec.enabled !== false
    const scheduleName = stageScheduleName(swarmName, stage)
    if (!enabled) {
      stageConfigs.push({ stage, enabled, scheduleName })
      continue
    }

    const every = resolveStageEvery(spec, stageSpec, stage)
    if (!every) {
      errors.push(`spec.execution.${stage}.every or spec.cadence.${STAGE_CADENCE_KEY[stage]} is required`)
      stageConfigs.push({ stage, enabled, scheduleName })
      continue
    }

    const cron = cadenceToCron(every, { swarmName, stage })
    if (!cron) {
      errors.push(`unsupported cadence for ${stage}: ${every}`)
      stageConfigs.push({ stage, enabled, scheduleName, every })
      continue
    }

    const targetRef = resolveStageTargetRef(stageSpec, swarmNamespace)
    if (!targetRef) {
      errors.push(`spec.execution.${stage}.targetRef requires kind (AgentRun|OrchestrationRun) and name`)
      stageConfigs.push({ stage, enabled, scheduleName, every, cron })
      continue
    }

    stageConfigs.push({ stage, enabled, scheduleName, every, cron, targetRef })
  }

  if (errors.length > 0) {
    clearSwarmUnfreezeTimer(swarmNamespace, swarmName)
    for (const stageConfig of stageConfigs) {
      try {
        await kube.delete(RESOURCE_MAP.Schedule, stageConfig.scheduleName, swarmNamespace, { wait: false })
      } catch {
        // best effort
      }
    }

    const conditions = upsertCondition(conditionsBase, buildReadyCondition(false, 'InvalidSpec', errors.join('; ')))
    await setStatus(kube, swarm, {
      observedGeneration: asRecord(swarm.metadata)?.generation ?? 0,
      phase: 'Invalid',
      conditions,
    })
    return
  }

  const swarmLabel = normalizeLabelValue(swarmName)
  const swarmSelector = swarmUid
    ? `swarm.proompteng.ai/name=${swarmLabel},swarm.proompteng.ai/uid=${swarmUid}`
    : `swarm.proompteng.ai/name=${swarmLabel}`
  const runNamespaces = Array.from(
    new Set(
      stageConfigs
        .filter((stageConfig) => stageConfig.enabled)
        .map((stageConfig) => stageConfig.targetRef?.namespace)
        .filter((targetNamespace): targetNamespace is string => {
          return typeof targetNamespace === 'string' && targetNamespace.length > 0
        }),
    ),
  )
  const namespacesForRunQueries = runNamespaces.length > 0 ? runNamespaces : [swarmNamespace]
  const runPayloads = await Promise.all(
    namespacesForRunQueries.flatMap((targetNamespace) => [
      kube.list(RESOURCE_MAP.AgentRun, targetNamespace, swarmSelector),
      kube.list(RESOURCE_MAP.OrchestrationRun, targetNamespace, swarmSelector),
    ]),
  )
  const runSeen = new Set<string>()
  const allRuns = runPayloads.flatMap(listItems).filter((run) => {
    const runMetadata = asRecord(run.metadata) ?? {}
    const runKind = asString(run.kind) ?? ''
    const runNamespace = asString(runMetadata.namespace) ?? ''
    const runName = asString(runMetadata.name)
    if (!runName) return false
    const runKey = `${runKind}/${runNamespace}/${runName}`
    if (runSeen.has(runKey)) return false
    runSeen.add(runKey)
    return true
  })
  const implementRuns = allRuns.filter(
    (run) => asString(readNested(run, ['metadata', 'labels', 'swarm.proompteng.ai/stage'])) === 'implement',
  )

  const nowMs = Date.now()
  const existingFreezeUntil = asString(readNested(status, ['freeze', 'until']))
  const existingFreezeReason = asString(readNested(status, ['freeze', 'reason']))
  const frozenAtReleaseReason = existingFreezeReason ?? 'Healthy'
  const existingFreezeEnteredAt = asString(readNested(status, ['freeze', 'enteredAt']))
  const existingFreezeAt = parseTimeOrNull(existingFreezeUntil)
  let freezeActive = existingFreezeAt !== null && existingFreezeAt > nowMs
  const freezeWasActive = freezeActive
  const staleStageSignals = collectStaleStageSignals(stageConfigs, status, allRuns, nowMs)
  let freezeReason = existingFreezeReason ?? 'FreezeActive'
  let freezeUntil = existingFreezeUntil ?? undefined
  const failureWindowStartMs = existingFreezeAt !== null && existingFreezeAt <= nowMs ? existingFreezeAt : null
  const recentImplementRuns = filterRunsAfterTime(implementRuns, failureWindowStartMs)
  let consecutiveFailures = 0

  const freezeTriggerReasons: string[] = []
  if (!freezeActive) {
    consecutiveFailures = countConsecutiveFailures(recentImplementRuns)
    const failureRunSummary = collectRecentFailureRuns(recentImplementRuns)
    if (consecutiveFailures >= freezeAfterFailures) {
      freezeTriggerReasons.push('ConsecutiveFailures')
    } else {
      if (failureRunSummary.length > 0) {
        console.info('[jangar] swarm freeze check', {
          swarm: swarmName,
          namespace: swarmNamespace,
          consecutiveFailures,
          threshold: freezeAfterFailures,
          failureRunCount: failureRunSummary.length,
          evidenceRuns: failureRunSummary,
        })
      }
      freezeReason = 'Healthy'
      freezeUntil = undefined
    }
    if (staleStageSignals.length > 0) {
      freezeTriggerReasons.push('StageStaleness')
    }
    if (freezeTriggerReasons.length > 0) {
      freezeActive = true
      freezeReason = freezeTriggerReasons.join('|')
      freezeUntil = new Date(nowMs + freezeDurationMs).toISOString()
      console.warn('[jangar] swarm freeze activated', {
        swarm: swarmName,
        namespace: swarmNamespace,
        reason: freezeReason,
        reasons: freezeTriggerReasons,
        consecutiveFailures,
        threshold: freezeAfterFailures,
        freezeDurationMs,
        staleStageSignals: staleStageSignals.map((entry) => ({
          stage: entry.stage,
          ageMs: entry.ageMs,
          configuredEveryMs: entry.configuredEveryMs,
          staleAfterMs: entry.staleAfterMs,
        })),
      })
    } else {
      const failureRunSummary = collectRecentFailureRuns(recentImplementRuns)
      if (failureRunSummary.length > 0) {
        console.info('[jangar] swarm freeze check', {
          swarm: swarmName,
          namespace: swarmNamespace,
          consecutiveFailures,
          threshold: freezeAfterFailures,
          failureRunCount: failureRunSummary.length,
          evidenceRuns: failureRunSummary,
        })
      }
      freezeReason = 'Healthy'
      freezeUntil = undefined
    }
  }
  const freezeFailureEvidence = collectRecentFailureRuns(
    recentImplementRuns.filter((resource) => {
      const runTime = parseTimeOrNull(getRunTimestamp(resource))
      if (failureWindowStartMs === null) return true
      return runTime !== null && runTime > failureWindowStartMs
    }),
    10,
  )

  const freezeEnteredAt = freezeActive
    ? freezeWasActive
      ? existingFreezeEnteredAt || new Date(nowMs).toISOString()
      : new Date(nowMs).toISOString()
    : undefined

  if (!freezeWasActive && freezeActive) {
    console.warn('[jangar] swarm freeze activated', {
      swarm: swarmName,
      namespace: swarmNamespace,
      reason: freezeReason,
      until: freezeUntil,
      consecutiveFailures,
      threshold: freezeAfterFailures,
    })
  }
  if (freezeWasActive && !freezeActive) {
    console.info('[jangar] swarm freeze released', {
      swarm: swarmName,
      namespace: swarmNamespace,
      previousReason: frozenAtReleaseReason,
    })
  }

  const ownerReferences = buildOwnerRefs(swarm)
  const implementStageConfig = stageConfigs.find(
    (
      stageConfig,
    ): stageConfig is { stage: StageName; enabled: boolean; scheduleName: string; targetRef: StageTargetRef } =>
      stageConfig.stage === 'implement' && stageConfig.enabled && Boolean(stageConfig.targetRef),
  )
  const requirementSelector = `${SWARM_REQUIREMENT_LABEL_TYPE}=requirement,${SWARM_REQUIREMENT_LABEL_TO}=${swarmLabel}`
  const requirementSignals = sortRequirementSignalsForDispatch(
    listItems(await kube.list(RESOURCE_MAP.Signal, swarmNamespace, requirementSelector)),
  )
  const requirementRunStates = new Map<
    string,
    {
      any: boolean
      active: boolean
      success: boolean
      failed: number
    }
  >()
  for (const run of implementRuns) {
    const requirementId = asString(readNested(run, ['metadata', 'labels', SWARM_REQUIREMENT_LABEL_ID]))
    if (!requirementId) continue
    if (isIdempotencyDuplicateRun(run)) continue
    const phase = (asString(readNested(run, ['status', 'phase'])) ?? '').toLowerCase()
    const current = requirementRunStates.get(requirementId) ?? { any: false, active: false, success: false, failed: 0 }
    current.any = true
    if (TERMINAL_SUCCESS_PHASES.has(phase)) current.success = true
    if (ACTIVE_PHASES.has(phase)) current.active = true
    if (TERMINAL_FAILURE_PHASES.has(phase)) current.failed += 1
    requirementRunStates.set(requirementId, current)
  }

  let requirementTemplate: Record<string, unknown> | null | undefined
  let requirementTemplateError: string | null = null
  const requirementStats = {
    pending: 0,
    dispatched: 0,
    blocked: 0,
    completed: 0,
    invalidChannel: 0,
  }

  for (const signal of requirementSignals) {
    const signalName = asString(readNested(signal, ['metadata', 'name']))
    if (!signalName) continue
    const signalNamespace = asString(readNested(signal, ['metadata', 'namespace'])) ?? swarmNamespace
    const requirementId = requirementIdForSignal(signalNamespace, signalName)
    const signalSpec = asRecord(signal.spec) ?? {}
    const signalChannel = asString(signalSpec.channel)

    if (!isHulyChannel(signalChannel)) {
      requirementStats.pending += 1
      requirementStats.blocked += 1
      requirementStats.invalidChannel += 1
      continue
    }

    const state = requirementRunStates.get(requirementId)
    if (state?.success) {
      requirementStats.completed += 1
      continue
    }

    requirementStats.pending += 1

    if (state?.active) continue
    const attempt = Math.max(1, Math.min((state?.failed ?? 0) + 1, SWARM_REQUIREMENT_MAX_ATTEMPTS))
    if (state?.failed && state.failed >= SWARM_REQUIREMENT_MAX_ATTEMPTS) {
      requirementStats.blocked += 1
      continue
    }
    if (state?.any && !state.failed) {
      requirementStats.blocked += 1
      continue
    }
    if (freezeActive) continue
    if (requirementStats.dispatched >= SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE) continue
    if (!implementStageConfig?.targetRef) {
      requirementStats.blocked += 1
      continue
    }

    if (requirementTemplate === undefined) {
      requirementTemplate = await resolveStageTargetResource(kube, implementStageConfig.targetRef)
      if (!requirementTemplate) {
        requirementTemplateError = `implement target ${implementStageConfig.targetRef.kind}/${implementStageConfig.targetRef.name} not found`
      }
    }
    if (!requirementTemplate) {
      requirementStats.blocked += 1
      continue
    }

    const sourceSwarmRaw =
      asString(readNested(signal, ['metadata', 'labels', SWARM_REQUIREMENT_LABEL_FROM])) ?? 'unknown'
    const sourceSwarmLabel = normalizeLabelValue(sourceSwarmRaw)
    const requirementIdentity = buildSwarmAgentIdentity({
      swarmName,
      stage: 'implement',
      seedSuffix: requirementId,
    })
    const runtimeParameters = buildSwarmRuntimeParameters({
      ownerChannel,
      huly,
      identity: requirementIdentity,
    })
    const runLabels = {
      'swarm.proompteng.ai/name': swarmLabel,
      'swarm.proompteng.ai/stage': 'implement',
      'swarm.proompteng.ai/mode': mode,
      ...(swarmUid ? { 'swarm.proompteng.ai/uid': swarmUid } : {}),
      [SWARM_AGENT_WORKER_ID_LABEL]: requirementIdentity.workerId,
      [SWARM_REQUIREMENT_LABEL_ID]: requirementId,
      [SWARM_REQUIREMENT_LABEL_ATTEMPT]: String(attempt),
      [SWARM_REQUIREMENT_LABEL_FROM]: sourceSwarmLabel,
      [SWARM_REQUIREMENT_LABEL_TO]: swarmLabel,
      [SWARM_REQUIREMENT_LABEL_CHANNEL]: 'huly',
    }
    const runAnnotations = {
      [SWARM_REQUIREMENT_ANNOTATION_SIGNAL]: signalName,
      [SWARM_SCHEDULE_ANNOTATION_IDENTITY]: requirementIdentity.identity,
    }
    const rawPayloadValue = stringifyUnknown(signalSpec.payload)
    const payloadValue = clampUtf8(rawPayloadValue, SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT)
    const description = asString(signalSpec.description)
    const objectiveValue = makeRequirementObjective(description ?? '', payloadValue.value)
    const requirementParameters: Record<string, string> = {
      ...runtimeParameters,
      swarmRequirementId: requirementId,
      swarmRequirementSignal: signalName,
      swarmRequirementSource: sourceSwarmRaw,
      swarmRequirementTarget: swarmName,
      swarmRequirementChannel: signalChannel ?? '',
    }
    if (description) {
      requirementParameters.swarmRequirementDescription = description
    }
    if (payloadValue.value) {
      requirementParameters.swarmRequirementPayload = payloadValue.value
      requirementParameters.swarmRequirementPayloadBytes = String(payloadValue.bytes)
      if (payloadValue.truncated) {
        requirementParameters.swarmRequirementPayloadTruncated = 'true'
      }
    }
    if (objectiveValue) {
      requirementParameters.objective = objectiveValue
    }

    const targetKind = asString(requirementTemplate.kind)
    const targetNamespace =
      asString(readNested(requirementTemplate, ['metadata', 'namespace'])) ?? implementStageConfig.targetRef.namespace
    const targetSpec = asRecord(requirementTemplate.spec) ?? {}
    const generateName = makeGenerateName(`${swarmName}-${sourceSwarmLabel}`, `req-${requirementId}-${attempt}`)

    try {
      if (targetKind === 'AgentRun') {
        const existingParameters = normalizeParameterMap(targetSpec.parameters)
        const existingSecrets = parseStringList(targetSpec.secrets)
        const mergedSecrets = resolveSwarmRunSecrets(existingSecrets, huly.secretName)
        await kube.apply({
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          metadata: {
            generateName,
            namespace: targetNamespace,
            labels: runLabels,
            annotations: runAnnotations,
            ...(ownerReferences && targetNamespace === swarmNamespace ? { ownerReferences } : {}),
          },
          spec: {
            ...targetSpec,
            idempotencyKey: `swarm-requirement-${swarmName}-${requirementId}-attempt-${attempt}`,
            parameters: {
              ...existingParameters,
              ...requirementParameters,
            },
            ...(mergedSecrets.length > 0 ? { secrets: mergedSecrets } : {}),
          },
        })
      } else if (targetKind === 'OrchestrationRun') {
        const existingParameters = normalizeParameterMap(targetSpec.parameters)
        await kube.apply({
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'OrchestrationRun',
          metadata: {
            generateName,
            namespace: targetNamespace,
            labels: runLabels,
            annotations: runAnnotations,
            ...(ownerReferences && targetNamespace === swarmNamespace ? { ownerReferences } : {}),
          },
          spec: {
            ...targetSpec,
            deliveryId: `swarm-requirement-${swarmName}-${requirementId}-attempt-${attempt}`,
            parameters: {
              ...existingParameters,
              ...requirementParameters,
            },
          },
        })
      } else {
        requirementStats.blocked += 1
        continue
      }

      requirementStats.dispatched += 1
      requirementRunStates.set(requirementId, { any: true, active: true, success: false, failed: state?.failed ?? 0 })
    } catch {
      requirementStats.blocked += 1
    }
  }

  const stageStates: Record<string, unknown> = {}

  for (const stageConfig of stageConfigs) {
    const baseState: Record<string, unknown> = {
      enabled: stageConfig.enabled,
      scheduleName: stageConfig.scheduleName,
      cadence: stageConfig.every ?? null,
      targetRef: stageConfig.targetRef ?? null,
    }

    if (!stageConfig.enabled || freezeActive) {
      try {
        await kube.delete(RESOURCE_MAP.Schedule, stageConfig.scheduleName, swarmNamespace, { wait: false })
      } catch {
        // best effort
      }
      stageStates[stageConfig.stage] = {
        ...baseState,
        phase: freezeActive ? 'Frozen' : 'Disabled',
      }
      continue
    }

    const stageLabel = normalizeLabelValue(stageConfig.stage)
    const stageIdentity = buildSwarmAgentIdentity({
      swarmName,
      stage: stageConfig.stage,
      seedSuffix: stageConfig.targetRef ? `${stageConfig.targetRef.kind}:${stageConfig.targetRef.name}` : undefined,
    })
    const stageAnnotations = buildSwarmScheduleAnnotations({
      ownerChannel,
      huly,
      identity: stageIdentity,
    })
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: stageConfig.scheduleName,
        namespace: swarmNamespace,
        labels: {
          'swarm.proompteng.ai/name': swarmLabel,
          'swarm.proompteng.ai/stage': stageLabel,
          'swarm.proompteng.ai/mode': mode,
          [SWARM_AGENT_WORKER_ID_LABEL]: stageIdentity.workerId,
          ...(swarmUid ? { 'swarm.proompteng.ai/uid': swarmUid } : {}),
        },
        annotations: stageAnnotations,
        ...(ownerReferences ? { ownerReferences } : {}),
      },
      spec: {
        cron: stageConfig.cron,
        timezone,
        targetRef: {
          apiVersion: resolveStageApiVersion(stageConfig.targetRef?.kind ?? ''),
          kind: stageConfig.targetRef?.kind,
          name: stageConfig.targetRef?.name,
          namespace: stageConfig.targetRef?.namespace,
        },
      },
    }

    await applyResourceIfChanged(kube, schedule)
    const scheduleResource = await kube.get(RESOURCE_MAP.Schedule, stageConfig.scheduleName, swarmNamespace)
    const schedulePhase = asString(readNested(scheduleResource ?? {}, ['status', 'phase'])) ?? 'Active'
    const lastRunTime = asString(readNested(scheduleResource ?? {}, ['status', 'lastRunTime'])) ?? undefined
    stageStates[stageConfig.stage] = {
      ...baseState,
      phase: schedulePhase,
      lastRunTime: lastRunTime ?? null,
      agentWorkerId: stageIdentity.workerId,
      agentIdentity: stageIdentity.identity,
    }
  }

  const missions24hThreshold = nowMs - 24 * 60 * 60 * 1000
  const runsIn24h = allRuns.filter((run) => {
    const timestamp = parseTimeOrNull(getRunTimestamp(run))
    return timestamp !== null && timestamp >= missions24hThreshold
  })
  const discoveries24h = runsIn24h.filter(
    (run) => asString(readNested(run, ['metadata', 'labels', 'swarm.proompteng.ai/stage'])) === 'discover',
  ).length
  const activeMissions = allRuns.filter((run) => {
    const phase = (asString(readNested(run, ['status', 'phase'])) ?? '').toLowerCase()
    return ACTIVE_PHASES.has(phase)
  }).length

  const terminalRuns24h = runsIn24h.filter((run) => {
    const phase = (asString(readNested(run, ['status', 'phase'])) ?? '').toLowerCase()
    return TERMINAL_SUCCESS_PHASES.has(phase) || TERMINAL_FAILURE_PHASES.has(phase)
  })
  const succeededRuns24h = terminalRuns24h.filter((run) =>
    TERMINAL_SUCCESS_PHASES.has((asString(readNested(run, ['status', 'phase'])) ?? '').toLowerCase()),
  ).length
  const autonomousSuccessRate24h =
    terminalRuns24h.length > 0 ? Number((succeededRuns24h / terminalRuns24h.length).toFixed(4)) : 1

  const latestSuccessfulImplement = sortByMostRecentRun(implementRuns).find((run) =>
    TERMINAL_SUCCESS_PHASES.has((asString(readNested(run, ['status', 'phase'])) ?? '').toLowerCase()),
  )
  const lastProductionChangeRef =
    asString(readNested(latestSuccessfulImplement ?? {}, ['metadata', 'name'])) ??
    asString(status.lastProductionChangeRef) ??
    undefined

  const nextStatus: Record<string, unknown> = {
    observedGeneration: asRecord(swarm.metadata)?.generation ?? 0,
    phase: freezeActive ? 'Frozen' : 'Active',
    activeMissions,
    queuedNeeds: requirementStats.pending,
    discoveries24h,
    missions24h: runsIn24h.length,
    autonomousSuccessRate24h,
    lastProductionChangeRef,
    stageStates,
    requirements: {
      pending: requirementStats.pending,
      dispatched: requirementStats.dispatched,
      blocked: requirementStats.blocked,
      completed: requirementStats.completed,
      invalidChannel: requirementStats.invalidChannel,
      ...(requirementTemplateError ? { error: requirementTemplateError } : {}),
    },
  }

  for (const stage of STAGE_NAMES) {
    const stageState = asRecord(stageStates[stage])
    const stageLastRun = asString(stageState?.lastRunTime)
    if (stageLastRun) {
      nextStatus[STAGE_LAST_RUN_KEY[stage]] = stageLastRun
    } else {
      const existing = asString(status[STAGE_LAST_RUN_KEY[stage]])
      if (existing) nextStatus[STAGE_LAST_RUN_KEY[stage]] = existing
    }
  }

  const inactiveFreezeUntil = freezeUntil ?? existingFreezeUntil ?? nowIso()
  const inactiveFreezeEnteredAt = freezeEnteredAt ?? existingFreezeEnteredAt ?? nowIso()
  let conditions = conditionsBase
  if (freezeActive) {
    if (freezeUntil) {
      scheduleSwarmUnfreezeReconcile(kube, swarmNamespace, swarmName, freezeUntil)
    } else {
      clearSwarmUnfreezeTimer(swarmNamespace, swarmName)
    }
    conditions = upsertCondition(conditions, buildReadyCondition(false, 'Frozen', `swarm frozen until ${freezeUntil}`))
    conditions = upsertCondition(conditions, {
      type: 'Frozen',
      status: 'True',
      reason: freezeReason,
      message: `swarm frozen until ${freezeUntil}`,
    })
    nextStatus.freeze = {
      reason: freezeReason,
      until: freezeUntil,
      consecutiveFailures,
      threshold: freezeAfterFailures,
      enteredAt: freezeEnteredAt,
      durationMs: freezeDurationMs,
      evidence: {
        triggeringRuns: freezeFailureEvidence,
        recentRunWindowMs: freezeAfterFailures * freezeDurationMs,
        freezeWindowStartedAt: failureWindowStartMs === null ? null : new Date(failureWindowStartMs).toISOString(),
        stageStaleness: staleStageSignals,
        triggers: freezeTriggerReasons,
      },
    }
  } else {
    clearSwarmUnfreezeTimer(swarmNamespace, swarmName)
    conditions = upsertCondition(conditions, buildReadyCondition(true, 'Active', 'swarm active'))
    conditions = upsertCondition(conditions, {
      type: 'Frozen',
      status: 'False',
      reason: 'NotFrozen',
      message: 'swarm operating normally',
    })
    // Keep a concrete object here so server-side apply updates the existing freeze status
    // instead of attempting to delete it with null values that violate the CRD schema.
    nextStatus.freeze = {
      reason: 'NotFrozen',
      until: inactiveFreezeUntil,
      consecutiveFailures,
      threshold: freezeAfterFailures,
      enteredAt: inactiveFreezeEnteredAt,
      durationMs: freezeDurationMs,
      evidence: {
        triggeringRuns: freezeFailureEvidence,
        recentRunWindowMs: freezeAfterFailures * freezeDurationMs,
        freezeWindowStartedAt: failureWindowStartMs === null ? null : new Date(failureWindowStartMs).toISOString(),
        stageStaleness: staleStageSignals,
        triggers: freezeTriggerReasons,
      },
    }
  }

  if (requirementStats.invalidChannel > 0) {
    conditions = upsertCondition(conditions, {
      type: 'RequirementsBridge',
      status: 'False',
      reason: 'InvalidRequirementChannel',
      message: `${requirementStats.invalidChannel} requirement signal(s) were rejected because channel is not Huly`,
    })
  } else if (requirementTemplateError) {
    conditions = upsertCondition(conditions, {
      type: 'RequirementsBridge',
      status: 'False',
      reason: 'ImplementTemplateMissing',
      message: requirementTemplateError,
    })
  } else if (requirementStats.blocked > 0) {
    conditions = upsertCondition(conditions, {
      type: 'RequirementsBridge',
      status: 'False',
      reason: 'RequirementBlocked',
      message: `${requirementStats.blocked} requirement signal(s) blocked for manual intervention`,
    })
  } else {
    conditions = upsertCondition(conditions, {
      type: 'RequirementsBridge',
      status: 'True',
      reason: requirementStats.pending > 0 ? 'Processing' : 'Idle',
      message:
        requirementStats.pending > 0
          ? `${requirementStats.pending} requirement signal(s) pending; ${requirementStats.dispatched} dispatched`
          : 'no requirement signals pending',
    })
  }
  nextStatus.conditions = conditions

  await setStatus(kube, swarm, nextStatus)
}

const reconcileWorkspace = async (
  kube: ReturnType<typeof createKubernetesClient>,
  workspace: Record<string, unknown>,
  namespace: string,
) => {
  const spec = asRecord(workspace.spec) ?? {}
  const size = asString(spec.size)
  const accessModes = Array.isArray(spec.accessModes) ? spec.accessModes : ['ReadWriteOnce']
  const storageClassName = asString(spec.storageClassName)
  const ttlSeconds = typeof spec.ttlSeconds === 'number' ? spec.ttlSeconds : null
  const status = asRecord(workspace.status) ?? {}
  if (!size) {
    const conditions = upsertCondition(
      normalizeConditions(status.conditions),
      buildReadyCondition(false, 'InvalidSpec', 'spec.size is required'),
    )
    await setStatus(kube, workspace, {
      observedGeneration: asRecord(workspace.metadata)?.generation ?? 0,
      phase: 'Invalid',
      conditions,
    })
    return
  }

  const workspaceName = asString(readNested(workspace, ['metadata', 'name'])) ?? 'workspace'
  const ownerReferences = buildOwnerRefs(workspace)
  const labels = { 'workspaces.proompteng.ai/workspace': workspaceName }
  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: workspaceName,
      namespace,
      labels,
      ...(ownerReferences ? { ownerReferences } : {}),
    },
    spec: {
      accessModes,
      resources: { requests: { storage: size } },
      ...(storageClassName ? { storageClassName } : {}),
    },
  }
  await applyResourceIfChanged(kube, pvc)

  const pvcResource = await kube.get('persistentvolumeclaim', workspaceName, namespace)
  const pvcPhase = asString(readNested(pvcResource ?? {}, ['status', 'phase'])) ?? 'Pending'
  const pvcVolumeName = asString(readNested(pvcResource ?? {}, ['spec', 'volumeName'])) ?? undefined

  if (ttlSeconds && ttlSeconds > 0) {
    const createdAt = asString(readNested(workspace, ['metadata', 'creationTimestamp']))
    if (createdAt) {
      const expiresAt = new Date(createdAt).getTime() + ttlSeconds * 1000
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        await kube.delete('persistentvolumeclaim', workspaceName, namespace)
        const conditions = upsertCondition(
          normalizeConditions(status.conditions),
          buildReadyCondition(false, 'Expired', 'workspace TTL expired'),
        )
        await setStatus(kube, workspace, {
          observedGeneration: asRecord(workspace.metadata)?.generation ?? 0,
          phase: 'Expired',
          volumeName: pvcVolumeName,
          conditions,
        })
        return
      }
    }
  }

  const phase = pvcPhase === 'Bound' ? 'Ready' : pvcPhase === 'Lost' ? 'Failed' : 'Pending'
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(phase === 'Ready', phase === 'Ready' ? 'Bound' : 'Pending', `workspace ${phase.toLowerCase()}`),
  )
  await setStatus(kube, workspace, {
    observedGeneration: asRecord(workspace.metadata)?.generation ?? 0,
    phase,
    volumeName: pvcVolumeName,
    conditions,
  })
}

const reconcileArtifact = async (
  kube: ReturnType<typeof createKubernetesClient>,
  artifact: Record<string, unknown>,
) => {
  const status = asRecord(artifact.status) ?? {}
  const name = asString(readNested(artifact, ['metadata', 'name'])) ?? 'artifact'
  const namespace = resolveNamespace(artifact)
  const storageRef = asString(readNested(artifact, ['spec', 'storageRef', 'name']))
  const uri = storageRef ? `storage://${storageRef}` : `artifact://${namespace}/${name}`
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(true, 'Ready', 'artifact ready'),
  )
  await setStatus(kube, artifact, {
    observedGeneration: asRecord(artifact.metadata)?.generation ?? 0,
    phase: 'Ready',
    uri,
    checksum: asString(status.checksum) ?? undefined,
    conditions,
  })
}

const reconcileResource = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  namespace: string,
) => {
  const kind = asString(resource.kind)
  if (!kind) return
  if (kind === 'Tool') {
    await reconcileTool(kube, resource)
    return
  }
  if (kind === 'ApprovalPolicy') {
    await reconcileApprovalPolicy(kube, resource)
    return
  }
  if (kind === 'Budget') {
    await reconcileBudget(kube, resource)
    return
  }
  if (kind === 'SecretBinding') {
    await reconcileSecretBinding(kube, resource)
    return
  }
  if (kind === 'Signal') {
    await reconcileSignal(kube, resource)
    return
  }
  if (kind === 'SignalDelivery') {
    await reconcileSignalDelivery(kube, resource)
    return
  }
  if (kind === 'Schedule') {
    await reconcileSchedule(kube, resource, namespace)
    return
  }
  if (kind === 'Swarm') {
    await reconcileSwarm(kube, resource, namespace)
    return
  }
  if (kind === 'Workspace') {
    await reconcileWorkspace(kube, resource, namespace)
    return
  }
  if (kind === 'Artifact') {
    await reconcileArtifact(kube, resource)
  }
}

const reconcileNamespace = async (kube: ReturnType<typeof createKubernetesClient>, namespace: string) => {
  const listRequests = [
    kube.list(RESOURCE_MAP.Tool, namespace),
    kube.list(RESOURCE_MAP.ApprovalPolicy, namespace),
    kube.list(RESOURCE_MAP.Budget, namespace),
    kube.list(RESOURCE_MAP.SecretBinding, namespace),
    kube.list(RESOURCE_MAP.Signal, namespace),
    kube.list(RESOURCE_MAP.SignalDelivery, namespace),
    kube.list(RESOURCE_MAP.Schedule, namespace),
    kube.list(RESOURCE_MAP.Artifact, namespace),
    kube.list(RESOURCE_MAP.Workspace, namespace),
  ]
  if (optionalCrdsReady.has(RESOURCE_MAP.Swarm)) {
    listRequests.push(kube.list(RESOURCE_MAP.Swarm, namespace))
  }
  const payloads = await Promise.all(listRequests)
  const items = payloads.flatMap(listItems)
  for (const item of items) {
    await reconcileResource(kube, item, namespace)
  }
}

const reconcileAll = async (kube: ReturnType<typeof createKubernetesClient>, namespaces: string[]) => {
  if (reconciling) return
  reconciling = true
  try {
    for (const namespace of namespaces) {
      await reconcileNamespace(kube, namespace)
    }
  } catch (error) {
    console.warn('[jangar] supporting controller reconcile failed', error)
  } finally {
    reconciling = false
  }
}

const handleResourceEvent = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  event: { type?: string; object?: Record<string, unknown> },
) => {
  const resource = asRecord(event.object)
  if (event.type === 'DELETED') {
    const kind = asString(resource?.kind)
    if (kind === 'Swarm') {
      const name = asString(readNested(resource ?? {}, ['metadata', 'name']))
      const resourceNamespace = asString(readNested(resource ?? {}, ['metadata', 'namespace'])) ?? namespace
      if (name) {
        clearSwarmUnfreezeTimer(resourceNamespace, name)
      }
    }
    return
  }
  if (!resource) return
  const resourceNamespace = asString(readNested(resource, ['metadata', 'namespace'])) ?? namespace
  const resourceKind = asString(resource.kind) ?? 'Unknown'
  const resourceName = asString(readNested(resource, ['metadata', 'name'])) ?? 'unknown'
  const queueKey = `${resourceNamespace}/${resourceKind}/${resourceName}`
  if (isSwarmStatusOnlyEvent(event.type, resource) && shouldThrottleSwarmStatusReconcile(queueKey)) {
    return
  }
  queueResourceTask(resourceNamespace, queueKey, async () => {
    const watchedResource = resolveWatchedResourceForKind(resourceKind)
    if (!watchedResource || !resourceName || resourceName === 'unknown') {
      await reconcileResource(kube, resource, resourceNamespace)
      return
    }
    const latestResource = await kube.get(watchedResource, resourceName, resourceNamespace)
    if (!latestResource) return
    await reconcileResource(kube, latestResource, resourceNamespace)
  })
}

const handleScheduleRunnerEvent = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  event: { type?: string; object?: Record<string, unknown> },
) => {
  const resource = asRecord(event.object)
  if (!resource) return
  const scheduleName = asString(readNested(resource, ['metadata', 'labels', 'schedules.proompteng.ai/schedule']))
  if (!scheduleName) return
  const queueKey = `${namespace}/Schedule/${scheduleName}`
  if (event.type === 'MODIFIED' && shouldThrottleScheduleRunnerStatusReconcile(queueKey)) return
  queueResourceTask(namespace, queueKey, async () => {
    const schedule = await kube.get(RESOURCE_MAP.Schedule, scheduleName, namespace)
    if (!schedule) return
    if (event.type === 'DELETED') {
      await reconcileSchedule(kube, schedule, namespace)
      return
    }
    await reconcileScheduleRunnerStatus(kube, schedule, namespace)
  })
}

const handleWorkspaceVolumeEvent = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  event: { type?: string; object?: Record<string, unknown> },
) => {
  const resource = asRecord(event.object)
  if (!resource) return
  const workspaceName = asString(readNested(resource, ['metadata', 'labels', 'workspaces.proompteng.ai/workspace']))
  if (!workspaceName) return
  queueResourceTask(namespace, `${namespace}/Workspace/${workspaceName}`, async () => {
    const workspace = await kube.get(RESOURCE_MAP.Workspace, workspaceName, namespace)
    if (!workspace) return
    await reconcileWorkspace(kube, workspace, namespace)
  })
}

export const startSupportingPrimitivesController = async () => {
  if (started || starting) return
  starting = true
  lifecycleToken += 1
  const token = lifecycleToken
  let featureEnabled = false
  try {
    featureEnabled = await shouldStartWithFeatureFlag()
  } catch (error) {
    if (lifecycleToken === token) {
      starting = false
    }
    throw error
  }
  if (!featureEnabled) {
    if (lifecycleToken === token) {
      starting = false
    }
    return
  }
  const crdsReady = await checkCrds()
  if (!crdsReady.ok) {
    console.error('[jangar] supporting controller will not start without CRDs')
    starting = false
    return
  }
  const handles: Array<{ stop: () => void }> = []
  try {
    const kube = createKubernetesClient()
    const namespaces = await resolveNamespaces()
    if (lifecycleToken !== token) return
    void reconcileAll(kube, namespaces)

    for (const namespace of namespaces) {
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Tool,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] tool watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.ApprovalPolicy,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] approval policy watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Budget,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] budget watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.SecretBinding,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] secret binding watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Signal,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] signal watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.SignalDelivery,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] signal delivery watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Schedule,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] schedule watch failed', error),
        }),
      )
      if (optionalCrdsReady.has(RESOURCE_MAP.Swarm)) {
        swarmWatchersStarted = true
        handles.push(
          startResourceWatch({
            resource: RESOURCE_MAP.Swarm,
            namespace,
            onEvent: (event) => handleResourceEvent(kube, namespace, event),
            onError: (error) => console.warn('[jangar] swarm watch failed', error),
          }),
        )
      }
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Artifact,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] artifact watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Workspace,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] workspace watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: 'cronjob',
          namespace,
          labelSelector: 'schedules.proompteng.ai/schedule',
          onEvent: (event) => void handleScheduleRunnerEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] schedule cronjob watch failed', error),
        }),
      )
      handles.push(
        startResourceWatch({
          resource: 'persistentvolumeclaim',
          namespace,
          labelSelector: 'workspaces.proompteng.ai/workspace',
          onEvent: (event) => void handleWorkspaceVolumeEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] workspace pvc watch failed', error),
        }),
      )
    }

    if (!optionalCrdsReady.has(RESOURCE_MAP.Swarm)) {
      if (swarmCrdsRefreshHandle) clearInterval(swarmCrdsRefreshHandle)
      swarmCrdsRefreshHandle = setInterval(() => {
        if (!started) return
        void refreshOptionalSwarmWatches(kube, namespaces, token)
      }, SWARM_CRD_REFRESH_INTERVAL_MS)
    }

    if (lifecycleToken !== token) return
    watchHandles = handles
    started = true
    controllerState.started = true
  } catch (error) {
    console.error('[jangar] supporting controller failed to start', error)
  } finally {
    if (lifecycleToken !== token) {
      for (const handle of handles) {
        handle.stop()
      }
    }
    if (swarmCrdsRefreshHandle && (lifecycleToken !== token || !started)) {
      clearInterval(swarmCrdsRefreshHandle)
      swarmCrdsRefreshHandle = null
    }
    if (lifecycleToken === token) {
      starting = false
    }
  }
}

export const stopSupportingPrimitivesController = () => {
  lifecycleToken += 1
  starting = false
  if (swarmCrdsRefreshHandle) {
    clearInterval(swarmCrdsRefreshHandle)
    swarmCrdsRefreshHandle = null
  }
  swarmWatchersStarted = false
  for (const handle of watchHandles) {
    handle.stop()
  }
  clearAllSwarmUnfreezeTimers()
  watchHandles = []
  namespaceQueues.clear()
  queuedResourceKeysByNamespace.clear()
  swarmStatusReconcileThrottleByKey.clear()
  scheduleRunnerStatusReconcileThrottleByKey.clear()
  started = false
  controllerState.started = false
}

export const __test__ = {
  applyResourceIfChanged,
  buildScheduleRunnerCommand,
  buildScheduleRunTemplate,
  cadenceToCron,
  deriveStageStaggerMinute,
  isSwarmStatusOnlyEvent,
  reconcileScheduleRunnerStatus,
  reconcileTool,
  reconcileSwarm,
  resolveRequirementPriorityScore,
  resolveSwarmRunSecrets,
  resolveWatchedResourceForKind,
  shouldThrottleScheduleRunnerStatusReconcile,
  shouldThrottleSwarmStatusReconcile,
  SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS,
  shouldStartWithFeatureFlag,
  SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS,
  SWARM_CRD_REFRESH_INTERVAL_MS,
}

import { spawn } from 'node:child_process'

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { startResourceWatch } from '~/server/kube-watch'
import { assertClusterScopedForWildcard } from '~/server/namespace-scope'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { shouldApplyStatus } from '~/server/status-utils'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY = 'jangar.supporting_controller.enabled'

const REQUIRED_CRDS = [
  RESOURCE_MAP.Tool,
  RESOURCE_MAP.ToolRun,
  RESOURCE_MAP.ApprovalPolicy,
  RESOURCE_MAP.Budget,
  RESOURCE_MAP.SecretBinding,
  RESOURCE_MAP.Signal,
  RESOURCE_MAP.SignalDelivery,
  RESOURCE_MAP.Schedule,
  RESOURCE_MAP.Swarm,
  RESOURCE_MAP.Artifact,
  RESOURCE_MAP.Workspace,
]

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
let _crdCheckState: CrdCheckState | null = controllerState.crdCheckState
let watchHandles: Array<{ stop: () => void }> = []
const namespaceQueues = new Map<string, Promise<void>>()

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

const makeName = (base: string, suffix: string) => {
  const max = 45
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const trimmed = sanitized.length > max ? sanitized.slice(0, max) : sanitized
  return `${trimmed}-${suffix}`
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

const STAGE_CADENCE_KEY: Record<StageName, string> = {
  discover: 'discoverEvery',
  plan: 'planEvery',
  implement: 'implementEvery',
  verify: 'verifyEvery',
}

const STAGE_LAST_RUN_KEY: Record<StageName, string> = {
  discover: 'lastDiscoverAt',
  plan: 'lastPlanAt',
  implement: 'lastImplementAt',
  verify: 'lastVerifyAt',
}

const TERMINAL_SUCCESS_PHASES = new Set(['succeeded', 'success', 'completed'])
const TERMINAL_FAILURE_PHASES = new Set(['failed', 'error', 'cancelled'])
const ACTIVE_PHASES = new Set(['pending', 'running', 'inprogress', 'progressing', 'queued'])

const normalizeLabelValue = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  if (!normalized) return 'swarm'
  return normalized.slice(0, 63)
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

const cadenceToCron = (raw: string) => {
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
  return { kind, name, namespace }
}

const resolveStageApiVersion = (kind: string) => {
  if (kind === 'AgentRun') return 'agents.proompteng.ai/v1alpha1'
  if (kind === 'OrchestrationRun') return 'orchestration.proompteng.ai/v1alpha1'
  return ''
}

const stageScheduleName = (swarmName: string, stage: StageName) => makeName(`${swarmName}-${stage}`, 'sched')

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

const countConsecutiveFailures = (resources: Record<string, unknown>[]) => {
  const sorted = sortByMostRecentRun(resources)
  let failures = 0
  for (const resource of sorted) {
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

  if (targetKind === 'AgentRun') {
    const spec = asRecord(target.spec) ?? {}
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
      },
    }
  }

  if (targetKind === 'OrchestrationRun') {
    const spec = asRecord(target.spec) ?? {}
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
    await kube.apply(configMap)

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
                    command: [
                      '/bin/sh',
                      '-ec',
                      [
                        'DELIVERY_ID=$(cat /proc/sys/kernel/random/uuid);',
                        `sed "s/__JANGAR_DELIVERY_ID__/\\$${'{DELIVERY_ID}'}/g" /config/run.json | kubectl create -f -`,
                      ].join(' '),
                    ],
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
    await kube.apply(cronJob)
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
  const owner = asRecord(spec.owner) ?? {}
  const mode = asString(spec.mode) ?? ''
  const timezone = asString(spec.timezone) ?? 'UTC'
  const execution = asRecord(spec.execution) ?? {}
  const risk = asRecord(spec.risk) ?? {}

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
    targetRef?: { kind: string; name: string; namespace: string }
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

    const cron = cadenceToCron(every)
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
    const conditions = upsertCondition(conditionsBase, buildReadyCondition(false, 'InvalidSpec', errors.join('; ')))
    await setStatus(kube, swarm, {
      observedGeneration: asRecord(swarm.metadata)?.generation ?? 0,
      phase: 'Invalid',
      conditions,
    })
    return
  }

  const swarmLabel = normalizeLabelValue(swarmName)
  const swarmSelector = `swarm.proompteng.ai/name=${swarmLabel}`
  const [agentRunsPayload, orchestrationRunsPayload] = await Promise.all([
    kube.list(RESOURCE_MAP.AgentRun, swarmNamespace, swarmSelector),
    kube.list(RESOURCE_MAP.OrchestrationRun, swarmNamespace, swarmSelector),
  ])
  const allRuns = [...listItems(agentRunsPayload), ...listItems(orchestrationRunsPayload)]
  const implementRuns = allRuns.filter(
    (run) => asString(readNested(run, ['metadata', 'labels', 'swarm.proompteng.ai/stage'])) === 'implement',
  )

  const nowMs = Date.now()
  const existingFreezeUntil = asString(readNested(status, ['freeze', 'until']))
  const existingFreezeReason = asString(readNested(status, ['freeze', 'reason']))
  const existingFreezeAt = parseTimeOrNull(existingFreezeUntil)
  let freezeActive = existingFreezeAt !== null && existingFreezeAt > nowMs
  let freezeReason = existingFreezeReason ?? 'FreezeActive'
  let freezeUntil = existingFreezeUntil ?? undefined

  if (!freezeActive) {
    const consecutiveFailures = countConsecutiveFailures(implementRuns)
    if (consecutiveFailures >= freezeAfterFailures) {
      freezeActive = true
      freezeReason = 'ConsecutiveFailures'
      freezeUntil = new Date(nowMs + freezeDurationMs).toISOString()
    } else {
      freezeReason = 'Healthy'
      freezeUntil = undefined
    }
  }

  const ownerReferences = buildOwnerRefs(swarm)
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
    const schedule = {
      apiVersion: 'schedules.schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: stageConfig.scheduleName,
        namespace: swarmNamespace,
        labels: {
          'swarm.proompteng.ai/name': swarmLabel,
          'swarm.proompteng.ai/stage': stageLabel,
          'swarm.proompteng.ai/mode': mode,
        },
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

    await kube.apply(schedule)
    const scheduleResource = await kube.get(RESOURCE_MAP.Schedule, stageConfig.scheduleName, swarmNamespace)
    const schedulePhase = asString(readNested(scheduleResource ?? {}, ['status', 'phase'])) ?? 'Active'
    const lastRunTime = asString(readNested(scheduleResource ?? {}, ['status', 'lastRunTime'])) ?? undefined
    stageStates[stageConfig.stage] = {
      ...baseState,
      phase: schedulePhase,
      lastRunTime: lastRunTime ?? null,
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
    queuedNeeds: Number(status.queuedNeeds ?? 0) || 0,
    discoveries24h,
    missions24h: runsIn24h.length,
    autonomousSuccessRate24h,
    lastProductionChangeRef,
    stageStates,
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

  let conditions = conditionsBase
  if (freezeActive) {
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
    }
  } else {
    conditions = upsertCondition(conditions, buildReadyCondition(true, 'Active', 'swarm active'))
    conditions = upsertCondition(conditions, {
      type: 'Frozen',
      status: 'False',
      reason: 'NotFrozen',
      message: 'swarm operating normally',
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
  await kube.apply(pvc)

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
  const payloads = await Promise.all([
    kube.list(RESOURCE_MAP.Tool, namespace),
    kube.list(RESOURCE_MAP.ApprovalPolicy, namespace),
    kube.list(RESOURCE_MAP.Budget, namespace),
    kube.list(RESOURCE_MAP.SecretBinding, namespace),
    kube.list(RESOURCE_MAP.Signal, namespace),
    kube.list(RESOURCE_MAP.SignalDelivery, namespace),
    kube.list(RESOURCE_MAP.Schedule, namespace),
    kube.list(RESOURCE_MAP.Swarm, namespace),
    kube.list(RESOURCE_MAP.Artifact, namespace),
    kube.list(RESOURCE_MAP.Workspace, namespace),
  ])
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
  if (event.type === 'DELETED') return
  const resource = asRecord(event.object)
  if (!resource) return
  enqueueNamespaceTask(namespace, () => reconcileResource(kube, resource, namespace))
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
  const schedule = await kube.get(RESOURCE_MAP.Schedule, scheduleName, namespace)
  if (!schedule) return
  await reconcileSchedule(kube, schedule, namespace)
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
  const workspace = await kube.get(RESOURCE_MAP.Workspace, workspaceName, namespace)
  if (!workspace) return
  await reconcileWorkspace(kube, workspace, namespace)
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
      handles.push(
        startResourceWatch({
          resource: RESOURCE_MAP.Swarm,
          namespace,
          onEvent: (event) => handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn('[jangar] swarm watch failed', error),
        }),
      )
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
    if (lifecycleToken === token) {
      starting = false
    }
  }
}

export const stopSupportingPrimitivesController = () => {
  lifecycleToken += 1
  starting = false
  for (const handle of watchHandles) {
    handle.stop()
  }
  watchHandles = []
  namespaceQueues.clear()
  started = false
  controllerState.started = false
}

export const __test__ = {
  reconcileTool,
  reconcileSwarm,
  shouldStartWithFeatureFlag,
}

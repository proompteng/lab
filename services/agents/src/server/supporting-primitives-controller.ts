import { isRuntimeTestEnv } from './agents-controller/runtime-config'
import { AGENTS_RESOURCE_LABELS } from './agent-resource-labels'
import { isSwarmPrimitiveEnabled, resolveSupportingControllerConfig } from './controller-runtime-config'
import { resolveBooleanFeatureToggle } from './feature-flags'
import { createKubeGateway, type KubeGateway } from './kube-gateway'
import { startResourceWatch } from './kube-watch'
import { asRecord, asString, readNested } from './primitives'
import { createKubernetesClient, RESOURCE_MAP } from './kube-types'
import { shouldApplyStatus } from './status-utils'

const DEFAULT_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY = 'agents.supporting_controller.enabled'
const SCHEDULE_DELIVERY_PLACEHOLDER = '__AGENTS_DELIVERY_ID__'

const BASE_REQUIRED_CRDS = [
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

const resolveRequiredCrds = () =>
  isSwarmPrimitiveEnabled() ? [...BASE_REQUIRED_CRDS, RESOURCE_MAP.Swarm] : BASE_REQUIRED_CRDS

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
  forbidden: string[]
  checkedAt: string
}

type ControllerHealthState = {
  started: boolean
  crdCheckState: CrdCheckState | null
  namespaces: string[] | null
}

const globalState = globalThis as typeof globalThis & {
  __agentsSupportingControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__agentsSupportingControllerState) return globalState.__agentsSupportingControllerState
  const initial = { started: false, crdCheckState: null, namespaces: null }
  globalState.__agentsSupportingControllerState = initial
  return initial
})()

let started = controllerState.started
let starting = false
let reconciling = false
let lifecycleToken = 0
let watchHandles: Array<{ stop: () => void }> = []
const namespaceQueues = new Map<string, Promise<void>>()
const queuedResourceKeysByNamespace = new Map<string, Map<string, { rerun: boolean }>>()

const nowIso = () => new Date().toISOString()

const readEnv = (agentsName: string) => process.env[agentsName]?.trim() || ''

const resolveSupportingRuntimeConfig = () => {
  const image =
    readEnv('AGENTS_SCHEDULE_RUNNER_IMAGE') ||
    readEnv('AGENTS_IMAGE') ||
    readEnv('AGENTS_RUNTIME_IMAGE') ||
    'ghcr.io/proompteng/agents-controller:latest'
  const serviceAccountName =
    readEnv('AGENTS_SCHEDULE_SERVICE_ACCOUNT') || readEnv('AGENTS_SERVICE_ACCOUNT_NAME') || undefined
  const nodeSelectorRaw = readEnv('AGENTS_SCHEDULE_RUNNER_NODE_SELECTOR')
  const nodeSelector = (() => {
    if (!nodeSelectorRaw) return null
    try {
      const parsed = JSON.parse(nodeSelectorRaw) as unknown
      return asRecord(parsed)
    } catch {
      return null
    }
  })()
  return { image, serviceAccountName, nodeSelector }
}

const shouldStartFallback = () => {
  if (isRuntimeTestEnv()) return false
  return resolveSupportingControllerConfig().enabled
}

const shouldStart = () => {
  if (isRuntimeTestEnv()) return false
  return resolveSupportingControllerConfig().enabled
}

const shouldStartWithFeatureFlag = async () => {
  if (isRuntimeTestEnv()) return false
  const config = resolveSupportingControllerConfig()
  return resolveBooleanFeatureToggle({
    key: config.enabledFlagKey || DEFAULT_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY,
    keyEnvVar: 'AGENTS_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY',
    fallbackEnvVar: 'AGENTS_SUPPORTING_CONTROLLER_ENABLED',
    defaultValue: shouldStartFallback(),
  })
}

const parseNamespaces = () => resolveSupportingControllerConfig().namespaces

const resolveCrdCheckNamespace = () => {
  const namespaces = parseNamespaces()
  if (namespaces.includes('*')) return 'default'
  return namespaces[0] ?? 'default'
}

const resolveNamespaces = async (kubeGateway: Pick<KubeGateway, 'listNamespaces'> = createKubeGateway()) => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) return namespaces
  const resolved = await kubeGateway.listNamespaces()
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kube gateway')
  }
  return resolved
}

const resolveConfiguredNamespaces = () => {
  try {
    return parseNamespaces()
  } catch {
    return null
  }
}

const checkCrds = async (
  kubeGateway: Pick<KubeGateway, 'probeNamespacedResource'> = createKubeGateway(),
): Promise<CrdCheckState> => {
  const namespace = resolveCrdCheckNamespace()
  const missing: string[] = []
  const forbidden: string[] = []
  for (const name of resolveRequiredCrds()) {
    const access = await kubeGateway.probeNamespacedResource(name, namespace)
    if (access === 'ok') continue
    if (access === 'forbidden') {
      forbidden.push(name)
    } else {
      missing.push(name)
    }
  }

  const state = {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
    checkedAt: nowIso(),
  }
  controllerState.crdCheckState = state
  if (!state.ok) {
    if (missing.length > 0) {
      console.error('[agents] missing supporting primitives CRDs:', missing.join(', '))
    }
    if (forbidden.length > 0) {
      console.error(
        `[agents] insufficient RBAC to read supporting primitives CRDs in namespace ${namespace}: ${forbidden.join(
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
  namespaces: controllerState.namespaces ?? resolveConfiguredNamespaces(),
  crdsReady: controllerState.crdCheckState?.ok ?? null,
  missingCrds: controllerState.crdCheckState?.missing ?? [],
  forbiddenCrds: controllerState.crdCheckState?.forbidden ?? [],
  lastCheckedAt: controllerState.crdCheckState?.checkedAt ?? null,
})

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  const current = namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.warn('[agents] supporting controller task failed', error)
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
      let shouldRerun = false
      try {
        await task()
      } finally {
        const currentKeys = queuedResourceKeysByNamespace.get(namespace)
        const currentState = currentKeys?.get(key)
        if (currentKeys && currentState && currentState.rerun) {
          currentState.rerun = false
          shouldRerun = true
        } else if (currentKeys && currentState) {
          currentKeys.delete(key)
          if (currentKeys.size === 0) {
            queuedResourceKeysByNamespace.delete(namespace)
          }
        }
      }
      if (shouldRerun) {
        runTask()
      }
    })
  }

  runTask()
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
    output.push({
      type,
      status: status === 'True' ? 'True' : status === 'False' ? 'False' : 'Unknown',
      reason: asString(record.reason)?.trim() || 'Reconciled',
      message: asString(record.message) ?? '',
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
  const index = next.findIndex((condition) => condition.type === normalized.type)
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
  const nextStatus = {
    ...status,
    updatedAt: nowIso(),
  }
  if (!shouldApplyStatus(asRecord(resource.status), nextStatus)) return
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status: nextStatus })
}

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

const extractComparableValue = (actual: unknown, desired: unknown): unknown => {
  if (desired === null || typeof desired !== 'object') return actual
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return actual
    return desired.map((entry, index) => extractComparableValue(actual[index], entry))
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return actual
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
  if (kind === 'PersistentVolumeClaim') return RESOURCE_MAP.PersistentVolumeClaim
  return null
}

const applyResourceIfChanged = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
) => {
  const kind = asString(resource.kind)
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!kind || !name || !namespace) return kube.apply(resource)

  const comparableResource = resolveComparableResource(kind)
  if (!comparableResource) return kube.apply(resource)

  const existing = await kube.get(comparableResource, name, namespace)
  if (existing) {
    const normalizedExisting = normalizeResourceForApplyCompare(existing, resource)
    const normalizedDesired = normalizeResourceForApplyCompare(resource, resource)
    if (stableStringify(normalizedExisting) === stableStringify(normalizedDesired)) return existing
  }

  return kube.apply(resource)
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

const makeName = (base: string, suffix: string) => {
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const maxBaseLength = 45
  if (sanitized.length <= maxBaseLength) return `${sanitized}-${suffix}`
  return `${sanitized.slice(0, maxBaseLength)}-${suffix}`
}

const resolveNamespace = (resource: Record<string, unknown>) =>
  asString(readNested(resource, ['metadata', 'namespace'])) ?? 'default'

const reconcileGenericReady = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  reason: string,
  message: string,
) => {
  const status = asRecord(resource.status) ?? {}
  const conditions = upsertCondition(normalizeConditions(status.conditions), buildReadyCondition(true, reason, message))
  await setStatus(kube, resource, {
    observedGeneration: asRecord(resource.metadata)?.generation ?? 0,
    phase: asString(status.phase) ?? 'Ready',
    conditions,
  })
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

const normalizeParameterMap = (value: unknown) => {
  const record = asRecord(value) ?? {}
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

const buildScheduleRunTemplate = (
  schedule: Record<string, unknown>,
  target: Record<string, unknown>,
  deliveryPlaceholder = SCHEDULE_DELIVERY_PLACEHOLDER,
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
        key !== AGENTS_RESOURCE_LABELS.deliveryId.canonical,
    ),
  ) as Record<string, string>
  const labels = {
    ...inheritedLabels,
    'schedules.proompteng.ai/schedule': scheduleName,
    'agents.proompteng.ai/delivery-id': deliveryPlaceholder,
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
        parameters: normalizeParameterMap(spec.parameters),
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
        parameters: normalizeParameterMap(spec.parameters),
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
  if (!targetKind || !targetName) throw new Error('spec.targetRef.kind and spec.targetRef.name are required')
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

const deleteScheduleRunnerResources = async (
  kube: ReturnType<typeof createKubernetesClient>,
  scheduleName: string,
  namespace: string,
) => {
  await Promise.allSettled([
    kube.delete('configmap', makeName(scheduleName, 'template'), namespace, { wait: false }),
    kube.delete('cronjob', makeName(scheduleName, 'cron'), namespace, { wait: false }),
  ])
}

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
  const suspend = spec.suspend === true
  const status = asRecord(schedule.status) ?? {}
  const scheduleName = asString(readNested(schedule, ['metadata', 'name'])) ?? 'schedule'
  if (suspend) {
    await deleteScheduleRunnerResources(kube, scheduleName, namespace)
    const conditions = upsertCondition(
      normalizeConditions(status.conditions),
      buildReadyCondition(true, 'Suspended', 'schedule suspended'),
    )
    await setStatus(kube, schedule, {
      observedGeneration: asRecord(schedule.metadata)?.generation ?? 0,
      phase: 'Suspended',
      conditions,
    })
    return
  }

  if (!cron) {
    await deleteScheduleRunnerResources(kube, scheduleName, namespace)
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
    const template = buildScheduleRunTemplate(schedule, target)
    const configName = makeName(scheduleName, 'template')
    const ownerReferences = buildOwnerRefs(schedule)
    const labels = { 'schedules.proompteng.ai/schedule': scheduleName }
    await applyResourceIfChanged(kube, {
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
    })

    const runtimeConfig = resolveSupportingRuntimeConfig()
    const cronJobName = makeName(scheduleName, 'cron')
    await applyResourceIfChanged(kube, {
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
            backoffLimit: 1,
            template: {
              metadata: { labels },
              spec: {
                serviceAccountName: runtimeConfig.serviceAccountName,
                restartPolicy: 'Never',
                ...(runtimeConfig.nodeSelector ? { nodeSelector: runtimeConfig.nodeSelector } : {}),
                containers: [
                  {
                    name: 'schedule-runner',
                    image: runtimeConfig.image,
                    command: ['bun', 'run', '/app/services/agents/src/server/supporting-schedule-runner.ts'],
                    volumeMounts: [{ name: 'schedule-template', mountPath: '/config' }],
                  },
                ],
                volumes: [
                  {
                    name: 'schedule-template',
                    configMap: { name: configName },
                  },
                ],
              },
            },
          },
        },
      },
    })
    await reconcileScheduleRunnerStatus(kube, schedule, namespace)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deleteScheduleRunnerResources(kube, scheduleName, namespace)
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
  await applyResourceIfChanged(kube, {
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
  })

  const pvcResource = await kube.get(RESOURCE_MAP.PersistentVolumeClaim, workspaceName, namespace)
  const pvcPhase = asString(readNested(pvcResource ?? {}, ['status', 'phase'])) ?? 'Pending'
  const pvcVolumeName = asString(readNested(pvcResource ?? {}, ['spec', 'volumeName'])) ?? undefined

  if (ttlSeconds && ttlSeconds > 0) {
    const createdAt = asString(readNested(workspace, ['metadata', 'creationTimestamp']))
    if (createdAt) {
      const expiresAt = new Date(createdAt).getTime() + ttlSeconds * 1000
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        await kube.delete(RESOURCE_MAP.PersistentVolumeClaim, workspaceName, namespace)
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

const reconcileSwarm = async (kube: ReturnType<typeof createKubernetesClient>, swarm: Record<string, unknown>) => {
  const status = asRecord(swarm.status) ?? {}
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(true, 'Observed', 'swarm observed by Agents supporting controller'),
  )
  await setStatus(kube, swarm, {
    observedGeneration: asRecord(swarm.metadata)?.generation ?? 0,
    phase: asString(status.phase) ?? 'Observed',
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
  if (kind === 'Tool') return reconcileTool(kube, resource)
  if (kind === 'ToolRun') return reconcileGenericReady(kube, resource, 'Observed', 'tool run observed')
  if (kind === 'ApprovalPolicy') return reconcileGenericReady(kube, resource, 'Active', 'approval policy active')
  if (kind === 'Budget') return reconcileBudget(kube, resource)
  if (kind === 'SecretBinding') return reconcileSecretBinding(kube, resource)
  if (kind === 'Signal') return reconcileGenericReady(kube, resource, 'Active', 'signal active')
  if (kind === 'SignalDelivery') return reconcileSignalDelivery(kube, resource)
  if (kind === 'Schedule') return reconcileSchedule(kube, resource, namespace)
  if (kind === 'Artifact') return reconcileArtifact(kube, resource)
  if (kind === 'Workspace') return reconcileWorkspace(kube, resource, namespace)
  if (kind === 'Swarm' && isSwarmPrimitiveEnabled()) return reconcileSwarm(kube, resource)
}

const BASE_RESOURCE_LIST_ORDER = [
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

const resolveResourceListOrder = () =>
  isSwarmPrimitiveEnabled() ? [...BASE_RESOURCE_LIST_ORDER, RESOURCE_MAP.Swarm] : BASE_RESOURCE_LIST_ORDER

const reconcileNamespace = async (kube: ReturnType<typeof createKubernetesClient>, namespace: string) => {
  for (const resourceName of resolveResourceListOrder()) {
    const payload = await kube.list(resourceName, namespace)
    for (const item of listItems(payload)) {
      await reconcileResource(kube, item, namespace)
    }
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
    console.warn('[agents] supporting controller reconcile failed', error)
  } finally {
    reconciling = false
  }
}

const resourceNameFromEvent = (resource: Record<string, unknown>) =>
  asString(readNested(resource, ['metadata', 'name'])) ?? asString(readNested(resource, ['metadata', 'generateName']))

const handleResourceEvent = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  event: { type?: string; object?: unknown },
) => {
  const resource = asRecord(event.object)
  if (!resource) return
  const kind = asString(resource.kind)
  const resourceNamespace = asString(readNested(resource, ['metadata', 'namespace'])) ?? namespace
  const name = resourceNameFromEvent(resource)
  if (!kind || !name) return
  const key = `${kind}/${resourceNamespace}/${name}`
  if (event.type === 'DELETED') {
    if (kind === 'Schedule') {
      queueResourceTask(resourceNamespace, key, async () =>
        deleteScheduleRunnerResources(kube, name, resourceNamespace),
      )
    }
    return
  }
  queueResourceTask(resourceNamespace, key, async () => reconcileResource(kube, resource, resourceNamespace))
}

const startWatches = (kube: ReturnType<typeof createKubernetesClient>, namespaces: string[]) => {
  for (const namespace of namespaces) {
    for (const resource of resolveResourceListOrder()) {
      watchHandles.push(
        startResourceWatch({
          resource,
          namespace,
          onEvent: (event) => void handleResourceEvent(kube, namespace, event),
          onError: (error) => console.warn(`[agents] supporting ${resource} watch failed`, error),
        }),
      )
    }
    watchHandles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.AgentRun,
        namespace,
        onEvent: () => void reconcileAll(kube, [namespace]),
        onError: (error) => console.warn('[agents] supporting AgentRun watch failed', error),
      }),
    )
    watchHandles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.OrchestrationRun,
        namespace,
        onEvent: () => void reconcileAll(kube, [namespace]),
        onError: (error) => console.warn('[agents] supporting OrchestrationRun watch failed', error),
      }),
    )
    watchHandles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.PersistentVolumeClaim,
        namespace,
        onEvent: () => void reconcileAll(kube, [namespace]),
        onError: (error) => console.warn('[agents] supporting PVC watch failed', error),
      }),
    )
  }
}

export const startSupportingPrimitivesController = async () => {
  if (started || starting) return
  starting = true
  try {
    if (!(await shouldStartWithFeatureFlag()) || started || !starting) return
    const kubeGateway = createKubeGateway()
    const crds = await checkCrds(kubeGateway)
    if (!crds.ok) {
      const failures = [
        ...(crds.missing.length ? [`missing: ${crds.missing.join(', ')}`] : []),
        ...(crds.forbidden.length ? [`forbidden: ${crds.forbidden.join(', ')}`] : []),
      ]
      throw new Error(`supporting primitives CRD check failed: ${failures.join('; ')}`)
    }
    const namespaces = await resolveNamespaces(kubeGateway)
    if (started || !starting) return

    const token = lifecycleToken + 1
    lifecycleToken = token
    const kube = createKubernetesClient()
    controllerState.namespaces = namespaces
    controllerState.started = true
    started = true
    console.info('[agents] supporting primitives controller namespace scope:', JSON.stringify(namespaces))

    startWatches(kube, namespaces)
    void reconcileAll(kube, namespaces)
  } catch (error) {
    console.error('[agents] supporting primitives controller failed to start', error)
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
      throw error
    }
    throw error
  } finally {
    starting = false
  }
}

export const stopSupportingPrimitivesController = () => {
  starting = false
  lifecycleToken += 1
  for (const handle of watchHandles) {
    handle.stop()
  }
  watchHandles = []
  namespaceQueues.clear()
  queuedResourceKeysByNamespace.clear()
  controllerState.started = false
  controllerState.namespaces = null
  started = false
}

export const __test__ = {
  buildScheduleRunTemplate,
  checkCrds,
  reconcileArtifact,
  reconcileBudget,
  reconcileSchedule,
  reconcileSecretBinding,
  reconcileSignalDelivery,
  reconcileSwarm,
  reconcileTool,
  reconcileWorkspace,
  resolveRequiredCrds,
  resolveResourceListOrder,
  resolveSupportingRuntimeConfig,
}

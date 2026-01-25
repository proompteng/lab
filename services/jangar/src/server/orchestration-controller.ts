import { spawn } from 'node:child_process'
import { startResourceWatch } from '~/server/kube-watch'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const DEFAULT_NAMESPACES = ['agents']

const REQUIRED_CRDS = [
  RESOURCE_MAP.Orchestration,
  RESOURCE_MAP.OrchestrationRun,
  RESOURCE_MAP.Tool,
  RESOURCE_MAP.ToolRun,
  RESOURCE_MAP.ApprovalPolicy,
  RESOURCE_MAP.Budget,
  RESOURCE_MAP.SecretBinding,
  RESOURCE_MAP.Signal,
  RESOURCE_MAP.SignalDelivery,
]

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
  __jangarOrchestrationControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__jangarOrchestrationControllerState) return globalState.__jangarOrchestrationControllerState
  const initial = { started: false, crdCheckState: null }
  globalState.__jangarOrchestrationControllerState = initial
  return initial
})()

type Condition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

type StepStatus = {
  name: string
  kind: string
  phase: string
  message?: string
  startedAt?: string
  finishedAt?: string
  lastTransitionTime?: string
  resourceRef?: Record<string, unknown>
  outputs?: Record<string, unknown>
  attempt?: number
  nextRetryAt?: string
}

let started = controllerState.started
let reconciling = false
let _crdCheckState: CrdCheckState | null = controllerState.crdCheckState
let watchHandles: Array<{ stop: () => void }> = []
const namespaceQueues = new Map<string, Promise<void>>()
const retrySchedules = new Map<string, { timeout: NodeJS.Timeout; retryAt: number }>()

const nowIso = () => new Date().toISOString()

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

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
  const flag = (process.env.JANGAR_ORCHESTRATION_CONTROLLER_ENABLED ?? '1').trim().toLowerCase()
  return flag !== '0' && flag !== 'false'
}

const parseNamespaces = () => {
  const raw = process.env.JANGAR_ORCHESTRATION_CONTROLLER_NAMESPACES
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
  _crdCheckState = state
  controllerState.crdCheckState = state
  if (!state.ok) {
    if (missing.length > 0) {
      console.error('[jangar] missing required Orchestration CRDs:', missing.join(', '))
    }
    if (forbidden.length > 0) {
      console.error(
        `[jangar] insufficient RBAC to read Orchestration CRDs in namespace ${namespace}: ${forbidden.join(', ')}`,
      )
    }
  }
  return state
}

export const getOrchestrationControllerHealth = () => ({
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
  await kube.applyStatus({
    apiVersion,
    kind,
    metadata: { name, namespace },
    status: {
      ...status,
      updatedAt: nowIso(),
      conditions,
    },
  })
}

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const validateOrchestrationSpec = (spec: Record<string, unknown>) => {
  const steps = Array.isArray(spec.steps) ? spec.steps : []
  if (steps.length === 0) {
    return {
      ok: false as const,
      reason: 'MissingSteps',
      message: 'spec.steps must include at least one step',
    }
  }

  const stepNames = new Set<string>()

  for (const rawStep of steps) {
    const step = asRecord(rawStep) ?? {}
    const name = asString(step.name)?.trim() ?? ''
    const kind = asString(step.kind)?.trim() ?? ''
    if (!name) {
      return {
        ok: false as const,
        reason: 'StepMissingName',
        message: 'steps[].name is required',
      }
    }
    if (!kind) {
      return {
        ok: false as const,
        reason: 'StepMissingKind',
        message: `step ${name} is missing kind`,
      }
    }
    if (stepNames.has(name)) {
      return {
        ok: false as const,
        reason: 'DuplicateStep',
        message: `step ${name} is duplicated`,
      }
    }
    stepNames.add(name)
  }

  const entrypoint = asString(spec.entrypoint)?.trim()
  if (entrypoint && !stepNames.has(entrypoint)) {
    return {
      ok: false as const,
      reason: 'EntrypointMissing',
      message: `entrypoint ${entrypoint} not found in steps`,
    }
  }

  for (const rawStep of steps) {
    const step = asRecord(rawStep) ?? {}
    const name = asString(step.name)?.trim() ?? ''
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : []
    for (const dep of dependsOn) {
      if (typeof dep !== 'string' || dep.trim().length === 0) continue
      if (dep === name) {
        return {
          ok: false as const,
          reason: 'InvalidDependency',
          message: `step ${name} cannot depend on itself`,
        }
      }
      if (!stepNames.has(dep)) {
        return {
          ok: false as const,
          reason: 'MissingDependency',
          message: `step ${name} depends on missing step ${dep}`,
        }
      }
    }
  }

  return { ok: true as const }
}

const normalizeStringMap = (value: Record<string, unknown> | null | undefined): Record<string, string> => {
  if (!value) return {}
  const entries = Object.entries(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return output
}

const mergeParameters = (base: Record<string, string>, overlay: Record<string, string>) => ({
  ...base,
  ...overlay,
})

const normalizeStepStatuses = (
  steps: Record<string, unknown>[],
  existing: StepStatus[],
): { statuses: StepStatus[]; index: Map<string, StepStatus> } => {
  const byName = new Map(existing.map((status) => [status.name, status]))
  const output: StepStatus[] = []
  for (const step of steps) {
    const stepName = asString(step.name) ?? ''
    const stepKind = asString(step.kind) ?? 'Unknown'
    if (!stepName) continue
    const current = byName.get(stepName)
    output.push({
      name: stepName,
      kind: stepKind,
      phase: current?.phase ?? 'Pending',
      message: current?.message,
      startedAt: current?.startedAt,
      finishedAt: current?.finishedAt,
      lastTransitionTime: current?.lastTransitionTime,
      resourceRef: current?.resourceRef,
      outputs: current?.outputs,
      attempt: typeof current?.attempt === 'number' ? current.attempt : 0,
      nextRetryAt: current?.nextRetryAt,
    })
  }
  return { statuses: output, index: new Map(output.map((status) => [status.name, status])) }
}

const setStepPhase = (status: StepStatus, phase: string, message?: string) => {
  const next = { ...status }
  if (next.phase !== phase) {
    next.phase = phase
    next.lastTransitionTime = nowIso()
  }
  if (message !== undefined) {
    next.message = message
  }
  return next
}

const makeName = (base: string, suffix: string) => {
  const max = 50
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const trimmed = sanitized.length > max ? sanitized.slice(0, max) : sanitized
  return `${trimmed}-${suffix}`
}

const resolveRetryConfig = (step: Record<string, unknown>) => {
  const retries = Math.max(0, Math.floor(parseOptionalNumber(step.retries) ?? 0))
  const retryBackoffSeconds = Math.max(0, Math.floor(parseOptionalNumber(step.retryBackoffSeconds) ?? 0))
  return { maxAttempts: retries + 1, retryBackoffSeconds }
}

const shouldRetryStep = (status: StepStatus, now: number) => {
  if (!status.nextRetryAt) return true
  const retryAt = Date.parse(status.nextRetryAt)
  return Number.isNaN(retryAt) ? true : retryAt <= now
}

const recordRetryAt = (current: number | null, retryAt: number | string | null | undefined) => {
  if (retryAt == null) return current
  const parsed = typeof retryAt === 'number' ? retryAt : Date.parse(retryAt)
  if (!Number.isFinite(parsed)) return current
  return Math.min(current ?? Number.POSITIVE_INFINITY, parsed)
}

const scheduleRetry = (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  runName: string,
  retryAt: number,
) => {
  if (!runName) return
  const key = `${namespace}/${runName}`
  const existing = retrySchedules.get(key)
  if (existing && existing.retryAt === retryAt) return
  if (existing) {
    clearTimeout(existing.timeout)
    retrySchedules.delete(key)
  }
  const delay = Math.max(0, retryAt - Date.now())
  const timeout = setTimeout(() => {
    retrySchedules.delete(key)
    enqueueNamespaceTask(namespace, () => reconcileOrchestrationRunByName(kube, namespace, runName))
  }, delay)
  retrySchedules.set(key, { timeout, retryAt })
}

const clearRetrySchedule = (namespace: string, runName: string) => {
  const key = `${namespace}/${runName}`
  const existing = retrySchedules.get(key)
  if (existing) {
    clearTimeout(existing.timeout)
    retrySchedules.delete(key)
  }
}

const renderTemplate = (input: string, context: Record<string, unknown>) => {
  return input.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, key) => {
    const path = String(key)
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean)
    let cursor: unknown = context
    for (const part of path) {
      if (!cursor || typeof cursor !== 'object') return ''
      cursor = (cursor as Record<string, unknown>)[part]
    }
    if (cursor == null) return ''
    return typeof cursor === 'string' ? cursor : JSON.stringify(cursor)
  })
}

const createRunSpecConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  owner: { name: string; uid?: string; apiVersion: string; kind: string },
  name: string,
  payload: Record<string, unknown>,
  labels: Record<string, string>,
) => {
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace,
      labels,
      ...(owner.uid
        ? {
            ownerReferences: [
              {
                apiVersion: owner.apiVersion,
                kind: owner.kind,
                name: owner.name,
                uid: owner.uid,
              },
            ],
          }
        : {}),
    },
    data: {
      'run.json': JSON.stringify(payload, null, 2),
    },
  }
  await kube.apply(configMap)
  return configMap
}

const submitToolRunJob = async (
  kube: ReturnType<typeof createKubernetesClient>,
  toolRun: Record<string, unknown>,
  tool: Record<string, unknown>,
  namespace: string,
) => {
  const toolSpec = asRecord(tool.spec) ?? {}
  const toolRunSpec = asRecord(toolRun.spec) ?? {}
  const parameters = normalizeStringMap(asRecord(toolRunSpec.parameters))
  const context = { parameters, tool, toolRun }

  const image = asString(toolSpec.image)
  if (!image) {
    throw new Error('tool.spec.image is required')
  }

  const command = Array.isArray(toolSpec.command)
    ? toolSpec.command.map((arg) => renderTemplate(String(arg), context))
    : null
  const args = Array.isArray(toolSpec.args) ? toolSpec.args.map((arg) => renderTemplate(String(arg), context)) : null
  if (!command && (!args || args.length === 0)) {
    throw new Error('tool.spec.command or tool.spec.args is required')
  }

  const envTemplate = Array.isArray(toolSpec.env) ? toolSpec.env : []
  const env = envTemplate
    .map((entry) => ({
      name: asString((entry as Record<string, unknown>).name) ?? '',
      value: renderTemplate(String((entry as Record<string, unknown>).value ?? ''), context),
    }))
    .filter((entry) => entry.name)

  const metadata = asRecord(toolRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'toolrun'
  const runUid = asString(metadata.uid) ?? undefined
  const jobName = makeName(runName, 'job')

  const labels = {
    'jangar.proompteng.ai/tool-run': runName,
  }

  const configName = makeName(runName, 'spec')
  const configMap = await createRunSpecConfigMap(
    kube,
    namespace,
    { name: runName, uid: runUid, apiVersion: 'tools.proompteng.ai/v1alpha1', kind: 'ToolRun' },
    configName,
    { toolRun, tool, parameters },
    labels,
  )

  const volumeName = makeName(configName, 'vol')

  const jobResource = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels,
      ...(runUid
        ? {
            ownerReferences: [
              {
                apiVersion: 'tools.proompteng.ai/v1alpha1',
                kind: 'ToolRun',
                name: runName,
                uid: runUid,
              },
            ],
          }
        : {}),
    },
    spec: {
      ttlSecondsAfterFinished:
        typeof toolSpec.ttlSecondsAfterFinished === 'number' ? toolSpec.ttlSecondsAfterFinished : undefined,
      template: {
        metadata: {
          labels,
        },
        spec: {
          serviceAccountName: asString(toolSpec.serviceAccount) ?? undefined,
          restartPolicy: 'Never',
          containers: [
            {
              name: 'tool-runner',
              image,
              command: command ?? undefined,
              args: args ?? undefined,
              env: [{ name: 'TOOL_RUN_SPEC', value: '/workspace/run.json' }, ...env],
              workingDir: asString(toolSpec.workingDir) ?? undefined,
              volumeMounts: [{ name: volumeName, mountPath: '/workspace/run.json', subPath: 'run.json' }],
            },
          ],
          volumes: [{ name: volumeName, configMap: { name: asString(configMap.metadata?.name) ?? configName } }],
        },
      },
    },
  }

  const applied = await kube.apply(jobResource)
  return {
    type: 'job',
    name: jobName,
    namespace,
    uid: asString(readNested(applied, ['metadata', 'uid'])) ?? undefined,
  }
}

const reconcileOrchestration = async (
  kube: ReturnType<typeof createKubernetesClient>,
  orchestration: Record<string, unknown>,
) => {
  const spec = asRecord(orchestration.spec) ?? {}
  const status = asRecord(orchestration.status) ?? {}
  const validation = validateOrchestrationSpec(spec)
  const conditions = upsertCondition(
    normalizeConditions(status.conditions),
    buildReadyCondition(
      validation.ok,
      validation.ok ? 'ValidSpec' : validation.reason,
      validation.ok ? 'orchestration ready' : validation.message,
    ),
  )

  await setStatus(kube, orchestration, {
    observedGeneration: asRecord(orchestration.metadata)?.generation ?? 0,
    phase: validation.ok ? 'Ready' : 'Invalid',
    conditions,
  })
}

const reconcileToolRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  toolRun: Record<string, unknown>,
  namespace: string,
) => {
  const metadata = asRecord(toolRun.metadata) ?? {}
  const name = asString(metadata.name) ?? ''
  if (!name) return

  const spec = asRecord(toolRun.spec) ?? {}
  const status = asRecord(toolRun.status) ?? {}
  const phase = asString(status.phase) ?? 'Pending'
  const runtimeRef = asRecord(status.runtimeRef) ?? null

  if (['Succeeded', 'Failed', 'Cancelled'].includes(phase)) return

  if (!runtimeRef && phase === 'Pending') {
    const toolRefName = asString(readNested(spec, ['toolRef', 'name']))
    if (!toolRefName) {
      await setStatus(kube, toolRun, {
        observedGeneration: asRecord(toolRun.metadata)?.generation ?? 0,
        phase: 'Failed',
        conditions: upsertCondition(normalizeConditions(status.conditions), {
          type: 'Failed',
          status: 'True',
          reason: 'MissingTool',
          message: 'spec.toolRef.name is required',
        }),
      })
      return
    }
    const tool = await kube.get(RESOURCE_MAP.Tool, toolRefName, namespace)
    if (!tool) {
      await setStatus(kube, toolRun, {
        observedGeneration: asRecord(toolRun.metadata)?.generation ?? 0,
        phase: 'Failed',
        conditions: upsertCondition(normalizeConditions(status.conditions), {
          type: 'Failed',
          status: 'True',
          reason: 'MissingTool',
          message: `tool ${toolRefName} not found`,
        }),
      })
      return
    }
    try {
      const newRuntimeRef = await submitToolRunJob(kube, toolRun, tool, namespace)
      await setStatus(kube, toolRun, {
        observedGeneration: asRecord(toolRun.metadata)?.generation ?? 0,
        phase: 'Running',
        startedAt: nowIso(),
        runtimeRef: newRuntimeRef,
        conditions: upsertCondition(normalizeConditions(status.conditions), {
          type: 'Running',
          status: 'True',
          reason: 'Submitted',
        }),
      })
    } catch (error) {
      await setStatus(kube, toolRun, {
        observedGeneration: asRecord(toolRun.metadata)?.generation ?? 0,
        phase: 'Failed',
        finishedAt: nowIso(),
        conditions: upsertCondition(normalizeConditions(status.conditions), {
          type: 'Failed',
          status: 'True',
          reason: 'SubmitFailed',
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    }
    return
  }

  if (!runtimeRef) return
  if (asString(runtimeRef.type) !== 'job') return
  const jobName = asString(runtimeRef.name)
  if (!jobName) return

  const job = await kube.get('job', jobName, asString(runtimeRef.namespace) ?? namespace)
  if (!job) return

  const jobStatus = asRecord(job.status) ?? {}
  const succeeded = Number(jobStatus.succeeded ?? 0)
  const failed = Number(jobStatus.failed ?? 0)
  if (succeeded > 0 || isJobComplete(job)) {
    await setStatus(kube, toolRun, {
      observedGeneration: asRecord(toolRun.metadata)?.generation ?? 0,
      phase: 'Succeeded',
      startedAt: asString(jobStatus.startTime) ?? asString(status.startedAt) ?? undefined,
      finishedAt: asString(jobStatus.completionTime) ?? nowIso(),
      runtimeRef,
      conditions: upsertCondition(normalizeConditions(status.conditions), {
        type: 'Succeeded',
        status: 'True',
        reason: 'Completed',
      }),
    })
  } else if (failed > 0 && isJobFailed(job)) {
    await setStatus(kube, toolRun, {
      observedGeneration: asRecord(toolRun.metadata)?.generation ?? 0,
      phase: 'Failed',
      finishedAt: nowIso(),
      runtimeRef,
      conditions: upsertCondition(normalizeConditions(status.conditions), {
        type: 'Failed',
        status: 'True',
        reason: 'JobFailed',
      }),
    })
  }
}

const resolveDependsOn = (step: Record<string, unknown>) => {
  const raw = step.dependsOn
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

const depsSatisfied = (dependsOn: string[], statusIndex: Map<string, StepStatus>) => {
  if (dependsOn.length === 0) return true
  return dependsOn.every((dep) => statusIndex.get(dep)?.phase === 'Succeeded')
}

const buildResourceRef = (resource: Record<string, unknown>) => {
  const metadata = asRecord(resource.metadata) ?? {}
  return {
    apiVersion: asString(resource.apiVersion) ?? undefined,
    kind: asString(resource.kind) ?? undefined,
    name: asString(metadata.name) ?? undefined,
    namespace: asString(metadata.namespace) ?? undefined,
    uid: asString(metadata.uid) ?? undefined,
  }
}

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  const current = namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.warn('[jangar] orchestration controller task failed', error)
    })
  namespaceQueues.set(namespace, next)
}

const submitAgentRunStep = async (
  kube: ReturnType<typeof createKubernetesClient>,
  step: Record<string, unknown>,
  orchestrationRun: Record<string, unknown>,
  namespace: string,
  parameters: Record<string, string>,
) => {
  const agentRefName =
    asString(readNested(step, ['agentRef', 'name'])) ??
    asString(step.agentRef) ??
    asString(readNested(step, ['with', 'agentRef']))
  if (!agentRefName) {
    throw new Error('agentRef.name is required for AgentRun step')
  }

  const implRefName =
    asString(readNested(step, ['implementationSpecRef', 'name'])) ??
    asString(step.implementationSpecRef) ??
    asString(readNested(step, ['with', 'implementationSpecRef']))
  const implementation = asRecord(readNested(step, ['implementation'])) ?? null

  if (!implRefName && !implementation) {
    throw new Error('implementationSpecRef or implementation is required for AgentRun step')
  }

  const runtime = asRecord(readNested(step, ['runtime'])) ?? asRecord(readNested(step, ['with', 'runtime'])) ?? {}
  const runtimeType = asString(runtime.type) ?? 'job'
  const runtimeConfig = asRecord(runtime.config) ?? {}
  const workload = asRecord(readNested(step, ['workload'])) ?? undefined
  const memoryRefName = asString(readNested(step, ['memoryRef', 'name'])) ?? asString(step.memoryRef)
  const secrets = Array.isArray(step.secrets)
    ? step.secrets.filter((val): val is string => typeof val === 'string')
    : []

  const metadata = asRecord(orchestrationRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'orchestration'

  const resource = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      generateName: `${makeName(runName, asString(step.name) ?? 'step')}-`,
      namespace,
      labels: {
        'jangar.proompteng.ai/orchestration-run': runName,
        'jangar.proompteng.ai/orchestration-step': asString(step.name) ?? '',
      },
    },
    spec: {
      agentRef: { name: agentRefName },
      ...(implRefName ? { implementationSpecRef: { name: implRefName } } : {}),
      ...(implementation ? { implementation } : {}),
      parameters,
      ...(memoryRefName ? { memoryRef: { name: memoryRefName } } : {}),
      ...(secrets.length > 0 ? { secrets } : {}),
      runtime: { type: runtimeType, ...(Object.keys(runtimeConfig).length > 0 ? { config: runtimeConfig } : {}) },
      ...(workload ? { workload } : {}),
    },
  }

  const applied = await kube.apply(resource)
  return buildResourceRef(applied)
}

const submitToolRunStep = async (
  kube: ReturnType<typeof createKubernetesClient>,
  step: Record<string, unknown>,
  orchestrationRun: Record<string, unknown>,
  namespace: string,
  parameters: Record<string, string>,
) => {
  const toolRefName =
    asString(readNested(step, ['toolRef', 'name'])) ??
    asString(step.toolRef) ??
    asString(readNested(step, ['with', 'toolRef']))
  if (!toolRefName) {
    throw new Error('toolRef.name is required for ToolRun step')
  }

  const metadata = asRecord(orchestrationRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'orchestration'

  const resource = {
    apiVersion: 'tools.proompteng.ai/v1alpha1',
    kind: 'ToolRun',
    metadata: {
      generateName: `${makeName(runName, asString(step.name) ?? 'tool')}-`,
      namespace,
      labels: {
        'jangar.proompteng.ai/orchestration-run': runName,
        'jangar.proompteng.ai/orchestration-step': asString(step.name) ?? '',
      },
    },
    spec: {
      toolRef: { name: toolRefName },
      parameters,
    },
  }

  const applied = await kube.apply(resource)
  return buildResourceRef(applied)
}

const submitSubOrchestrationStep = async (
  kube: ReturnType<typeof createKubernetesClient>,
  step: Record<string, unknown>,
  orchestrationRun: Record<string, unknown>,
  namespace: string,
  parameters: Record<string, string>,
) => {
  const orchestrationName =
    asString(readNested(step, ['orchestrationRef', 'name'])) ??
    asString(step.orchestrationRef) ??
    asString(readNested(step, ['with', 'orchestrationRef']))
  if (!orchestrationName) {
    throw new Error('orchestrationRef.name is required for SubOrchestration step')
  }

  const metadata = asRecord(orchestrationRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'orchestration'

  const resource = {
    apiVersion: 'orchestration.proompteng.ai/v1alpha1',
    kind: 'OrchestrationRun',
    metadata: {
      generateName: `${makeName(runName, asString(step.name) ?? 'sub')}-`,
      namespace,
      labels: {
        'jangar.proompteng.ai/orchestration-run': runName,
        'jangar.proompteng.ai/orchestration-step': asString(step.name) ?? '',
      },
    },
    spec: {
      orchestrationRef: { name: orchestrationName },
      parameters,
    },
  }

  const applied = await kube.apply(resource)
  return buildResourceRef(applied)
}

const resolvePhase = (raw: unknown) => asString(raw) ?? 'Pending'

const classifyPhase = (phase: string) => phase.toLowerCase()

const isTerminal = (phase: string) => ['succeeded', 'failed', 'cancelled'].includes(classifyPhase(phase))

const buildStepGraph = (steps: Record<string, unknown>[]) => {
  const names = steps.map((step) => asString(step.name) ?? '').filter(Boolean)
  const indexMap = new Map(names.map((name, index) => [name, index]))
  const adjacency = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const name of names) {
    adjacency.set(name, [])
    indegree.set(name, 0)
  }
  for (const step of steps) {
    const stepName = asString(step.name) ?? ''
    if (!stepName) continue
    const deps = resolveDependsOn(step)
    for (const dep of deps) {
      if (!adjacency.has(dep)) continue
      adjacency.get(dep)?.push(stepName)
      indegree.set(stepName, (indegree.get(stepName) ?? 0) + 1)
    }
  }

  const sorted: Record<string, unknown>[] = []
  const queue = names
    .filter((name) => (indegree.get(name) ?? 0) === 0)
    .sort((a, b) => (indexMap.get(a) ?? 0) - (indexMap.get(b) ?? 0))

  while (queue.length > 0) {
    const name = queue.shift()
    if (!name) continue
    const step = steps.find((candidate) => asString(candidate.name) === name)
    if (step) sorted.push(step)
    for (const neighbor of adjacency.get(name) ?? []) {
      const nextDegree = (indegree.get(neighbor) ?? 0) - 1
      indegree.set(neighbor, nextDegree)
      if (nextDegree === 0) {
        queue.push(neighbor)
        queue.sort((a, b) => (indexMap.get(a) ?? 0) - (indexMap.get(b) ?? 0))
      }
    }
  }

  if (sorted.length !== steps.length) {
    return {
      ok: false as const,
      reason: 'DependencyCycle',
      message: 'orchestration has a dependency cycle',
    }
  }

  return { ok: true as const, steps: sorted }
}

const emitRunEvent = async (
  kube: ReturnType<typeof createKubernetesClient>,
  run: Record<string, unknown>,
  reason: string,
  message: string,
  type: 'Normal' | 'Warning' = 'Warning',
) => {
  const metadata = asRecord(run.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!name || !namespace) return
  const uid = asString(metadata.uid)
  const eventName = makeName(name, 'event')
  const event = {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: {
      generateName: `${eventName}-`,
      namespace,
    },
    type,
    reason,
    message,
    involvedObject: {
      apiVersion: asString(run.apiVersion) ?? 'orchestration.proompteng.ai/v1alpha1',
      kind: asString(run.kind) ?? 'OrchestrationRun',
      name,
      namespace,
      uid: uid ?? undefined,
    },
    source: {
      component: 'jangar-orchestration-controller',
    },
    firstTimestamp: nowIso(),
    lastTimestamp: nowIso(),
    count: 1,
  }
  await kube.apply(event)
}

const reconcileOrchestrationRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  orchestrationRun: Record<string, unknown>,
  namespace: string,
) => {
  const metadata = asRecord(orchestrationRun.metadata) ?? {}
  const name = asString(metadata.name) ?? ''
  if (!name) return

  const spec = asRecord(orchestrationRun.spec) ?? {}
  const status = asRecord(orchestrationRun.status) ?? {}
  const runPhase = resolvePhase(status.phase)

  if (isTerminal(runPhase)) return

  const orchestrationName = asString(readNested(spec, ['orchestrationRef', 'name']))
  if (!orchestrationName) {
    await setStatus(kube, orchestrationRun, {
      observedGeneration: asRecord(orchestrationRun.metadata)?.generation ?? 0,
      phase: 'Failed',
      finishedAt: nowIso(),
      conditions: upsertCondition(normalizeConditions(status.conditions), {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingOrchestrationRef',
        message: 'spec.orchestrationRef.name is required',
      }),
    })
    return
  }

  const orchestration = await kube.get(RESOURCE_MAP.Orchestration, orchestrationName, namespace)
  if (!orchestration) {
    await setStatus(kube, orchestrationRun, {
      observedGeneration: asRecord(orchestrationRun.metadata)?.generation ?? 0,
      phase: 'Failed',
      finishedAt: nowIso(),
      conditions: upsertCondition(normalizeConditions(status.conditions), {
        type: 'InvalidSpec',
        status: 'True',
        reason: 'MissingOrchestration',
        message: `orchestration ${orchestrationName} not found`,
      }),
    })
    return
  }

  const orchestrationSpec = asRecord(orchestration.spec) ?? {}
  const steps = Array.isArray(orchestrationSpec.steps) ? orchestrationSpec.steps : []
  const orchestrationValidation = validateOrchestrationSpec(orchestrationSpec)
  if (!orchestrationValidation.ok) {
    await setStatus(kube, orchestrationRun, {
      observedGeneration: asRecord(orchestrationRun.metadata)?.generation ?? 0,
      phase: 'Failed',
      finishedAt: nowIso(),
      conditions: upsertCondition(normalizeConditions(status.conditions), {
        type: 'InvalidSpec',
        status: 'True',
        reason: orchestrationValidation.reason,
        message: orchestrationValidation.message,
      }),
    })
    return
  }
  const graph = buildStepGraph(steps as Record<string, unknown>[])
  if (!graph.ok) {
    await setStatus(kube, orchestrationRun, {
      observedGeneration: asRecord(orchestrationRun.metadata)?.generation ?? 0,
      phase: 'Failed',
      finishedAt: nowIso(),
      conditions: upsertCondition(normalizeConditions(status.conditions), {
        type: 'InvalidSpec',
        status: 'True',
        reason: graph.reason,
        message: graph.message,
      }),
    })
    return
  }
  const orderedSteps = graph.steps
  const existingSteps = Array.isArray(status.stepStatuses)
    ? status.stepStatuses.filter((item): item is StepStatus => !!item && typeof item === 'object')
    : []
  const { index: statusIndex } = normalizeStepStatuses(steps as Record<string, unknown>[], existingSteps)
  const nextStatusMap = new Map<string, StepStatus>()

  const orchestrationParams = normalizeStringMap(asRecord(spec.parameters))
  let anyRunning = false
  let anyFailed = false
  let allSucceeded = true
  let failureMessage = ''
  let failureReason = ''
  let scheduledRetryAt: number | null = null

  for (const rawStep of orderedSteps as Record<string, unknown>[]) {
    const step = asRecord(rawStep) ?? {}
    const stepName = asString(step.name) ?? ''
    const stepKind = asString(step.kind) ?? 'Unknown'
    if (!stepName) continue

    const current = statusIndex.get(stepName) ?? { name: stepName, kind: stepKind, phase: 'Pending', attempt: 0 }
    const currentAttempt = current.attempt ?? 0
    const dependsOn = resolveDependsOn(step)
    const canStart = depsSatisfied(dependsOn, statusIndex)
    const retryConfig = resolveRetryConfig(step)
    const now = Date.now()

    if (current.phase === 'Succeeded') {
      nextStatusMap.set(stepName, current)
      statusIndex.set(stepName, current)
      continue
    }

    if (current.phase === 'Failed') {
      if (currentAttempt < retryConfig.maxAttempts) {
        const retryAt =
          retryConfig.retryBackoffSeconds > 0
            ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
            : nowIso()
        const retrying = setStepPhase(current, 'Retrying', current.message ?? 'Retrying')
        retrying.nextRetryAt = retryAt
        retrying.finishedAt = retrying.finishedAt ?? nowIso()
        anyRunning = true
        allSucceeded = false
        scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
        nextStatusMap.set(stepName, retrying)
        statusIndex.set(stepName, retrying)
      } else {
        anyFailed = true
        allSucceeded = false
        if (!failureMessage) {
          failureMessage = current.message ?? `step ${stepName} failed`
          failureReason = 'StepFailed'
        }
        nextStatusMap.set(stepName, current)
        statusIndex.set(stepName, current)
      }
      continue
    }

    if (current.phase === 'Retrying') {
      if (!shouldRetryStep(current, now)) {
        anyRunning = true
        allSucceeded = false
        const retryAt = current.nextRetryAt ? Date.parse(current.nextRetryAt) : now
        scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
        nextStatusMap.set(stepName, current)
        statusIndex.set(stepName, current)
        continue
      }
      const pending = setStepPhase(current, 'Pending')
      pending.nextRetryAt = undefined
      pending.resourceRef = undefined
      statusIndex.set(stepName, pending)
      nextStatusMap.set(stepName, pending)
      current.phase = pending.phase
      current.lastTransitionTime = pending.lastTransitionTime
      current.nextRetryAt = pending.nextRetryAt
      current.resourceRef = pending.resourceRef
    }

    if (!canStart) {
      allSucceeded = false
      nextStatusMap.set(stepName, current)
      statusIndex.set(stepName, current)
      continue
    }

    try {
      if (stepKind === 'ApprovalGate') {
        const policyName = asString(step.policyRef) ?? asString(readNested(step, ['with', 'policyRef']))
        if (!policyName) {
          throw new Error('policyRef is required for ApprovalGate')
        }
        const policy = await kube.get(RESOURCE_MAP.ApprovalPolicy, policyName, namespace)
        if (!policy) {
          throw new Error(`approval policy ${policyName} not found`)
        }
        const policyPhase = asString(readNested(policy, ['status', 'phase']))?.toLowerCase() ?? ''
        if (['denied', 'rejected', 'blocked', 'failed'].includes(policyPhase)) {
          const failed = setStepPhase(current, 'Failed', `approval policy ${policyName} is ${policyPhase}`)
          failed.finishedAt = nowIso()
          anyFailed = true
          allSucceeded = false
          if (!failureMessage) {
            failureMessage = failed.message ?? `step ${stepName} failed`
            failureReason = 'ApprovalDenied'
          }
          nextStatusMap.set(stepName, failed)
          statusIndex.set(stepName, failed)
        } else if (['approved', 'allowed', 'ready', 'succeeded'].includes(policyPhase)) {
          const succeeded = setStepPhase(current, 'Succeeded')
          succeeded.startedAt = current.startedAt ?? nowIso()
          succeeded.finishedAt = nowIso()
          nextStatusMap.set(stepName, succeeded)
          statusIndex.set(stepName, succeeded)
        } else {
          anyRunning = true
          allSucceeded = false
          nextStatusMap.set(stepName, current)
          statusIndex.set(stepName, current)
        }
        continue
      }

      if (stepKind === 'SignalWait') {
        const signalRef =
          asString(step.signalRef) ??
          asString(readNested(step, ['with', 'signalRef'])) ??
          asString(readNested(step, ['signalRef', 'name']))
        const deliveryId = asString(step.deliveryId) ?? asString(readNested(step, ['with', 'deliveryId']))
        if (!signalRef && !deliveryId) {
          throw new Error('signalRef or deliveryId is required for SignalWait')
        }
        const deliveries = listItems(await kube.list(RESOURCE_MAP.SignalDelivery, namespace))
        const match = deliveries.find((delivery) => {
          const refName = asString(readNested(delivery, ['spec', 'signalRef', 'name']))
          const refDeliveryId = asString(readNested(delivery, ['spec', 'deliveryId']))
          if (deliveryId && refDeliveryId === deliveryId) return true
          if (signalRef && refName === signalRef) return true
          return false
        })
        if (match) {
          const succeeded = setStepPhase(current, 'Succeeded')
          succeeded.startedAt = current.startedAt ?? nowIso()
          succeeded.finishedAt = nowIso()
          succeeded.resourceRef = buildResourceRef(match)
          nextStatusMap.set(stepName, succeeded)
          statusIndex.set(stepName, succeeded)
        } else {
          anyRunning = true
          allSucceeded = false
          nextStatusMap.set(stepName, current)
          statusIndex.set(stepName, current)
        }
        continue
      }

      if (stepKind === 'Checkpoint' || stepKind === 'MemoryOp') {
        const succeeded = setStepPhase(current, 'Succeeded')
        succeeded.startedAt = current.startedAt ?? nowIso()
        succeeded.finishedAt = nowIso()
        nextStatusMap.set(stepName, succeeded)
        statusIndex.set(stepName, succeeded)
        continue
      }

      if (stepKind === 'AgentRun') {
        if (!current.resourceRef) {
          const attempt = currentAttempt + 1
          if (attempt > retryConfig.maxAttempts) {
            const failed = setStepPhase(current, 'Failed', 'Retry limit exceeded')
            failed.finishedAt = nowIso()
            anyFailed = true
            allSucceeded = false
            if (!failureMessage) {
              failureMessage = failed.message ?? `step ${stepName} failed`
              failureReason = 'RetriesExhausted'
            }
            nextStatusMap.set(stepName, failed)
            statusIndex.set(stepName, failed)
            continue
          }
          const merged = mergeParameters(orchestrationParams, normalizeStringMap(asRecord(step.with)))
          const resourceRef = await submitAgentRunStep(kube, step, orchestrationRun, namespace, merged)
          const running = setStepPhase(current, 'Running')
          running.startedAt = current.startedAt ?? nowIso()
          running.resourceRef = resourceRef
          running.attempt = attempt
          anyRunning = true
          allSucceeded = false
          nextStatusMap.set(stepName, running)
          statusIndex.set(stepName, running)
        } else {
          const refName = asString(current.resourceRef.name)
          const refNamespace = asString(current.resourceRef.namespace) ?? namespace
          if (refName) {
            const agentRun = await kube.get(RESOURCE_MAP.AgentRun, refName, refNamespace)
            if (!agentRun) {
              const failed = setStepPhase(current, 'Failed', 'agent run not found')
              failed.finishedAt = nowIso()
              if (currentAttempt < retryConfig.maxAttempts) {
                const retryAt =
                  retryConfig.retryBackoffSeconds > 0
                    ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
                    : nowIso()
                const retrying = setStepPhase(failed, 'Retrying', failed.message)
                retrying.nextRetryAt = retryAt
                anyRunning = true
                allSucceeded = false
                scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
                nextStatusMap.set(stepName, retrying)
                statusIndex.set(stepName, retrying)
              } else {
                anyFailed = true
                allSucceeded = false
                if (!failureMessage) {
                  failureMessage = failed.message ?? `step ${stepName} failed`
                  failureReason = 'AgentRunMissing'
                }
                nextStatusMap.set(stepName, failed)
                statusIndex.set(stepName, failed)
              }
            } else {
              const agentPhase = asString(readNested(agentRun, ['status', 'phase'])) ?? 'Pending'
              if (agentPhase === 'Succeeded') {
                const succeeded = setStepPhase(current, 'Succeeded')
                succeeded.finishedAt = asString(readNested(agentRun, ['status', 'finishedAt'])) ?? nowIso()
                succeeded.startedAt =
                  asString(readNested(agentRun, ['status', 'startedAt'])) ?? current.startedAt ?? undefined
                nextStatusMap.set(stepName, succeeded)
                statusIndex.set(stepName, succeeded)
              } else if (agentPhase === 'Failed' || agentPhase === 'Cancelled') {
                const failed = setStepPhase(current, 'Failed', `agent run ${agentPhase.toLowerCase()}`)
                failed.finishedAt = asString(readNested(agentRun, ['status', 'finishedAt'])) ?? nowIso()
                if (currentAttempt < retryConfig.maxAttempts) {
                  const retryAt =
                    retryConfig.retryBackoffSeconds > 0
                      ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
                      : nowIso()
                  const retrying = setStepPhase(failed, 'Retrying', failed.message)
                  retrying.nextRetryAt = retryAt
                  anyRunning = true
                  allSucceeded = false
                  scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
                  nextStatusMap.set(stepName, retrying)
                  statusIndex.set(stepName, retrying)
                } else {
                  anyFailed = true
                  allSucceeded = false
                  if (!failureMessage) {
                    failureMessage = failed.message ?? `step ${stepName} failed`
                    failureReason = 'AgentRunFailed'
                  }
                  nextStatusMap.set(stepName, failed)
                  statusIndex.set(stepName, failed)
                }
              } else {
                anyRunning = true
                allSucceeded = false
                nextStatusMap.set(stepName, current)
                statusIndex.set(stepName, current)
              }
            }
          } else {
            const failed = setStepPhase(current, 'Failed', 'agent run reference missing')
            failed.finishedAt = nowIso()
            anyFailed = true
            allSucceeded = false
            if (!failureMessage) {
              failureMessage = failed.message ?? `step ${stepName} failed`
              failureReason = 'AgentRunMissing'
            }
            nextStatusMap.set(stepName, failed)
            statusIndex.set(stepName, failed)
          }
        }
        continue
      }

      if (stepKind === 'ToolRun') {
        if (!current.resourceRef) {
          const attempt = currentAttempt + 1
          if (attempt > retryConfig.maxAttempts) {
            const failed = setStepPhase(current, 'Failed', 'Retry limit exceeded')
            failed.finishedAt = nowIso()
            anyFailed = true
            allSucceeded = false
            if (!failureMessage) {
              failureMessage = failed.message ?? `step ${stepName} failed`
              failureReason = 'RetriesExhausted'
            }
            nextStatusMap.set(stepName, failed)
            statusIndex.set(stepName, failed)
            continue
          }
          const merged = mergeParameters(orchestrationParams, normalizeStringMap(asRecord(step.with)))
          const resourceRef = await submitToolRunStep(kube, step, orchestrationRun, namespace, merged)
          const running = setStepPhase(current, 'Running')
          running.startedAt = current.startedAt ?? nowIso()
          running.resourceRef = resourceRef
          running.attempt = attempt
          anyRunning = true
          allSucceeded = false
          nextStatusMap.set(stepName, running)
          statusIndex.set(stepName, running)
        } else {
          const refName = asString(current.resourceRef.name)
          const refNamespace = asString(current.resourceRef.namespace) ?? namespace
          if (refName) {
            const toolRun = await kube.get(RESOURCE_MAP.ToolRun, refName, refNamespace)
            if (!toolRun) {
              const failed = setStepPhase(current, 'Failed', 'tool run not found')
              failed.finishedAt = nowIso()
              if (currentAttempt < retryConfig.maxAttempts) {
                const retryAt =
                  retryConfig.retryBackoffSeconds > 0
                    ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
                    : nowIso()
                const retrying = setStepPhase(failed, 'Retrying', failed.message)
                retrying.nextRetryAt = retryAt
                anyRunning = true
                allSucceeded = false
                scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
                nextStatusMap.set(stepName, retrying)
                statusIndex.set(stepName, retrying)
              } else {
                anyFailed = true
                allSucceeded = false
                if (!failureMessage) {
                  failureMessage = failed.message ?? `step ${stepName} failed`
                  failureReason = 'ToolRunMissing'
                }
                nextStatusMap.set(stepName, failed)
                statusIndex.set(stepName, failed)
              }
            } else {
              const toolPhase = asString(readNested(toolRun, ['status', 'phase'])) ?? 'Pending'
              if (toolPhase === 'Succeeded') {
                const succeeded = setStepPhase(current, 'Succeeded')
                succeeded.finishedAt = asString(readNested(toolRun, ['status', 'finishedAt'])) ?? nowIso()
                succeeded.startedAt =
                  asString(readNested(toolRun, ['status', 'startedAt'])) ?? current.startedAt ?? undefined
                nextStatusMap.set(stepName, succeeded)
                statusIndex.set(stepName, succeeded)
              } else if (toolPhase === 'Failed' || toolPhase === 'Cancelled') {
                const failed = setStepPhase(current, 'Failed', `tool run ${toolPhase.toLowerCase()}`)
                failed.finishedAt = asString(readNested(toolRun, ['status', 'finishedAt'])) ?? nowIso()
                if (currentAttempt < retryConfig.maxAttempts) {
                  const retryAt =
                    retryConfig.retryBackoffSeconds > 0
                      ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
                      : nowIso()
                  const retrying = setStepPhase(failed, 'Retrying', failed.message)
                  retrying.nextRetryAt = retryAt
                  anyRunning = true
                  allSucceeded = false
                  scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
                  nextStatusMap.set(stepName, retrying)
                  statusIndex.set(stepName, retrying)
                } else {
                  anyFailed = true
                  allSucceeded = false
                  if (!failureMessage) {
                    failureMessage = failed.message ?? `step ${stepName} failed`
                    failureReason = 'ToolRunFailed'
                  }
                  nextStatusMap.set(stepName, failed)
                  statusIndex.set(stepName, failed)
                }
              } else {
                anyRunning = true
                allSucceeded = false
                nextStatusMap.set(stepName, current)
                statusIndex.set(stepName, current)
              }
            }
          } else {
            const failed = setStepPhase(current, 'Failed', 'tool run reference missing')
            failed.finishedAt = nowIso()
            anyFailed = true
            allSucceeded = false
            if (!failureMessage) {
              failureMessage = failed.message ?? `step ${stepName} failed`
              failureReason = 'ToolRunMissing'
            }
            nextStatusMap.set(stepName, failed)
            statusIndex.set(stepName, failed)
          }
        }
        continue
      }

      if (stepKind === 'SubOrchestration') {
        if (!current.resourceRef) {
          const attempt = currentAttempt + 1
          if (attempt > retryConfig.maxAttempts) {
            const failed = setStepPhase(current, 'Failed', 'Retry limit exceeded')
            failed.finishedAt = nowIso()
            anyFailed = true
            allSucceeded = false
            if (!failureMessage) {
              failureMessage = failed.message ?? `step ${stepName} failed`
              failureReason = 'RetriesExhausted'
            }
            nextStatusMap.set(stepName, failed)
            statusIndex.set(stepName, failed)
            continue
          }
          const merged = mergeParameters(orchestrationParams, normalizeStringMap(asRecord(step.with)))
          const resourceRef = await submitSubOrchestrationStep(kube, step, orchestrationRun, namespace, merged)
          const running = setStepPhase(current, 'Running')
          running.startedAt = current.startedAt ?? nowIso()
          running.resourceRef = resourceRef
          running.attempt = attempt
          anyRunning = true
          allSucceeded = false
          nextStatusMap.set(stepName, running)
          statusIndex.set(stepName, running)
        } else {
          const refName = asString(current.resourceRef.name)
          const refNamespace = asString(current.resourceRef.namespace) ?? namespace
          if (refName) {
            const subRun = await kube.get(RESOURCE_MAP.OrchestrationRun, refName, refNamespace)
            if (!subRun) {
              const failed = setStepPhase(current, 'Failed', 'sub orchestration run not found')
              failed.finishedAt = nowIso()
              if (currentAttempt < retryConfig.maxAttempts) {
                const retryAt =
                  retryConfig.retryBackoffSeconds > 0
                    ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
                    : nowIso()
                const retrying = setStepPhase(failed, 'Retrying', failed.message)
                retrying.nextRetryAt = retryAt
                anyRunning = true
                allSucceeded = false
                scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
                nextStatusMap.set(stepName, retrying)
                statusIndex.set(stepName, retrying)
              } else {
                anyFailed = true
                allSucceeded = false
                if (!failureMessage) {
                  failureMessage = failed.message ?? `step ${stepName} failed`
                  failureReason = 'SubOrchestrationMissing'
                }
                nextStatusMap.set(stepName, failed)
                statusIndex.set(stepName, failed)
              }
            } else {
              const subPhase = asString(readNested(subRun, ['status', 'phase'])) ?? 'Pending'
              if (subPhase === 'Succeeded') {
                const succeeded = setStepPhase(current, 'Succeeded')
                succeeded.finishedAt = asString(readNested(subRun, ['status', 'finishedAt'])) ?? nowIso()
                succeeded.startedAt =
                  asString(readNested(subRun, ['status', 'startedAt'])) ?? current.startedAt ?? undefined
                nextStatusMap.set(stepName, succeeded)
                statusIndex.set(stepName, succeeded)
              } else if (subPhase === 'Failed' || subPhase === 'Cancelled') {
                const failed = setStepPhase(current, 'Failed', `sub orchestration ${subPhase.toLowerCase()}`)
                failed.finishedAt = asString(readNested(subRun, ['status', 'finishedAt'])) ?? nowIso()
                if (currentAttempt < retryConfig.maxAttempts) {
                  const retryAt =
                    retryConfig.retryBackoffSeconds > 0
                      ? new Date(now + retryConfig.retryBackoffSeconds * 1000).toISOString()
                      : nowIso()
                  const retrying = setStepPhase(failed, 'Retrying', failed.message)
                  retrying.nextRetryAt = retryAt
                  anyRunning = true
                  allSucceeded = false
                  scheduledRetryAt = recordRetryAt(scheduledRetryAt, retryAt)
                  nextStatusMap.set(stepName, retrying)
                  statusIndex.set(stepName, retrying)
                } else {
                  anyFailed = true
                  allSucceeded = false
                  if (!failureMessage) {
                    failureMessage = failed.message ?? `step ${stepName} failed`
                    failureReason = 'SubOrchestrationFailed'
                  }
                  nextStatusMap.set(stepName, failed)
                  statusIndex.set(stepName, failed)
                }
              } else {
                anyRunning = true
                allSucceeded = false
                nextStatusMap.set(stepName, current)
                statusIndex.set(stepName, current)
              }
            }
          } else {
            const failed = setStepPhase(current, 'Failed', 'sub orchestration reference missing')
            failed.finishedAt = nowIso()
            anyFailed = true
            allSucceeded = false
            if (!failureMessage) {
              failureMessage = failed.message ?? `step ${stepName} failed`
              failureReason = 'SubOrchestrationMissing'
            }
            nextStatusMap.set(stepName, failed)
            statusIndex.set(stepName, failed)
          }
        }
        continue
      }

      const failed = setStepPhase(current, 'Failed', `unsupported step kind ${stepKind}`)
      failed.finishedAt = nowIso()
      anyFailed = true
      allSucceeded = false
      if (!failureMessage) {
        failureMessage = failed.message ?? `step ${stepName} failed`
        failureReason = 'UnsupportedStep'
      }
      nextStatusMap.set(stepName, failed)
      statusIndex.set(stepName, failed)
    } catch (error) {
      const failed = setStepPhase(current, 'Failed', error instanceof Error ? error.message : String(error))
      failed.finishedAt = nowIso()
      anyFailed = true
      allSucceeded = false
      if (!failureMessage) {
        failureMessage = failed.message ?? `step ${stepName} failed`
        failureReason = 'StepError'
      }
      nextStatusMap.set(stepName, failed)
      statusIndex.set(stepName, failed)
    }
  }

  const nextStatuses = (steps as Record<string, unknown>[])
    .map((step) => nextStatusMap.get(asString(step.name) ?? ''))
    .filter((status): status is StepStatus => !!status)

  let nextPhase = 'Pending'
  if (anyFailed) {
    nextPhase = 'Failed'
  } else if (allSucceeded && nextStatuses.length > 0) {
    nextPhase = 'Succeeded'
  } else if (anyRunning) {
    nextPhase = 'Running'
  }

  const conditions = normalizeConditions(status.conditions)
  let updatedConditions = conditions
  if (nextPhase === 'Running') {
    updatedConditions = upsertCondition(updatedConditions, { type: 'Accepted', status: 'True', reason: 'Submitted' })
    updatedConditions = upsertCondition(updatedConditions, { type: 'InProgress', status: 'True', reason: 'Running' })
    updatedConditions = upsertCondition(updatedConditions, { type: 'Running', status: 'True', reason: 'InProgress' })
  }
  if (nextPhase === 'Succeeded') {
    updatedConditions = upsertCondition(updatedConditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
  }
  if (nextPhase === 'Failed') {
    updatedConditions = upsertCondition(updatedConditions, {
      type: 'Failed',
      status: 'True',
      reason: failureReason || 'StepFailed',
      message: failureMessage || 'orchestration step failed',
    })
  }

  await setStatus(kube, orchestrationRun, {
    observedGeneration: asRecord(orchestrationRun.metadata)?.generation ?? 0,
    phase: nextPhase,
    runId: asString(metadata.name) ?? undefined,
    startedAt: asString(status.startedAt) ?? (nextPhase === 'Running' ? nowIso() : undefined),
    finishedAt: nextPhase === 'Succeeded' || nextPhase === 'Failed' ? nowIso() : undefined,
    stepStatuses: nextStatuses,
    conditions: updatedConditions,
  })

  if (scheduledRetryAt !== null && Number.isFinite(scheduledRetryAt)) {
    scheduleRetry(kube, namespace, name, scheduledRetryAt)
  } else {
    clearRetrySchedule(namespace, name)
  }

  if (nextPhase === 'Failed') {
    const failedSteps = nextStatuses.filter((status) => status.phase === 'Failed')
    await Promise.allSettled(
      failedSteps.map((step) =>
        emitRunEvent(
          kube,
          orchestrationRun,
          'StepFailed',
          `step ${step.name} failed${step.message ? `: ${step.message}` : ''}`,
          'Warning',
        ),
      ),
    )
  }
}

const reconcileAll = async (kube: ReturnType<typeof createKubernetesClient>, namespaces: string[]) => {
  if (reconciling) return
  reconciling = true
  try {
    await checkCrds()
    for (const namespace of namespaces) {
      const orchestrations = listItems(await kube.list(RESOURCE_MAP.Orchestration, namespace))
      for (const orchestration of orchestrations) {
        await reconcileOrchestration(kube, orchestration)
      }

      const toolRuns = listItems(await kube.list(RESOURCE_MAP.ToolRun, namespace))
      for (const toolRun of toolRuns) {
        await reconcileToolRun(kube, toolRun, namespace)
      }

      const orchestrationRuns = listItems(await kube.list(RESOURCE_MAP.OrchestrationRun, namespace))
      for (const orchestrationRun of orchestrationRuns) {
        await reconcileOrchestrationRun(kube, orchestrationRun, namespace)
      }
    }
  } catch (error) {
    console.warn('[jangar] orchestration controller failed', error)
  } finally {
    reconciling = false
  }
}

const resolveParentRunLabel = (resource: Record<string, unknown>) =>
  asString(readNested(resource, ['metadata', 'labels', 'jangar.proompteng.ai/orchestration-run']))

const reconcileOrchestrationRunByName = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  name: string,
) => {
  if (!name) return
  const run = await kube.get(RESOURCE_MAP.OrchestrationRun, name, namespace)
  if (!run) return
  await reconcileOrchestrationRun(kube, run, namespace)
}

const reconcileAllRunsInNamespace = async (kube: ReturnType<typeof createKubernetesClient>, namespace: string) => {
  const orchestrationRuns = listItems(await kube.list(RESOURCE_MAP.OrchestrationRun, namespace))
  for (const orchestrationRun of orchestrationRuns) {
    await reconcileOrchestrationRun(kube, orchestrationRun, namespace)
  }
}

const startNamespaceWatches = (kube: ReturnType<typeof createKubernetesClient>, namespace: string) => {
  const handleOrchestrationRun = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource || event.type === 'DELETED') return
    enqueueNamespaceTask(namespace, () => reconcileOrchestrationRun(kube, resource, namespace))
  }

  const handleToolRun = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    enqueueNamespaceTask(namespace, async () => {
      if (event.type !== 'DELETED') {
        await reconcileToolRun(kube, resource, namespace)
      }
      const parent = resolveParentRunLabel(resource)
      if (parent) {
        await reconcileOrchestrationRunByName(kube, namespace, parent)
      }
    })
  }

  const handleAgentRun = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const parent = resolveParentRunLabel(resource)
    if (!parent) return
    enqueueNamespaceTask(namespace, () => reconcileOrchestrationRunByName(kube, namespace, parent))
  }

  const handleJob = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const toolRunName = asString(readNested(resource, ['metadata', 'labels', 'jangar.proompteng.ai/tool-run']))
    if (!toolRunName) return
    enqueueNamespaceTask(namespace, async () => {
      const toolRun = await kube.get(RESOURCE_MAP.ToolRun, toolRunName, namespace)
      if (!toolRun) return
      await reconcileToolRun(kube, toolRun, namespace)
      const parent = resolveParentRunLabel(toolRun)
      if (parent) {
        await reconcileOrchestrationRunByName(kube, namespace, parent)
      }
    })
  }

  const handlePolicyOrSignal = () => {
    enqueueNamespaceTask(namespace, () => reconcileAllRunsInNamespace(kube, namespace))
  }

  const handleOrchestration = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource || event.type === 'DELETED') return
    enqueueNamespaceTask(namespace, async () => {
      await reconcileOrchestration(kube, resource)
      await reconcileAllRunsInNamespace(kube, namespace)
    })
  }

  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.OrchestrationRun,
      namespace,
      onEvent: handleOrchestrationRun,
      onError: (error) => console.warn('[jangar] orchestration run watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ToolRun,
      namespace,
      onEvent: handleToolRun,
      onError: (error) => console.warn('[jangar] tool run watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentRun,
      namespace,
      onEvent: handleAgentRun,
      onError: (error) => console.warn('[jangar] agent run watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.SignalDelivery,
      namespace,
      onEvent: handlePolicyOrSignal,
      onError: (error) => console.warn('[jangar] signal delivery watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ApprovalPolicy,
      namespace,
      onEvent: handlePolicyOrSignal,
      onError: (error) => console.warn('[jangar] approval policy watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Orchestration,
      namespace,
      onEvent: handleOrchestration,
      onError: (error) => console.warn('[jangar] orchestration watch failed', error),
    }),
  )
  watchHandles.push(
    startResourceWatch({
      resource: 'job',
      namespace,
      labelSelector: 'jangar.proompteng.ai/tool-run',
      onEvent: handleJob,
      onError: (error) => console.warn('[jangar] tool job watch failed', error),
    }),
  )
}

export const startOrchestrationController = async () => {
  if (started || !shouldStart()) return
  try {
    await checkCrds()
    const kube = createKubernetesClient()
    const namespaces = parseNamespaces()
    await reconcileAll(kube, namespaces)
    for (const namespace of namespaces) {
      startNamespaceWatches(kube, namespace)
    }
    started = true
    controllerState.started = true
  } catch (error) {
    console.warn('[jangar] orchestration controller failed to start', error)
  }
}

export const stopOrchestrationController = () => {
  for (const handle of watchHandles) {
    handle.stop()
  }
  watchHandles = []
  namespaceQueues.clear()
  for (const entry of retrySchedules.values()) {
    clearTimeout(entry.timeout)
  }
  retrySchedules.clear()
  started = false
  controllerState.started = false
}

export const __test__ = {
  reconcileOrchestration,
  reconcileOrchestrationRun,
  emitRunEvent,
}

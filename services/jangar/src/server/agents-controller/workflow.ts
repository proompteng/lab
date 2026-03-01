import { asRecord, asString, readNested } from '~/server/primitives-http'

import { parseBooleanEnv, parseNumberEnv, parseOptionalNumber } from './env-config'

const PARAMETERS_MAX_ENTRIES = 100
const PARAMETERS_MAX_VALUE_BYTES = 2048

const WORKFLOW_LOOPS_ENABLED_ENV = 'JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED'
const WORKFLOW_LOOP_MAX_ITERATIONS_ENV = 'JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_MAX_ITERATIONS'
const WORKFLOW_LOOP_STATUS_HISTORY_LIMIT_ENV = 'JANGAR_AGENTS_CONTROLLER_WORKFLOW_LOOP_STATUS_HISTORY_LIMIT'

const WORKFLOW_LOOP_MAX_ITERATIONS_DEFAULT = 20
const WORKFLOW_LOOP_STATUS_HISTORY_LIMIT_DEFAULT = 50

const nowIso = () => new Date().toISOString()

const parseStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : []

const toNonNegativeInteger = (value: unknown, fallback = 0) => {
  const parsed = parseOptionalNumber(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.trunc(parsed ?? fallback))
}

const normalizeLoopConditionSource = (source: Record<string, unknown> | null): WorkflowLoopConditionSourceSpec => {
  const path = asString(source?.path) ?? '/workspace/.agentrun/loop-control.json'
  const onMissingRaw = (asString(source?.onMissing) ?? 'stop').toLowerCase()
  const onInvalidRaw = (asString(source?.onInvalid) ?? 'fail').toLowerCase()
  return {
    type: 'file',
    path,
    onMissing: onMissingRaw === 'fail' ? 'fail' : 'stop',
    onInvalid: onInvalidRaw === 'stop' ? 'stop' : 'fail',
  }
}

export const isWorkflowLoopsEnabled = () => parseBooleanEnv(process.env[WORKFLOW_LOOPS_ENABLED_ENV], false)

export const resolveWorkflowLoopMaxIterationsLimit = () =>
  parseNumberEnv(process.env[WORKFLOW_LOOP_MAX_ITERATIONS_ENV], WORKFLOW_LOOP_MAX_ITERATIONS_DEFAULT, 1)

export const resolveWorkflowLoopStatusHistoryLimit = () =>
  parseNumberEnv(process.env[WORKFLOW_LOOP_STATUS_HISTORY_LIMIT_ENV], WORKFLOW_LOOP_STATUS_HISTORY_LIMIT_DEFAULT, 1)

export type WorkflowLoopConditionSourceSpec = {
  type: 'file'
  path: string
  onMissing: 'stop' | 'fail'
  onInvalid: 'stop' | 'fail'
}

export type WorkflowLoopConditionSpec = {
  type: 'cel'
  expression: string
  source: WorkflowLoopConditionSourceSpec
}

export type WorkflowLoopStateSpec = {
  required: boolean
  volumeNames: string[]
}

export type WorkflowLoopSpec = {
  maxIterations: number
  condition: WorkflowLoopConditionSpec | null
  state: WorkflowLoopStateSpec
}

export type WorkflowStepSpec = {
  name: string
  implementationSpecRefName: string | null
  implementationInline: Record<string, unknown> | null
  parameters: Record<string, string>
  workload: Record<string, unknown> | null
  retries: number
  retryBackoffSeconds: number
  timeoutSeconds: number
  loop: WorkflowLoopSpec | null
}

export type WorkflowLoopIterationStatus = {
  index: number
  phase: string
  attempts: number
  startedAt?: string
  finishedAt?: string
  message?: string
  jobRef?: Record<string, unknown>
}

export type WorkflowLoopStatus = {
  currentIteration: number
  completedIterations: number
  maxIterations: number
  stopReason?: string
  retainedIterations: number
  prunedIterations: number
  lastControl?: Record<string, unknown>
  iterations: WorkflowLoopIterationStatus[]
}

export type WorkflowStepStatus = {
  name: string
  phase: string
  attempt: number
  startedAt?: string
  finishedAt?: string
  lastTransitionTime: string
  message?: string
  jobRef?: Record<string, unknown>
  jobObservedAt?: string
  nextRetryAt?: string
  loop?: WorkflowLoopStatus
}

export type WorkflowStatus = {
  phase: string
  lastTransitionTime: string
  steps: WorkflowStepStatus[]
}

export const validateParameters = (params: Record<string, unknown>) => {
  const entries = Object.entries(params)
  if (entries.length > PARAMETERS_MAX_ENTRIES) {
    return {
      ok: false as const,
      reason: 'ParametersTooLarge',
      message: `spec.parameters exceeds ${PARAMETERS_MAX_ENTRIES} entries`,
    }
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      return {
        ok: false as const,
        reason: 'ParameterNotString',
        message: `spec.parameters.${key} must be a string`,
      }
    }
    if (Buffer.byteLength(value, 'utf8') > PARAMETERS_MAX_VALUE_BYTES) {
      return {
        ok: false as const,
        reason: 'ParameterValueTooLarge',
        message: `spec.parameters.${key} exceeds ${PARAMETERS_MAX_VALUE_BYTES} bytes`,
      }
    }
  }
  return { ok: true as const }
}

const parseWorkflowStepLoop = (step: Record<string, unknown>): WorkflowLoopSpec | null => {
  const loop = asRecord(step.loop)
  if (!loop) return null
  const condition = asRecord(loop.condition)
  const source = normalizeLoopConditionSource(asRecord(condition?.source) ?? null)
  const state = asRecord(loop.state)
  return {
    maxIterations: toNonNegativeInteger(loop.maxIterations, 0),
    condition: condition
      ? {
          type: 'cel',
          expression: asString(condition.expression) ?? '',
          source,
        }
      : null,
    state: {
      required: Boolean(state?.required),
      volumeNames: parseStringArray(state?.volumeNames),
    },
  }
}

export const parseWorkflowSteps = (agentRun: Record<string, unknown>): WorkflowStepSpec[] => {
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
      const timeoutSeconds = parseOptionalNumber(step.timeoutSeconds)
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
        timeoutSeconds: Number.isFinite(timeoutSeconds) ? Math.max(0, Math.trunc(timeoutSeconds ?? 0)) : 0,
        loop: parseWorkflowStepLoop(step),
      }
    })
    .filter((step) => step.name.length > 0)
}

const resolveEffectiveWorkflowVolumes = (step: WorkflowStepSpec, baseWorkload: Record<string, unknown> | null) => {
  const stepVolumes = Array.isArray(step.workload?.volumes) ? (step.workload?.volumes as Record<string, unknown>[]) : []
  const baseVolumes = Array.isArray(baseWorkload?.volumes) ? (baseWorkload?.volumes as Record<string, unknown>[]) : []
  const selected = stepVolumes.length > 0 ? stepVolumes : baseVolumes
  const byName = new Map<string, Record<string, unknown>>()
  for (const item of selected) {
    const name = asString(item.name)
    if (!name) continue
    byName.set(name, item)
  }
  return byName
}

export const validateWorkflowSteps = (
  steps: WorkflowStepSpec[],
  options: { baseWorkload?: Record<string, unknown> | null } = {},
) => {
  if (steps.length === 0) {
    return {
      ok: false as const,
      reason: 'MissingWorkflowSteps',
      message: 'spec.workflow.steps must include at least one step for workflow runtime',
    }
  }
  const seen = new Set<string>()
  const loopsEnabled = isWorkflowLoopsEnabled()
  const maxLoopIterationsLimit = resolveWorkflowLoopMaxIterationsLimit()
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
    const loop = step.loop
    if (!loop) continue
    if (!loopsEnabled) {
      return {
        ok: false as const,
        reason: 'WorkflowLoopsDisabled',
        message: `workflow step ${step.name}: workflow loops are disabled`,
      }
    }
    if (loop.maxIterations < 1) {
      return {
        ok: false as const,
        reason: 'WorkflowLoopMaxIterationsInvalid',
        message: `workflow step ${step.name}: loop.maxIterations must be >= 1`,
      }
    }
    if (loop.maxIterations > maxLoopIterationsLimit) {
      return {
        ok: false as const,
        reason: 'WorkflowLoopMaxIterationsExceeded',
        message: `workflow step ${step.name}: loop.maxIterations exceeds limit ${maxLoopIterationsLimit}`,
      }
    }
    if (loop.condition) {
      if (loop.condition.type !== 'cel') {
        return {
          ok: false as const,
          reason: 'WorkflowLoopConditionTypeInvalid',
          message: `workflow step ${step.name}: loop.condition.type must be cel`,
        }
      }
      if (loop.condition.expression.trim().length === 0) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopConditionExpressionMissing',
          message: `workflow step ${step.name}: loop.condition.expression is required`,
        }
      }
      if (loop.condition.source.type !== 'file') {
        return {
          ok: false as const,
          reason: 'WorkflowLoopConditionSourceTypeInvalid',
          message: `workflow step ${step.name}: loop.condition.source.type must be file`,
        }
      }
      if (loop.condition.source.path.length > 0 && !loop.condition.source.path.startsWith('/')) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopConditionPathInvalid',
          message: `workflow step ${step.name}: loop.condition.source.path must be absolute`,
        }
      }
      if (!['stop', 'fail'].includes(loop.condition.source.onMissing)) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopConditionOnMissingInvalid',
          message: `workflow step ${step.name}: loop.condition.source.onMissing must be stop or fail`,
        }
      }
      if (!['stop', 'fail'].includes(loop.condition.source.onInvalid)) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopConditionOnInvalidInvalid',
          message: `workflow step ${step.name}: loop.condition.source.onInvalid must be stop or fail`,
        }
      }
    }
    const dedup = new Set<string>()
    for (const volumeName of loop.state.volumeNames) {
      if (dedup.has(volumeName)) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopStateVolumeDuplicate',
          message: `workflow step ${step.name}: loop.state.volumeNames contains duplicate ${volumeName}`,
        }
      }
      dedup.add(volumeName)
    }
    const effectiveVolumes = resolveEffectiveWorkflowVolumes(step, options.baseWorkload ?? null)
    for (const volumeName of loop.state.volumeNames) {
      if (!effectiveVolumes.has(volumeName)) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopStateVolumeMissing',
          message: `workflow step ${step.name}: loop.state.volumeNames references missing volume ${volumeName}`,
        }
      }
    }
    if (loop.state.required) {
      if (loop.state.volumeNames.length === 0) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopStateVolumeRequired',
          message: `workflow step ${step.name}: loop.state.volumeNames is required when loop.state.required=true`,
        }
      }
      const hasPersistentVolume = loop.state.volumeNames.some((volumeName) => {
        const volume = effectiveVolumes.get(volumeName)
        if (!volume) return false
        const type = (asString(volume.type) ?? '').toLowerCase()
        const claimName = asString(volume.claimName) ?? ''
        return type === 'pvc' && claimName.length > 0
      })
      if (!hasPersistentVolume) {
        return {
          ok: false as const,
          reason: 'WorkflowLoopStateVolumeNotPersistent',
          message: `workflow step ${step.name}: loop.state.required requires at least one pvc volume with claimName`,
        }
      }
    }
  }
  return { ok: true as const }
}

const normalizeWorkflowLoopIterations = (loop: Record<string, unknown>): WorkflowLoopIterationStatus[] => {
  const rawIterations = Array.isArray(loop.iterations) ? (loop.iterations as Record<string, unknown>[]) : []
  const normalized: WorkflowLoopIterationStatus[] = []
  for (const item of rawIterations) {
    const index = toNonNegativeInteger(item.index, 0)
    if (index < 1) continue
    normalized.push({
      index,
      phase: asString(item.phase) ?? 'Pending',
      attempts: toNonNegativeInteger(item.attempts ?? item.attempt, 0),
      startedAt: asString(item.startedAt) ?? undefined,
      finishedAt: asString(item.finishedAt) ?? undefined,
      message: asString(item.message) ?? undefined,
      jobRef: asRecord(item.jobRef) ?? undefined,
    })
  }
  normalized.sort((a, b) => a.index - b.index)
  return normalized
}

const normalizeWorkflowLoopStatus = (step: WorkflowStepSpec, current: Record<string, unknown>) => {
  if (!step.loop) return undefined
  const existingLoop = asRecord(current.loop) ?? {}
  const iterations = normalizeWorkflowLoopIterations(existingLoop)
  return {
    currentIteration: toNonNegativeInteger(existingLoop.currentIteration, 0),
    completedIterations: toNonNegativeInteger(existingLoop.completedIterations, 0),
    maxIterations: step.loop.maxIterations,
    stopReason: asString(existingLoop.stopReason) ?? undefined,
    retainedIterations: toNonNegativeInteger(existingLoop.retainedIterations, iterations.length),
    prunedIterations: toNonNegativeInteger(existingLoop.prunedIterations, 0),
    lastControl: asRecord(existingLoop.lastControl) ?? undefined,
    iterations,
  } satisfies WorkflowLoopStatus
}

export const normalizeWorkflowStatus = (
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
        jobObservedAt: asString(current.jobObservedAt) ?? undefined,
        nextRetryAt: asString(current.nextRetryAt) ?? undefined,
        loop: normalizeWorkflowLoopStatus(step, current),
      }
    }),
  }
}

export const setWorkflowPhase = (workflow: WorkflowStatus, phase: string) => {
  if (workflow.phase !== phase) {
    workflow.phase = phase
    workflow.lastTransitionTime = nowIso()
  }
}

export const setWorkflowStepPhase = (step: WorkflowStepStatus, phase: string, message?: string) => {
  if (step.phase !== phase) {
    step.phase = phase
    step.lastTransitionTime = nowIso()
  }
  if (message !== undefined) {
    step.message = message
  }
}

export const shouldRetryStep = (step: WorkflowStepStatus, now: number) => {
  if (!step.nextRetryAt) return true
  const retryAt = Date.parse(step.nextRetryAt)
  return Number.isNaN(retryAt) ? true : retryAt <= now
}

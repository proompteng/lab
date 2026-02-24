import { asRecord, asString, readNested } from '~/server/primitives-http'

import { parseOptionalNumber } from './env-config'

const PARAMETERS_MAX_ENTRIES = 100
const PARAMETERS_MAX_VALUE_BYTES = 2048

const nowIso = () => new Date().toISOString()

export type WorkflowStepSpec = {
  name: string
  implementationSpecRefName: string | null
  implementationInline: Record<string, unknown> | null
  parameters: Record<string, string>
  workload: Record<string, unknown> | null
  retries: number
  retryBackoffSeconds: number
  timeoutSeconds: number
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
      }
    })
    .filter((step) => step.name.length > 0)
}

export const validateWorkflowSteps = (steps: WorkflowStepSpec[]) => {
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

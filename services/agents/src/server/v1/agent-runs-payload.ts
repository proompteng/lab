import { asString } from '../primitives'

export type AgentRunPayload = {
  agentRef: { name: string }
  namespace: string
  idempotencyKey?: string
  implementationSpecRef?: { name: string }
  implementation?: Record<string, unknown>
  goal?: { objective: string; tokenBudget?: number }
  runtime: { type: string; config?: Record<string, unknown> }
  workflow?: { steps: WorkflowStepPayload[] }
  workload?: Record<string, unknown>
  memoryRef?: { name: string }
  vcsRef?: { name: string }
  vcsPolicy?: { required?: boolean; mode?: string }
  parameters?: Record<string, string>
  secrets?: string[]
  policy?: Record<string, unknown>
  ttlSecondsAfterFinished?: number
  systemPrompt?: unknown
  systemPromptRef?: unknown
}

export type WorkflowStepPayload = {
  name: string
  implementationSpecRef?: { name: string }
  implementation?: Record<string, unknown>
  parameters?: Record<string, string>
  workload?: Record<string, unknown>
  retries?: number
  retryBackoffSeconds?: number
}

export const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export const parseGoal = (value: Record<string, unknown> | null): AgentRunPayload['goal'] => {
  if (!value) return undefined
  const objective = asString(value.objective)
  if (!objective) {
    throw new Error('goal.objective is required')
  }
  const tokenBudget = parseOptionalNumber(value.tokenBudget)
  if (value.tokenBudget != null && tokenBudget === undefined) {
    throw new Error('goal.tokenBudget must be a number')
  }
  if (tokenBudget !== undefined && tokenBudget <= 0) {
    throw new Error('goal.tokenBudget must be > 0')
  }
  return {
    objective,
    ...(tokenBudget !== undefined ? { tokenBudget: Math.trunc(tokenBudget) } : {}),
  }
}

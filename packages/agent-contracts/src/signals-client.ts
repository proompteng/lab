import { postAgentsJsonEffect, runAgentsJsonPromise, type AgentsServiceJsonResult, type EnvSource } from './agents-http'
import {
  SWARM_REQUIREMENT_LABEL_CHANNEL,
  SWARM_REQUIREMENT_LABEL_FROM,
  SWARM_REQUIREMENT_LABEL_TO,
  SWARM_REQUIREMENT_LABEL_TYPE,
} from './swarm-contracts'

export const SWARM_REQUIREMENT_SIGNAL_LABEL_TYPE = SWARM_REQUIREMENT_LABEL_TYPE
export const SWARM_REQUIREMENT_SIGNAL_LABEL_TO = SWARM_REQUIREMENT_LABEL_TO
export const SWARM_REQUIREMENT_SIGNAL_LABEL_FROM = SWARM_REQUIREMENT_LABEL_FROM
export const SWARM_REQUIREMENT_SIGNAL_LABEL_CHANNEL = SWARM_REQUIREMENT_LABEL_CHANNEL

export type AgentsSwarmRequirementSignalSubmitInput = {
  deliveryId: string
  name: string
  namespace: string
  sourceSwarm: string
  targetSwarm: string
  channel: string
  description: string
  priority?: string | null
  payload: Record<string, unknown>
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

export type AgentsSignalResource = Record<string, unknown>

export type AgentsSignalResourceResult = {
  ok: boolean
  kind?: 'Signal' | string | null
  namespace?: string | null
  resource?: AgentsSignalResource | null
}

const normalizeLabelValue = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'unknown'

export const buildSwarmRequirementSignalResource = (
  input: AgentsSwarmRequirementSignalSubmitInput,
): Record<string, unknown> => {
  const priority = input.priority?.trim() || 'normal'
  return {
    apiVersion: 'signals.proompteng.ai/v1alpha1',
    kind: 'Signal',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        [SWARM_REQUIREMENT_SIGNAL_LABEL_TYPE]: 'requirement',
        [SWARM_REQUIREMENT_SIGNAL_LABEL_FROM]: normalizeLabelValue(input.sourceSwarm),
        [SWARM_REQUIREMENT_SIGNAL_LABEL_TO]: normalizeLabelValue(input.targetSwarm),
        [SWARM_REQUIREMENT_SIGNAL_LABEL_CHANNEL]: 'nats',
        priority: normalizeLabelValue(priority),
        ...input.labels,
      },
      annotations: {
        ...input.annotations,
      },
    },
    spec: {
      channel: input.channel,
      description: input.description,
      priority,
      payload: input.payload,
    },
  }
}

export const submitSwarmRequirementSignalToAgentsServiceEffect = (
  input: AgentsSwarmRequirementSignalSubmitInput,
  env: EnvSource = process.env,
) =>
  postAgentsJsonEffect<AgentsSignalResourceResult>(
    '/v1/signals/resources',
    buildSwarmRequirementSignalResource(input),
    {
      env,
      idempotencyKey: input.deliveryId,
    },
  )

export const submitSwarmRequirementSignalToAgentsService = async (
  input: AgentsSwarmRequirementSignalSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsSignalResourceResult>> =>
  runAgentsJsonPromise(submitSwarmRequirementSignalToAgentsServiceEffect(input, env))

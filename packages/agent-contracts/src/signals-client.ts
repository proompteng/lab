import { postAgentsJson, type AgentsServiceJsonResult, type EnvSource } from './agents-http'

export const SWARM_REQUIREMENT_SIGNAL_LABEL_TYPE = 'swarm.proompteng.ai/type'
export const SWARM_REQUIREMENT_SIGNAL_LABEL_TO = 'swarm.proompteng.ai/to'
export const SWARM_REQUIREMENT_SIGNAL_LABEL_FROM = 'swarm.proompteng.ai/from'
export const SWARM_REQUIREMENT_SIGNAL_LABEL_CHANNEL = 'swarm.proompteng.ai/requirement-channel'

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

export const submitSwarmRequirementSignalToAgentsService = async (
  input: AgentsSwarmRequirementSignalSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsSignalResourceResult>> =>
  postAgentsJson<AgentsSignalResourceResult>('/v1/signals/resources', buildSwarmRequirementSignalResource(input), {
    env,
    idempotencyKey: input.deliveryId,
  })

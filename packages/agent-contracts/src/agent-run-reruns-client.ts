import { postAgentsJsonEffect, runAgentsJsonPromise, type EnvSource } from './agents-http'

export type AgentsAgentRunRerunSubmitInput = {
  agentRunId: string
  deliveryId: string
  payload: Record<string, unknown>
}

export type AgentsAgentRunRerunSubmitResult = {
  ok: boolean
  agentRun?: Record<string, unknown>
  submission?: Record<string, unknown>
  orchestrationRun?: Record<string, unknown>
  resource?: Record<string, unknown> | null
  idempotent?: boolean
}

const encodePathSegment = (value: string) => encodeURIComponent(value)

export const submitAgentRunRerunToAgentsServiceEffect = (
  input: AgentsAgentRunRerunSubmitInput,
  env: EnvSource = process.env,
) =>
  postAgentsJsonEffect<AgentsAgentRunRerunSubmitResult>(
    `/v1/agent-runs/${encodePathSegment(input.agentRunId)}/reruns`,
    { ...input.payload, deliveryId: input.deliveryId },
    {
      env,
      idempotencyKey: input.deliveryId,
    },
  )

export const submitAgentRunRerunToAgentsService = async (
  input: AgentsAgentRunRerunSubmitInput,
  env: EnvSource = process.env,
) => runAgentsJsonPromise(submitAgentRunRerunToAgentsServiceEffect(input, env))

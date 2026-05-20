import { postAgentsJsonEffect, runAgentsJsonPromise, type EnvSource } from './agents-http'

export type AgentsAgentRunCallbackSubmitInput = {
  agentRunId: string
  callbackType: 'notify' | 'run_complete'
  payload: Record<string, unknown>
}

export type AgentsAgentRunCallbackSubmitResult = {
  ok: boolean
  callbackType?: string
  agentRun?: Record<string, unknown>
}

const encodePathSegment = (value: string) => encodeURIComponent(value)

export const submitAgentRunCallbackToAgentsServiceEffect = (
  input: AgentsAgentRunCallbackSubmitInput,
  env: EnvSource = process.env,
) =>
  postAgentsJsonEffect<AgentsAgentRunCallbackSubmitResult>(
    `/v1/agent-runs/${encodePathSegment(input.agentRunId)}/callbacks`,
    { ...input.payload, callbackType: input.callbackType },
    { env },
  )

export const submitAgentRunCallbackToAgentsService = async (
  input: AgentsAgentRunCallbackSubmitInput,
  env: EnvSource = process.env,
) => runAgentsJsonPromise(submitAgentRunCallbackToAgentsServiceEffect(input, env))

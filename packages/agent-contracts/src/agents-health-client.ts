import { fetchAgentsJson, type AgentsServiceJsonResult, type EnvSource } from './agents-http'

export type { AgentsServiceJsonResult } from './agents-http'

export type AgentsHealthController = {
  enabled: boolean
  crdsReady: boolean | null
}

export type AgentsHealthPayload = {
  status?: string
  service?: string
  agentsController?: AgentsHealthController
}

export const fetchAgentsHealthFromAgentsService = async (
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsHealthPayload>> => fetchAgentsJson<AgentsHealthPayload>('/health', env)

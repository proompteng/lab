import {
  fetchAgentsJsonEffect,
  runAgentsJsonPromise,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

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

export type AgentsDependencyHealth = {
  status: 'healthy' | 'degraded' | 'unavailable'
  ready: boolean
  http_status: number
  error: string | null
  controller: AgentsHealthController
}

export const unavailableAgentsController = (): AgentsHealthController => ({
  enabled: true,
  crdsReady: false,
})

export const buildAgentsDependencyHealth = (
  result: AgentsServiceJsonResult<AgentsHealthPayload>,
): AgentsDependencyHealth => {
  const controller = result.body?.agentsController ?? unavailableAgentsController()
  const ready = result.ok && (controller.enabled ? controller.crdsReady !== false : true)

  return {
    status: !result.ok ? 'unavailable' : ready ? 'healthy' : 'degraded',
    ready,
    http_status: result.status,
    error: result.ok ? null : (result.error ?? `Agents service returned HTTP ${result.status}`),
    controller,
  }
}

export const fetchAgentsHealthFromAgentsServiceEffect = (env: EnvSource = process.env) =>
  fetchAgentsJsonEffect<AgentsHealthPayload>('/health', env)

export const fetchAgentsHealthFromAgentsService = async (
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsHealthPayload>> =>
  runAgentsJsonPromise(fetchAgentsHealthFromAgentsServiceEffect(env))

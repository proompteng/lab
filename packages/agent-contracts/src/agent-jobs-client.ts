import {
  appendAgentsListParams,
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  runAgentsJsonPromise,
  servicePath,
  type AgentsResourceListInput,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type AgentsJobResourceListInput = AgentsResourceListInput

export type AgentsJobResource = Record<string, unknown>

export type AgentsJobResourcesResult = {
  ok: boolean
  kind?: 'Job' | string | null
  namespace?: string | null
  total?: number | null
  items: AgentsJobResource[]
}

export const fetchJobResourcesFromAgentsServiceEffect = (
  input: AgentsJobResourceListInput = {},
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/jobs/resources', env)
  appendAgentsListParams(targetUrl, input)
  return fetchAgentsJsonEffect<AgentsJobResourcesResult>(servicePath(targetUrl), env)
}

export const fetchJobResourcesFromAgentsService = async (
  input: AgentsJobResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsJobResourcesResult>> =>
  runAgentsJsonPromise(fetchJobResourcesFromAgentsServiceEffect(input, env))

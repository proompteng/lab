import {
  buildAgentsServiceUrl,
  fetchAgentsJson,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'
import type { ExecutionTrustSnapshot } from './execution-trust'

export type AgentsExecutionTrustGetInput = {
  namespace?: string | null
  swarms?: string[] | null
  summaryLimit?: number | null
}

export const fetchExecutionTrustFromAgentsService = async (
  input: AgentsExecutionTrustGetInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<ExecutionTrustSnapshot>> => {
  const targetUrl = buildAgentsServiceUrl('/v1/control-plane/execution-trust', env)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  const swarms = (input.swarms ?? []).map((swarm) => swarm.trim()).filter((swarm) => swarm.length > 0)
  if (swarms.length > 0) targetUrl.searchParams.set('swarms', swarms.join(','))
  if (input.summaryLimit && input.summaryLimit > 0) {
    targetUrl.searchParams.set('summaryLimit', String(Math.trunc(input.summaryLimit)))
  }
  return fetchAgentsJson<ExecutionTrustSnapshot>(servicePath(targetUrl), env)
}

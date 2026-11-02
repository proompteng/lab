import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  runAgentsJsonPromise,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type AgentsAgentRunLogPodContainer = {
  name: string
  type: 'main' | 'init'
}

export type AgentsAgentRunLogPod = {
  name: string
  phase: string | null
  containers: AgentsAgentRunLogPodContainer[]
}

export type AgentsAgentRunLogsInput = {
  name: string
  namespace: string
  pod?: string | null
  container?: string | null
  tailLines?: number | null
}

export type AgentsAgentRunLogsResult = {
  ok: true
  name: string
  namespace: string
  pods: AgentsAgentRunLogPod[]
  logs: string
  pod: string | null
  container: string | null
  tailLines: number | null
}

export const fetchAgentRunLogsFromAgentsServiceEffect = (
  input: AgentsAgentRunLogsInput,
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/control-plane/logs', env)
  targetUrl.searchParams.set('name', input.name)
  targetUrl.searchParams.set('namespace', input.namespace)
  const pod = input.pod?.trim()
  if (pod) targetUrl.searchParams.set('pod', pod)
  const container = input.container?.trim()
  if (container) targetUrl.searchParams.set('container', container)
  if (input.tailLines && input.tailLines > 0)
    targetUrl.searchParams.set('tailLines', String(Math.trunc(input.tailLines)))
  return fetchAgentsJsonEffect<AgentsAgentRunLogsResult>(servicePath(targetUrl), env)
}

export const fetchAgentRunLogsFromAgentsService = async (
  input: AgentsAgentRunLogsInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunLogsResult>> =>
  runAgentsJsonPromise(fetchAgentRunLogsFromAgentsServiceEffect(input, env))

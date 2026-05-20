import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  postAgentsJsonEffect,
  runAgentsJsonPromise,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type AgentsAgentRunTerminalEvent = {
  eventId: string
  name: string
  namespace: string
  uid: string | null
  phase: string
  runId: string | null
  observedAt: string | null
  acked: boolean
  ackedAt: string | null
  ackOutcome: string | null
  resource: Record<string, unknown>
  status: Record<string, unknown>
}

export type AgentsAgentRunTerminalEventsListInput = {
  namespace?: string | null
  runIdPrefix?: string | null
  consumer?: string | null
  includeAcked?: boolean | null
  limit?: number | null
}

export type AgentsAgentRunTerminalEventsListResult = {
  ok: boolean
  namespace: string
  consumer: string | null
  total: number
  events: AgentsAgentRunTerminalEvent[]
}

export type AgentsAgentRunTerminalEventAckInput = {
  eventId: string
  consumer: string
  outcome?: string | null
  message?: string | null
  receiptRef?: string | null
  annotations?: Record<string, string | null> | null
}

export type AgentsAgentRunTerminalEventAckResult = {
  ok: boolean
  eventId: string
  name: string
  namespace: string
  consumer: string
  resource: Record<string, unknown>
}

export const fetchAgentRunTerminalEventsFromAgentsServiceEffect = (
  input: AgentsAgentRunTerminalEventsListInput = {},
  env: EnvSource = process.env,
) => {
  const targetUrl = buildAgentsServiceUrl('/v1/agent-runs/terminal-events', env)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  const runIdPrefix = input.runIdPrefix?.trim()
  if (runIdPrefix) targetUrl.searchParams.set('runIdPrefix', runIdPrefix)
  const consumer = input.consumer?.trim()
  if (consumer) targetUrl.searchParams.set('consumer', consumer)
  if (input.includeAcked !== undefined && input.includeAcked !== null) {
    targetUrl.searchParams.set('includeAcked', input.includeAcked ? 'true' : 'false')
  }
  if (input.limit && input.limit > 0) targetUrl.searchParams.set('limit', String(Math.trunc(input.limit)))
  return fetchAgentsJsonEffect<AgentsAgentRunTerminalEventsListResult>(servicePath(targetUrl), env)
}

export const fetchAgentRunTerminalEventsFromAgentsService = async (
  input: AgentsAgentRunTerminalEventsListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunTerminalEventsListResult>> =>
  runAgentsJsonPromise(fetchAgentRunTerminalEventsFromAgentsServiceEffect(input, env))

export const ackAgentRunTerminalEventViaAgentsServiceEffect = (
  input: AgentsAgentRunTerminalEventAckInput,
  env: EnvSource = process.env,
) => postAgentsJsonEffect<AgentsAgentRunTerminalEventAckResult>('/v1/agent-runs/terminal-events/ack', input, { env })

export const ackAgentRunTerminalEventViaAgentsService = async (
  input: AgentsAgentRunTerminalEventAckInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunTerminalEventAckResult>> =>
  runAgentsJsonPromise(ackAgentRunTerminalEventViaAgentsServiceEffect(input, env))

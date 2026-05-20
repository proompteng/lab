import { createFileRoute } from '@tanstack/react-router'

import {
  fetchAgentsHealthFromAgentsService,
  type AgentsHealthController,
  type AgentsHealthPayload,
} from '@proompteng/agent-contracts/agents-service-client'
import { resolveRuntimeServiceName } from '~/server/runtime-identity'

type AgentsDependencyHealth = {
  status: 'healthy' | 'degraded' | 'unavailable'
  ready: boolean
  http_status: number
  error: string | null
  controller: AgentsHealthController
}

const unavailableAgentsController = (): AgentsHealthController => ({
  enabled: true,
  crdsReady: false,
})

const buildAgentsDependencyHealth = (input: {
  ok: boolean
  status: number
  error?: string
  controller: AgentsHealthController
}): AgentsDependencyHealth => {
  const ready = input.ok && (input.controller.enabled ? input.controller.crdsReady !== false : true)
  return {
    status: !input.ok ? 'unavailable' : ready ? 'healthy' : 'degraded',
    ready,
    http_status: input.status,
    error: input.ok ? null : (input.error ?? `Agents service returned HTTP ${input.status}`),
    controller: input.controller,
  }
}

export const getHealthHandler = async () => {
  const agentsHealth = await fetchAgentsHealthFromAgentsService()
  const agentsController = agentsHealth.body?.agentsController ?? unavailableAgentsController()
  const agentsError = agentsHealth.ok ? undefined : (agentsHealth.error ?? undefined)
  const agentsDependency = buildAgentsDependencyHealth({
    ok: agentsHealth.ok,
    status: agentsHealth.status,
    error: agentsError,
    controller: agentsController,
  })
  const body = JSON.stringify({
    status: 'ok',
    service: resolveRuntimeServiceName(),
    agents_dependency: agentsDependency,
    agentsService: agentsHealth.ok
      ? agentsHealth.body
      : {
          status: 'unavailable',
          error: agentsHealth.error,
          httpStatus: agentsHealth.status,
        },
    agentsController,
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: () => getHealthHandler(),
    },
  },
})

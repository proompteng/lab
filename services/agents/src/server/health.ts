import { resolveRuntimeServiceName, type AgentsRuntimeServiceName } from './runtime-identity'

export type AgentsHealthControllerState = {
  enabled: boolean
  crdsReady: boolean | null
}

export type AgentsHealthResponseInput = {
  agentsController: AgentsHealthControllerState
  service?: AgentsRuntimeServiceName
}

export type AgentsHealthHandlerDependencies = {
  getAgentsControllerHealth: () => AgentsHealthControllerState
  resolveServiceName?: () => AgentsRuntimeServiceName
}

export const buildAgentsHealthResponse = (input: AgentsHealthResponseInput) => {
  const ready = input.agentsController.enabled ? input.agentsController.crdsReady !== false : true
  const body = JSON.stringify({
    status: ready ? 'ok' : 'degraded',
    service: input.service ?? 'agents',
    agentsController: input.agentsController,
  })
  return new Response(body, {
    status: ready ? 200 : 503,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const createAgentsHealthHandler = (deps: AgentsHealthHandlerDependencies) => () =>
  buildAgentsHealthResponse({
    agentsController: deps.getAgentsControllerHealth(),
    service: deps.resolveServiceName?.() ?? resolveRuntimeServiceName(),
  })

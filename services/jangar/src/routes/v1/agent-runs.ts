import { createFileRoute } from '@tanstack/react-router'
import {
  getAgentRunsHandler as getAgentsServiceAgentRunsHandler,
  postAgentRunsHandler as postAgentsServiceAgentRunsHandler,
  type AgentRunsApiDependencies,
  type AgentRunsApiStore,
} from '@proompteng/agents/server/v1/agent-runs'
import {
  resolveAuditContextFromRequest,
  resolveRepositoryFromParameters as resolveRepositoryFromParameterMap,
} from '~/server/audit-logging'
import { requireLeaderForMutationHttp } from '~/server/leader-election'
import { recordAgentQueueDepth } from '~/server/metrics'
import { createKubernetesClient } from '~/server/primitives-kube'
import { validatePolicies } from '~/server/primitives-policy'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/agent-runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAgentRunsHandler(request),
      POST: async ({ request }: JangarServerRouteArgs) => postAgentRunsHandler(request),
    },
  },
})

type JangarAgentRunsApiDependencies = Partial<AgentRunsApiDependencies>

const createJangarPrimitivesStore = (): AgentRunsApiStore => createPrimitivesStore()

const buildAgentRunsApiDependencies = (deps: JangarAgentRunsApiDependencies = {}): AgentRunsApiDependencies => ({
  storeFactory: deps.storeFactory ?? createJangarPrimitivesStore,
  kubeClient: deps.kubeClient,
  kubeClientFactory: deps.kubeClientFactory ?? createKubernetesClient,
  requireLeaderForMutation: deps.requireLeaderForMutation ?? requireLeaderForMutationHttp,
  recordAgentQueueDepth: deps.recordAgentQueueDepth ?? recordAgentQueueDepth,
  resolveAuditContextFromRequest: deps.resolveAuditContextFromRequest ?? resolveAuditContextFromRequest,
  resolveRepositoryFromParameters:
    deps.resolveRepositoryFromParameters ?? ((params) => resolveRepositoryFromParameterMap(params) ?? undefined),
  validatePolicies: deps.validatePolicies ?? validatePolicies,
})

export const getAgentRunsHandler = async (request: Request, deps: JangarAgentRunsApiDependencies = {}) =>
  getAgentsServiceAgentRunsHandler(request, buildAgentRunsApiDependencies(deps))

export const postAgentRunsHandler = async (request: Request, deps: JangarAgentRunsApiDependencies = {}) =>
  postAgentsServiceAgentRunsHandler(request, buildAgentRunsApiDependencies(deps))

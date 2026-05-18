import { createFileRoute } from '@tanstack/react-router'
import {
  getAgentRunHandler as getAgentsServiceAgentRunHandler,
  type RunReadApiDependencies,
  type RunReadApiStore,
} from '@proompteng/agents/server/v1/run-read'
import { createKubernetesClient } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/agent-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getAgentRunHandler(params.id, request),
    },
  },
})

type JangarRunReadApiDependencies = Partial<RunReadApiDependencies>

const createJangarPrimitivesStore = (): RunReadApiStore => createPrimitivesStore()

const buildRunReadApiDependencies = (deps: JangarRunReadApiDependencies = {}): RunReadApiDependencies => ({
  storeFactory: deps.storeFactory ?? createJangarPrimitivesStore,
  kubeClient: deps.kubeClient,
  kubeClientFactory: deps.kubeClientFactory ?? createKubernetesClient,
  defaultNamespace: deps.defaultNamespace,
})

export const getAgentRunHandler = async (id: string, request: Request, deps: JangarRunReadApiDependencies = {}) =>
  getAgentsServiceAgentRunHandler(id, request, buildRunReadApiDependencies(deps))

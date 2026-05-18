import { createFileRoute } from '@tanstack/react-router'
import {
  getRunHandler as getAgentsServiceRunHandler,
  type RunReadApiDependencies,
  type RunReadApiStore,
} from '@proompteng/agents/server/v1/run-read'
import { createKubernetesClient } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getRunHandler(params.id, request),
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

export const getRunHandler = async (id: string, request: Request, deps: JangarRunReadApiDependencies = {}) =>
  getAgentsServiceRunHandler(id, request, buildRunReadApiDependencies(deps))

import { createFileRoute } from '@tanstack/react-router'
import {
  getOrchestrationRunsHandler as getOrchestrationRunsServiceHandler,
  postOrchestrationRunsHandler as postOrchestrationRunsServiceHandler,
  type OrchestrationRunsApiDependencies,
} from '@proompteng/agents/routes/v1/orchestration-runs'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/orchestration-runs')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getOrchestrationRunsHandler(request),
      POST: async ({ request }: JangarServerRouteArgs) => postOrchestrationRunsHandler(request),
    },
  },
})

type JangarOrchestrationRunsApiDependencies = Partial<OrchestrationRunsApiDependencies>

export const getOrchestrationRunsHandler = async (
  request: Request,
  deps: JangarOrchestrationRunsApiDependencies = {},
) => getOrchestrationRunsServiceHandler(request, deps)

export const postOrchestrationRunsHandler = async (
  request: Request,
  deps: JangarOrchestrationRunsApiDependencies = {},
) => postOrchestrationRunsServiceHandler(request, deps)

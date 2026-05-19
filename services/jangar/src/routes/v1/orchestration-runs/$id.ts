import { createFileRoute } from '@tanstack/react-router'
import {
  getOrchestrationRunHandler as getOrchestrationRunServiceHandler,
  type OrchestrationRunReadDependencies,
} from '@proompteng/agents/routes/v1/orchestration-runs/$id'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/orchestration-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getOrchestrationRunHandler(params.id, request),
    },
  },
})

type JangarOrchestrationRunReadDependencies = Partial<OrchestrationRunReadDependencies>

export const getOrchestrationRunHandler = async (
  id: string,
  request: Request,
  deps: JangarOrchestrationRunReadDependencies = {},
) => getOrchestrationRunServiceHandler(id, request, deps)

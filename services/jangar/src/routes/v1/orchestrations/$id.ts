import { createFileRoute } from '@tanstack/react-router'
import {
  getOrchestrationHandler as getOrchestrationServiceHandler,
  type ResourceReadDependencies,
} from '@proompteng/agents/routes/v1/orchestrations/$id'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/orchestrations/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getOrchestrationHandler(params.id, request),
    },
  },
})

type JangarResourceReadDependencies = Partial<ResourceReadDependencies>

export const getOrchestrationHandler = async (
  id: string,
  request: Request,
  deps: JangarResourceReadDependencies = {},
) => getOrchestrationServiceHandler(id, request, deps)

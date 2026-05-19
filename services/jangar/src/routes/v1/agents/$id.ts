import { createFileRoute } from '@tanstack/react-router'
import {
  getAgentHandler as getAgentServiceHandler,
  type ResourceReadDependencies,
} from '@proompteng/agents/routes/v1/agents/$id'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/agents/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getAgentHandler(params.id, request),
    },
  },
})

type JangarResourceReadDependencies = Partial<ResourceReadDependencies>

export const getAgentHandler = async (id: string, request: Request, deps: JangarResourceReadDependencies = {}) =>
  getAgentServiceHandler(id, request, deps)

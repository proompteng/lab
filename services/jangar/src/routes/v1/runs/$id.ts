import { createFileRoute } from '@tanstack/react-router'
import {
  getRunHandler as getAgentsServiceRunHandler,
  type RunReadApiDependencies,
} from '@proompteng/agents/routes/v1/runs/$id'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: JangarServerRouteArgs) => getRunHandler(params.id, request),
    },
  },
})

type JangarRunReadApiDependencies = Partial<RunReadApiDependencies>

export const getRunHandler = async (id: string, request: Request, deps: JangarRunReadApiDependencies = {}) =>
  getAgentsServiceRunHandler(id, request, deps)

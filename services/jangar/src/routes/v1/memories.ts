import { createFileRoute } from '@tanstack/react-router'
import {
  postMemoriesHandler as postMemoriesServiceHandler,
  type MemoriesApiDependencies,
} from '@proompteng/agents/routes/v1/memories'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/memories')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postMemoriesHandler(request),
    },
  },
})

type JangarMemoriesApiDependencies = Partial<MemoriesApiDependencies>

export const postMemoriesHandler = async (request: Request, deps: JangarMemoriesApiDependencies = {}) =>
  postMemoriesServiceHandler(request, deps)

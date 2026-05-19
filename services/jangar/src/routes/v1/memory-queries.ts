import { createFileRoute } from '@tanstack/react-router'
import {
  postMemoryQueriesHandler as postMemoryQueriesServiceHandler,
  type MemoryQueriesApiDependencies,
} from '@proompteng/agents/routes/v1/memory-queries'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/memory-queries')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postMemoryQueriesHandler(request),
    },
  },
})

type JangarMemoryQueriesApiDependencies = Partial<MemoryQueriesApiDependencies>

export const postMemoryQueriesHandler = async (request: Request, deps: JangarMemoryQueriesApiDependencies = {}) =>
  postMemoryQueriesServiceHandler(request, deps)

import { createFileRoute } from '@tanstack/react-router'
import {
  postOrchestrationsHandler as postOrchestrationsServiceHandler,
  type OrchestrationsApiDependencies,
} from '@proompteng/agents/routes/v1/orchestrations'
import '~/server/agents-v1-runtime'

export const Route = createFileRoute('/v1/orchestrations')({
  server: {
    handlers: {
      POST: async ({ request }: JangarServerRouteArgs) => postOrchestrationsHandler(request),
    },
  },
})

type JangarOrchestrationsApiDependencies = Partial<OrchestrationsApiDependencies>

export const postOrchestrationsHandler = async (request: Request, deps: JangarOrchestrationsApiDependencies = {}) =>
  postOrchestrationsServiceHandler(request, deps)

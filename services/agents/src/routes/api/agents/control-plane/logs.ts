import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'
import { getAgentRunLogsHandler, type AgentRunLogsDependencies } from '../../../../server/v1/agent-run-logs'

export const Route = createFileRoute('/api/agents/control-plane/logs')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => getAgentRunLogs(request),
    },
  },
})

export const getAgentRunLogs = (request: Request, deps: AgentRunLogsDependencies = {}) =>
  getAgentRunLogsHandler(request, deps)

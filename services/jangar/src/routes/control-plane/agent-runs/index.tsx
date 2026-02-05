import { createFileRoute, Navigate } from '@tanstack/react-router'

import { parseAgentRunsSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/control-plane/agent-runs/')({
  validateSearch: parseAgentRunsSearch,
  component: AgentRunsRedirect,
})

function AgentRunsRedirect() {
  const searchState = Route.useSearch()
  return <Navigate to="/control-plane/runs" search={searchState} />
}

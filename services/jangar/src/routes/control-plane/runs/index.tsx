import { createFileRoute } from '@tanstack/react-router'

import { ControlPlaneRedirect } from '@/components/agents-control-plane-redirect'
import { parseAgentRunsSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/control-plane/runs/')({
  validateSearch: parseAgentRunsSearch,
  component: ControlPlaneRedirect,
})

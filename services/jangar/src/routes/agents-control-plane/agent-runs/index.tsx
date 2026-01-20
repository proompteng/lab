import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/agent-runs/')({
  validateSearch: parseNamespaceSearch,
  component: AgentRunsListPage,
})

const buildAgentRunFields = (resource: PrimitiveResource) => {
  const specRef = readNestedValue(resource, ['spec', 'implementationSpecRef', 'name'])
  const inlineImpl = readNestedValue(resource, ['spec', 'implementation', 'inline', 'title'])
  return [
    {
      label: 'Agent',
      value: readNestedValue(resource, ['spec', 'agentRef', 'name']) ?? '—',
    },
    {
      label: 'Implementation',
      value: specRef ?? inlineImpl ?? '—',
    },
    {
      label: 'Runtime',
      value: readNestedValue(resource, ['spec', 'runtime', 'type']) ?? '—',
    },
    {
      label: 'Phase',
      value: readNestedValue(resource, ['status', 'phase']) ?? '—',
    },
  ]
}

function AgentRunsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="AgentRun"
      title="Agent runs"
      description="Execution history and runtime status."
      groupLabel="Agents"
      emptyLabel="No agent runs found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No agent runs found.' : `Loaded ${count} runs.`)}
      errorLabel="agent runs"
      detailTo="/agents-control-plane/agent-runs/$name"
      buildFields={buildAgentRunFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

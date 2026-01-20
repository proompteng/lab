import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/budgets/$name')({
  validateSearch: parseNamespaceSearch,
  component: BudgetDetailPage,
})

function BudgetDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Budget"
      title="Budget"
      description="Budget configuration and enforcement status."
      groupLabel="Agents"
      backTo="/agents-control-plane/budgets"
      errorLabel="budget"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Composition', value: readNestedValue(resource, ['spec', 'compositionRef', 'name']) ?? '—' },
        { label: 'CPU', value: readNestedValue(resource, ['spec', 'limits', 'cpu']) ?? '—' },
        { label: 'Memory', value: readNestedValue(resource, ['spec', 'limits', 'memory']) ?? '—' },
        { label: 'Dollars', value: readNestedValue(resource, ['spec', 'limits', 'dollars']) ?? '—' },
        { label: 'Tokens', value: readNestedValue(resource, ['spec', 'limits', 'tokens']) ?? '—' },
        { label: 'Window', value: readNestedValue(resource, ['spec', 'window', 'period']) ?? '—' },
      ]}
    />
  )
}

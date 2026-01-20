import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/budgets/$name')({
  validateSearch: parseNamespaceSearch,
  component: BudgetDetailRoute,
})

function BudgetDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Budgets"
      description="Budget configuration and status."
      kind="Budget"
      name={params.name}
      backPath="/agents-control-plane/budgets"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'CPU limit', value: readNestedValue(resource, ['spec', 'limits', 'cpu']) ?? '—' },
        { label: 'Memory limit', value: readNestedValue(resource, ['spec', 'limits', 'memory']) ?? '—' },
        { label: 'GPU limit', value: readNestedValue(resource, ['spec', 'limits', 'gpu']) ?? '—' },
        { label: 'Token limit', value: readNestedValue(resource, ['spec', 'limits', 'tokens']) ?? '—' },
        { label: 'Dollar limit', value: readNestedValue(resource, ['spec', 'limits', 'dollars']) ?? '—' },
        { label: 'Tokens used', value: readNestedValue(resource, ['status', 'used', 'tokens']) ?? '—' },
        { label: 'Dollars used', value: readNestedValue(resource, ['status', 'used', 'dollars']) ?? '—' },
      ]}
    />
  )
}

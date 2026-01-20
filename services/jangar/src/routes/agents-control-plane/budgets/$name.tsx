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
        { label: 'Composition', value: readNestedValue(resource, ['spec', 'compositionRef', 'name']) ?? '—' },
        { label: 'CPU limit', value: readNestedValue(resource, ['spec', 'limits', 'cpu']) ?? '—' },
        { label: 'Token limit', value: readNestedValue(resource, ['spec', 'limits', 'tokens']) ?? '—' },
        { label: 'Dollar limit', value: readNestedValue(resource, ['spec', 'limits', 'dollars']) ?? '—' },
        { label: 'Window', value: readNestedValue(resource, ['spec', 'window', 'period']) ?? '—' },
      ]}
    />
  )
}

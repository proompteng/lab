import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/budgets/')({
  validateSearch: parseNamespaceSearch,
  component: BudgetsListRoute,
})

const fields = [
  {
    label: 'CPU',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'limits', 'cpu']) ?? '—',
  },
  {
    label: 'Memory',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'limits', 'memory']) ?? '—',
  },
  {
    label: 'Tokens',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'limits', 'tokens']) ?? '—',
  },
  {
    label: 'Dollars',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'limits', 'dollars']) ?? '—',
  },
]

function BudgetsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Budgets"
      description="Budget ceilings and enforcement rules."
      kind="Budget"
      emptyLabel="No budgets found."
      detailPath="/agents-control-plane/budgets/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

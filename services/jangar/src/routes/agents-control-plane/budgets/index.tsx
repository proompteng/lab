import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/budgets/')({
  validateSearch: parseNamespaceSearch,
  component: BudgetsListPage,
})

const buildBudgetFields = (resource: PrimitiveResource) => [
  { label: 'Composition', value: readNestedValue(resource, ['spec', 'compositionRef', 'name']) ?? '—' },
  { label: 'CPU', value: readNestedValue(resource, ['spec', 'limits', 'cpu']) ?? '—' },
  { label: 'Dollars', value: readNestedValue(resource, ['spec', 'limits', 'dollars']) ?? '—' },
  { label: 'Window', value: readNestedValue(resource, ['spec', 'window', 'period']) ?? '—' },
]

function BudgetsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Budget"
      title="Budgets"
      description="Resource and cost ceilings for workloads."
      groupLabel="Agents"
      emptyLabel="No budgets found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No budgets found.' : `Loaded ${count} budgets.`)}
      errorLabel="budgets"
      detailTo="/agents-control-plane/budgets/$name"
      buildFields={buildBudgetFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

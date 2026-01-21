import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/schedules/')({
  validateSearch: parseNamespaceSearch,
  component: SchedulesListRoute,
})

const fields = [
  {
    label: 'Cron',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'cron']) ?? '—',
  },
  {
    label: 'Timezone',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'timezone']) ?? '—',
  },
  {
    label: 'Target kind',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'targetRef', 'kind']) ?? '—',
  },
  {
    label: 'Target name',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'targetRef', 'name']) ?? '—',
  },
]

function SchedulesListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Schedules"
      description="Schedule definitions for recurring runs."
      kind="Schedule"
      emptyLabel="No schedules found."
      detailPath="/agents-control-plane/schedules/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(next) => void navigate({ search: next })}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/schedules/$name')({
  validateSearch: parseNamespaceSearch,
  component: ScheduleDetailRoute,
})

function ScheduleDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Schedules"
      description="Schedule configuration and status."
      kind="Schedule"
      name={params.name}
      backPath="/agents-control-plane/schedules"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Cron', value: readNestedValue(resource, ['spec', 'cron']) ?? '—' },
        { label: 'Timezone', value: readNestedValue(resource, ['spec', 'timezone']) ?? '—' },
        { label: 'Target kind', value: readNestedValue(resource, ['spec', 'targetRef', 'kind']) ?? '—' },
        { label: 'Target name', value: readNestedValue(resource, ['spec', 'targetRef', 'name']) ?? '—' },
      ]}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/schedules/')({
  validateSearch: parseNamespaceSearch,
  component: SchedulesListPage,
})

const buildScheduleFields = (resource: PrimitiveResource) => {
  const targetKind = readNestedValue(resource, ['spec', 'targetRef', 'kind'])
  const targetName = readNestedValue(resource, ['spec', 'targetRef', 'name'])
  return [
    { label: 'Cron', value: readNestedValue(resource, ['spec', 'cron']) ?? '—' },
    { label: 'Timezone', value: readNestedValue(resource, ['spec', 'timezone']) ?? '—' },
    { label: 'Target', value: targetKind && targetName ? `${targetKind}/${targetName}` : (targetName ?? '—') },
    { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
  ]
}

function SchedulesListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Schedule"
      title="Schedules"
      description="Time-based triggers and automation schedules."
      groupLabel="Agents"
      emptyLabel="No schedules found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No schedules found.' : `Loaded ${count} schedules.`)}
      errorLabel="schedules"
      detailTo="/agents-control-plane/schedules/$name"
      buildFields={buildScheduleFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/schedules/$name')({
  validateSearch: parseNamespaceSearch,
  component: ScheduleDetailPage,
})

const readRecordCount = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? `${Object.keys(value).length}` : '—'

function ScheduleDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Schedule"
      title="Schedule"
      description="Schedule configuration and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/schedules"
      errorLabel="schedule"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => {
        const targetKind = readNestedValue(resource, ['spec', 'targetRef', 'kind'])
        const targetName = readNestedValue(resource, ['spec', 'targetRef', 'name'])
        const parameters = (resource.spec as Record<string, unknown>)?.parameters
        return [
          { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
          { label: 'Cron', value: readNestedValue(resource, ['spec', 'cron']) ?? '—' },
          { label: 'Timezone', value: readNestedValue(resource, ['spec', 'timezone']) ?? '—' },
          { label: 'Target', value: targetKind && targetName ? `${targetKind}/${targetName}` : (targetName ?? '—') },
          { label: 'Parameters', value: readRecordCount(parameters) },
          { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
        ]
      }}
    />
  )
}

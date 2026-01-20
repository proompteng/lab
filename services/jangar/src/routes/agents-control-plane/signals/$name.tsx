import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/signals/$name')({
  validateSearch: parseNamespaceSearch,
  component: SignalDetailPage,
})

function SignalDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Signal"
      title="Signal"
      description="Signal definition and configuration."
      groupLabel="Agents"
      backTo="/agents-control-plane/signals"
      errorLabel="signal"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Description', value: readNestedValue(resource, ['spec', 'description']) ?? '—' },
        { label: 'Schema', value: readNestedValue(resource, ['spec', 'payloadSchema']) ?? '—' },
        { label: 'Retention', value: readNestedValue(resource, ['spec', 'retentionSeconds']) ?? '—' },
        { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
      ]}
    />
  )
}

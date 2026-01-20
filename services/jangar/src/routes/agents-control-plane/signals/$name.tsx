import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/signals/$name')({
  validateSearch: parseNamespaceSearch,
  component: SignalDetailRoute,
})

function SignalDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Signals"
      description="Signal configuration and status."
      kind="Signal"
      name={params.name}
      backPath="/agents-control-plane/signals"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Description', value: readNestedValue(resource, ['spec', 'description']) ?? '—' },
        { label: 'Retention', value: readNestedValue(resource, ['spec', 'retentionSeconds']) ?? '—' },
        { label: 'Schema', value: readNestedValue(resource, ['spec', 'payloadSchema']) ?? '—' },
        { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
      ]}
    />
  )
}

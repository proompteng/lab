import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/signal-deliveries/$name')({
  validateSearch: parseNamespaceSearch,
  component: SignalDeliveryDetailPage,
})

function SignalDeliveryDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="SignalDelivery"
      title="Signal delivery"
      description="Signal delivery event details."
      groupLabel="Agents"
      backTo="/agents-control-plane/signal-deliveries"
      errorLabel="signal delivery"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => [
        { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
        { label: 'Signal', value: readNestedValue(resource, ['spec', 'signalRef', 'name']) ?? '—' },
        { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
        { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
        { label: 'Delivered', value: formatTimestamp(readNestedValue(resource, ['status', 'deliveredAt'])) },
      ]}
    />
  )
}

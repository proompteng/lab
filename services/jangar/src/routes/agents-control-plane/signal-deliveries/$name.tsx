import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/signal-deliveries/$name')({
  validateSearch: parseNamespaceSearch,
  component: SignalDeliveryDetailRoute,
})

function SignalDeliveryDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Signal deliveries"
      description="Signal delivery payload and status."
      kind="SignalDelivery"
      name={params.name}
      backPath="/agents-control-plane/signal-deliveries"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Signal', value: readNestedValue(resource, ['spec', 'signalRef', 'name']) ?? '—' },
        { label: 'Signal namespace', value: readNestedValue(resource, ['spec', 'signalRef', 'namespace']) ?? '—' },
        { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
        { label: 'Payload', value: readNestedValue(resource, ['spec', 'payload', 'message']) ?? '—' },
      ]}
    />
  )
}

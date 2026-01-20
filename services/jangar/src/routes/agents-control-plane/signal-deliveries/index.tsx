import { createFileRoute } from '@tanstack/react-router'

import { formatTimestamp, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/signal-deliveries/')({
  validateSearch: parseNamespaceSearch,
  component: SignalDeliveriesListPage,
})

const buildSignalDeliveryFields = (resource: PrimitiveResource) => [
  { label: 'Signal', value: readNestedValue(resource, ['spec', 'signalRef', 'name']) ?? '—' },
  { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
  { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
  {
    label: 'Delivered',
    value: formatTimestamp(readNestedValue(resource, ['status', 'deliveredAt'])),
  },
]

function SignalDeliveriesListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="SignalDelivery"
      title="Signal deliveries"
      description="Signal delivery events and payloads."
      groupLabel="Agents"
      emptyLabel="No signal deliveries found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No signal deliveries found.' : `Loaded ${count} deliveries.`)}
      errorLabel="signal deliveries"
      detailTo="/agents-control-plane/signal-deliveries/$name"
      buildFields={buildSignalDeliveryFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

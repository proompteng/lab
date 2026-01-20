import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/signal-deliveries/')({
  validateSearch: parseNamespaceSearch,
  component: SignalDeliveriesListRoute,
})

const fields = [
  {
    label: 'Signal',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'signalRef', 'name']) ?? '—',
  },
  {
    label: 'Signal namespace',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'signalRef', 'namespace']) ?? '—',
  },
  {
    label: 'Delivery ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'deliveryId']) ?? '—',
  },
  {
    label: 'Payload',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'payload', 'message']) ?? '—',
  },
]

function SignalDeliveriesListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Signal deliveries"
      description="Signal delivery records received by the control plane."
      kind="SignalDelivery"
      emptyLabel="No signal deliveries found."
      detailPath="/agents-control-plane/signal-deliveries/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

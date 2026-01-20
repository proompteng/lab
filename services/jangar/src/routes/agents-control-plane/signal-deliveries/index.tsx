import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/signal-deliveries/')({
  validateSearch: parseNamespaceSearch,
  component: SignalDeliveriesListRoute,
})

const formatObjectKeys = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '—'
  const count = Object.keys(value as Record<string, unknown>).length
  if (count === 0) return '—'
  return `${count} ${count === 1 ? 'key' : 'keys'}`
}

const fields = [
  {
    label: 'Signal',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'signalRef', 'name']) ?? '—',
  },
  {
    label: 'Delivery ID',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'deliveryId']) ?? '—',
  },
  {
    label: 'Payload',
    value: (resource: PrimitiveResource) => formatObjectKeys(resource.spec.payload),
  },
  {
    label: 'Delivered',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'deliveredAt']) ?? '—',
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

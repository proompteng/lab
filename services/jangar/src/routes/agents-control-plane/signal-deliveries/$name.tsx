import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/signal-deliveries/$name')({
  validateSearch: parseNamespaceSearch,
  component: SignalDeliveryDetailRoute,
})

const formatObjectKeys = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '—'
  const count = Object.keys(value as Record<string, unknown>).length
  if (count === 0) return '—'
  return `${count} ${count === 1 ? 'key' : 'keys'}`
}

const readSpecValue = (resource: Record<string, unknown>, key: string) => {
  const spec = resource.spec
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  return (spec as Record<string, unknown>)[key] ?? null
}

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
        { label: 'Delivery ID', value: readNestedValue(resource, ['spec', 'deliveryId']) ?? '—' },
        { label: 'Payload', value: formatObjectKeys(readSpecValue(resource, 'payload')) },
        { label: 'Delivered', value: readNestedValue(resource, ['status', 'deliveredAt']) ?? '—' },
      ]}
    />
  )
}

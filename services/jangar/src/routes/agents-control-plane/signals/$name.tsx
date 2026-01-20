import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/signals/$name')({
  validateSearch: parseNamespaceSearch,
  component: SignalDetailRoute,
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
      summaryItems={(resource, _namespace) => [
        { label: 'Channel', value: readNestedValue(resource, ['spec', 'channel']) ?? '—' },
        { label: 'Description', value: readNestedValue(resource, ['spec', 'description']) ?? '—' },
        { label: 'Payload', value: formatObjectKeys(readSpecValue(resource, 'payload')) },
        { label: 'Last delivery', value: readNestedValue(resource, ['status', 'lastDeliveryAt']) ?? '—' },
      ]}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/signals/')({
  validateSearch: parseNamespaceSearch,
  component: SignalsListRoute,
})

const formatObjectKeys = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '—'
  const count = Object.keys(value as Record<string, unknown>).length
  if (count === 0) return '—'
  return `${count} ${count === 1 ? 'key' : 'keys'}`
}

const fields = [
  {
    label: 'Channel',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'channel']) ?? '—',
  },
  {
    label: 'Description',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'description']) ?? '—',
  },
  {
    label: 'Payload',
    value: (resource: PrimitiveResource) => formatObjectKeys(resource.spec.payload),
  },
  {
    label: 'Last delivery',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'lastDeliveryAt']) ?? '—',
  },
]

function SignalsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Signals"
      description="Signal definitions for orchestration coordination."
      kind="Signal"
      emptyLabel="No signals found."
      detailPath="/agents-control-plane/signals/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

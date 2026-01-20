import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/orchestrations/')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationsListRoute,
})

const formatCount = (value: unknown, label: string) => {
  const count = Array.isArray(value) ? value.length : 0
  if (count === 0) return '—'
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

const readFirstStepKind = (resource: PrimitiveResource) => {
  const steps = Array.isArray(resource.spec.steps) ? resource.spec.steps : []
  const first = steps[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '—'
  const record = first as Record<string, unknown>
  return typeof record.kind === 'string' && record.kind.trim().length > 0 ? record.kind : '—'
}

const fields = [
  {
    label: 'Composition',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'compositionRef', 'name']) ?? '—',
  },
  {
    label: 'Entrypoint',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'entrypoint']) ?? '—',
  },
  {
    label: 'Steps',
    value: (resource: PrimitiveResource) => formatCount(resource.spec.steps, 'step'),
  },
  {
    label: 'First step',
    value: (resource: PrimitiveResource) => readFirstStepKind(resource),
  },
]

function OrchestrationsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Orchestrations"
      description="Orchestration definitions for multi-step runs."
      kind="Orchestration"
      emptyLabel="No orchestrations found."
      detailPath="/agents-control-plane/orchestrations/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

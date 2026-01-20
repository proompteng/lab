import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/orchestrations/$name')({
  validateSearch: parseNamespaceSearch,
  component: OrchestrationDetailRoute,
})

const formatCount = (value: unknown, label: string) => {
  const count = Array.isArray(value) ? value.length : 0
  if (count === 0) return '—'
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

const formatObjectCount = (value: unknown, label: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '—'
  const count = Object.keys(value as Record<string, unknown>).length
  if (count === 0) return '—'
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

const readFirstStep = (value: unknown) => {
  if (!Array.isArray(value)) return '—'
  const first = value[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '—'
  const record = first as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind : null
  const name = typeof record.name === 'string' ? record.name : null
  if (kind && name) return `${kind}/${name}`
  return kind ?? name ?? '—'
}

const readSpecValue = (resource: Record<string, unknown>, key: string) => {
  const spec = resource.spec
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  return (spec as Record<string, unknown>)[key] ?? null
}

function OrchestrationDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Orchestrations"
      description="Orchestration configuration and status."
      kind="Orchestration"
      name={params.name}
      backPath="/agents-control-plane/orchestrations"
      searchState={searchState}
      summaryItems={(resource, _namespace) => {
        const steps = readSpecValue(resource, 'steps')
        const policies = readSpecValue(resource, 'policies')
        return [
          { label: 'Entrypoint', value: readNestedValue(resource, ['spec', 'entrypoint']) ?? '—' },
          { label: 'Steps', value: formatCount(steps, 'step') },
          { label: 'First step', value: readFirstStep(steps) },
          { label: 'Policies', value: formatObjectCount(policies, 'policy') },
        ]
      }}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/secret-bindings/')({
  validateSearch: parseNamespaceSearch,
  component: SecretBindingsListRoute,
})

const formatCount = (value: unknown, label: string) => {
  const count = Array.isArray(value) ? value.length : 0
  if (count === 0) return '—'
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

const readFirstSubject = (resource: PrimitiveResource) => {
  const subjects = Array.isArray(resource.spec.subjects) ? resource.spec.subjects : []
  const first = subjects[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '—'
  const record = first as Record<string, unknown>
  const kind = typeof record.kind === 'string' && record.kind.trim().length > 0 ? record.kind : null
  const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name : null
  const namespace = typeof record.namespace === 'string' && record.namespace.trim().length > 0 ? record.namespace : null
  if (kind && name && namespace) return `${kind}/${name} (${namespace})`
  if (kind && name) return `${kind}/${name}`
  return kind ?? name ?? '—'
}

const fields = [
  {
    label: 'Allowed secrets',
    value: (resource: PrimitiveResource) => readNestedArrayValue(resource, ['spec', 'allowedSecrets']) ?? '—',
  },
  {
    label: 'Subjects',
    value: (resource: PrimitiveResource) => formatCount(resource.spec.subjects, 'subject'),
  },
  {
    label: 'First subject',
    value: (resource: PrimitiveResource) => readFirstSubject(resource),
  },
  {
    label: 'Phase',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'phase']) ?? '—',
  },
]

function SecretBindingsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Secret bindings"
      description="Secret binding policies for controlled access."
      kind="SecretBinding"
      emptyLabel="No secret bindings found."
      detailPath="/agents-control-plane/secret-bindings/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(next) => void navigate({ search: next })}
    />
  )
}

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

const readFirstSubjectKind = (resource: PrimitiveResource) => {
  const subjects = Array.isArray(resource.spec.subjects) ? resource.spec.subjects : []
  const first = subjects[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '—'
  const record = first as Record<string, unknown>
  return typeof record.kind === 'string' && record.kind.trim().length > 0 ? record.kind : '—'
}

const fields = [
  {
    label: 'Namespace',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'namespace']) ?? '—',
  },
  {
    label: 'Allowed secrets',
    value: (resource: PrimitiveResource) => readNestedArrayValue(resource, ['spec', 'allowedSecrets']) ?? '—',
  },
  {
    label: 'Subjects',
    value: (resource: PrimitiveResource) => formatCount(resource.spec.subjects, 'subject'),
  },
  {
    label: 'Subject kind',
    value: (resource: PrimitiveResource) => readFirstSubjectKind(resource),
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
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

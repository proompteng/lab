import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/secret-bindings/$name')({
  validateSearch: parseNamespaceSearch,
  component: SecretBindingDetailPage,
})

const formatList = (value: unknown) =>
  Array.isArray(value) && value.length > 0 ? value.filter((item) => typeof item === 'string').join(', ') : '—'

const formatSubjects = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0) return '—'
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const record = entry as Record<string, unknown>
      const kind = typeof record.kind === 'string' ? record.kind : 'Subject'
      const name = typeof record.name === 'string' ? record.name : 'unknown'
      const namespace = typeof record.namespace === 'string' ? record.namespace : null
      return namespace ? `${kind}/${name}@${namespace}` : `${kind}/${name}`
    })
    .join(', ')
}

function SecretBindingDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="SecretBinding"
      title="Secret binding"
      description="Secret binding configuration and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/secret-bindings"
      errorLabel="secret binding"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => {
        const spec = resource.spec as Record<string, unknown>
        return [
          { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
          { label: 'Binding namespace', value: readNestedValue(resource, ['spec', 'namespace']) ?? '—' },
          { label: 'Allowed secrets', value: formatList(spec.allowedSecrets) },
          { label: 'Subjects', value: formatSubjects(spec.subjects) },
          { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
        ]
      }}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/secret-bindings/')({
  validateSearch: parseNamespaceSearch,
  component: SecretBindingsListPage,
})

const readCount = (value: unknown) => (Array.isArray(value) ? `${value.length}` : '—')

const buildSecretBindingFields = (resource: PrimitiveResource) => {
  const spec = resource.spec as Record<string, unknown>
  return [
    { label: 'Namespace', value: readNestedValue(resource, ['spec', 'namespace']) ?? '—' },
    { label: 'Secrets', value: readCount(spec.allowedSecrets) },
    { label: 'Subjects', value: readCount(spec.subjects) },
    { label: 'Phase', value: readNestedValue(resource, ['status', 'phase']) ?? '—' },
  ]
}

function SecretBindingsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="SecretBinding"
      title="Secret bindings"
      description="Secret access bindings and subject mapping."
      groupLabel="Agents"
      emptyLabel="No secret bindings found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No secret bindings found.' : `Loaded ${count} bindings.`)}
      errorLabel="secret bindings"
      detailTo="/agents-control-plane/secret-bindings/$name"
      buildFields={buildSecretBindingFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/tools/')({
  validateSearch: parseNamespaceSearch,
  component: ToolsListPage,
})

const readRecordCount = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? `${Object.keys(value).length}` : '—'

const buildToolFields = (resource: PrimitiveResource) => {
  const runtime = readNestedValue(resource, ['spec', 'runtime', 'type'])
  const image =
    readNestedValue(resource, ['spec', 'runtime', 'argo', 'image']) ??
    readNestedValue(resource, ['spec', 'runtime', 'image']) ??
    '—'
  const runtimeParams = (resource.spec as Record<string, unknown>)?.runtime as Record<string, unknown>
  const argo = runtimeParams?.argo as Record<string, unknown>
  const params = argo?.parameters ?? runtimeParams?.parameters
  return [
    { label: 'Runtime', value: runtime ?? '—' },
    { label: 'Image', value: image },
    { label: 'Parameters', value: readRecordCount(params) },
    { label: 'Description', value: readNestedValue(resource, ['spec', 'description']) ?? '—' },
  ]
}

function ToolsListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="Tool"
      title="Tools"
      description="Tool definitions and runtime bindings."
      groupLabel="Agents"
      emptyLabel="No tools found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No tools found.' : `Loaded ${count} tools.`)}
      errorLabel="tools"
      detailTo="/agents-control-plane/tools/$name"
      buildFields={buildToolFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

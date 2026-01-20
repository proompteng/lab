import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/tools/$name')({
  validateSearch: parseNamespaceSearch,
  component: ToolDetailPage,
})

const readRecordCount = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? `${Object.keys(value).length}` : '—'

function ToolDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="Tool"
      title="Tool"
      description="Tool definition and runtime configuration."
      groupLabel="Agents"
      backTo="/agents-control-plane/tools"
      errorLabel="tool"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => {
        const runtime = readNestedValue(resource, ['spec', 'runtime', 'type'])
        const runtimeConfig = (resource.spec as Record<string, unknown>)?.runtime as Record<string, unknown>
        const argo = runtimeConfig?.argo as Record<string, unknown>
        const paramsValue = argo?.parameters ?? runtimeConfig?.parameters
        return [
          { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
          { label: 'Runtime', value: runtime ?? '—' },
          {
            label: 'Image',
            value:
              readNestedValue(resource, ['spec', 'runtime', 'argo', 'image']) ??
              readNestedValue(resource, ['spec', 'runtime', 'image']) ??
              '—',
          },
          { label: 'Parameters', value: readRecordCount(paramsValue) },
          { label: 'Description', value: readNestedValue(resource, ['spec', 'description']) ?? '—' },
        ]
      }}
    />
  )
}

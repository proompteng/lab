import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/tools/$name')({
  validateSearch: parseNamespaceSearch,
  component: ToolDetailRoute,
})

function ToolDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Tools"
      description="Tool configuration and status."
      kind="Tool"
      name={params.name}
      backPath="/agents-control-plane/tools"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Runtime', value: readNestedValue(resource, ['spec', 'runtime', 'type']) ?? '—' },
        { label: 'Image', value: readNestedValue(resource, ['spec', 'runtime', 'argo', 'image']) ?? '—' },
        {
          label: 'Command',
          value: readNestedArrayValue(resource, ['spec', 'runtime', 'argo', 'command']) ?? '—',
        },
        { label: 'Args', value: readNestedArrayValue(resource, ['spec', 'runtime', 'argo', 'args']) ?? '—' },
      ]}
    />
  )
}

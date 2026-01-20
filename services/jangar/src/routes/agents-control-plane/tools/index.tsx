import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/tools/')({
  validateSearch: parseNamespaceSearch,
  component: ToolsListRoute,
})

const fields = [
  {
    label: 'Runtime',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'runtime', 'type']) ?? '—',
  },
  {
    label: 'Image',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'runtime', 'argo', 'image']) ?? '—',
  },
  {
    label: 'Command',
    value: (resource: PrimitiveResource) =>
      readNestedArrayValue(resource, ['spec', 'runtime', 'argo', 'command']) ?? '—',
  },
  {
    label: 'Args',
    value: (resource: PrimitiveResource) => readNestedArrayValue(resource, ['spec', 'runtime', 'argo', 'args']) ?? '—',
  },
]

function ToolsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Tools"
      description="Tool definitions registered in the control plane."
      kind="Tool"
      emptyLabel="No tools found."
      detailPath="/agents-control-plane/tools/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

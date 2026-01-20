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
      summaryItems={(resource, _namespace) => [
        { label: 'Image', value: readNestedValue(resource, ['spec', 'image']) ?? '—' },
        { label: 'Command', value: readNestedArrayValue(resource, ['spec', 'command']) ?? '—' },
        { label: 'Args', value: readNestedArrayValue(resource, ['spec', 'args']) ?? '—' },
        { label: 'Service account', value: readNestedValue(resource, ['spec', 'serviceAccount']) ?? '—' },
        { label: 'Working dir', value: readNestedValue(resource, ['spec', 'workingDir']) ?? '—' },
        { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
        { label: 'TTL after finish', value: readNestedValue(resource, ['spec', 'ttlSecondsAfterFinished']) ?? '—' },
      ]}
    />
  )
}

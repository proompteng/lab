import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/approvals/$name')({
  validateSearch: parseNamespaceSearch,
  component: ApprovalDetailRoute,
})

function ApprovalDetailRoute() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      title="Approvals"
      description="Approval policy configuration and status."
      kind="ApprovalPolicy"
      name={params.name}
      backPath="/agents-control-plane/approvals"
      searchState={searchState}
      summaryItems={(resource, namespace) => [
        { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
        { label: 'Mode', value: readNestedValue(resource, ['spec', 'mode']) ?? '—' },
        { label: 'Required approvals', value: readNestedValue(resource, ['spec', 'requiredApprovals']) ?? '—' },
        { label: 'Approvers', value: readNestedArrayValue(resource, ['spec', 'approvers']) ?? '—' },
        { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
      ]}
    />
  )
}

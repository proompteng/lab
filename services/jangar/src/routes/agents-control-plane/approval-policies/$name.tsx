import { createFileRoute } from '@tanstack/react-router'

import { getMetadataValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/approval-policies/$name')({
  validateSearch: parseNamespaceSearch,
  component: ApprovalPolicyDetailPage,
})

const formatList = (value: unknown) =>
  Array.isArray(value) && value.length > 0 ? value.filter((item) => typeof item === 'string').join(', ') : '—'

function ApprovalPolicyDetailPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  return (
    <PrimitiveDetailPage
      kind="ApprovalPolicy"
      title="Approval policy"
      description="Approval policy configuration and status."
      groupLabel="Agents"
      backTo="/agents-control-plane/approval-policies"
      errorLabel="approval policy"
      name={params.name}
      searchState={searchState}
      buildSummary={(resource, namespace) => {
        const spec = resource.spec as Record<string, unknown>
        return [
          { label: 'Namespace', value: getMetadataValue(resource, 'namespace') ?? namespace },
          { label: 'Mode', value: readNestedValue(resource, ['spec', 'mode']) ?? '—' },
          { label: 'Approvers', value: formatList(spec.approvers) },
          { label: 'Required', value: readNestedValue(resource, ['spec', 'requiredApprovals']) ?? '—' },
          { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
        ]
      }}
    />
  )
}

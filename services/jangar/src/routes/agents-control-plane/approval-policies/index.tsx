import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/approval-policies/')({
  validateSearch: parseNamespaceSearch,
  component: ApprovalPoliciesListPage,
})

const readCount = (value: unknown) => (Array.isArray(value) ? `${value.length}` : '—')

const buildApprovalPolicyFields = (resource: PrimitiveResource) => {
  const spec = resource.spec as Record<string, unknown>
  return [
    { label: 'Mode', value: readNestedValue(resource, ['spec', 'mode']) ?? '—' },
    { label: 'Approvers', value: readCount(spec.approvers) },
    { label: 'Required', value: readNestedValue(resource, ['spec', 'requiredApprovals']) ?? '—' },
    { label: 'Timeout', value: readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—' },
  ]
}

function ApprovalPoliciesListPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      kind="ApprovalPolicy"
      title="Approval policies"
      description="Approval rules and gating configuration."
      groupLabel="Agents"
      emptyLabel="No approval policies found in this namespace."
      statusLabel={(count) => (count === 0 ? 'No approval policies found.' : `Loaded ${count} policies.`)}
      errorLabel="approval policies"
      detailTo="/agents-control-plane/approval-policies/$name"
      buildFields={buildApprovalPolicyFields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

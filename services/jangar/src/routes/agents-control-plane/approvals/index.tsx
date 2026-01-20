import { createFileRoute } from '@tanstack/react-router'

import { readNestedArrayValue, readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/approvals/')({
  validateSearch: parseNamespaceSearch,
  component: ApprovalsListRoute,
})

const fields = [
  {
    label: 'Mode',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'mode']) ?? '—',
  },
  {
    label: 'Required',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'requiredApprovals']) ?? '—',
  },
  {
    label: 'Approvers',
    value: (resource: PrimitiveResource) => readNestedArrayValue(resource, ['spec', 'approvers']) ?? '—',
  },
  {
    label: 'Timeout',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'timeoutSeconds']) ?? '—',
  },
]

function ApprovalsListRoute() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <PrimitiveListPage
      title="Approvals"
      description="Approval policies that gate long-horizon actions."
      kind="ApprovalPolicy"
      emptyLabel="No approval policies found."
      detailPath="/agents-control-plane/approvals/$name"
      fields={fields}
      searchState={searchState}
      onNavigate={(namespace) => void navigate({ search: { namespace } })}
    />
  )
}

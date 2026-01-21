import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveListPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { PrimitiveResource } from '@/data/agents-control-plane'

export const Route = createFileRoute('/agents-control-plane/approvals/')({
  validateSearch: parseNamespaceSearch,
  component: ApprovalsListRoute,
})

const formatCount = (value: unknown, label: string) => {
  const count = Array.isArray(value) ? value.length : 0
  if (count === 0) return '—'
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

const fields = [
  {
    label: 'Mode',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'mode']) ?? '—',
  },
  {
    label: 'Default decision',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['spec', 'defaultDecision']) ?? '—',
  },
  {
    label: 'Subjects',
    value: (resource: PrimitiveResource) => formatCount(resource.spec.subjects, 'subject'),
  },
  {
    label: 'Last decision',
    value: (resource: PrimitiveResource) => readNestedValue(resource, ['status', 'lastDecisionAt']) ?? '—',
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
      onNavigate={(params) => void navigate({ search: params })}
    />
  )
}

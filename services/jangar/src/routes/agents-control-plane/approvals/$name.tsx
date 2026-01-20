import { createFileRoute } from '@tanstack/react-router'

import { readNestedValue } from '@/components/agents-control-plane'
import { PrimitiveDetailPage } from '@/components/agents-control-plane-primitives'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/agents-control-plane/approvals/$name')({
  validateSearch: parseNamespaceSearch,
  component: ApprovalDetailRoute,
})

const formatCount = (value: unknown, label: string) => {
  const count = Array.isArray(value) ? value.length : 0
  if (count === 0) return '—'
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

const readFirstSubject = (value: unknown) => {
  if (!Array.isArray(value)) return '—'
  const first = value[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '—'
  const record = first as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind : null
  const name = typeof record.name === 'string' ? record.name : null
  if (kind && name) return `${kind}/${name}`
  return kind ?? name ?? '—'
}

const readSpecValue = (resource: Record<string, unknown>, key: string) => {
  const spec = resource.spec
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  return (spec as Record<string, unknown>)[key] ?? null
}

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
      summaryItems={(resource, namespace) => {
        const subjects = readSpecValue(resource, 'subjects') ?? []
        return [
          { label: 'Namespace', value: readNestedValue(resource, ['metadata', 'namespace']) ?? namespace },
          { label: 'Mode', value: readNestedValue(resource, ['spec', 'mode']) ?? '—' },
          { label: 'Default decision', value: readNestedValue(resource, ['spec', 'defaultDecision']) ?? '—' },
          { label: 'Subjects', value: formatCount(subjects, 'subject') },
          { label: 'First subject', value: readFirstSubject(subjects) },
          { label: 'Last decision', value: readNestedValue(resource, ['status', 'lastDecisionAt']) ?? '—' },
        ]
      }}
    />
  )
}

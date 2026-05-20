import { createFileRoute, Navigate } from '@tanstack/react-router'

import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/control-plane/implementation-specs/new')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecCreateRedirect,
})

function ImplementationSpecCreateRedirect() {
  const searchState = Route.useSearch()

  return <Navigate to="/control-plane/implementation-specs" search={searchState} replace />
}

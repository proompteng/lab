import { createFileRoute } from '@tanstack/react-router'

import { ControlPlaneRedirect } from '@/components/agents-control-plane-redirect'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'

export const Route = createFileRoute('/control-plane/implementation-specs/$name')({
  validateSearch: parseNamespaceSearch,
  component: ControlPlaneRedirect,
})

import { createFileRoute } from '@tanstack/react-router'

import { ControlPlaneRedirect } from '@/components/agents-control-plane-redirect'

export const Route = createFileRoute('/control-plane/secret-bindings/$name')({
  component: ControlPlaneRedirect,
})

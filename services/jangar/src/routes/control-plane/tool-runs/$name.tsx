import { createFileRoute } from '@tanstack/react-router'

import { ControlPlaneRedirect } from '@/components/agents-control-plane-redirect'

export const Route = createFileRoute('/control-plane/tool-runs/$name')({
  component: ControlPlaneRedirect,
})

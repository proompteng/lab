import { Navigate } from '@tanstack/react-router'

import { DEFAULT_NAMESPACE } from '@/components/agents-control-plane-search'

export function ControlPlaneRedirect() {
  return <Navigate to="/control-plane/implementation-specs" search={{ namespace: DEFAULT_NAMESPACE }} />
}

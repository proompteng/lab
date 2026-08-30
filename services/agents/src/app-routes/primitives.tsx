import { Outlet, createFileRoute, useLocation } from '@tanstack/react-router'

import { PrimitivesOverview } from '../components/control-plane/primitives-overview'

export const Route = createFileRoute('/primitives')({
  component: PrimitivesRoute,
})

function PrimitivesRoute() {
  const location = useLocation()
  if (location.pathname === '/primitives' || location.pathname === '/primitives/') {
    return <PrimitivesOverview />
  }
  return <Outlet />
}

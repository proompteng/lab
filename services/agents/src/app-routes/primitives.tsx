import { Link, Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'

import { primitiveRegistry } from '../control-plane/registry'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'

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

function PrimitivesOverview() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Primitives</h1>
          <p className="text-sm text-muted-foreground">{primitiveRegistry.length} Kubernetes resources</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {primitiveRegistry.map((entry) => (
          <Card key={entry.kind} className="rounded-md">
            <CardHeader className="gap-2">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">{entry.display.label}</CardTitle>
                <Badge variant="outline">{entry.version}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{entry.group}</p>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3">
              <Button asChild variant="outline" size="sm">
                <Link to="/primitives/$kind" params={{ kind: entry.display.pathSegment }}>
                  Open
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/primitives/$kind/new" params={{ kind: entry.display.pathSegment }}>
                  <PlusIcon className="size-4" />
                  New
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

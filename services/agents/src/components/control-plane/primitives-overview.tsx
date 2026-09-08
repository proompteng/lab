import { Link } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'

import { primitiveRegistry } from '../../control-plane/registry'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { ControlPlanePage } from './control-plane-page'

export function PrimitivesOverview() {
  return (
    <ControlPlanePage>
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
                  <PlusIcon data-icon="inline-start" />
                  New
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </ControlPlanePage>
  )
}

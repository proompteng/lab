import { Link, Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { fetchPrimitiveResources, type PrimitiveResourceSummary } from '../control-plane/api-client'
import { findPrimitiveDefinition } from '../control-plane/registry'
import { ControlPlanePage } from '../components/control-plane/control-plane-page'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Skeleton } from '../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

export const Route = createFileRoute('/primitives/$kind')({
  component: PrimitiveKindRoute,
})

const metadataValue = (resource: PrimitiveResourceSummary, key: string) => {
  const value = resource.metadata[key]
  return typeof value === 'string' ? value : ''
}

function PrimitiveKindRoute() {
  const location = useLocation()
  const segments = location.pathname.split('/').filter(Boolean)
  if (segments.length > 2) {
    return <Outlet />
  }
  return <PrimitiveListPage />
}

function PrimitiveListPage() {
  const { kind } = Route.useParams()
  const primitive = findPrimitiveDefinition(kind)
  const [items, setItems] = useState<PrimitiveResourceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    if (!primitive) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetchPrimitiveResources(primitive.display.pathSegment)
      setItems(response.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [primitive?.kind])

  if (!primitive) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>Unknown primitive.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <ControlPlanePage>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-hidden rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead className="text-right">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const name = metadataValue(item, 'name')
              const namespace = metadataValue(item, 'namespace') || 'agents'
              const creationTimestamp = metadataValue(item, 'creationTimestamp')
              const phase = typeof item.status.phase === 'string' ? item.status.phase : ''
              return (
                <TableRow key={`${namespace}/${name}`}>
                  <TableCell className="font-medium">
                    <Link
                      to="/primitives/$kind/$namespace/$name"
                      params={{ kind: primitive.display.pathSegment, namespace, name }}
                      className="underline-offset-4 hover:underline"
                    >
                      {name}
                    </Link>
                  </TableCell>
                  <TableCell>{namespace}</TableCell>
                  <TableCell>
                    {phase ? (
                      <Badge variant="secondary">{phase}</Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{creationTimestamp || '-'}</TableCell>
                </TableRow>
              )
            })}
            {!loading && items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No resources found.
                </TableCell>
              </TableRow>
            ) : null}
            {loading ? (
              <>
                {Array.from({ length: 8 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      <Skeleton className="h-4 w-[240px] max-w-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Skeleton className="h-4 w-36" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </ControlPlanePage>
  )
}

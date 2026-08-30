import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { fetchLiveImplementationSpecs } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { LiveImplementationSpec } from '~/server/kubernetes'

export const Route = createFileRoute('/specs')({
  component: SpecsRoute,
  loader: loadInitialSnapshot,
})

function SpecsRoute() {
  const initialSnapshot = Route.useLoaderData()
  const specsQuery = useQuery({
    queryKey: ['live-implementation-specs'],
    queryFn: fetchLiveImplementationSpecs,
    refetchInterval: 10000,
  })
  const specs = specsQuery.data?.specs ?? []

  return (
    <GatewayFrame active="/specs" snapshot={initialSnapshot}>
      <GatewayPageHeader title="Specs" />
      <main className="min-h-0 flex-1 p-4 pb-12">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>Spec</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {specs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    {specsQuery.isLoading ? 'Loading specs.' : 'No specs.'}
                  </TableCell>
                </TableRow>
              ) : (
                specs.map((spec) => (
                  <TableRow key={`${spec.namespace}/${spec.name}`}>
                    <TableCell className="max-w-72 truncate font-medium">
                      <Link to="/specs/$name" params={{ name: spec.name }} className="hover:underline">
                        {spec.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={spec.phase === 'Ready' ? 'secondary' : 'outline'}>{spec.phase}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[34rem] truncate text-muted-foreground">{spec.summary}</TableCell>
                    <TableCell className="max-w-72 truncate font-mono text-xs">
                      {spec.requiredKeys.length ? spec.requiredKeys.join(', ') : '-'}
                    </TableCell>
                    <TableCell>{formatDate(spec.updatedAt ?? spec.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </main>
    </GatewayFrame>
  )
}

const formatDate = (value: LiveImplementationSpec['createdAt']) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

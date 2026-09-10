import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { ScrollArea, ScrollBar } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { fetchLiveImplementationSpec } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'

export const Route = createFileRoute('/specs_/$name')({
  component: SpecDetailRoute,
  loader: loadInitialSnapshot,
})

function SpecDetailRoute() {
  const initialSnapshot = Route.useLoaderData()
  const { name } = Route.useParams()
  const specQuery = useQuery({
    queryKey: ['live-implementation-spec', name],
    queryFn: () => fetchLiveImplementationSpec(name),
    refetchInterval: 10000,
  })
  const spec = specQuery.data?.spec ?? null

  return (
    <GatewayFrame active="/specs" snapshot={initialSnapshot}>
      <GatewayPageHeader title={name} active="/specs" breadcrumbs={[{ label: name }]} />
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 pb-12 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card size="sm" className="min-h-0">
          <CardHeader>
            <CardTitle>Spec</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="w-full">
              <div className="min-w-max">
                <Table>
                  <TableBody>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Phase</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant={spec?.phase === 'Ready' ? 'secondary' : 'outline'}>
                          {spec?.phase ?? 'Loading'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Namespace</TableCell>
                      <TableCell className="whitespace-nowrap">{spec?.namespace ?? 'agents'}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Required</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {spec?.requiredKeys.length ? spec.requiredKeys.join(', ') : '-'}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Updated</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(spec?.updatedAt ?? '')}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-muted-foreground">Created</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(spec?.createdAt ?? '')}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </CardContent>
        </Card>

        <Card size="sm" className="min-h-0">
          <CardHeader>
            <CardTitle>Text</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0">
            <ScrollArea className="h-[calc(100svh-12rem)] rounded-lg border bg-muted/20">
              <pre className="min-h-full whitespace-pre-wrap p-3 font-mono text-xs leading-5">
                {specQuery.isLoading ? 'Loading spec.' : spec?.text || spec?.summary || 'No text.'}
              </pre>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </GatewayFrame>
  )
}

const formatDate = (value: string) => {
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

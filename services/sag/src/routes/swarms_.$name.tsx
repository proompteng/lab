import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { ScrollArea, ScrollBar } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { fetchLiveSwarm } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'

export const Route = createFileRoute('/swarms_/$name')({
  component: SwarmDetailRoute,
  loader: loadInitialSnapshot,
})

function SwarmDetailRoute() {
  const initialSnapshot = Route.useLoaderData()
  const { name } = Route.useParams()
  const swarmQuery = useQuery({
    queryKey: ['live-swarm', name],
    queryFn: () => fetchLiveSwarm(name),
    refetchInterval: 10000,
  })
  const swarm = swarmQuery.data?.swarm ?? null

  return (
    <GatewayFrame active="/swarms" snapshot={initialSnapshot}>
      <GatewayPageHeader title={name} active="/swarms" breadcrumbs={[{ label: name }]} />
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 pb-12 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="grid min-h-0 gap-4 content-start">
          <Card size="sm" className="min-h-0">
            <CardHeader>
              <CardTitle>Swarm</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="w-full">
                <div className="min-w-max">
                  <Table>
                    <TableBody>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Phase</TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Badge variant={swarm?.ready ? 'secondary' : 'outline'}>{swarm?.phase ?? 'Loading'}</Badge>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Namespace</TableCell>
                        <TableCell className="whitespace-nowrap">{swarm?.namespace ?? 'agents'}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Mode</TableCell>
                        <TableCell className="whitespace-nowrap">{swarm?.mode ?? '-'}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Active</TableCell>
                        <TableCell className="whitespace-nowrap">{swarm?.activeMissions ?? 0}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">24h missions</TableCell>
                        <TableCell className="whitespace-nowrap">{swarm?.missions24h ?? 0}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-muted-foreground">Queued</TableCell>
                        <TableCell className="whitespace-nowrap">{swarm?.queuedNeeds ?? 0}</TableCell>
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
              <CardTitle>Mission</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-xs">
              <div className="text-muted-foreground">{swarm?.mission.businessMetric ?? '-'}</div>
              <div className="grid gap-1">
                {(swarm?.mission.valueGates ?? []).map((gate) => (
                  <div key={gate} className="truncate rounded-md border bg-muted/20 px-2 py-1 font-mono">
                    {gate}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </aside>

        <Card size="sm" className="min-h-0">
          <CardHeader>
            <CardTitle>Objectives</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0">
            <ScrollArea className="h-[calc(100svh-12rem)] rounded-lg border bg-muted/20">
              <div className="grid gap-3 p-3">
                {(swarm?.objectives ?? []).map((objective) => (
                  <div key={objective} className="rounded-md border bg-background/60 p-3 text-sm">
                    {objective}
                  </div>
                ))}
                {swarm?.objectives.length ? null : (
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    {swarmQuery.isLoading ? 'Loading swarm.' : 'No objectives.'}
                  </div>
                )}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </GatewayFrame>
  )
}

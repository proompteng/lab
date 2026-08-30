import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { fetchLiveSwarms } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { LiveSwarm } from '~/server/kubernetes'

export const Route = createFileRoute('/swarms')({
  component: SwarmsRoute,
  loader: loadInitialSnapshot,
})

function SwarmsRoute() {
  const initialSnapshot = Route.useLoaderData()
  const swarmsQuery = useQuery({
    queryKey: ['live-swarms'],
    queryFn: fetchLiveSwarms,
    refetchInterval: 10000,
  })
  const swarms = swarmsQuery.data?.swarms ?? []

  return (
    <GatewayFrame active="/swarms" snapshot={initialSnapshot}>
      <GatewayPageHeader title="Swarms" />
      <main className="min-h-0 flex-1 p-4 pb-12">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>Swarm</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>24h</TableHead>
                <TableHead>Queued</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {swarms.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    {swarmsQuery.isLoading ? 'Loading swarms.' : 'No swarms.'}
                  </TableCell>
                </TableRow>
              ) : (
                swarms.map((swarm) => (
                  <TableRow key={`${swarm.namespace}/${swarm.name}`}>
                    <TableCell className="font-medium">
                      <Link to="/swarms/$name" params={{ name: swarm.name }} className="hover:underline">
                        {swarm.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={swarm.ready ? 'secondary' : 'outline'}>{swarm.phase}</Badge>
                    </TableCell>
                    <TableCell>{swarm.mode}</TableCell>
                    <TableCell>{swarm.activeMissions}</TableCell>
                    <TableCell>{swarm.missions24h}</TableCell>
                    <TableCell>{swarm.queuedNeeds}</TableCell>
                    <TableCell>{formatDate(swarm.updatedAt ?? swarm.createdAt)}</TableCell>
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

const formatDate = (value: LiveSwarm['createdAt']) => {
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

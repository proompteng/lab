import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { Spinner } from '~/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { fetchLiveAgents, fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'

export const Route = createFileRoute('/agents')({
  component: AgentsRoute,
  loader: loadInitialSnapshot,
})

function AgentsRoute() {
  const initialSnapshot = Route.useLoaderData()
  const snapshotQuery = useQuery({
    queryKey: ['snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialSnapshot,
  })
  const agentsQuery = useQuery({
    queryKey: ['live-agents'],
    queryFn: fetchLiveAgents,
    refetchInterval: 10000,
  })
  const agents = agentsQuery.data?.agents ?? []

  return (
    <GatewayFrame active="/agents" snapshot={snapshotQuery.data ?? initialSnapshot}>
      <GatewayPageHeader
        title="Agents"
        detail="Cluster executors."
        action={
          <Button variant="outline" size="sm" onClick={() => agentsQuery.refetch()} disabled={agentsQuery.isFetching}>
            {agentsQuery.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            Refresh
          </Button>
        }
      />

      <main className="min-h-0 flex-1 overflow-hidden p-4">
        <Card className="h-full rounded-lg" size="sm">
          <CardHeader>
            <CardTitle>Agents</CardTitle>
            <CardAction>
              <Badge variant="outline">{agents.length}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="min-h-0 overflow-auto">
            {agents.length === 0 ? (
              <Empty className="min-h-[320px] rounded-lg border">
                <EmptyHeader>
                  <EmptyTitle>No agents</EmptyTitle>
                  <EmptyDescription>No Agent resources are visible to SAG.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Namespace</TableHead>
                    <TableHead>Runtime</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <TableRow key={`${agent.namespace}/${agent.name}`}>
                      <TableCell className="font-medium">{agent.name}</TableCell>
                      <TableCell>{agent.namespace}</TableCell>
                      <TableCell>{agent.runtime}</TableCell>
                      <TableCell>{agent.model}</TableCell>
                      <TableCell>
                        <Badge variant={agent.ready ? 'secondary' : 'outline'}>{agent.phase}</Badge>
                      </TableCell>
                      <TableCell>{formatDate(agent.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
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

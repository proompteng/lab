import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { GatewayFrame, GatewayPageHeader } from '~/components/gateway-shell'
import { fetchLiveAgents } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { LiveAgent } from '~/server/kubernetes'

export const Route = createFileRoute('/agents')({
  component: AgentsRoute,
  loader: loadInitialSnapshot,
})

function AgentsRoute() {
  const initialSnapshot = Route.useLoaderData()
  const agentsQuery = useQuery({
    queryKey: ['live-agents'],
    queryFn: fetchLiveAgents,
    refetchInterval: 10000,
  })
  const agents = agentsQuery.data?.agents ?? []

  return (
    <GatewayFrame active="/agents" snapshot={initialSnapshot}>
      <GatewayPageHeader title="Agents" />
      <main className="min-h-0 flex-1 p-4">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    {agentsQuery.isLoading ? 'Loading agents.' : 'No agents.'}
                  </TableCell>
                </TableRow>
              ) : (
                agents.map((agent) => (
                  <TableRow key={`${agent.namespace}/${agent.name}`}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>
                      <Badge variant={agent.ready ? 'secondary' : 'outline'}>{agent.phase}</Badge>
                    </TableCell>
                    <TableCell>{agent.runtime}</TableCell>
                    <TableCell>{agent.model}</TableCell>
                    <TableCell>{formatDate(agent.createdAt)}</TableCell>
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

const formatDate = (value: LiveAgent['createdAt']) => {
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

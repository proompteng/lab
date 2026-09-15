import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { GatewayFrame } from '~/components/gateway-shell'
import { Badge } from '~/components/ui/badge'
import { Empty, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { connectorAccessLabel, connectorGuardrailLabel, sourceLabel, statusBadgeVariant } from '~/lib/sag-display'
import { fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { Connector, GatewaySnapshot } from '~/server/gateway'

export const Route = createFileRoute('/connectors')({
  component: SourcesRoute,
  loader: loadInitialSnapshot,
})

function SourcesRoute() {
  const initialSnapshot = Route.useLoaderData() as GatewaySnapshot
  const [enabled, setEnabled] = useState(false)
  useEffect(() => setEnabled(true), [])
  const snapshotQuery = useQuery({
    queryKey: ['sag-snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialSnapshot,
    enabled,
  })
  const snapshot = snapshotQuery.data

  return (
    <GatewayFrame active="/connectors" snapshot={snapshot}>
      <header className="flex h-14 shrink-0 items-center border-b border-zinc-900 px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-50">Sources</h2>
          <div className="mt-0.5 text-xs text-zinc-400">{snapshot.connectors.length} connected</div>
        </div>
      </header>
      <section className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.connectors.length === 0 ? (
          <Empty className="min-h-36 border-0">
            <EmptyHeader>
              <EmptyTitle>No sources</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
        {snapshot.connectors.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-900">
                <TableHead className="w-48 px-4 text-xs text-zinc-400">Source</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Access</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Guardrail</TableHead>
                <TableHead className="w-28 px-4 text-xs text-zinc-400">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.connectors.map((connector) => (
                <SourceLine key={connector.id} connector={connector} />
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>
    </GatewayFrame>
  )
}

function SourceLine({ connector }: { connector: Connector }) {
  return (
    <TableRow className="border-zinc-900">
      <TableCell className="w-48 px-4">
        <Badge variant="outline">{sourceLabel(connector.id)}</Badge>
      </TableCell>
      <TableCell className="px-4 text-sm text-zinc-100">{connectorAccessLabel(connector)}</TableCell>
      <TableCell className="px-4 text-sm text-zinc-300">{connectorGuardrailLabel(connector)}</TableCell>
      <TableCell className="w-28 px-4">
        <Badge variant={statusBadgeVariant(connector.status === 'ready' ? 'allowed' : 'failed')}>
          {connector.status}
        </Badge>
      </TableCell>
    </TableRow>
  )
}

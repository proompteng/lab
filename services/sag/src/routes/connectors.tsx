import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Badge } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { type Connector, type GatewaySnapshot } from '~/server/gateway'

export const Route = createFileRoute('/connectors')({
  component: ConnectorsRoute,
  loader: loadInitialSnapshot,
})

function ConnectorsRoute() {
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
      <section className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid h-10 grid-cols-[180px_270px_minmax(0,1fr)] items-center border-b border-zinc-800 px-5 text-[11px] font-medium text-zinc-500">
          <span>Connector</span>
          <span>Target</span>
          <span>Boundary</span>
        </div>
        <div className="divide-y divide-zinc-900">
          {snapshot.connectors.map((connector) => (
            <ConnectorLine key={connector.id} connector={connector} />
          ))}
        </div>
      </section>
    </GatewayFrame>
  )
}

function ConnectorLine({ connector }: { connector: Connector }) {
  return (
    <div className="grid min-h-16 grid-cols-[180px_270px_minmax(0,1fr)] items-center px-5 text-xs">
      <div className="min-w-0">
        <p className="truncate text-zinc-100">{connector.name}</p>
        <Badge className="mt-1 font-mono">{connector.id}</Badge>
      </div>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-400">{connector.target}</span>
      <span className="min-w-0 truncate text-zinc-400">{connector.trustBoundary}</span>
    </div>
  )
}

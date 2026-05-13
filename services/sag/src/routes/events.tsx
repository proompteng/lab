import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Badge } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { cn } from '~/lib/utils'
import { type EventStatus, type GatewayEvent, type GatewaySnapshot } from '~/server/gateway'

export const Route = createFileRoute('/events')({
  component: EventsRoute,
  loader: loadInitialSnapshot,
})

function EventsRoute() {
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
    <GatewayFrame active="/events" snapshot={snapshot}>
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="grid h-10 shrink-0 grid-cols-[96px_96px_130px_minmax(0,1fr)_220px] items-center border-b border-zinc-800 px-5 text-[11px] font-medium text-zinc-500">
          <span>Time</span>
          <span>Source</span>
          <span>Result</span>
          <span>Operation</span>
          <span>Policy</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y divide-zinc-900">
            {snapshot.events.map((event) => (
              <EventLine key={event.id} event={event} />
            ))}
            {snapshot.events.length === 0 ? <div className="p-6 text-sm text-zinc-500">No events.</div> : null}
          </div>
        </div>
      </section>
    </GatewayFrame>
  )
}

function EventLine({ event }: { event: GatewayEvent }) {
  return (
    <div className="grid min-h-12 grid-cols-[96px_96px_130px_minmax(0,1fr)_220px] items-center px-5 text-xs">
      <span className="font-mono text-[11px] text-zinc-500">
        {new Date(event.timestamp).toISOString().slice(11, 19)}
      </span>
      <Badge className="font-mono">{event.connector}</Badge>
      <Status status={event.status} />
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-100">{event.operation}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{event.policy}</span>
    </div>
  )
}

function Status({ status }: { status: EventStatus }) {
  const blocked = status === 'blocked' || status === 'denied'
  const attention = status === 'approval_required'
  return (
    <Badge variant={blocked ? 'destructive' : attention ? 'secondary' : 'outline'} className={cn('capitalize')}>
      {status.replace('_', ' ')}
    </Badge>
  )
}

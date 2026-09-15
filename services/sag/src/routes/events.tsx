import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { GatewayFrame } from '~/components/gateway-shell'
import { Badge } from '~/components/ui/badge'
import { Empty, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import {
  formatTime,
  operationLabel,
  policyLabel,
  sourceLabel,
  statusBadgeVariant,
  statusLabel,
  userFacingText,
} from '~/lib/sag-display'
import { fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { GatewayEvent, GatewaySnapshot } from '~/server/gateway'

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
      <header className="flex h-14 shrink-0 items-center border-b border-zinc-900 px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-50">Audit</h2>
          <div className="mt-0.5 text-xs text-zinc-400">{snapshot.events.length} events</div>
        </div>
      </header>
      <section className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.events.length === 0 ? (
          <Empty className="min-h-36 border-0">
            <EmptyHeader>
              <EmptyTitle>No audit events</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
        {snapshot.events.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-900">
                <TableHead className="w-24 px-4 text-xs text-zinc-400">Time</TableHead>
                <TableHead className="w-40 px-4 text-xs text-zinc-400">Source</TableHead>
                <TableHead className="w-36 px-4 text-xs text-zinc-400">Decision</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Action</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.events.map((event) => (
                <EventLine key={event.id} event={event} />
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>
    </GatewayFrame>
  )
}

function EventLine({ event }: { event: GatewayEvent }) {
  return (
    <TableRow className="border-zinc-900">
      <TableCell className="w-24 px-4 font-mono text-xs text-zinc-400">{formatTime(event.timestamp)}</TableCell>
      <TableCell className="w-40 px-4">
        <Badge variant="outline">{sourceLabel(event.connector)}</Badge>
      </TableCell>
      <TableCell className="w-36 px-4">
        <Badge variant={statusBadgeVariant(event.status)}>{statusLabel(event.status)}</Badge>
      </TableCell>
      <TableCell className="px-4">
        <span className="text-sm font-medium text-zinc-100">{operationLabel(event.operation)}</span>
      </TableCell>
      <TableCell className="px-4">
        <div className="grid gap-0.5">
          <span className="line-clamp-1 text-sm text-zinc-300">{userFacingText(event.summary)}</span>
          <span className="text-xs text-zinc-400">{policyLabel(event.policy)}</span>
        </div>
      </TableCell>
    </TableRow>
  )
}

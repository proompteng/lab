'use client'

import { fromJson } from '@bufbuild/protobuf'
import { Button, Skeleton } from '@proompteng/design/ui'
import { activityResources } from '@/lib/platform/activity'
import { ActivityFilters } from './activity-filters'
import { usePortalQuery } from './collection-view'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readPlatformResponse } from '@/lib/platform/client'
import {
  ReadWorkspaceActivityResponseSchema,
  type ReadWorkspaceActivityResponse,
  type GetPlatformWorkspaceResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

const activityNames: Record<string, string> = {
  'ofz.relationships.write': 'Access changed',
  'ofz.relationships.read': 'Access viewed',
  'ofz.workspaces.read': 'Workspace viewed',
  'ofz.workspaces.activity': 'Activity viewed',
  'ofz.connections.put': 'Connection saved',
  'ofz.connections.revoke': 'Connection disconnected',
  'ofz.access_requests.create': 'Access requested',
  'ofz.access_requests.review': 'Access request reviewed',
  'ofz.access_requests.cancel': 'Access request cancelled',
  'ofz.access_requests.list': 'Access requests viewed',
  'ofz.delegations.create': 'Agent credential issued',
  'ofz.delegations.activate': 'Agent connection activated',
  'ofz.delegations.revoke': 'Agent connection revoked',
  'relay.execution.started': 'Operation started',
  'relay.execution.succeeded': 'Operation completed',
  'relay.execution.failed': 'Operation failed',
  'relay.execution.withheld': 'Operation response withheld',
}
export function WorkspaceActivity({ detail }: { detail: GetPlatformWorkspaceResponse }) {
  const { query, change } = usePortalQuery()
  const filters = new URLSearchParams()
  for (const name of ['action', 'outcome', 'actorId', 'cursor']) {
    const value = query.get(name)
    if (value) filters.set(name, value)
  }
  const filterKey = filters.toString()
  const [page, setPage] = useState<ReadWorkspaceActivityResponse>()
  const [error, setError] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const readVersion = useRef(0)
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++readVersion.current
      setBusy(true)
      setError(undefined)
      setPage(undefined)
      try {
        const query = filterKey ? '?' + filterKey : ''
        const json = await fetch(`/api/platform/workspaces/${detail.workspace!.id}/activity${query}`, {
          signal,
          cache: 'no-store',
        }).then(readPlatformResponse)
        if (signal?.aborted || version !== readVersion.current) return
        const next = fromJson(ReadWorkspaceActivityResponseSchema, json)
        setPage(next)
      } catch (cause) {
        if (!signal?.aborted && version === readVersion.current)
          setError(cause instanceof Error ? cause : new Error('Activity could not be loaded.'))
      } finally {
        if (!signal?.aborted && version === readVersion.current) setBusy(false)
      }
    },
    [detail.workspace!.id, filterKey],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  return (
    <section className="space-y-4" aria-label="Workspace activity">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Recent activity</h2>
          <p className="mt-1 text-sm text-zinc-400">Connection, access and execution history for this workspace.</p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh activity"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <ActivityFilters detail={detail} />
      <p className="text-xs text-zinc-400">
        Newest first. Filters apply to the full workspace history before each page of up to 100 receipts. Successful
        administration reads are excluded.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error.message}
        </p>
      ) : null}
      {!page && !error ? <Skeleton aria-label="Loading activity" className="h-32" /> : null}
      {page ? (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {page.receipts.map((receipt) => {
            const actor =
              receipt.actor?.identity.case === 'humanId'
                ? detail.members.find((person) => person.humanId === receipt.actor!.identity.value)
                : undefined
            return (
              <li key={receipt.id} className="space-y-1 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <p>
                    {activityNames[receipt.platformAction] || receipt.platformAction.replaceAll('.', ' ')}
                    <span className={`ml-2 text-xs ${receipt.allowed ? 'text-zinc-400' : 'text-red-300'}`}>
                      {receipt.allowed ? '' : 'Denied'}
                    </span>
                  </p>
                  <time
                    dateTime={new Date(Number(receipt.createdAtUnixMs)).toISOString()}
                    className="text-xs text-zinc-400"
                  >
                    {new Date(Number(receipt.createdAtUnixMs)).toLocaleString()}
                  </time>
                </div>
                <p className="text-xs text-zinc-400">
                  {actor?.displayName ||
                    (actor ? `GitHub ${actor.githubId}` : receipt.platformClient || 'Platform service')}
                </p>
                <details className="text-xs text-zinc-400">
                  <summary className="cursor-pointer">Details</summary>
                  <p className="mt-2">{receipt.reason}</p>
                  <dl className="mt-2 space-y-2 break-all">
                    <dt>Action</dt>
                    <dd>{receipt.platformAction}</dd>
                    <dt>Outcome</dt>
                    <dd>{receipt.allowed ? 'Allowed' : 'Denied'}</dd>
                    <dt>Client</dt>
                    <dd>{receipt.platformClient || 'Platform service'}</dd>
                    {activityResources(receipt.platformResources).map((resource) => (
                      <div key={resource}>
                        <dt>Resource</dt>
                        <dd>
                          {detail.workspace!.resources.find(
                            (entry) => `${entry.resource?.kind}/${entry.resource?.id}` === resource.split('#')[0],
                          )?.name || resource}
                        </dd>
                        <dd className="font-mono">{resource}</dd>
                      </div>
                    ))}
                    <dt>Receipt</dt>
                    <dd>{receipt.id}</dd>
                    <dt>Operation</dt>
                    <dd>{receipt.operationId}</dd>
                    <dt>Policy revision</dt>
                    <dd>{receipt.revision}</dd>
                  </dl>
                </details>
              </li>
            )
          })}
          {!page.receipts.length ? (
            <li className="p-4 text-sm text-zinc-400">No activity in this workspace yet.</li>
          ) : null}
        </ul>
      ) : null}
      {query.get('cursor') ? (
        <Button variant="ghost" size="sm" onClick={() => change({ cursor: '' })}>
          Newest activity
        </Button>
      ) : null}
      {page?.cursor ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => change({ cursor: page.cursor })}>
          {busy ? 'Loading…' : 'Load earlier activity'}
        </Button>
      ) : null}
    </section>
  )
}

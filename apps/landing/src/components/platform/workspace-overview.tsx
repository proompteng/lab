'use client'

import { fromJson } from '@bufbuild/protobuf'
import { Card, CardHeader, CardTitle, CardContent, Skeleton } from '@proompteng/design/ui'
import { useEffect, useState } from 'react'
import { portalPath } from '@/lib/platform/portal'
import { readPlatformResponse } from '@/lib/platform/client'
import {
  ListPlatformAccessRequestsResponseSchema,
  ListProviderConnectionsResponseSchema,
  PlatformWorkspaceRole,
  ProviderConnectionState,
  type GetPlatformWorkspaceResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export function WorkspaceOverview({ detail }: { detail: GetPlatformWorkspaceResponse }) {
  const workspace = detail.workspace!
  const [summary, setSummary] = useState<{ requests: number; connections: number; reconnect: number }>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const query = '?' + new URLSearchParams({ workspaceId: workspace.id })
    void Promise.all([
      fetch('/api/platform/access-requests' + query, { signal: controller.signal, cache: 'no-store' })
        .then(readPlatformResponse)
        .then((json) => fromJson(ListPlatformAccessRequestsResponseSchema, json)),
      fetch('/api/platform/provider-connections' + query, { signal: controller.signal, cache: 'no-store' })
        .then(readPlatformResponse)
        .then((json) => fromJson(ListProviderConnectionsResponseSchema, json)),
    ])
      .then(([requests, providers]) => {
        if (controller.signal.aborted) return
        const shared = providers.connections.filter((profile) => profile.workspaceManaged)
        setSummary({
          requests: requests.requests.length,
          connections: shared.filter((profile) => profile.state === ProviderConnectionState.READY).length,
          reconnect: shared.filter((profile) => profile.state === ProviderConnectionState.RECONNECT).length,
        })
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Summary unavailable.')
      })
    return () => controller.abort()
  }, [workspace.id])
  const cards = [
    {
      name: 'Active members',
      value: detail.members.filter((member) => member.admitted).length,
      section: 'people' as const,
      hint: 'Admitted people in this workspace',
    },
    {
      name: 'Enrolled clients',
      value: detail.clients.filter((client) => client.enabled).length,
      section: 'integrations' as const,
      hint: 'Applications enabled for this workspace',
    },
    {
      name: 'Registered resources',
      value: workspace.resources.length,
      section: 'resources' as const,
      hint: 'The approved resource catalog',
    },
  ]
  return (
    <section aria-label="Workspace overview" className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.name} className="border-zinc-800 bg-zinc-950">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                <a
                  className="underline-offset-4 hover:underline"
                  href={portalPath(
                    workspace.id,
                    card.section,
                    card.section === 'people'
                      ? { filter: 'active' }
                      : card.section === 'integrations'
                        ? { filter: 'enabled' }
                        : undefined,
                  )}
                >
                  {card.name}
                </a>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">{card.value}</p>
              <p className="mt-2 text-xs leading-5 text-zinc-400">{card.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader>
          <CardTitle>Needs your attention</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error ? (
            <p role="alert" className="text-red-300">
              {error} Use Refresh workspace to retry.
            </p>
          ) : !summary ? (
            <Skeleton aria-label="Loading workspace summary" className="h-20" />
          ) : (
            <>
              <a
                href={portalPath(workspace.id, 'requests')}
                className="block rounded-md border border-zinc-800 p-4 hover:bg-zinc-900"
              >
                <span className="font-medium">{summary.requests} pending access requests</span>
                <span className="mt-1 block text-zinc-400">Review the exact operations members need.</span>
              </a>
              <a
                href={portalPath(workspace.id, 'connections')}
                className="block rounded-md border border-zinc-800 p-4 hover:bg-zinc-900"
              >
                <span className="font-medium">
                  {summary.connections} connected provider accounts · {summary.reconnect} need reconnection
                </span>
                <span className="mt-1 block text-zinc-400">Provider consent is separate from resource permission.</span>
              </a>
            </>
          )}
          {detail.members.filter((member) => member.admitted && member.role === PlatformWorkspaceRole.ADMINISTRATOR)
            .length === 1 ? (
            <p className="rounded-md border border-amber-800 p-4 text-amber-200">
              This workspace has one active administrator. Add another admitted administrator before removing or
              demoting the current one.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <a
          className="rounded-lg border border-zinc-800 p-5 hover:bg-zinc-900"
          href={portalPath(workspace.id, 'people')}
        >
          <h2 className="text-sm font-medium">Onboard a teammate</h2>
          <p className="mt-2 text-sm text-zinc-400">Add an admitted GitHub identity and choose their workspace role.</p>
        </a>
        <a
          className="rounded-lg border border-zinc-800 p-5 hover:bg-zinc-900"
          href={portalPath(workspace.id, 'activity')}
        >
          <h2 className="text-sm font-medium">Inspect recent changes</h2>
          <p className="mt-2 text-sm text-zinc-400">Read authoritative outcomes and their audit receipts.</p>
        </a>
      </div>
    </section>
  )
}

export function WorkspaceSettings({ detail }: { detail: GetPlatformWorkspaceResponse }) {
  const workspace = detail.workspace!
  return (
    <section aria-label="Workspace settings" className="space-y-6">
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-2">
            <dt className="text-zinc-400">Workspace name</dt>
            <dd>{workspace.name}</dd>
            <dt className="text-zinc-400">Configuration authority</dt>
            <dd>Ofz service registry</dd>
          </dl>
          <p className="leading-6 text-zinc-400">
            Workspace names, resource ceilings, provider profiles and client identities are reviewed platform
            configuration. Creating, renaming or retiring an administration workspace requires that configuration
            review. This is not a Tengri virtual machine.
          </p>
          <details>
            <summary className="cursor-pointer">Technical details</summary>
            <dl className="mt-3 space-y-2 break-all">
              <dt className="text-zinc-400">Workspace ID</dt>
              <dd className="font-mono">{workspace.id}</dd>
              <dt className="text-zinc-400">Policy version</dt>
              <dd>{String(detail.policyVersion)}</dd>
            </dl>
          </details>
        </CardContent>
      </Card>
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader>
          <CardTitle>Access and security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="leading-6 text-zinc-400">
            Ofz checks your current workspace role for every operation. Sensitive access changes require a reason and
            fresh passkey verification. Use the account menu to verify your identity or manage passkeys.
          </p>
          <div className="flex flex-wrap gap-4">
            <a className="underline underline-offset-4" href={portalPath(workspace.id, 'people')}>
              Manage membership
            </a>
            <a className="underline underline-offset-4" href={portalPath(workspace.id, 'integrations')}>
              Manage client enrollment
            </a>
            <a className="underline underline-offset-4" href={portalPath(workspace.id, 'resources')}>
              Manage resource grants
            </a>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

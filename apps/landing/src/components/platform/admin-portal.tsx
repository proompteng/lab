'use client'

import { fromJson } from '@bufbuild/protobuf'
import { Button, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@proompteng/design/ui'
import { ArrowUpRight, LogOut, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { signOut, startSignIn } from '@/lib/platform/auth-client'
import { PlatformClientError, readPlatformResponse } from '@/lib/platform/client'
import {
  GetPlatformWorkspaceResponseSchema,
  ListPlatformWorkspacesResponseSchema,
  ReadWorkspaceActivityResponseSchema,
  type GetPlatformWorkspaceResponse,
  type RegisteredPlatformWorkspace,
  type ReadWorkspaceActivityResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { ResourceAccessPanel } from './resource-access-panel'
import { SettingsSelect } from './settings-select'
import { WorkspaceClients } from './workspace-clients'
import { WorkspacePeople } from './workspace-people'

import { portalSections, type PortalSection } from '@/lib/platform/portal'
const activityNames: Record<string, string> = {
  'ofz.relationships.write': 'Access changed',
  'ofz.relationships.read': 'Access viewed',
  'ofz.workspaces.read': 'Workspace viewed',
  'ofz.workspaces.activity': 'Activity viewed',
  'ofz.connections.put': 'Connection saved',
  'ofz.connections.revoke': 'Connection disconnected',
  'ofz.delegations.create': 'Agent credential issued',
  'ofz.delegations.activate': 'Agent connection activated',
  'ofz.delegations.revoke': 'Agent connection revoked',
  'relay.execution.started': 'Operation started',
  'relay.execution.succeeded': 'Operation completed',
  'relay.execution.failed': 'Operation failed',
  'relay.execution.withheld': 'Operation response withheld',
}
function Activity({ detail }: { detail: GetPlatformWorkspaceResponse }) {
  const [page, setPage] = useState<ReadWorkspaceActivityResponse>()
  const [error, setError] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const load = useCallback(
    async (cursor = '', signal?: AbortSignal) => {
      setBusy(true)
      setError(undefined)
      try {
        const query = cursor ? '?' + new URLSearchParams({ cursor }) : ''
        const json = await fetch(`/api/platform/workspaces/${detail.workspace!.id}/activity${query}`, {
          signal,
          cache: 'no-store',
        }).then(readPlatformResponse)
        if (signal?.aborted) return
        const next = fromJson(ReadWorkspaceActivityResponseSchema, json)
        setPage((previous) =>
          cursor && previous ? { ...next, receipts: [...previous.receipts, ...next.receipts] } : next,
        )
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause : new Error('Activity could not be loaded.'))
      } finally {
        if (!signal?.aborted) setBusy(false)
      }
    },
    [detail.workspace!.id],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load('', controller.signal)
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
                  <p className="mt-1 break-all">Receipt {receipt.id}</p>
                </details>
              </li>
            )
          })}
          {!page.receipts.length ? (
            <li className="p-4 text-sm text-zinc-400">No activity in this workspace yet.</li>
          ) : null}
        </ul>
      ) : null}
      {page?.cursor ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(page.cursor)}>
          {busy ? 'Loading…' : 'Load earlier activity'}
        </Button>
      ) : null}
    </section>
  )
}

export function AdminPortal({
  identity,
  workspaceId,
  section = 'integrations',
}: {
  identity: { humanId: string; name: string } | null
  workspaceId?: string
  section?: PortalSection
}) {
  const router = useRouter()
  const [workspaces, setWorkspaces] = useState<RegisteredPlatformWorkspace[]>()
  const [detail, setDetail] = useState<GetPlatformWorkspaceResponse>()
  const [error, setError] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    if (!identity) return
    const controller = new AbortController()
    void fetch('/api/platform/workspaces', { signal: controller.signal, cache: 'no-store' })
      .then(readPlatformResponse)
      .then((json) => {
        if (controller.signal.aborted) return
        const spaces = fromJson(ListPlatformWorkspacesResponseSchema, json).workspaces
        setWorkspaces(spaces)
        if (!workspaceId && spaces[0]) router.replace(`/workspaces/${spaces[0].id}/${section}`, { scroll: false })
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error('Workspaces could not be loaded.'))
      })
    return () => controller.abort()
  }, [identity?.humanId, router, workspaceId, section])
  useEffect(() => {
    if (!identity || !workspaceId) return
    const controller = new AbortController()
    setError(undefined)
    void fetch(`/api/platform/workspaces/${workspaceId}`, { signal: controller.signal, cache: 'no-store' })
      .then(readPlatformResponse)
      .then((json) => {
        if (!controller.signal.aborted) setDetail(fromJson(GetPlatformWorkspaceResponseSchema, json))
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setDetail(undefined)
          setError(cause instanceof Error ? cause : new Error('This workspace could not be loaded.'))
        }
      })
    return () => controller.abort()
  }, [identity?.humanId, workspaceId, revision])
  const current = detail?.workspace?.id === workspaceId ? detail : undefined
  const navigate = (next: string, tab: PortalSection = section) =>
    router.push(`/workspaces/${next}/${tab}`, { scroll: false })
  const authenticate = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await startSignIn()
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Sign-in failed.'))
      setBusy(false)
    }
  }
  return (
    <main className="tengri-theme font-geist min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-8">
          <a href="/" className="min-w-0 text-sm font-medium">
            Proompteng <span className="ml-2 font-normal text-zinc-400">Administration</span>
          </a>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href="https://proompteng.ai/"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Tengri
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
            {identity ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Sign out"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void signOut()
                    .then(() => router.refresh())
                    .catch((cause) => {
                      setError(cause instanceof Error ? cause : new Error('Sign out failed.'))
                      setBusy(false)
                    })
                }}
              >
                <LogOut className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-5xl space-y-7 px-4 py-7 sm:px-8 sm:py-10">
        {!identity ? (
          <section className="mx-auto max-w-md space-y-4 py-16">
            <h1 className="text-2xl font-semibold tracking-tight">Workspace administration</h1>
            <p className="text-sm leading-6 text-zinc-400">
              Manage people, integrations and access for your workspaces.
            </p>
            <Button disabled={busy} onClick={() => void authenticate()}>
              {busy ? 'Opening sign-in…' : 'Continue with GitHub'}
            </Button>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs text-zinc-400">Workspace</p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight">
                  {current?.workspace?.name ||
                    workspaces?.find((space) => space.id === workspaceId)?.name ||
                    'Administration'}
                </h1>
              </div>
              {workspaces && workspaces.length > 1 ? (
                <div className="w-full sm:w-56">
                  <SettingsSelect
                    name="workspace"
                    aria-label="Workspace"
                    value={workspaceId || ''}
                    onValueChange={(value) => navigate(value)}
                    options={workspaces.map((space) => ({ value: space.id, label: space.name }))}
                  />
                </div>
              ) : null}
            </div>
            {workspaces?.length === 0 ? (
              <p className="text-sm text-zinc-400">
                You do not administer a workspace. Ask a workspace administrator to add you.
              </p>
            ) : null}
            {current ? (
              <Tabs
                value={section}
                onValueChange={(value) => {
                  if (portalSections.includes(value as PortalSection)) navigate(workspaceId!, value as PortalSection)
                }}
                className="gap-6"
              >
                <TabsList
                  variant="line"
                  aria-label="Workspace administration"
                  className="max-w-full justify-start gap-3 overflow-x-auto border-b border-zinc-800 pb-2"
                >
                  <TabsTrigger value="integrations" className="shrink-0 px-1 text-sm">
                    Integrations
                  </TabsTrigger>
                  <TabsTrigger value="people" className="shrink-0 px-1 text-sm">
                    People & access
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="shrink-0 px-1 text-sm">
                    Activity
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="integrations">
                  <div className="space-y-8">
                    <WorkspaceClients
                      key={workspaceId + '-clients'}
                      detail={current}
                      humanId={identity.humanId}
                      onChanged={refresh}
                    />
                    <ResourceAccessPanel
                      key={workspaceId + '-resources'}
                      detail={current}
                      humanId={identity.humanId}
                      onChanged={refresh}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="people">
                  <WorkspacePeople
                    key={workspaceId + '-people'}
                    detail={current}
                    humanId={identity.humanId}
                    onChanged={refresh}
                  />
                </TabsContent>
                <TabsContent value="activity">
                  <Activity key={workspaceId} detail={current} />
                </TabsContent>
              </Tabs>
            ) : workspaceId && !error ? (
              <Skeleton aria-label="Loading workspace" className="h-64" />
            ) : null}
          </>
        )}
        {error ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-red-300">{error.message}</p>
            {identity ? (
              <Button
                variant="outline"
                size="sm"
                onClick={
                  error instanceof PlatformClientError && error.status === 401 ? () => void authenticate() : refresh
                }
              >
                {error instanceof PlatformClientError && error.status === 401 ? 'Sign in' : 'Retry'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  )
}

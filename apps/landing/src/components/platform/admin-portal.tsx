'use client'

import { fromJson } from '@bufbuild/protobuf'
import {
  Button,
  Skeleton,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@proompteng/design/ui'
import {
  Activity,
  ArrowUpRight,
  Blocks,
  ChevronDown,
  CircleUser,
  Home,
  KeyRound,
  ListChecks,
  Plug,
  RefreshCw,
  Settings,
  Users,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { signOut, startSignIn } from '@/lib/platform/auth-client'
import { PlatformClientError, readPlatformResponse } from '@/lib/platform/client'
import { portalPages, portalPath, portalSections, type PortalSection } from '@/lib/platform/portal'
import {
  GetPlatformWorkspaceResponseSchema,
  ListPlatformWorkspacesResponseSchema,
  type GetPlatformWorkspaceResponse,
  type RegisteredPlatformWorkspace,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { SettingsSelect } from './settings-select'
import { WorkspaceOverview, WorkspaceSettings } from './workspace-overview'

const WorkspacePeople = lazy(() => import('./workspace-people').then((m) => ({ default: m.WorkspacePeople })))
const WorkspaceClients = lazy(() => import('./workspace-clients').then((m) => ({ default: m.WorkspaceClients })))
const ResourceAccessPanel = lazy(() =>
  import('./resource-access-panel').then((m) => ({ default: m.ResourceAccessPanel })),
)
const WorkspaceAccessRequests = lazy(() =>
  import('./workspace-access-requests').then((m) => ({ default: m.WorkspaceAccessRequests })),
)
const WorkspaceProviderAccounts = lazy(() =>
  import('./provider-accounts').then((m) => ({ default: m.WorkspaceProviderAccounts })),
)
const WorkspaceActivity = lazy(() => import('./workspace-activity').then((m) => ({ default: m.WorkspaceActivity })))
const icons = {
  overview: Home,
  people: Users,
  integrations: Blocks,
  resources: KeyRound,
  connections: Plug,
  requests: ListChecks,
  activity: Activity,
  settings: Settings,
}

export function AdminPortal({
  identity,
  workspaceId,
  section = 'overview',
  initialWorkspaces,
  initialDetail,
}: {
  identity: { humanId: string; name: string } | null
  workspaceId?: string
  section?: PortalSection
  initialWorkspaces?: RegisteredPlatformWorkspace[]
  initialDetail?: GetPlatformWorkspaceResponse
}) {
  const router = useRouter()
  const [workspaces, setWorkspaces] = useState(initialWorkspaces)
  const [detail, setDetail] = useState(initialDetail)
  const [error, setError] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    if (!identity) return
    const controller = new AbortController()
    setError(undefined)
    const listing =
      initialWorkspaces && revision === 0
        ? Promise.resolve(initialWorkspaces)
        : fetch('/api/platform/workspaces', { signal: controller.signal, cache: 'no-store' })
            .then(readPlatformResponse)
            .then((json) => fromJson(ListPlatformWorkspacesResponseSchema, json).workspaces)
    void listing
      .then((spaces) => {
        if (controller.signal.aborted) return
        setWorkspaces(spaces)
        if (!workspaceId && spaces[0]) router.replace(portalPath(spaces[0].id, section), { scroll: false })
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error('Workspaces could not be loaded.'))
      })
    return () => controller.abort()
  }, [identity?.humanId, workspaceId, initialWorkspaces, revision, router, section])
  useEffect(() => {
    if (!identity || !workspaceId || (initialDetail?.workspace?.id === workspaceId && revision === 0)) return
    const controller = new AbortController()
    void fetch(`/api/platform/workspaces/${workspaceId}`, { signal: controller.signal, cache: 'no-store' })
      .then(readPlatformResponse)
      .then((json) => {
        if (!controller.signal.aborted) setDetail(fromJson(GetPlatformWorkspaceResponseSchema, json))
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error('This workspace could not be loaded.'))
      })
    return () => controller.abort()
  }, [identity?.humanId, workspaceId, initialDetail, revision])
  const current = detail?.workspace?.id === workspaceId ? detail : undefined
  const authenticate = async (action: 'login' | 'step-up' | 'add-passkey' = 'login') => {
    setBusy(true)
    try {
      await startSignIn(action)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Sign-in failed.'))
      setBusy(false)
    }
  }
  const page = portalPages[section]
  const workspaceName =
    current?.workspace?.name || workspaces?.find((space) => space.id === workspaceId)?.name || 'Workspace'
  const props = current && identity ? { detail: current, humanId: identity.humanId, onChanged: refresh } : undefined
  return (
    <div data-admin-console className="tengri-theme font-geist min-h-dvh bg-zinc-950 text-zinc-100">
      <a
        href="#admin-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-zinc-100 focus:p-3 focus:text-zinc-950"
      >
        Skip to content
      </a>
      {!identity ? (
        <main id="admin-content" className="mx-auto max-w-md space-y-5 px-5 py-24">
          <p className="text-sm text-zinc-400">Proompteng / Administration</p>
          <h1 className="text-2xl font-semibold tracking-tight">Workspace administration</h1>
          <p className="text-sm leading-6 text-zinc-400">
            Manage your workspace’s people, integrations and access with your verified GitHub identity.
          </p>
          <Button disabled={busy} onClick={() => void authenticate()}>
            {busy ? 'Opening sign-in…' : 'Continue with GitHub'}
          </Button>
          {error ? <p role="alert">{error.message}</p> : null}
        </main>
      ) : (
        <SidebarProvider>
          <Sidebar className="border-zinc-800">
            <SidebarHeader className="gap-5 p-4">
              <a href="/" className="text-sm font-semibold tracking-tight">
                Proompteng <span className="font-normal text-zinc-400">/ Admin</span>
              </a>
              <SettingsSelect
                name="workspace"
                aria-label="Workspace"
                value={workspaceId || ''}
                disabled={!workspaces?.length}
                onValueChange={(value) => router.push(portalPath(value, section))}
                options={(workspaces || []).map((space) => ({ value: space.id, label: space.name }))}
              />
            </SidebarHeader>
            <SidebarContent className="px-3 py-2">
              <nav aria-label="Workspace navigation">
                <SidebarMenu>
                  {portalSections.map((item) => {
                    const Icon = icons[item]
                    return (
                      <SidebarMenuItem key={item}>
                        <SidebarMenuButton
                          render={<a href={workspaceId ? portalPath(workspaceId, item) : '/workspaces'} />}
                          isActive={section === item}
                          aria-current={section === item ? 'page' : undefined}
                          className="min-h-10 text-sm"
                        >
                          <Icon aria-hidden="true" />
                          <span>{portalPages[item].title}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </nav>
            </SidebarContent>
            <SidebarFooter className="border-t border-zinc-800 p-3">
              <a
                href="https://proompteng.ai/"
                className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm text-zinc-400 hover:text-zinc-100"
              >
                Open Tengri <ArrowUpRight className="size-4" aria-hidden="true" />
              </a>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" className="min-h-11 w-full justify-start" />}>
                  <CircleUser className="size-4" />
                  <span className="truncate">{identity.name}</span>
                  <ChevronDown className="ml-auto size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="tengri-theme font-geist min-w-56" side="top">
                  <DropdownMenuItem disabled={busy} onClick={() => void authenticate('step-up')}>
                    Verify identity
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busy} onClick={() => void authenticate('add-passkey')}>
                    Add a passkey
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      void signOut()
                        .then(() => router.refresh())
                        .catch((cause) => setError(cause instanceof Error ? cause : new Error('Sign out failed.')))
                        .finally(() => setBusy(false))
                    }}
                  >
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarFooter>
          </Sidebar>
          <SidebarInset id="admin-content" className="min-w-0 bg-zinc-950">
            <header className="flex min-h-16 items-center gap-3 border-b border-zinc-800 px-4 sm:px-8">
              <SidebarTrigger className="size-10" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      href={workspaceId ? portalPath(workspaceId, 'overview') : '/'}
                      className="max-w-40 truncate"
                    >
                      {workspaceName}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{page.title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </header>
            <div className="mx-auto w-full max-w-6xl space-y-7 px-4 py-7 sm:px-8 sm:py-10">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">{page.description}</p>
                </div>
                <Button variant="outline" size="icon" aria-label="Refresh workspace" onClick={refresh}>
                  <RefreshCw className="size-4" />
                </Button>
              </div>
              {error ? (
                <section role="alert" className="space-y-3 rounded-lg border border-zinc-800 p-5">
                  <h2 className="font-medium">
                    {error instanceof PlatformClientError && error.status === 403
                      ? 'Workspace access denied'
                      : 'Unable to load workspace'}
                  </h2>
                  <p className="text-sm text-zinc-400">{error.message}</p>
                  <Button
                    variant="outline"
                    onClick={
                      error instanceof PlatformClientError && error.status === 401 ? () => void authenticate() : refresh
                    }
                  >
                    {error instanceof PlatformClientError && error.status === 401 ? 'Sign in' : 'Retry'}
                  </Button>
                  <a href="/workspaces" className="ml-4 text-sm underline underline-offset-4">
                    Choose a workspace
                  </a>
                </section>
              ) : null}
              {workspaces?.length === 0 ? (
                <section className="rounded-lg border border-zinc-800 p-6">
                  <h2 className="font-medium">No administered workspaces</h2>
                  <p className="mt-2 text-sm text-zinc-400">
                    Ask an existing workspace administrator to add your admitted platform identity as an administrator.
                  </p>
                </section>
              ) : null}
              {!error && props ? (
                <Suspense fallback={<Skeleton aria-label="Loading page" className="h-64" />}>
                  <div key={`${identity.humanId}:${workspaceId}:${section}`}>
                    {section === 'overview' ? <WorkspaceOverview detail={props.detail} revision={revision} /> : null}
                    {section === 'people' ? <WorkspacePeople {...props} /> : null}
                    {section === 'integrations' ? <WorkspaceClients {...props} /> : null}
                    {section === 'resources' ? <ResourceAccessPanel {...props} /> : null}
                    {section === 'connections' ? (
                      <WorkspaceProviderAccounts workspaceId={workspaceId!} principalId={identity.humanId} />
                    ) : null}
                    {section === 'requests' ? <WorkspaceAccessRequests {...props} /> : null}
                    {section === 'activity' ? <WorkspaceActivity detail={props.detail} /> : null}
                    {section === 'settings' ? <WorkspaceSettings detail={props.detail} /> : null}
                  </div>
                </Suspense>
              ) : !error && workspaceId ? (
                <Skeleton aria-label="Loading workspace" className="h-64" />
              ) : null}
            </div>
          </SidebarInset>
        </SidebarProvider>
      )}
    </div>
  )
}

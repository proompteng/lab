import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  ScrollArea,
  SidebarProvider,
  SidebarTrigger,
  Toaster,
} from '@proompteng/design/ui'
import { Link, useRouterState } from '@tanstack/react-router'
import * as React from 'react'
import { AppSidebar } from '@/components/app-sidebar'

export function AppShell({ mainId, children }: { mainId: string; children: React.ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  const breadcrumbs = buildBreadcrumbs(pathname, searchStr)
  const isFullscreen = pathname.endsWith('/fullscreen')

  React.useEffect(() => {
    document.documentElement.dataset.hydrated = 'true'
    return () => {
      delete document.documentElement.dataset.hydrated
    }
  }, [])

  if (isFullscreen) {
    return (
      <SidebarProvider>
        <div id={mainId} className="h-svh w-full overflow-hidden" tabIndex={-1}>
          {children}
        </div>
        <Toaster richColors position="top-right" />
      </SidebarProvider>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <div className="flex h-svh min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 items-center gap-3 border-b px-3">
          <SidebarTrigger />
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList>
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1
                return (
                  <React.Fragment key={crumb.to}>
                    <BreadcrumbItem>
                      {isLast ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                    {!isLast ? <BreadcrumbSeparator /> : null}
                  </React.Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div id={mainId} className="flex-1 min-h-0" tabIndex={-1}>
          <ScrollArea className="h-full">{children}</ScrollArea>
        </div>
      </div>
      <Toaster richColors position="top-right" />
    </SidebarProvider>
  )
}

const ROOT_LABELS = new Map<string, string>([
  ['/', 'Home'],
  ['/atlas', 'Atlas'],
  ['/atlas/search', 'Search'],
  ['/atlas/enrich', 'Enrich'],
  ['/atlas/indexed', 'Indexed'],
  ['/agents', 'Agents'],
  ['/control-plane', 'Control plane'],
  ['/control-plane/implementation-specs', 'Specs'],
  ['/control-plane/runs', 'Runs'],
  ['/codex', 'Codex'],
  ['/codex/search', 'Search'],
  ['/codex/runs', 'All runs'],
  ['/github/pulls', 'Pulls'],
  ['/torghut', 'Torghut'],
  ['/torghut/charts', 'Charts'],
  ['/torghut/symbols', 'Symbols'],
  ['/memories', 'Memories'],
  ['/mcp', 'MCP'],
])

const toTitle = (value: string) => value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())

const DEFAULT_PULLS_LIMIT = 25

const buildBreadcrumbs = (rawPath: string, rawSearch = '') => {
  const normalized = rawPath === '/' ? '/' : rawPath.replace(/\/$/, '')
  if (normalized === '/') return [{ label: ROOT_LABELS.get('/') ?? 'Home', to: '/' }]

  const segments = normalized.split('/').filter(Boolean)
  if (segments[0] === 'github' && segments[1] === 'pulls') {
    const basePath = '/github/pulls'
    const baseLabel = ROOT_LABELS.get(basePath) ?? 'Pulls'
    if (segments.length >= 5) {
      const [owner, repo, number] = [segments[2], segments[3], segments[4]]
      const label = `${owner}/${repo} #${number}`
      const pullsSearch = new URLSearchParams(rawSearch)
      pullsSearch.set('repository', `${owner}/${repo}`)
      if (!pullsSearch.get('limit')) {
        pullsSearch.set('limit', String(DEFAULT_PULLS_LIMIT))
      }
      const pullsTo = `${basePath}?${pullsSearch.toString()}`
      return [
        { label: baseLabel, to: pullsTo },
        { label, to: `/${segments.slice(0, 5).join('/')}` },
      ]
    }
    return [{ label: baseLabel, to: basePath }]
  }
  const crumbs = segments.map((segment, index) => {
    const to = `/${segments.slice(0, index + 1).join('/')}`
    const label = ROOT_LABELS.get(to) ?? toTitle(segment)
    return { label, to }
  })

  return crumbs.length > 0 ? crumbs : [{ label: ROOT_LABELS.get('/') ?? 'Home', to: '/' }]
}

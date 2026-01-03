import { Link, useRouterState } from '@tanstack/react-router'
import * as React from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'

export function AppShell({ mainId, children }: { mainId: string; children: React.ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const breadcrumbs = buildBreadcrumbs(pathname)

  React.useEffect(() => {
    document.documentElement.dataset.hydrated = 'true'
    return () => {
      delete document.documentElement.dataset.hydrated
    }
  }, [])

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
                  <BreadcrumbItem key={crumb.to}>
                    {isLast ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
                    )}
                    {!isLast ? <BreadcrumbSeparator /> : null}
                  </BreadcrumbItem>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="text-xs text-muted-foreground">Cmd/Ctrl + B</div>
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
  ['/codex', 'Codex'],
  ['/codex/runs', 'Runs'],
  ['/codex/runs/all', 'All runs'],
  ['/torghut', 'Torghut'],
  ['/torghut/visuals', 'Visuals'],
  ['/torghut/symbols', 'Symbols'],
  ['/memories', 'Memories'],
  ['/mcp', 'MCP'],
])

const toTitle = (value: string) => value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())

const buildBreadcrumbs = (rawPath: string) => {
  const normalized = rawPath === '/' ? '/' : rawPath.replace(/\/$/, '')
  if (normalized === '/') return [{ label: ROOT_LABELS.get('/') ?? 'Home', to: '/' }]

  const segments = normalized.split('/').filter(Boolean)
  const crumbs = segments.map((segment, index) => {
    const to = `/${segments.slice(0, index + 1).join('/')}`
    const label = ROOT_LABELS.get(to) ?? toTitle(segment)
    return { label, to }
  })

  return crumbs.length > 0 ? crumbs : [{ label: ROOT_LABELS.get('/') ?? 'Home', to: '/' }]
}

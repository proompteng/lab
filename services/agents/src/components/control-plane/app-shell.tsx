import { Link, useLocation } from '@tanstack/react-router'
import { BoxesIcon, ChevronRightIcon, Layers3Icon } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { findPrimitiveDefinition, primitiveRegistry } from '../../control-plane/registry'
import type { ControlPlanePrimitiveRegistryEntry } from '../../control-plane/primitive-registry.generated'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb'
import { Separator } from '../ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '../ui/sidebar'
import { TooltipProvider } from '../ui/tooltip'

type BreadcrumbEntry = {
  label: string
  to?: string
}

const groupedPrimitives = primitiveRegistry.reduce(
  (groups, entry) => {
    const category = entry.display.category
    groups[category] ??= []
    groups[category].push(entry)
    return groups
  },
  {} as Record<string, ControlPlanePrimitiveRegistryEntry[]>,
)

const breadcrumbEntries = (pathname: string): BreadcrumbEntry[] => {
  const segments = pathname.split('/').filter(Boolean)
  const entries: BreadcrumbEntry[] = [{ label: 'Primitives', to: '/primitives' }]
  if (segments[0] !== 'primitives') return entries

  const primitive = findPrimitiveDefinition(segments[1])
  if (primitive) {
    entries.push({
      label: primitive.display.label,
      to: `/primitives/${primitive.display.pathSegment}`,
    })
  }

  if (segments[2] === 'new') {
    entries.push({ label: 'New' })
  } else if (segments[2] && segments[3]) {
    entries.push({ label: segments[2], to: `/primitives/${segments[1]}` })
    entries.push({ label: segments[3] })
  }

  return entries
}

export function ControlPlaneShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const entries = breadcrumbEntries(location.pathname)

  return (
    <TooltipProvider delayDuration={150}>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <Link to="/primitives">
                    <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                      <BoxesIcon className="size-4" />
                    </div>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">Agents</span>
                      <span className="truncate text-xs text-muted-foreground">Control plane</span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            {Object.entries(groupedPrimitives).map(([category, entries]) => (
              <SidebarGroup key={category}>
                <SidebarGroupLabel>{category}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {entries.map((entry) => (
                      <SidebarMenuItem key={entry.kind}>
                        <SidebarMenuButton
                          asChild
                          isActive={location.pathname.startsWith(`/primitives/${entry.display.pathSegment}`)}
                          tooltip={entry.display.label}
                        >
                          <Link to="/primitives/$kind" params={{ kind: entry.display.pathSegment }}>
                            <Layers3Icon className="size-4" />
                            <span>{entry.display.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-vertical:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                {entries.map((entry, index) => (
                  <Fragment key={`${entry.label}-${index}`}>
                    {index > 0 ? <BreadcrumbSeparator className="hidden md:block" /> : null}
                    <BreadcrumbItem>
                      {entry.to && index < entries.length - 1 ? (
                        <BreadcrumbLink asChild>
                          <a href={entry.to}>{entry.label}</a>
                        </BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage>{entry.label}</BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <ChevronRightIcon className="ml-auto hidden size-4 text-muted-foreground sm:block" />
          </header>
          <main className="min-w-0 flex-1 bg-muted/20">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

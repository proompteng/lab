import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  BotIcon,
  BoxesIcon,
  CalendarClockIcon,
  CirclePlayIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HomeIcon,
  KeyRoundIcon,
  ListChecksIcon,
  NetworkIcon,
  PackageIcon,
  PlusIcon,
  PlugZapIcon,
  RadioIcon,
  SendIcon,
  ShieldCheckIcon,
  TerminalIcon,
  WalletCardsIcon,
  WorkflowIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { getPrimitiveGroups } from '../../control-plane/primitive-groups'
import { findPrimitiveDefinition } from '../../control-plane/registry'
import {
  AgentRunStatusFilter,
  parseAgentRunStatusSearch,
  serializeAgentRunStatusSearch,
  type AgentRunStatus,
} from './agent-run-status-filter'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb'
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
import { Button } from '../ui/button'
import { TooltipProvider } from '../ui/tooltip'

type BreadcrumbEntry = {
  label: string
  to?: string
  icon?: LucideIcon
}

type HeaderPrimaryAction = {
  label: string
  kind: string
}

const primitiveSidebarIcons: Record<string, LucideIcon> = {
  agent: BotIcon,
  'agent-provider': PlugZapIcon,
  'agent-run': CirclePlayIcon,
  'implementation-source': GitBranchIcon,
  'implementation-spec': FileTextIcon,
  'version-control-provider': GitPullRequestIcon,
  workspace: FolderIcon,
  orchestration: WorkflowIcon,
  'orchestration-run': ListChecksIcon,
  schedule: CalendarClockIcon,
  swarm: NetworkIcon,
  tool: WrenchIcon,
  'tool-run': TerminalIcon,
  signal: RadioIcon,
  'signal-delivery': SendIcon,
  memory: DatabaseIcon,
  artifact: PackageIcon,
  'approval-policy': ShieldCheckIcon,
  budget: WalletCardsIcon,
  'secret-binding': KeyRoundIcon,
}

const breadcrumbEntries = (pathname: string): BreadcrumbEntry[] => {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return [{ label: 'Home', icon: HomeIcon }]
  const entries: BreadcrumbEntry[] = [{ label: 'Home', to: '/', icon: HomeIcon }]
  if (segments[0] !== 'primitives') return entries

  entries.push({ label: 'Primitives', to: '/primitives' })

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

const isAgentRunListPath = (pathname: string) => {
  const segments = pathname.split('/').filter(Boolean)
  return segments.length === 2 && segments[0] === 'primitives' && segments[1] === 'agent-run'
}

const headerPrimaryAction = (pathname: string): HeaderPrimaryAction | null => {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) {
    return { label: 'AgentRun', kind: 'agent-run' }
  }
  if (segments[0] !== 'primitives' || !segments[1] || segments[2] === 'new') return null
  const primitive = findPrimitiveDefinition(segments[1])
  return primitive ? { label: 'New', kind: primitive.display.pathSegment } : null
}

export function ControlPlaneShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [sectionSegment, primitiveSegment] = location.pathname.split('/').filter(Boolean)
  const entries = breadcrumbEntries(location.pathname)
  const primaryAction = headerPrimaryAction(location.pathname)
  const showAgentRunStatusFilter = isAgentRunListPath(location.pathname)
  const selectedAgentRunStatuses = showAgentRunStatusFilter
    ? parseAgentRunStatusSearch((location.search as Record<string, unknown>).status)
    : []
  const sidebarGroups = getPrimitiveGroups()

  const updateAgentRunStatuses = (statuses: AgentRunStatus[]) => {
    const nextSearch: Record<string, unknown> = { ...(location.search as Record<string, unknown>) }
    const serialized = serializeAgentRunStatusSearch(statuses)
    if (serialized) {
      nextSearch.status = serialized
    } else {
      delete nextSearch.status
    }

    void navigate({
      to: '/primitives/$kind',
      params: { kind: 'agent-run' },
      search: nextSearch,
      replace: true,
    })
  }

  return (
    <TooltipProvider delayDuration={150}>
      <SidebarProvider>
        <Sidebar collapsible="icon" className="group-data-[side=left]:!border-r-0">
          <SidebarHeader>
            <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
              <SidebarMenu className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <SidebarMenuItem>
                  <SidebarMenuButton size="default" asChild>
                    <Link to="/">
                      <BoxesIcon />
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">Agents</span>
                      </div>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              <SidebarTrigger className="shrink-0" />
            </div>
          </SidebarHeader>
          <SidebarContent>
            {sidebarGroups.map((group) => (
              <SidebarGroup key={group.label} className="px-2 py-1">
                <SidebarGroupLabel className="h-6 px-2 text-[0.68rem] font-medium uppercase tracking-normal">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.entries.map((entry) => {
                      const PrimitiveIcon = primitiveSidebarIcons[entry.display.pathSegment] ?? BoxesIcon
                      return (
                        <SidebarMenuItem key={entry.kind}>
                          <SidebarMenuButton
                            asChild
                            isActive={sectionSegment === 'primitives' && primitiveSegment === entry.display.pathSegment}
                            size="sm"
                            tooltip={entry.display.label}
                            className="rounded-md bg-transparent hover:bg-sidebar-accent/60 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
                          >
                            <Link to="/primitives/$kind" params={{ kind: entry.display.pathSegment }}>
                              <PrimitiveIcon className="size-4" />
                              <span>{entry.display.label}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Breadcrumb className="min-w-0">
                <BreadcrumbList>
                  {entries.map((entry, index) => (
                    <BreadcrumbEntryView
                      key={`${entry.label}-${index}`}
                      entry={entry}
                      index={index}
                      entries={entries}
                    />
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {showAgentRunStatusFilter ? (
                <AgentRunStatusFilter
                  selectedStatuses={selectedAgentRunStatuses}
                  onSelectedStatusesChange={updateAgentRunStatuses}
                />
              ) : null}
              {primaryAction ? (
                <Button asChild size="sm">
                  <Link to="/primitives/$kind/new" params={{ kind: primaryAction.kind }}>
                    <PlusIcon data-icon="inline-start" />
                    {primaryAction.label}
                  </Link>
                </Button>
              ) : null}
            </div>
          </header>
          <main className="min-w-0 flex-1 bg-background">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function BreadcrumbEntryView({
  entry,
  index,
  entries,
}: {
  entry: BreadcrumbEntry
  index: number
  entries: BreadcrumbEntry[]
}) {
  const Icon = entry.icon
  const content = Icon ? (
    <>
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{entry.label}</span>
    </>
  ) : (
    entry.label
  )

  return (
    <Fragment>
      {index > 0 ? <BreadcrumbSeparator className="hidden md:block" /> : null}
      <BreadcrumbItem>
        {entry.to && index < entries.length - 1 ? (
          <BreadcrumbLink asChild>
            <a href={entry.to} aria-label={Icon ? entry.label : undefined}>
              {content}
            </a>
          </BreadcrumbLink>
        ) : (
          <BreadcrumbPage aria-label={Icon ? entry.label : undefined}>{content}</BreadcrumbPage>
        )}
      </BreadcrumbItem>
    </Fragment>
  )
}

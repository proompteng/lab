import {
  IconActivity,
  IconBrain,
  IconBriefcase,
  IconBroadcast,
  IconCalendar,
  IconChartCandle,
  IconChecklist,
  IconDatabase,
  IconGitPullRequest,
  IconHeart,
  IconHome,
  IconKey,
  IconList,
  IconMessages,
  IconPackage,
  IconRobot,
  IconRoute,
  IconSend,
  IconTerminal2,
  IconTimeline,
  IconTool,
  IconWallet,
} from '@tabler/icons-react'
import { Link, useRouterState } from '@tanstack/react-router'
import * as React from 'react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type AppNavItem = {
  to: string
  label: string
  icon: React.ComponentType
  children?: { to: string; label: string }[]
}

type TerminalSession = {
  id: string
  label: string
}

const appNav: AppNavItem[] = [
  { to: '/', label: 'Home', icon: IconHome },
  { to: '/memories', label: 'Memories', icon: IconBrain },
  { to: '/github/pulls', label: 'PR reviews', icon: IconGitPullRequest },
  {
    to: '/codex/runs',
    label: 'Codex runs',
    icon: IconList,
    children: [
      { to: '/codex/search', label: 'Search' },
      { to: '/codex/runs', label: 'All runs' },
    ],
  },
  { to: '/terminals', label: 'Terminals', icon: IconTerminal2 },
  {
    to: '/agents',
    label: 'Agent comms',
    icon: IconMessages,
    children: [{ to: '/agents/general', label: 'General' }],
  },
  {
    to: '/atlas',
    label: 'Atlas',
    icon: IconDatabase,
    children: [
      { to: '/atlas/search', label: 'Search' },
      { to: '/atlas/indexed', label: 'Indexed files' },
      { to: '/atlas/enrich', label: 'Enrichment' },
    ],
  },
]

const agentsControlNav = [
  { to: '/agents-control-plane', label: 'Overview', icon: IconRobot },
  { to: '/agents-control-plane/agents', label: 'Agents', icon: IconMessages },
  { to: '/agents-control-plane/agent-runs', label: 'Agent runs', icon: IconList },
  { to: '/agents-control-plane/agent-providers', label: 'Agent providers', icon: IconDatabase },
  { to: '/agents-control-plane/implementation-specs', label: 'Implementation specs', icon: IconBrain },
  { to: '/agents-control-plane/implementation-sources', label: 'Implementation sources', icon: IconGitPullRequest },
  { to: '/agents-control-plane/memories', label: 'Memories', icon: IconHeart },
  { to: '/agents-control-plane/tools', label: 'Tools', icon: IconTool },
  { to: '/agents-control-plane/tool-runs', label: 'Tool runs', icon: IconActivity },
  { to: '/agents-control-plane/approvals', label: 'Approvals', icon: IconChecklist },
  { to: '/agents-control-plane/budgets', label: 'Budgets', icon: IconWallet },
  { to: '/agents-control-plane/signals', label: 'Signals', icon: IconBroadcast },
  { to: '/agents-control-plane/signal-deliveries', label: 'Signal deliveries', icon: IconSend },
  { to: '/agents-control-plane/schedules', label: 'Schedules', icon: IconCalendar },
  { to: '/agents-control-plane/artifacts', label: 'Artifacts', icon: IconPackage },
  { to: '/agents-control-plane/workspaces', label: 'Workspaces', icon: IconBriefcase },
  { to: '/agents-control-plane/secret-bindings', label: 'Secret bindings', icon: IconKey },
  { to: '/agents-control-plane/orchestrations', label: 'Orchestrations', icon: IconRoute },
  { to: '/agents-control-plane/orchestration-runs', label: 'Orchestration runs', icon: IconTimeline },
] as const

const apiNav = [
  { to: '/api/models', label: 'Models', icon: IconRobot },
  { to: '/api/health', label: 'Health', icon: IconHeart },
] as const

const torghutNav = [
  { to: '/torghut/symbols', label: 'Symbols', icon: IconList },
  { to: '/torghut/visuals', label: 'Visuals', icon: IconChartCandle },
] as const

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { state: sidebarState } = useSidebar()
  const isCollapsed = sidebarState === 'collapsed'
  const [terminalSessions, setTerminalSessions] = React.useState<TerminalSession[]>([])

  React.useEffect(() => {
    let isMounted = true
    const loadTerminalSessions = async () => {
      try {
        const response = await fetch('/api/terminals')
        const payload = (await response.json().catch(() => null)) as
          | { ok: true; sessions: TerminalSession[] }
          | { ok: false; message?: string }
          | null

        if (!response.ok || !payload || !('ok' in payload) || !payload.ok) return
        if (isMounted) setTerminalSessions(payload.sessions ?? [])
      } catch {
        if (isMounted) setTerminalSessions([])
      }
    }

    void loadTerminalSessions()
    const handleRefresh = () => {
      void loadTerminalSessions()
    }
    window.addEventListener('terminals:refresh', handleRefresh)
    return () => {
      isMounted = false
      window.removeEventListener('terminals:refresh', handleRefresh)
    }
  }, [])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 p-0 border-b justify-center">
        <div
          className={[
            'flex h-12 w-full items-center overflow-hidden whitespace-nowrap',
            isCollapsed ? 'justify-center px-0' : 'px-2',
          ].join(' ')}
        >
          <span className="truncate text-xs font-medium">{isCollapsed ? 'J' : 'Jangar'}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>App</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {appNav.map((item) => {
                const isActive =
                  item.to === '/codex/runs'
                    ? pathname.startsWith('/codex')
                    : pathname === item.to || pathname.startsWith(`${item.to}/`)
                const children =
                  item.to === '/terminals' && terminalSessions.length > 0
                    ? terminalSessions.map((session) => ({
                        to: `/terminals/${session.id}`,
                        label: session.label || session.id,
                      }))
                    : item.children
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarNavButton
                      icon={item.icon}
                      isActive={isActive}
                      isCollapsed={isCollapsed}
                      label={item.label}
                      to={item.to}
                    />
                    {children ? (
                      <SidebarMenuSub>
                        {children.map((child) => (
                          <SidebarMenuSubItem key={child.to}>
                            <SidebarMenuSubButton render={<Link to={child.to} />} isActive={pathname === child.to}>
                              {child.label}
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    ) : null}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {agentsControlNav.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarNavButton
                    icon={item.icon}
                    isActive={pathname === item.to || pathname.startsWith(`${item.to}/`)}
                    isCollapsed={isCollapsed}
                    label={item.label}
                    to={item.to}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>API</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {apiNav.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarNavButton
                    icon={item.icon}
                    isActive={pathname === item.to}
                    isCollapsed={isCollapsed}
                    label={item.label}
                    to={item.to}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Torghut</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {torghutNav.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarNavButton
                    icon={item.icon}
                    isActive={pathname === item.to}
                    isCollapsed={isCollapsed}
                    label={item.label}
                    to={item.to}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

function SidebarNavButton({
  icon: Icon,
  isActive,
  isCollapsed,
  label,
  to,
}: {
  icon: React.ComponentType
  isActive: boolean
  isCollapsed: boolean
  label: string
  to: string
}) {
  const button = (
    <SidebarMenuButton
      isActive={isActive}
      className={isCollapsed ? 'justify-center' : undefined}
      render={<Link to={to} />}
    >
      <Icon />
      {isCollapsed ? null : <span>{label}</span>}
    </SidebarMenuButton>
  )

  if (!isCollapsed) return button

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right" align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useSidebar,
} from '@proompteng/design/ui'
import {
  IconActivity,
  IconBrain,
  IconChartCandle,
  IconChartLine,
  IconDatabase,
  IconFileText,
  IconGitPullRequest,
  IconHeart,
  IconHome,
  IconList,
  IconMessages,
  IconRobot,
  IconTerminal2,
} from '@tabler/icons-react'
import { Link, useRouterState } from '@tanstack/react-router'
import * as React from 'react'

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
  {
    to: '/library',
    label: 'Library',
    icon: IconFileText,
    children: [
      { to: '/library/whitepapers', label: 'Whitepapers' },
      { to: '/library/whitepapers/search', label: 'Semantic search' },
    ],
  },
]

const agentsStudioNav: AppNavItem = {
  to: '/control-plane/implementation-specs',
  label: 'Control plane',
  icon: IconRobot,
}
const controlPlaneNav: AppNavItem[] = [
  { to: '/control-plane/implementation-specs', label: 'Specs', icon: IconFileText },
  { to: '/control-plane/runs', label: 'Runs', icon: IconActivity },
  { to: '/control-plane/torghut/quant', label: 'Torghut Quant', icon: IconChartLine },
]

const apiNav = [
  { to: '/api/models', label: 'Models', icon: IconRobot },
  { to: '/api/health', label: 'Health', icon: IconHeart },
] as const

const torghutNav = [
  { to: '/torghut/symbols', label: 'Symbols', icon: IconList },
  { to: '/torghut/charts', label: 'Charts', icon: IconChartCandle },
  { to: '/torghut/trading', label: 'Trading', icon: IconChartLine },
] as const

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { state: sidebarState } = useSidebar()
  const isCollapsed = sidebarState === 'collapsed'
  const isControlPlaneRoute = pathname === '/control-plane' || pathname.startsWith('/control-plane/')
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
        {!isControlPlaneRoute ? (
          <SidebarGroup>
            <SidebarGroupLabel>App</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {appNav.map((item) => {
                  const children =
                    item.to === '/terminals' && terminalSessions.length > 0
                      ? terminalSessions.map((session) => ({
                          to: `/terminals/${session.id}`,
                          label: session.label || session.id,
                        }))
                      : item.children
                  const hasActiveChild = children?.some(
                    (child) => pathname === child.to || pathname.startsWith(`${child.to}/`),
                  )
                  const isActive = hasActiveChild
                    ? false
                    : item.to === '/codex/runs'
                      ? pathname.startsWith('/codex')
                      : pathname === item.to || pathname.startsWith(`${item.to}/`)
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
                              <SidebarMenuSubButton
                                render={<Link to={child.to} />}
                                isActive={pathname === child.to || pathname.startsWith(`${child.to}/`)}
                              >
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
        ) : null}

        <SidebarGroup>
          <SidebarGroupLabel>{isControlPlaneRoute ? 'Control plane' : 'Agents'}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {(isControlPlaneRoute ? controlPlaneNav : [agentsStudioNav]).map((item) => {
                const isActive = isControlPlaneRoute
                  ? item.to === '/control-plane'
                    ? pathname === item.to
                    : pathname === item.to || pathname.startsWith(`${item.to}/`)
                  : pathname === item.to || pathname.startsWith(`${item.to}/`)
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarNavButton
                      icon={item.icon}
                      isActive={isActive}
                      isCollapsed={isCollapsed}
                      label={item.label}
                      to={item.to}
                    />
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!isControlPlaneRoute ? (
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
        ) : null}

        {!isControlPlaneRoute ? (
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
        ) : null}
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
      title={isCollapsed ? label : undefined}
      aria-label={label}
      render={<Link to={to} aria-label={label} aria-current={isActive ? 'page' : undefined} />}
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

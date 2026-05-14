import { Link } from '@tanstack/react-router'
import { Bot, GitBranch, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '~/components/ui/sidebar'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { GatewaySnapshot } from '~/server/gateway'
import { cn } from '~/lib/utils'

const navItems = [
  { label: 'Agents', href: '/agents', icon: Bot },
  { label: 'Agent Runs', href: '/agent-runs', icon: SquareTerminal },
] as const

type NavHref = (typeof navItems)[number]['href']

export function GatewayFrame({
  active,
  snapshot: _snapshot,
  children,
}: {
  active: string
  snapshot: GatewaySnapshot
  children: ReactNode
}) {
  return (
    <TooltipProvider>
      <SidebarProvider
        className="min-h-screen bg-zinc-950 text-zinc-100"
        style={
          {
            '--sidebar-width': '14rem',
            '--sidebar-width-icon': '3rem',
          } as React.CSSProperties
        }
      >
        <GatewaySidebar active={active} />
        <SidebarInset id="main-content" className="min-w-0 bg-zinc-950">
          <div className="flex h-screen min-h-[720px] min-w-0 flex-col">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function GatewaySidebar({ active }: { active: string }) {
  return (
    <Sidebar collapsible="icon" className="border-zinc-900 bg-zinc-950">
      <SidebarHeader className="border-b border-zinc-900 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/agent-runs" />} size="lg" tooltip="Action Gateway">
              <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
                <GitBranch aria-hidden="true" />
              </div>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate font-semibold text-zinc-50">Action Gateway</span>
                <span className="truncate text-xs text-zinc-400">Agent authority</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarNavItem key={item.href} active={active === item.href} href={item.href} icon={<item.icon />}>
                  {item.label}
                </SidebarNavItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

export function SidebarNavItem({
  active,
  href,
  icon,
  children,
}: {
  active: boolean
  href: NavHref
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to={href} />}
        isActive={active}
        tooltip={String(children)}
        className={cn('text-zinc-400 hover:bg-zinc-900 hover:text-zinc-50', active && 'bg-zinc-900 text-zinc-50')}
      >
        {icon}
        <span>{children}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export { SidebarTrigger }

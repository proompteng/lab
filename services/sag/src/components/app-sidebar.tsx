import { Link } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import { AiSecurity02Icon } from '@hugeicons/core-free-icons'
import type * as React from 'react'

import { NavMain } from '~/components/nav-main'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '~/components/ui/sidebar'

export function AppSidebar({
  active,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  active: string
}) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/agent-runs" />} size="lg" tooltip="Action Gateway">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
                <HugeiconsIcon icon={AiSecurity02Icon} strokeWidth={2} />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Action Gateway</span>
                <span className="truncate text-xs">Agent authority</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain active={active} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

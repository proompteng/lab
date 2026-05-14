import { Link } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import { BotIcon, ComputerTerminalIcon } from '@hugeicons/core-free-icons'
import type * as React from 'react'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '~/components/ui/sidebar'

type NavItem = {
  title: string
  url: '/agents' | '/agent-runs'
  icon: React.ComponentProps<typeof HugeiconsIcon>['icon']
}

const items: NavItem[] = [
  {
    title: 'Agents',
    url: '/agents',
    icon: BotIcon,
  },
  {
    title: 'Agent Runs',
    url: '/agent-runs',
    icon: ComputerTerminalIcon,
  },
]

export function NavMain({ active }: { active: string }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Control</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.url}>
            <SidebarMenuButton render={<Link to={item.url} />} isActive={active === item.url} tooltip={item.title}>
              <HugeiconsIcon icon={item.icon} strokeWidth={2} />
              <span>{item.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

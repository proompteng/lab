import type { ReactNode } from 'react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
} from '@/components/ui/sidebar'

type AppLayoutProps = {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-screen min-w-0 overflow-hidden bg-slate-950 text-slate-50">
        <Sidebar collapsible="icon" className="border-r border-sidebar-border">
          <SidebarHeader className="flex items-start gap-3 px-6 py-3 text-left">
            <SidebarTrigger className="md:hidden" />
            <span className="text-sm font-semibold leading-tight uppercase">Jangar</span>
          </SidebarHeader>
          <SidebarContent className="px-2">
            <SidebarGroup>
              <SidebarGroupLabel>Platform</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive>
                      <a href="/">Chat</a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <a href="/work-orders">Work orders</a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="px-2 pb-4">
            <SidebarRail />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex min-h-screen w-full min-w-0 flex-1 flex-col bg-slate-950">
          <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 md:hidden">
            <SidebarTrigger />
            <span className="text-sm font-medium text-slate-100">Mission chat</span>
          </header>
          <main className="flex-1 overflow-hidden">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
}

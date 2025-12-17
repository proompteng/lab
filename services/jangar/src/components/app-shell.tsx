import type * as React from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

export function AppShell({ mainId, children }: { mainId: string; children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          <div className="text-xs text-muted-foreground">Cmd/Ctrl + B</div>
        </header>
        <div id={mainId} className="flex-1" tabIndex={-1}>
          {children}
        </div>
      </div>
    </SidebarProvider>
  )
}

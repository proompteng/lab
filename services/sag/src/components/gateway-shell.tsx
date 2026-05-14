import type { ReactNode } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from '~/components/ui/breadcrumb'
import { Separator } from '~/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '~/components/ui/sidebar'
import { AppSidebar } from '~/components/app-sidebar'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { GatewaySnapshot } from '~/server/gateway'

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
        style={
          {
            '--sidebar-width': 'calc(var(--spacing) * 56)',
            '--header-height': 'calc(var(--spacing) * 14)',
          } as React.CSSProperties
        }
      >
        <AppSidebar active={active} />
        <SidebarInset id="main-content">
          <div className="flex h-svh min-h-[720px] min-w-0 flex-col">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export function GatewayPageHeader({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center justify-between gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-sm font-medium">{title}</span>
                  {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
                </span>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 px-4">{action}</div> : null}
    </header>
  )
}

export { SidebarTrigger }

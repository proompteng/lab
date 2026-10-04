import { Fragment, type ReactNode } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import type { HugeiconsIconProps } from '@hugeicons/react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Separator } from '~/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '~/components/ui/sidebar'
import { AppSidebar } from '~/components/app-sidebar'
import { sidebarItems } from '~/components/navigation'
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

type BreadcrumbEntry = {
  label: string
  href?: string
}

export function GatewayPageHeader({
  title,
  detail,
  action,
  active,
  breadcrumbs,
}: {
  title: string
  detail?: string
  action?: ReactNode
  active?: string
  breadcrumbs?: BreadcrumbEntry[]
}) {
  const entries = breadcrumbs?.length ? breadcrumbs : [{ label: title }]
  const root =
    sidebarItems.find((item) => item.url === active) ?? sidebarItems.find((item) => item.title === entries[0]?.label)
  const iconOnly = entries.length === 1 && root?.title === entries[0]?.label

  return (
    <header className="flex h-(--header-height) shrink-0 items-center justify-between gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb>
          <BreadcrumbList>
            {(iconOnly ? [] : entries).map((entry, index) => {
              const current = index === entries.length - 1
              return (
                <Fragment key={`${entry.label}-${index}`}>
                  <BreadcrumbItem key={`${entry.label}-${index}`}>
                    {index === 0 && root ? <CrumbIcon icon={root.icon} /> : null}
                    <BreadcrumbPage>
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-xs font-medium">{entry.label}</span>
                        {current && detail ? (
                          <span className="truncate text-xs text-muted-foreground">{detail}</span>
                        ) : null}
                      </span>
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                  {!current ? <BreadcrumbSeparator key={`${entry.label}-${index}-separator`} /> : null}
                </Fragment>
              )
            })}
            {iconOnly && root ? (
              <BreadcrumbItem>
                <CrumbIcon icon={root.icon} />
              </BreadcrumbItem>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 px-4">{action}</div> : null}
    </header>
  )
}

function CrumbIcon({ icon }: { icon: HugeiconsIconProps['icon'] }) {
  return <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5 text-muted-foreground" />
}

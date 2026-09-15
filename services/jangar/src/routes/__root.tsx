import { createRootRoute, Outlet } from '@tanstack/react-router'
import React from 'react'
import { AppShell } from '@/components/app-shell'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const mainId = React.useId()

  return (
    <>
      <a
        href={`#${mainId}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-none focus:border focus:bg-card focus:px-3 focus:py-2 focus:text-xs"
      >
        Skip to content
      </a>
      <AppShell mainId={mainId}>
        <Outlet />
      </AppShell>
    </>
  )
}

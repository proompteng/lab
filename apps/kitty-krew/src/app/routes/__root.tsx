import type { QueryClient } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query'
import React from 'react'
import { CommandPalette } from '~/components/command-palette'
import type { AppRouter } from '~/server/routers/_app'

import '../main.css'

export interface RouterAppContext {
  trpc: TRPCOptionsProxy<AppRouter>
  queryClient: QueryClient
}

const TanStackRouterDevtools =
  process.env.NODE_ENV === 'production'
    ? () => null
    : React.lazy(() =>
        import('@tanstack/router-devtools').then((res) => ({
          default: res.TanStackRouterDevtools,
        })),
      )

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  shellComponent: RootDocument,
  head: () => ({
    links: [
      {
        rel: 'icon',
        href: '/favicon.ico',
      },
    ],
  }),
})

function RootComponent() {
  return (
    <>
      <div className="min-h-screen flex flex-col antialiased text-zinc-300 w-full">
        <CommandPalette />
        <Outlet />
      </div>
      <TanStackRouterDevtools position="bottom-left" />
      <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

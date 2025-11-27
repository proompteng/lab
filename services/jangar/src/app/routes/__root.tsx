import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { useId } from 'react'
import { AppLayout } from '@/components/app-layout'
import type { RouterContext } from '../router'
import stylesHref from '../styles.css?url'

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#0f172a' },
      { title: 'Jangar platform' },
    ],
    links: [{ rel: 'stylesheet', href: stylesHref }],
  }),
  component: RootDocument,
})

function RootDocument() {
  const { queryClient } = Route.useRouteContext()
  const mainId = useId()

  return (
    <html lang="en" data-theme="dark" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen w-screen overflow-hidden bg-slate-950 text-slate-50" suppressHydrationWarning>
        <QueryClientProvider client={queryClient}>
          <AppLayout>
            <main id={mainId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <Outlet />
            </main>
          </AppLayout>
          {import.meta.env.DEV ? (
            <>
              <TanStackRouterDevtools position="bottom-right" />
              <ReactQueryDevtools buttonPosition="bottom-left" />
            </>
          ) : null}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

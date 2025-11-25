import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { useId } from 'react'
import type { RouterContext } from '../router'
import tailwindHref from '../tailwind.css?url'

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#0f172a' },
      { title: 'Jangar mission console' },
    ],
    links: [{ rel: 'stylesheet', href: tailwindHref }],
  }),
  component: RootDocument,
})

function RootDocument() {
  const { queryClient } = Route.useRouteContext()
  const mainId = useId()

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-slate-950 text-slate-50" suppressHydrationWarning>
        <a className="sr-only focus:not-sr-only" href={`#${mainId}`}>
          Skip to content
        </a>
        <QueryClientProvider client={queryClient}>
          <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
            <main id={mainId} className="flex flex-1 flex-col gap-6">
              <Outlet />
            </main>
          </div>
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

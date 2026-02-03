import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { useId, useMemo, useState } from 'react'
import appCss from '../app/styles/app.css?url'
import { Toaster } from '@proompteng/design/ui'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'theme-color', content: '#0b1224' },
      { title: 'golink · internal links' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootDocument,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center text-zinc-100">
      <div className="rounded-full bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-300">404</div>
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="max-w-lg text-zinc-300">We couldn't find that route. Check the URL or return to the overview.</p>
      <div className="flex gap-3">
        <Link
          to="/"
          className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-lg shadow-cyan-500/30 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        >
          Go to overview
        </Link>
        <Link
          to="/admin"
          className="rounded-full border border-white/10 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-white/5 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        >
          Open admin
        </Link>
      </div>
    </div>
  )
}

function RootDocument() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } } }),
  )

  const year = useMemo(() => new Date().getFullYear(), [])
  const mainId = useId()

  return (
    <html lang="en" className="h-full">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-zinc-950 dark">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-zinc-900 rounded-md bg-zinc-800 px-3 py-2 ml-3 mt-3 inline-block"
        >
          Skip to content
        </a>
        <QueryClientProvider client={queryClient}>
          <div className="relative isolate overflow-hidden min-h-screen">
            <div className="relative z-10 flex min-h-screen flex-col">
              <header className="sticky top-0 backdrop-blur-md bg-zinc-950/70 border-b border-white/5">
                <div className="flex w-full max-w-6xl items-center justify-between px-10 py-4">
                  <nav className="flex items-center gap-3 text-sm h-8">
                    <Link to="/" className="uppercase text-cyan-300 text-2xl tracking-wider font-semibold">
                      golink
                    </Link>
                  </nav>
                </div>
              </header>
              <main id={mainId} className="flex-1">
                <div className="mx-auto w-full max-w-6xl p-4">
                  <Outlet />
                </div>
              </main>
              <footer className="border-t border-white/5 bg-zinc-950/80">
                <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4 text-xs text-zinc-400">
                  <span>© {year} ProomptEng - golink</span>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] uppercase tracking-wide text-zinc-300">
                    ready
                  </span>
                </div>
              </footer>
            </div>
          </div>
          <Toaster richColors position="top-right" />
          <ReactQueryDevtools buttonPosition="top-right" initialIsOpen={false} />
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[{ name: 'TanStack Router', render: <TanStackRouterDevtoolsPanel /> }]}
          />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

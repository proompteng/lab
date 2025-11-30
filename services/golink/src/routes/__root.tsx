import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { useId, useMemo, useState } from 'react'
import appCss from '../app/styles/app.css?url'
import { Toaster } from '../components/ui/sonner'

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
})

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
      <body className="min-h-screen bg-slate-950 text-slate-50">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-slate-900 rounded-md bg-slate-800 px-3 py-2 ml-3 mt-3 inline-block"
        >
          Skip to content
        </a>
        <QueryClientProvider client={queryClient}>
          <div className="relative isolate overflow-hidden min-h-screen">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(94,234,212,0.12),transparent_40%),radial-gradient(circle_at_80%_0%,rgba(129,140,248,0.16),transparent_35%),radial-gradient(circle_at_50%_80%,rgba(56,189,248,0.1),transparent_40%)]" />
            <div className="relative z-10 flex min-h-screen flex-col">
              <header className="sticky top-0 backdrop-blur-md bg-slate-950/70 border-b border-white/5">
                <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-400 via-indigo-500 to-violet-500 shadow-lg shadow-cyan-500/20"
                      aria-hidden
                    />
                    <div>
                      <p className="text-lg font-semibold tracking-tight">golink</p>
                      <p className="text-xs text-slate-400">Internal redirects & admin</p>
                    </div>
                  </div>
                  <nav className="flex items-center gap-3 text-sm">
                    <Link
                      to="/admin"
                      className="rounded-full px-3 py-2 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    >
                      Admin
                    </Link>
                    <Link
                      to="/"
                      className="rounded-full px-3 py-2 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    >
                      Overview
                    </Link>
                  </nav>
                </div>
              </header>
              <main id={mainId} className="flex-1">
                <div className="mx-auto w-full max-w-6xl px-6 py-10">
                  <Outlet />
                </div>
              </main>
              <footer className="border-t border-white/5 bg-slate-950/80">
                <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4 text-xs text-slate-400">
                  <span>© {year} ProomptEng – golink</span>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] uppercase tracking-wide text-slate-300">
                    cluster-local · host go
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

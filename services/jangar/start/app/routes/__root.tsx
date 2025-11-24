import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  ScrollRestoration,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { useId } from 'react'
import type { RouterContext } from '../router'
import '../styles.css'

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
  }),
  component: RootDocument,
})

function RootDocument() {
  const { queryClient } = Route.useRouteContext()
  const mainId = useId()

  return (
    <html lang="en" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href={`#${mainId}`}>
          Skip to content
        </a>
        <QueryClientProvider client={queryClient}>
          <div className="page-shell">
            <header className="top-bar">
              <div className="brand">
                <span className="brand-dot" aria-hidden="true" />
                <div>
                  <p className="brand-title">Jangar</p>
                  <p className="brand-subtitle">Mission console</p>
                </div>
              </div>
              <nav className="top-links" aria-label="Primary">
                <Link to="/" className="nav-link" preload="intent">
                  Missions
                </Link>
                <span className="nav-pill">Start</span>
              </nav>
            </header>
            <main id={mainId} className="page-body">
              <Outlet />
            </main>
            <footer className="page-footer">
              <p>Mock UI — data updates will arrive via SSE once JNG-070b lands.</p>
            </footer>
          </div>
          {import.meta.env.DEV ? (
            <>
              <TanStackRouterDevtools position="bottom-right" />
              <ReactQueryDevtools buttonPosition="bottom-left" />
            </>
          ) : null}
        </QueryClientProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

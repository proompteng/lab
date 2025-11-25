import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { useEffect, useId } from 'react'
import type { RouterContext } from '../router'
import '../tailwind.css'
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
  }),
  links: () => [
    { rel: 'preload', href: tailwindHref, as: 'style', crossOrigin: 'anonymous' },
    { rel: 'stylesheet', href: tailwindHref, crossOrigin: 'anonymous' },
  ],
  component: RootDocument,
})

function RootDocument() {
  const { queryClient } = Route.useRouteContext()
  const mainId = useId()
  const criticalStyle = `
    *,*::before,*::after{box-sizing:border-box;}
    html,body{background-color:#0f172a;color:#e2e8f0;margin:0;padding:0;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;}
    a{text-decoration:none;color:inherit;}
    html.no-transitions *,html.no-transitions{transition:none!important;}
  `

  useEffect(() => {
    const html = document.documentElement
    html.classList.remove('no-transitions')
  }, [])

  return (
    <html lang="en" data-theme="dark" className="no-transitions" suppressHydrationWarning>
      <head>
        <style>{criticalStyle}</style>
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

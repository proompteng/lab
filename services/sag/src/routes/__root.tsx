import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'theme-color', content: '#09090b' },
      { name: 'color-scheme', content: 'dark' },
      { title: 'Secure Action Gateway' },
    ],
    links: [{ rel: 'icon', href: 'data:,' }],
  }),
  component: RootDocument,
})

function RootDocument() {
  return (
    <html
      lang="en"
      data-sag-paint="guard"
      className="dark h-full bg-zinc-950 text-zinc-100 [color-scheme:dark]"
      style={{ backgroundColor: '#09090b', color: '#f4f4f5', colorScheme: 'dark' }}
    >
      <head>
        <style>
          {
            'html,body{background:#09090b;color:#f4f4f5;color-scheme:dark}html[data-sag-paint=guard] body{visibility:hidden}'
          }
        </style>
        <script
          dangerouslySetInnerHTML={{
            __html:
              'window.addEventListener("load",function(){document.documentElement.dataset.sagPaint="ready"},{once:true});setTimeout(function(){document.documentElement.dataset.sagPaint="ready"},2500);',
          }}
        />
        <HeadContent />
      </head>
      <body
        className="min-h-screen bg-zinc-950 text-zinc-100 antialiased"
        style={{ backgroundColor: '#09090b', color: '#f4f4f5' }}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-zinc-900 focus:px-3 focus:py-2 focus:text-sm focus:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        >
          Skip to content
        </a>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}

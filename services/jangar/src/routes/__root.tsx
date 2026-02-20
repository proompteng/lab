import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import React from 'react'
import { AppShell } from '@/components/app-shell'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
      },
      { title: 'Jangar API' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const mainId = React.useId()

  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased overflow-hidden">
        <a
          href={`#${mainId}`}
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-none focus:border focus:bg-card focus:px-3 focus:py-2 focus:text-xs"
        >
          Skip to content
        </a>
        <AppShell mainId={mainId}>{children}</AppShell>
        <Scripts />
      </body>
    </html>
  )
}

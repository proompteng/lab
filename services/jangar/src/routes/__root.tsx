import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import React from 'react'

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
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-slate-950 text-slate-100">
        <a href={`#${mainId}`} className="sr-only focus:not-sr-only">
          Skip to content
        </a>
        <div id={mainId} className="min-h-screen">
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  )
}

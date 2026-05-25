import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import '../index.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Synthesis' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="h-dvh overflow-hidden bg-[#f4f1ea] text-[#201c18]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

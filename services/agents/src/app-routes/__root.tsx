/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { ControlPlaneShell } from '../components/control-plane/app-shell'
import appCss from '../styles/app.css?url'

const faviconHref =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2318181b'/%3E%3Cpath d='M16 5 6 10v12l10 5 10-5V10L16 5Zm0 3.3 6.6 3.3L16 15l-6.6-3.4L16 8.3Zm-7 6 5.5 2.8v6.2L9 20.5v-6.2Zm14 0v6.2l-5.5 2.8v-6.2L23 14.3Z' fill='%23fafafa'/%3E%3C/svg%3E"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Agents Control Plane' },
      {
        name: 'description',
        content: 'Kubernetes-native control plane for Agents primitives.',
      },
    ],
    links: [
      { rel: 'icon', href: faviconHref },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <ControlPlaneShell>
        <Outlet />
      </ControlPlaneShell>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

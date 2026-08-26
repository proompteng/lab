import type { Metadata, Viewport } from 'next'

import Providers from '@/components/providers'

import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://proompteng.ai'),
  title: {
    default: 'Tengri MicroVM Desktop',
    template: '%s | Tengri',
  },
  description:
    'A private Firecracker development desktop with persistent files, real terminals, Codex, and localhost previews.',
  applicationName: 'Tengri',
  category: 'DeveloperApplication',
  keywords: ['Firecracker microVM', 'Codex', 'cloud development environment', 'AI agent', 'Kata Containers'],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    locale: 'en_US',
    siteName: 'Tengri',
    title: 'Tengri MicroVM Desktop',
    description: 'Your private Firecracker development desktop.',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'Tengri MicroVM Desktop' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tengri MicroVM Desktop',
    description: 'Your private Firecracker development desktop.',
    images: ['/opengraph-image'],
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: '/favicon.ico' }, { url: '/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.ico',
  },
  manifest: '/site.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#050914',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body className="dark antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}

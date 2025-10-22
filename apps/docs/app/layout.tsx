import '@/app/global.css'
import { RootProvider } from 'fumadocs-ui/provider'
import type { Metadata } from 'next'

const siteUrl = 'https://docs.proompteng.ai'
const siteTitle = 'proompteng documentation'
const siteDescription = 'Guides and references for implementing and operating the proompteng platform.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: '%s | proompteng documentation',
  },
  description: siteDescription,
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    siteName: siteTitle,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
  },
}

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}

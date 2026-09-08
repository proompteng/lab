import '@/app/global.css'
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'

const siteUrl = 'https://olden.proompteng.ai'
const siteTitle = 'Olden Era Wiki'
const siteDescription =
  'Unofficial player wiki for Heroes of Might and Magic: Olden Era factions, units, heroes, spells, strategy, and Early Access changes.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: '%s | Olden Era Wiki',
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

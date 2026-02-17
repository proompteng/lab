import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import Providers from '@/components/providers'
import './globals.css'

const WEBSITE_JSON_LD_ID = 'ld+json-website'
const PRODUCT_JSON_LD_ID = 'ld+json-product'
const FAQ_JSON_LD_ID = 'ld+json-faq'
const BREADCRUMB_JSON_LD_ID = 'ld+json-breadcrumb'

export const metadata: Metadata = {
  metadataBase: new URL('https://proompteng.ai'),
  title: {
    default: 'proompteng — AI Agent Control Plane for Teams',
    template: '%s | proompteng',
  },
  description:
    'proompteng is a practical AI agent control plane for teams, offering policy governance, run observability, and model routing from a single interface.',
  applicationName: 'proompteng',
  category: 'AI Agent Platform',
  keywords: [
    'ai agent control plane',
    'agent governance',
    'policy checks',
    'agent observability',
    'model routing',
    'llm routing',
    'self hosted ai agents',
    'ai agent ops',
  ],
  alternates: {
    canonical: '/',
    languages: {
      'en-US': '/',
    },
  },
  openGraph: {
    type: 'website',
    url: '/',
    locale: 'en_US',
    siteName: 'proompteng',
    title: 'proompteng — AI Agent Control Plane',
    description: 'Clear policy checks, observability, and model routing for AI agents.',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'proompteng AI agent control plane',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'proompteng — AI Agent Control Plane',
    description: 'Clear policy checks, observability, and model routing for AI agents.',
    images: ['/opengraph-image'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      noimageindex: false,
      'max-image-preview': 'large',
    },
  },
  icons: {
    icon: [{ url: '/favicon.ico' }, { url: '/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.ico',
  },
  manifest: '/site.webmanifest',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e10' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'proompteng',
    url: 'https://proompteng.ai',
    description: 'A practical control plane for AI agents with clear policies and observability.',
    publisher: {
      '@type': 'Organization',
      name: 'proompteng',
      url: 'https://proompteng.ai',
      logo: {
        '@type': 'ImageObject',
        url: 'https://proompteng.ai/favicon.svg',
      },
      contactPoint: [
        {
          '@type': 'ContactPoint',
          email: 'greg@proompteng.ai',
          contactType: 'sales',
          areaServed: 'Worldwide',
          availableLanguage: ['English'],
        },
      ],
    },
    potentialAction: {
      '@type': 'SearchAction',
      target: 'https://docs.proompteng.ai?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  }
  const productLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'proompteng',
    applicationCategory: 'AIPlatform',
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    url: 'https://proompteng.ai',
    description: 'Control plane for AI agents with policy checks, observability, and model routing.',
    downloadUrl: 'https://docs.proompteng.ai',
    softwareVersion: '1.0',
    featureList: ['Policy checks', 'Observability and replay', 'Model routing', 'Memory integrations'],
    creator: {
      '@type': 'Organization',
      name: 'proompteng',
      url: 'https://proompteng.ai',
      contactPoint: {
        '@type': 'ContactPoint',
        email: 'greg@proompteng.ai',
        contactType: 'sales',
      },
    },
  }
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: 'https://proompteng.ai',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Documentation',
        item: 'https://docs.proompteng.ai',
      },
    ],
  }
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'Does proompteng require a specific framework?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'No. It works with any language or framework.',
        },
      },
      {
        '@type': 'Question',
        name: 'Can I self-host it?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Yes. Self-hosted deployments are supported for teams that need them.',
        },
      },
    ],
  }
  return (
    <html lang="en" suppressHydrationWarning className="dark scroll-smooth">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@100..800&family=Space+Grotesk:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="dark antialiased">
        <Providers>
          <Script id={WEBSITE_JSON_LD_ID} type="application/ld+json" strategy="afterInteractive">
            {JSON.stringify(jsonLd)}
          </Script>
          <Script id={PRODUCT_JSON_LD_ID} type="application/ld+json" strategy="afterInteractive">
            {JSON.stringify(productLd)}
          </Script>
          <Script id={FAQ_JSON_LD_ID} type="application/ld+json" strategy="afterInteractive">
            {JSON.stringify(faqLd)}
          </Script>
          <Script id={BREADCRUMB_JSON_LD_ID} type="application/ld+json" strategy="afterInteractive">
            {JSON.stringify(breadcrumbLd)}
          </Script>
          {children}
        </Providers>
      </body>
    </html>
  )
}

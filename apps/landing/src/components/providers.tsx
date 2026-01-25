'use client'

import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { ThemeProvider } from 'next-themes'
import { type ReactNode, useMemo } from 'react'
import { Toaster } from '@/components/ui/sonner'

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL

export default function Providers({ children }: { children: ReactNode }) {
  const convexClient = useMemo(() => {
    if (!convexUrl) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('NEXT_PUBLIC_CONVEX_URL is not set; Convex queries will be disabled.')
      }
      return undefined
    }

    return new ConvexReactClient(convexUrl)
  }, [])

  const content = convexClient ? <ConvexProvider client={convexClient}>{children}</ConvexProvider> : children

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {content}
      <Toaster richColors closeButton />
    </ThemeProvider>
  )
}

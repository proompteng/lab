import type { Metadata } from 'next'

import TengriDesktop from '@/components/tengri/desktop'
import { TengriDesktopApplication } from '@/components/tengri/desktop-application'

export const metadata: Metadata = {
  title: 'Tengri MicroVM Desktop',
  description:
    'A private Firecracker microVM desktop for building software with Codex, persistent files, real terminals, and localhost previews.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Tengri MicroVM Desktop',
    description: 'Your private Firecracker development desktop.',
    url: '/',
    images: ['/opengraph-image'],
  },
  twitter: {
    title: 'Tengri MicroVM Desktop',
    description: 'Your private Firecracker development desktop.',
  },
}

export default function Home() {
  return <TengriDesktop Application={TengriDesktopApplication} />
}

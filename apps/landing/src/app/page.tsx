import type { Metadata } from 'next'
import DesktopOnboarding from '@/components/tengri/desktop-onboarding'

export const metadata: Metadata = {
  title: 'Tengri | Proompteng',
  description: 'Create and manage a private Firecracker agent workspace.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Tengri | Proompteng',
    description: 'Create and manage a private Firecracker agent workspace.',
    url: '/',
    images: ['/opengraph-image'],
  },
  twitter: {
    title: 'Tengri | Proompteng',
    description: 'Create and manage a private Firecracker agent workspace.',
  },
}

export default function Home() {
  return <DesktopOnboarding />
}

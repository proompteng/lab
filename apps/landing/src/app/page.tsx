import type { Metadata } from 'next'
import DesktopHero from '@/components/desktop-hero'

export const metadata: Metadata = {
  title: 'AI Agent Control Plane | Proompteng',
  description:
    'Build and govern AI agent systems with policy checks, run observability, and model routing in one secure control plane.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'AI Agent Control Plane | Proompteng',
    description: 'Policy-first control plane for teams running AI agents at scale.',
    url: '/',
    images: ['/opengraph-image'],
  },
  twitter: {
    title: 'AI Agent Control Plane | Proompteng',
    description: 'Policy-first control plane for teams running AI agents at scale.',
  },
}

export default function Home() {
  return <DesktopHero />
}

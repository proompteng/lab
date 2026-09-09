import type { Metadata } from 'next'
import DesktopHero from '@/components/desktop-hero'
import DesktopOnboarding from '@/components/tengri/desktop-onboarding'
import { isTengriAuthConfigured } from '@/lib/tengri/auth'
import { shouldRenderTengriDesktop } from '@/lib/tengri/desktop-gate'
import { isTengriControlPlaneConfigured } from '@/lib/tengri/grpc'
import { TENGRI_PRODUCT_IDENTITY } from '@/lib/tengri/product-identity'

export const dynamic = 'force-dynamic'

const publicMetadata: Metadata = {
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

const tengriMetadata: Metadata = {
  title: 'Tengri | Proompteng',
  description: TENGRI_PRODUCT_IDENTITY.description,
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Tengri | Proompteng',
    description: TENGRI_PRODUCT_IDENTITY.description,
    url: '/',
    images: [TENGRI_PRODUCT_IDENTITY.openGraphImage],
  },
  twitter: {
    title: 'Tengri | Proompteng',
    description: TENGRI_PRODUCT_IDENTITY.description,
    images: [TENGRI_PRODUCT_IDENTITY.openGraphImage],
  },
}

export function generateMetadata(): Metadata {
  return tengriAvailable() ? tengriMetadata : publicMetadata
}

export default function Home() {
  return tengriAvailable() ? <DesktopOnboarding /> : <DesktopHero />
}

function tengriAvailable() {
  return shouldRenderTengriDesktop(isTengriAuthConfigured(), isTengriControlPlaneConfigured())
}

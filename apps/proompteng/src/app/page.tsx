import Link from 'next/link'

import { MODEL_CATALOG, USE_CASES } from '@/app/config'
import BenefitsGrid from '@/components/benefits-grid'
import ClosingCta from '@/components/closing-cta'
import ContentCards from '@/components/content-cards'
import ControlPlaneOverview from '@/components/control-plane-overview'
import FaqList from '@/components/faq-list'
import FeatureShowcase from '@/components/feature-showcase'
import Hero from '@/components/hero'
import Metrics from '@/components/metrics'
import Navbar from '@/components/navbar'
import PlaybookTimeline from '@/components/playbook-timeline'
import SocialProof from '@/components/social-proof'
import Testimonial from '@/components/testimonial'

export default function Home() {
  const footerGroups = [
    {
      heading: 'product',
      links: [
        { label: 'platform', href: '#platform' },
        { label: 'governance', href: '#governance' },
        { label: 'playbook', href: '#playbook' },
      ],
    },
    {
      heading: 'resources',
      links: [
        {
          label: 'docs',
          href: 'https://docs.proompteng.ai',
          isExternal: true,
        },
        { label: 'changelog', href: '#' },
        { label: 'status', href: '#' },
      ],
    },
    {
      heading: 'company',
      links: [
        { label: 'careers', href: '#' },
        { label: 'security', href: '#' },
        { label: 'contact', href: 'mailto:greg@proompteng.ai' },
      ],
    },
  ] satisfies {
    heading: string
    links: { label: string; href: string; isExternal?: boolean }[]
  }[]

  return (
    <div className="font-sans">
      <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(129,140,248,0.12),_transparent_55%),radial-gradient(circle_at_bottom,_rgba(129,140,248,0.12),_transparent_40%)]">
        <div className="pointer-events-none absolute inset-0 -z-[1] bg-[radial-gradient(900px_600px_at_10%_-10%,rgba(165,180,252,0.18),transparent),radial-gradient(600px_400px_at_90%_120%,rgba(165,180,252,0.18),transparent)]" />
        <div className="relative mx-auto w-full max-w-6xl px-6 pb-16 sm:pb-24">
          <header>
            <Navbar />
          </header>
          <main className="flex flex-col gap-12 py-10 sm:gap-16 sm:py-16">
            <Hero />
            <ControlPlaneOverview />
            <SocialProof />
            <Metrics />
            <BenefitsGrid />
            <FeatureShowcase />
            <ContentCards sectionId="use-cases" title="enterprise ai agent use cases" items={USE_CASES} />
            <ContentCards sectionId="models" title="model catalog" items={MODEL_CATALOG} />
            <PlaybookTimeline />
            <Testimonial />
            <FaqList />
            <ClosingCta />
          </main>
          <footer className="mt-16 border-t border-border/60 pt-12 pb-10 text-sm text-muted-foreground sm:mt-24">
            <div className="grid gap-10 sm:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
              <div>
                <p className="text-lg font-semibold text-foreground">proompteng</p>
                <p className="mt-3 max-w-sm text-sm">
                  The open control plane for AI agents — security, observability, and model freedom without vendor
                  lock-in.
                </p>
              </div>
              {footerGroups.map(({ heading, links }) => (
                <div key={heading} className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.3em] text-foreground/70">{heading}</p>
                  <ul className="space-y-2">
                    {links.map((link) => (
                      <li key={link.label}>
                        <Link
                          className="transition hover:text-foreground"
                          href={link.href}
                          prefetch={!link.isExternal}
                          target={link.isExternal ? '_blank' : undefined}
                          rel={link.isExternal ? 'noreferrer' : undefined}
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-10 text-xs text-muted-foreground">
              © {new Date().getFullYear()} proompteng. Built for builders who need production-grade AI agents.
            </p>
          </footer>
        </div>
      </div>
    </div>
  )
}

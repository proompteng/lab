import { Button } from '@proompteng/design/ui'
import { ArrowRight } from 'lucide-react'
import type { LandingContent } from '@/app/config'

type ClosingCtaProps = LandingContent['closingCta']

export default function ClosingCta({
  kicker,
  heading,
  description,
  primaryCtaLabel,
  primaryCtaHref,
  secondaryCtaLabel,
  secondaryCtaHref,
  deRisk,
}: ClosingCtaProps) {
  return (
    <section className="relative isolate overflow-hidden rounded-3xl border bg-gradient-to-br from-primary to-primary/70 px-6 py-14 shadow-lg sm:px-12">
      <div className="absolute inset-0 -z-[1] bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.35),_transparent_55%)]" />
      <div className="mx-auto max-w-3xl text-center text-primary-foreground">
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-primary-foreground/80">{kicker}</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h2>
        <p className="mt-3 text-sm text-primary-foreground/80">{description}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" variant="secondary">
            <a href={primaryCtaHref} target="_blank" rel="noopener noreferrer">
              {primaryCtaLabel}
              <ArrowRight className="size-5" />
            </a>
          </Button>
          <Button asChild size="lg" variant="ghost" className="text-primary-foreground hover:bg-primary-foreground/10">
            <a href={secondaryCtaHref}>{secondaryCtaLabel}</a>
          </Button>
        </div>
        <p className="mt-4 text-xs uppercase tracking-[0.2em] text-primary-foreground/70">{deRisk}</p>
      </div>
    </section>
  )
}

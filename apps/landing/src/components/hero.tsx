import { Badge, Button } from '@proompteng/design/ui'
import { ArrowRight, Check, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import type { HeroContent } from '@/app/config'
import { cn } from '@/lib/utils'

const HERO_HEADING_ID = 'hero-heading'
const CTA_REASSURANCE_ID = 'cta-reassurance'

type HeroProps = {
  content: HeroContent
}

export default function Hero({ content }: HeroProps) {
  const reassuranceId = CTA_REASSURANCE_ID

  return (
    <section
      aria-labelledby="hero-heading"
      className="relative isolate overflow-hidden rounded-3xl border bg-card/80 px-6 py-16 text-center shadow-sm backdrop-blur sm:px-12"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-[1] overflow-hidden">
        <div className="absolute left-1/2 top-[-65%] h-[560px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,_rgba(129,140,248,0.07),_transparent_85%)] blur-[140px] opacity-55 animate-hero-glow" />
        <div
          className="absolute bottom-[-52%] right-[-26%] h-[520px] w-[640px] rounded-full bg-[radial-gradient(circle,_rgba(70,88,242,0.05),_transparent_84%)] blur-[160px] opacity-45 animate-hero-glow"
          style={{ animationDelay: '4s' }}
        />
      </div>

      <div className="mx-auto max-w-4xl">
        {content.announcement ? (
          <Link
            href={content.announcement.href}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/15 px-4 py-2 text-xs font-medium text-muted-foreground transition hover:border-border hover:text-foreground"
          >
            <Badge
              variant="outline"
              className="border-none bg-transparent px-2 py-0 text-[0.7rem] uppercase tracking-widest"
            >
              new
            </Badge>
            <span>{content.announcement.label}</span>
            <ChevronRight className="size-3.5" />
          </Link>
        ) : null}

        <h1 id={HERO_HEADING_ID} className="mt-6 text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
          {content.headline}
        </h1>
        <p className="mx-auto mt-4 max-w-3xl text-pretty text-base text-muted-foreground sm:text-xl">
          {content.subheadline}
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" aria-describedby={reassuranceId}>
            <a href={content.ctaHref} target="_blank" rel="noopener noreferrer">
              {content.ctaLabel}
              <ArrowRight className="size-5" />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href={content.secondaryCtaHref}>{content.secondaryCtaLabel}</a>
          </Button>
        </div>
        <p id={reassuranceId} className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
          {content.deRisk}
        </p>
      </div>

      <dl className="mx-auto mt-10 grid max-w-4xl grid-cols-1 gap-4 text-left sm:grid-cols-3">
        {content.highlights.map(({ title, description }) => (
          <div
            key={title}
            className="group relative rounded-2xl border bg-secondary/10 p-6 transition-colors hover:border-ring/40 hover:bg-secondary/20"
          >
            <div>
              <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Check className="size-4 text-primary" strokeWidth={2} />
                {title}
              </dt>
              <dd className="mt-2 text-sm text-muted-foreground">{description}</dd>
            </div>
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-x-6 bottom-0 h-px',
                'bg-gradient-to-r from-transparent via-ring/40 to-transparent opacity-0',
                'transition-opacity duration-300 group-hover:opacity-100',
              )}
            />
          </div>
        ))}
      </dl>
    </section>
  )
}

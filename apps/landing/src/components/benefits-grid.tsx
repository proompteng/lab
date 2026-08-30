import type { Benefit } from '@/app/config'
import InfoCard from '@/components/info-card'

const PLATFORM_SECTION_ID = 'platform'
const BENEFITS_HEADING_ID = 'benefits-heading'

type BenefitsGridProps = {
  kicker: string
  heading: string
  description: string
  items: Benefit[]
}

export default function BenefitsGrid({ kicker, heading, description, items }: BenefitsGridProps) {
  return (
    <section id={PLATFORM_SECTION_ID} aria-labelledby={BENEFITS_HEADING_ID} className="relative isolate">
      <div className="absolute inset-x-8 top-0 -z-[1] h-32 rounded-full bg-indigo-500/10 blur-3xl" />
      <div className="rounded-3xl border bg-card/70 px-6 py-12 shadow-sm backdrop-blur sm:px-10">
        <div className="mx-auto flex max-w-4xl flex-col items-center text-center sm:flex-row sm:items-start sm:text-left">
          <div className="sm:flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{kicker}</p>
            <h2 id={BENEFITS_HEADING_ID} className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              {heading}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">{description}</p>
          </div>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
          {items.map(({ icon, title, text }) => (
            <InfoCard key={title} icon={icon} title={title} text={text} />
          ))}
        </div>
      </div>
    </section>
  )
}

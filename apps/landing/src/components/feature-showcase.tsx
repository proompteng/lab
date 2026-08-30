import type { ShowcaseSection } from '@/app/config'
import InfoCard from '@/components/info-card'

type FeatureShowcaseProps = {
  sections: ShowcaseSection[]
}

export default function FeatureShowcase({ sections }: FeatureShowcaseProps) {
  return (
    <section className="space-y-16">
      {sections.map(({ id, kicker, heading, description, items }, index) => (
        <div key={id} id={id} className="rounded-3xl border bg-card/70 px-6 py-12 shadow-sm backdrop-blur sm:px-10">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center">
            <div className="max-w-xl">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{kicker}</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h2>
              <p className="mt-3 text-sm text-muted-foreground sm:text-base">{description}</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {items.map(({ icon, title, text }) => (
                <InfoCard
                  key={`${id}-${title}`}
                  icon={icon}
                  title={title}
                  text={text}
                  className={index % 2 === 0 ? undefined : 'lg:even:translate-y-6'}
                />
              ))}
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}

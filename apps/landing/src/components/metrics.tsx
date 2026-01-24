import type { Metric } from '@/app/config'

const METRICS_HEADING_ID = 'metrics-heading'

type MetricsProps = {
  kicker: string
  heading: string
  description: string
  items: Metric[]
}

export default function Metrics({ kicker, heading, description, items }: MetricsProps) {
  return (
    <section
      aria-labelledby={METRICS_HEADING_ID}
      className="rounded-3xl border bg-gradient-to-br from-secondary/60 via-secondary/20 to-secondary/60 px-6 py-12 shadow-sm backdrop-blur sm:px-10"
    >
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{kicker}</p>
        <h2 id={METRICS_HEADING_ID} className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {heading}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">{description}</p>
      </div>

      <dl className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {items.map(({ value, label, sublabel }) => (
          <div
            key={label}
            className="relative overflow-hidden rounded-2xl border bg-card/80 p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-ring/40 hover:shadow-md motion-reduce:transform-none"
          >
            <dt className="text-sm uppercase tracking-widest text-muted-foreground">{label}</dt>
            <dd className="mt-2 text-4xl font-semibold tracking-tight text-primary">{value}</dd>
            <p className="mt-3 text-sm text-muted-foreground">{sublabel}</p>
          </div>
        ))}
      </dl>
    </section>
  )
}

import type { PlaybookStep } from '@/app/config'

const PLAYBOOK_SECTION_ID = 'playbook'
const PLAYBOOK_HEADING_ID = 'playbook-heading'

type PlaybookTimelineProps = {
  kicker: string
  heading: string
  description: string
  steps: PlaybookStep[]
}

export default function PlaybookTimeline({ kicker, heading, description, steps }: PlaybookTimelineProps) {
  return (
    <section
      id={PLAYBOOK_SECTION_ID}
      aria-labelledby={PLAYBOOK_HEADING_ID}
      className="rounded-3xl border bg-card/70 px-6 py-12 shadow-sm backdrop-blur sm:px-10"
    >
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{kicker}</p>
        <h2 id={PLAYBOOK_HEADING_ID} className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {heading}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="relative mx-auto mt-10 max-w-3xl">
        <span aria-hidden className="absolute left-4 top-0 h-full w-px bg-border/60" />
        <ol className="space-y-10">
          {steps.map(({ title, description, timeframe, result }) => (
            <li key={title} className="relative list-none pl-12">
              <span className="absolute left-4 top-5 flex size-3 -translate-x-1/2 items-center justify-center rounded-full border-2 border-primary bg-primary" />
              <div className="rounded-2xl border bg-secondary/30 p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">{timeframe}</p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{description}</p>
                <p className="mt-3 text-sm font-medium text-primary">outcome: {result}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

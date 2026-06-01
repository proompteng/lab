import { mechanics } from '@/src/data/olden/mechanics'

export function MechanicsMatrix() {
  return (
    <div className="not-prose my-12 space-y-6">
      <section className="rounded-lg border border-fd-border bg-fd-card px-5 py-6 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">Decision matrix</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-normal text-fd-foreground">
          What to check before spending a turn
        </h2>
        <p className="mt-3 max-w-4xl text-base leading-7 text-fd-muted-foreground">
          These cards separate the useful question from the common mistake. Use them while planning a route, fight,
          build order, or hero commitment.
        </p>
      </section>

      <div className="olden-md-grid-cols-2 grid gap-5 md:grid-cols-2">
        {mechanics.map((mechanic, index) => (
          <section key={mechanic.name} className="rounded-lg border border-fd-border bg-fd-card">
            <div className="border-b border-fd-border px-5 py-5">
              <div className="flex items-center gap-3">
                <span className="rounded border border-fd-border bg-fd-muted px-2 py-1 text-xs font-semibold text-fd-muted-foreground">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3 className="text-lg font-semibold tracking-normal text-fd-foreground">{mechanic.name}</h3>
              </div>
              <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{mechanic.whyItMatters}</p>
            </div>

            <div className="olden-md-grid-cols-2 grid gap-0 md:grid-cols-2">
              <div className="olden-md-border-r px-5 py-4 md:border-r md:border-fd-border">
                <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">
                  Check before acting
                </p>
                <ul className="mt-3 space-y-3 text-sm leading-6 text-fd-foreground">
                  {mechanic.decisions.map((decision) => (
                    <li key={decision} className="flex gap-3">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-fd-primary" />
                      <span>{decision}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="olden-md-border-t-0 border-t border-fd-border px-5 py-4 md:border-t-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">Avoid</p>
                <ul className="mt-3 space-y-3 text-sm leading-6 text-fd-muted-foreground">
                  {mechanic.mistakes.map((mistake) => (
                    <li key={mistake} className="flex gap-3">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-fd-muted-foreground" />
                      <span>{mistake}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

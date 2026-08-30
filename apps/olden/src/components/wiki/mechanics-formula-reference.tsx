import { mechanicsFormulaEntries } from '@/src/data/olden/assets'

const focusLabels = ['Combat math', 'Chance caps', 'Terrain tempo', 'Build gates', 'Magic access', 'Law economy']

export function MechanicsFormulaReference() {
  return (
    <div className="not-prose my-14 space-y-10">
      <section className="rounded-lg border border-fd-border bg-fd-card px-5 py-6 sm:px-6">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">
            Rules that change play
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-normal text-fd-foreground">
            Concrete mechanics and combinations
          </h2>
          <p className="mt-3 text-base leading-7 text-fd-muted-foreground">
            Source-backed rules are grouped by the decision they change: fight breakpoints, morale/luck caps, native
            terrain, hero skill synergies, spell access, law-point economy, and set thresholds.
          </p>
        </div>

        <div className="olden-lg-grid-cols-3 mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {focusLabels.map((label) => (
            <div key={label} className="border-l-2 border-fd-primary/70 bg-fd-muted/30 px-3 py-2">
              <p className="text-sm font-medium text-fd-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="space-y-8">
        {mechanicsFormulaEntries.map((entry, index) => (
          <section key={entry.id} className="rounded-lg border border-fd-border bg-fd-card">
            <div className="olden-md-grid-cols-3 grid gap-6 border-b border-fd-border px-5 py-6 md:grid-cols-3 sm:px-6">
              <div className="olden-md-col-span-2 md:col-span-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded border border-fd-border bg-fd-muted px-2 py-1 text-xs font-semibold text-fd-muted-foreground">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">
                    Source-backed rule
                  </p>
                </div>
                <h3 className="mt-4 text-2xl font-semibold tracking-normal text-fd-foreground">{entry.title}</h3>
                <p className="mt-3 text-base leading-7 text-fd-muted-foreground">{entry.rule}</p>
              </div>

              <aside className="border-l-2 border-fd-primary/70 bg-fd-muted/25 px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">Decision check</p>
                <p className="mt-2 text-sm font-medium leading-6 text-fd-foreground">{entry.check}</p>
              </aside>
            </div>

            <div className="px-5 py-6 sm:px-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">How it shows up</p>
              <ul className="olden-md-grid-cols-2 mt-3 grid gap-3 md:grid-cols-2">
                {entry.examples.map((example) => (
                  <li key={example} className="flex gap-3 text-sm leading-6 text-fd-foreground">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-fd-primary" />
                    <span>{example}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

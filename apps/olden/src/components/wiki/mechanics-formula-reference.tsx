import { mechanicsFormulaEntries } from '@/src/data/olden/assets'

export function MechanicsFormulaReference() {
  return (
    <div className="not-prose my-8 space-y-4">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">Concrete mechanics and combinations</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          These are the source-backed rules that affect actual decisions: damage breakpoints, morale/luck caps, native
          terrain, skill synergies, spell access, law-point economy, and artifact-set thresholds.
        </p>
      </div>
      <div className="grid gap-3">
        {mechanicsFormulaEntries.map((entry) => (
          <section key={entry.id} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <h3 className="text-base font-semibold text-fd-foreground">{entry.title}</h3>
            <p className="mt-2 text-sm text-fd-muted-foreground">{entry.rule}</p>
            <p className="mt-3 text-sm font-medium text-fd-foreground">{entry.check}</p>
            <ul className="mt-3 grid gap-2 md:grid-cols-2">
              {entry.examples.map((example) => (
                <li key={example} className="rounded border border-fd-border bg-fd-muted/30 px-3 py-2 text-sm">
                  {example}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

import { mechanics } from '@/src/data/olden/mechanics'

export function MechanicsMatrix() {
  return (
    <div className="not-prose grid gap-3 md:grid-cols-2">
      {mechanics.map((mechanic) => (
        <section key={mechanic.name} className="rounded-lg border border-fd-border bg-fd-card p-4">
          <h3 className="text-base font-semibold text-fd-foreground">{mechanic.name}</h3>
          <p className="mt-2 text-sm text-fd-muted-foreground">{mechanic.whyItMatters}</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase text-fd-muted-foreground">Decision checks</p>
              <ul className="mt-2 space-y-1 text-sm text-fd-foreground">
                {mechanic.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-fd-muted-foreground">Common failures</p>
              <ul className="mt-2 space-y-1 text-sm text-fd-foreground">
                {mechanic.mistakes.map((mistake) => (
                  <li key={mistake}>{mistake}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}

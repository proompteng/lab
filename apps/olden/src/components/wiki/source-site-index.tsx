import { sourceSiteNavEntries } from '@/src/data/olden/assets'

export function SourceSiteIndex() {
  return (
    <div className="not-prose my-8 space-y-3">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">Source-site parity map</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          The wiki front door mirrors the useful public database surfaces: simulator, units, artefacts, sets, skills,
          laws, spells, heroes, classes, factions, objects, resources, and buildings.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {sourceSiteNavEntries.map((entry) => (
          <article key={entry.id} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-fd-foreground">{entry.label}</h3>
                <p className="mt-1 text-sm text-fd-muted-foreground">{entry.coverage}</p>
              </div>
              <a
                className="shrink-0 text-xs font-semibold text-fd-foreground underline decoration-fd-muted-foreground/60 underline-offset-2"
                href={entry.localHref}
              >
                Local
              </a>
            </div>
            <a
              className="mt-3 block truncate text-xs text-fd-muted-foreground underline decoration-fd-muted-foreground/50 underline-offset-2"
              href={entry.url}
            >
              {entry.url}
            </a>
          </article>
        ))}
      </div>
    </div>
  )
}

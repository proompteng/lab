import { buildingEntries } from '@/src/data/olden/encyclopedia'
import { townBuildBranches } from '@/src/data/olden/mechanics'

const factionAliases: Record<string, string[]> = {
  Temple: ['human'],
  Necropolis: ['undead'],
  Grove: ['nature'],
  Dungeon: ['dungeon'],
  Hive: ['demon'],
  Schism: ['unfrozen'],
}

const buildingRowsForFaction = (faction: string) => {
  const aliases = factionAliases[faction] ?? []
  return buildingEntries.filter((entry) => aliases.includes(entry.properties.Faction)).slice(0, 28)
}

export function TownBuildTree() {
  return (
    <div className="not-prose space-y-4">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">Town and building coverage</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          {buildingEntries.length} public building entries are indexed from the community building database. The branch
          notes below are build-tree decision guidance; use the linked entries for the current source snapshot.
        </p>
      </div>

      {townBuildBranches.map((branch) => {
        const rows = buildingRowsForFaction(branch.faction)

        return (
          <section key={branch.faction} className="rounded-lg border border-fd-border bg-fd-card">
            <div className="border-b border-fd-border p-4">
              <h3 className="text-base font-semibold text-fd-foreground">{branch.faction}</h3>
              <p className="mt-1 text-sm text-fd-muted-foreground">{branch.identity}</p>
            </div>
            <div className="olden-lg-grid-town grid gap-4 p-4 lg:grid-cols-[1fr_1.4fr]">
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-fd-muted-foreground">Opening priorities</p>
                  <ul className="mt-2 space-y-1 text-sm text-fd-foreground">
                    {branch.opening.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-fd-muted-foreground">Build branches</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {branch.branches.map((item) => (
                      <span
                        key={item}
                        className="rounded border border-fd-border bg-fd-muted/40 px-2 py-1 text-xs text-fd-foreground"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {rows.map((entry) => (
                  <a
                    key={entry.id}
                    className="grid grid-cols-[44px_1fr] gap-3 rounded border border-fd-border bg-fd-muted/30 p-2 text-sm transition hover:border-fd-primary/50"
                    href={entry.url}
                  >
                    {entry.image ? (
                      <img
                        className="h-11 w-11 object-contain"
                        src={entry.image}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="h-11 w-11 rounded bg-fd-muted" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-fd-foreground">{entry.name}</span>
                      <span className="text-xs text-fd-muted-foreground">Building source entry</span>
                    </span>
                  </a>
                ))}
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}

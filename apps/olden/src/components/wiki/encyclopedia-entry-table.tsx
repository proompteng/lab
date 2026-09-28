import type { EncyclopediaEntry } from '@/src/data/olden/schema'

type EncyclopediaEntryTableProps = {
  entries: EncyclopediaEntry[]
  title: string
  description: string
  groupBy?: string
  defaultOpenGroups?: number
  sourceLabel?: string
}

const propertyPriority = [
  'Faction',
  'Class',
  'Slot',
  'Rarity',
  'Effect',
  'Set',
  'Magic School',
  'Tier / Level',
  'Type',
  'Faction / Alignment',
  'Base Skill / Category',
  'Kind',
]

const normalizeGroup = (value: string | undefined) => (value && value.trim().length > 0 ? value : 'Other')

const shortDescription = (description: string) => description.replace(/\s+/g, ' ').replace(/ — /g, ' - ').trim()

const propertyEntries = (entry: EncyclopediaEntry) => {
  const known = propertyPriority
    .filter((key) => entry.properties[key])
    .map((key) => [key, entry.properties[key]] as const)
  const rest = Object.entries(entry.properties).filter(([key]) => !propertyPriority.includes(key))

  return [...known, ...rest]
}

export function EncyclopediaEntryTable({
  entries,
  title,
  description,
  groupBy,
  defaultOpenGroups = 4,
  sourceLabel = 'Source page',
}: EncyclopediaEntryTableProps) {
  const groups = Object.entries(
    entries.reduce<Record<string, EncyclopediaEntry[]>>((acc, entry) => {
      const groupName = normalizeGroup(groupBy ? entry.properties[groupBy] : undefined)
      acc[groupName] = [...(acc[groupName] ?? []), entry]
      return acc
    }, {}),
  ).sort(([a], [b]) => a.localeCompare(b))

  const visibleGroups = groups.length > 0 ? groups : [['All entries', entries] as const]

  return (
    <div className="not-prose my-10 space-y-6">
      <section className="rounded-lg border border-fd-border bg-fd-card px-5 py-6 sm:px-6">
        <div className="olden-md-flex-row olden-md-items-start olden-md-justify-between flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">Reference index</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-normal text-fd-foreground">{title}</h2>
            <p className="mt-3 text-base leading-7 text-fd-muted-foreground">{description}</p>
          </div>
          <div className="shrink-0 border-l-2 border-fd-primary/70 bg-fd-muted/30 px-4 py-3">
            <p className="text-2xl font-semibold text-fd-foreground">{entries.length}</p>
            <p className="text-xs font-semibold uppercase tracking-wide text-fd-muted-foreground">visible entries</p>
          </div>
        </div>
        <p className="mt-5 border-t border-fd-border pt-4 text-sm leading-6 text-fd-muted-foreground">
          Every row links back to the public source page used for the current snapshot.
        </p>
      </section>

      {visibleGroups.map(([groupName, rows], index) => (
        <details
          key={groupName}
          className="rounded-lg border border-fd-border bg-fd-card"
          open={index < defaultOpenGroups}
        >
          <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-fd-foreground">
            <span className="inline-flex w-full items-center justify-between gap-4">
              <span>{groupName}</span>
              <span className="rounded border border-fd-border bg-fd-muted px-2 py-1 text-xs text-fd-muted-foreground">
                {rows.length}
              </span>
            </span>
          </summary>
          <div className="overflow-x-auto border-t border-fd-border">
            <table className="min-w-[1080px] text-left text-sm">
              <thead className="bg-fd-muted/40 text-fd-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">Entry</th>
                  <th className="px-4 py-3 font-semibold">Properties</th>
                  <th className="px-4 py-3 font-semibold">Information</th>
                  <th className="px-4 py-3 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fd-border text-fd-muted-foreground">
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <td className="w-[260px] px-4 py-4 align-top">
                      <div className="flex items-center gap-3">
                        {entry.image ? (
                          <img
                            className="h-12 w-12 shrink-0 rounded border border-fd-border bg-fd-muted object-contain"
                            src={entry.image}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="h-12 w-12 shrink-0 rounded border border-fd-border bg-fd-muted" />
                        )}
                        <span className="font-medium text-fd-foreground">{entry.name}</span>
                      </div>
                    </td>
                    <td className="w-[300px] px-4 py-4 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {propertyEntries(entry).map(([key, value]) => (
                          <span key={key} className="rounded border border-fd-border bg-fd-muted/40 px-2 py-1">
                            <span className="text-fd-muted-foreground">{key}: </span>
                            <span className="text-fd-foreground">{value}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-[460px] px-4 py-4 align-top leading-6">
                      {shortDescription(entry.description)}
                    </td>
                    <td className="w-[160px] px-4 py-4 align-top">
                      <a
                        className="font-medium text-fd-foreground underline decoration-fd-muted-foreground/60 underline-offset-2"
                        href={entry.url}
                      >
                        {sourceLabel}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  )
}

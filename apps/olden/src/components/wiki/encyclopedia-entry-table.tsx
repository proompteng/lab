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
    <div className="not-prose space-y-4">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">{title}</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">{description}</p>
        <p className="mt-2 text-xs text-fd-muted-foreground">
          {entries.length} visible entries. Each row links back to the public source page used for the current snapshot.
        </p>
      </div>

      {visibleGroups.map(([groupName, rows], index) => (
        <details
          key={groupName}
          className="rounded-lg border border-fd-border bg-fd-card"
          open={index < defaultOpenGroups}
        >
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fd-foreground">
            {groupName} ({rows.length})
          </summary>
          <div className="overflow-x-auto border-t border-fd-border">
            <table className="min-w-[1080px] text-left text-xs">
              <thead className="bg-fd-muted/40 text-fd-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Entry</th>
                  <th className="px-3 py-2 font-semibold">Properties</th>
                  <th className="px-3 py-2 font-semibold">Information</th>
                  <th className="px-3 py-2 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fd-border text-fd-muted-foreground">
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <td className="w-[260px] px-3 py-3 align-top">
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
                    <td className="w-[300px] px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {propertyEntries(entry).map(([key, value]) => (
                          <span key={key} className="rounded border border-fd-border bg-fd-muted/40 px-2 py-1">
                            <span className="text-fd-muted-foreground">{key}: </span>
                            <span className="text-fd-foreground">{value}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-[460px] px-3 py-3 align-top">{shortDescription(entry.description)}</td>
                    <td className="w-[160px] px-3 py-3 align-top">
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

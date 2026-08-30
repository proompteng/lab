import { artifactReferences } from '@/src/data/olden/artifacts'
import { artifactDirectoryEntries } from '@/src/data/olden/encyclopedia'
import type { ArtifactReference } from '@/src/data/olden/schema'

const slotLabels: Record<string, string> = {
  back: 'Back',
  chest: 'Chest',
  feet: 'Feet',
  head: 'Head',
  items: 'Items',
  main_hand: 'Main hand',
  off_hand: 'Off hand',
  relics: 'Relics',
  rings: 'Rings',
  waist: 'Waist',
}

const rarityLabels: Record<ArtifactReference['rarity'], string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
}

const slotOrder = ['main_hand', 'off_hand', 'head', 'chest', 'back', 'waist', 'feet', 'rings', 'items', 'relics']

const normalizeSet = (set: string) => (set ? set.replaceAll('_', ' ') : '-')

const directoryByName = new Map(artifactDirectoryEntries.map((artifact) => [artifact.name.toLowerCase(), artifact]))

const useText = (artifact: ArtifactReference) => {
  const effect = artifact.effect.toLowerCase()

  if (effect.includes('movement') || effect.includes('speed')) {
    return 'Put it on the hero whose route or first combat action matters this turn.'
  }

  if (effect.includes('spell') || effect.includes('mana') || effect.includes('knowledge') || effect.includes('power')) {
    return 'Use on a caster or spell-support hero before fights where mana or spell scaling changes losses.'
  }

  if (effect.includes('attack') || effect.includes('damage') || effect.includes('heroic strike')) {
    return 'Move to the main fighter before dangerous fights, especially when it creates a kill breakpoint.'
  }

  if (
    effect.includes('defense') ||
    effect.includes('hp') ||
    effect.includes('resistance') ||
    effect.includes('taken')
  ) {
    return 'Use when survival lets an important stack absorb one more hit or protects a fragile army plan.'
  }

  if (effect.includes('morale') || effect.includes('luck') || effect.includes('initiative')) {
    return 'Use as army tempo support when extra turns, lucky damage, or first actions decide the fight.'
  }

  if (
    effect.includes('persuasion') ||
    effect.includes('gold') ||
    effect.includes('resource') ||
    effect.includes('dust')
  ) {
    return 'Treat as economy or diplomacy utility; it can sit on support unless the main hero needs the slot.'
  }

  return 'Evaluate by the next fight or route it changes, not by rarity alone.'
}

export function ArtifactReferenceTable() {
  const grouped = slotOrder
    .map((slot) => ({
      slot,
      rows: artifactReferences.filter((artifact) => artifact.slot === slot),
    }))
    .filter((group) => group.rows.length > 0)

  return (
    <div className="not-prose space-y-4">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">Artifact coverage</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          {artifactReferences.length} listed artifacts across {grouped.length} slots. Every row includes source imagery
          when available, slot, rarity, effect, set membership when known, and a practical assignment note.
        </p>
      </div>

      {grouped.map(({ slot, rows }) => (
        <details
          key={slot}
          className="rounded-lg border border-fd-border bg-fd-card"
          open={slotOrder.indexOf(slot) < 4}
        >
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fd-foreground">
            {slotLabels[slot] ?? slot} ({rows.length})
          </summary>
          <div className="overflow-x-auto border-t border-fd-border">
            <table className="min-w-[980px] text-left text-xs">
              <thead className="bg-fd-muted/40 text-fd-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Artifact / item</th>
                  <th className="px-3 py-2 font-semibold">Rarity</th>
                  <th className="px-3 py-2 font-semibold">Effect</th>
                  <th className="px-3 py-2 font-semibold">Set</th>
                  <th className="px-3 py-2 font-semibold">How to use</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fd-border text-fd-muted-foreground">
                {rows.map((artifact) => (
                  <tr key={artifact.id}>
                    <td className="px-3 py-2 font-medium text-fd-foreground">
                      <div className="flex items-center gap-3">
                        {directoryByName.get(artifact.name.toLowerCase())?.image ? (
                          <img
                            className="h-10 w-10 shrink-0 rounded border border-fd-border bg-fd-muted object-contain"
                            src={directoryByName.get(artifact.name.toLowerCase())?.image}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="h-10 w-10 shrink-0 rounded border border-fd-border bg-fd-muted" />
                        )}
                        <span>{artifact.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">{rarityLabels[artifact.rarity]}</td>
                    <td className="max-w-[360px] px-3 py-2">{artifact.effect}</td>
                    <td className="px-3 py-2 capitalize">{normalizeSet(artifact.set)}</td>
                    <td className="max-w-[320px] px-3 py-2">{useText(artifact)}</td>
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

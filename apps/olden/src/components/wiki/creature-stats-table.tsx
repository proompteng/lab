import { unitAssetEntries } from '@/src/data/olden/assets'
import { creatureStats } from '@/src/data/olden/creatures'
import type { CreatureFactionId, CreatureStat } from '@/src/data/olden/schema'

const factionLabels: Record<CreatureFactionId, string> = {
  temple: 'Temple',
  necropolis: 'Necropolis',
  grove: 'Grove',
  dungeon: 'Dungeon',
  hive: 'Hive',
  schism: 'Schism',
  neutral: 'Neutral',
}

const factionOrder: CreatureFactionId[] = ['temple', 'necropolis', 'grove', 'dungeon', 'hive', 'schism', 'neutral']

const unitAssetsById = new Map(unitAssetEntries.map((entry) => [entry.id, entry]))

const useText = (creature: CreatureStat) => {
  if (creature.attackType === 'Ranged Attack') {
    return 'Protect the stack, use initiative windows, and keep enemies away from melee contact.'
  }

  if (creature.attackType === 'Long Reach') {
    return 'Hit from the extra hex to avoid retaliation and punish blocked or slow targets.'
  }

  if (creature.movement === 'Flying') {
    return 'Use flight to block shooters, cross obstacles, or finish exposed high-value targets.'
  }

  if (creature.health >= 100 || creature.defense >= creature.attack + 4) {
    return 'Use as a durable line stack when a trade protects rarer damage or caster units.'
  }

  return 'Use when the damage, speed, and retaliation math make the trade cheaper than waiting.'
}

const formatAbilities = (creature: CreatureStat) =>
  creature.keyAbilities.length > 0 ? creature.keyAbilities.join(', ') : 'No unique listed ability'

export function CreatureStatsTable() {
  const grouped = factionOrder.map((faction) => ({
    faction,
    rows: creatureStats
      .filter((creature) => creature.faction === faction)
      .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name)),
  }))

  return (
    <div className="not-prose space-y-4">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">Creature stats coverage</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          {creatureStats.length} listed creatures across all factions and neutral stacks. Every row includes tier, type,
          attack profile, movement, health, damage, attack, defense, speed, initiative, morale, luck, growth, cost,
          experience, abilities, a source unit icon, source page link, and a gameplay-use note.
        </p>
      </div>

      {grouped.map(({ faction, rows }) => (
        <details key={faction} className="rounded-lg border border-fd-border bg-fd-card" open={faction !== 'neutral'}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fd-foreground">
            {factionLabels[faction]} ({rows.length})
          </summary>
          <div className="overflow-x-auto border-t border-fd-border">
            <table className="min-w-[1420px] text-left text-xs">
              <thead className="bg-fd-muted/40 text-fd-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Creature</th>
                  <th className="px-3 py-2 font-semibold">T</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">HP</th>
                  <th className="px-3 py-2 font-semibold">Dmg</th>
                  <th className="px-3 py-2 font-semibold">Atk</th>
                  <th className="px-3 py-2 font-semibold">Def</th>
                  <th className="px-3 py-2 font-semibold">Spd</th>
                  <th className="px-3 py-2 font-semibold">Init</th>
                  <th className="px-3 py-2 font-semibold">Morale/Luck</th>
                  <th className="px-3 py-2 font-semibold">Growth</th>
                  <th className="px-3 py-2 font-semibold">Cost</th>
                  <th className="px-3 py-2 font-semibold">Exp</th>
                  <th className="px-3 py-2 font-semibold">Abilities</th>
                  <th className="px-3 py-2 font-semibold">How to use</th>
                  <th className="px-3 py-2 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fd-border text-fd-muted-foreground">
                {rows.map((creature) => {
                  const asset = unitAssetsById.get(creature.id)

                  return (
                    <tr key={creature.id}>
                      <td className="px-3 py-2 font-medium text-fd-foreground">
                        <div className="flex items-center gap-3">
                          {asset?.image ? (
                            <img
                              className="h-11 w-11 shrink-0 rounded border border-fd-border bg-fd-muted object-contain"
                              src={asset.image}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="h-11 w-11 shrink-0 rounded border border-fd-border bg-fd-muted" />
                          )}
                          <span>{creature.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">{creature.tier}</td>
                      <td className="px-3 py-2">{creature.creatureType}</td>
                      <td className="px-3 py-2">
                        {creature.attackType}
                        <br />
                        {creature.movement}
                      </td>
                      <td className="px-3 py-2">{creature.health}</td>
                      <td className="px-3 py-2">{creature.damage}</td>
                      <td className="px-3 py-2">{creature.attack}</td>
                      <td className="px-3 py-2">{creature.defense}</td>
                      <td className="px-3 py-2">{creature.speed}</td>
                      <td className="px-3 py-2">{creature.initiative}</td>
                      <td className="px-3 py-2">
                        {creature.morale}/{creature.luck}
                      </td>
                      <td className="px-3 py-2">{creature.weeklyGrowth || '-'}</td>
                      <td className="px-3 py-2">{creature.cost}</td>
                      <td className="px-3 py-2">{creature.experience}</td>
                      <td className="max-w-[260px] px-3 py-2">{formatAbilities(creature)}</td>
                      <td className="max-w-[300px] px-3 py-2">{useText(creature)}</td>
                      <td className="px-3 py-2">
                        {asset ? (
                          <a
                            className="font-medium text-fd-foreground underline decoration-fd-muted-foreground/60 underline-offset-2"
                            href={asset.url}
                          >
                            Unit page
                          </a>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  )
}

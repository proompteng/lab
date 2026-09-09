import {
  artifactDirectoryEntries,
  buildingEntries,
  classEntries,
  combatObjectEntries,
  heroEntries,
  lawEntries,
  neutralObjectEntries,
  resourceEntries,
  skillEntries,
  spellEntries,
} from '@/src/data/olden/encyclopedia'
import { artifactReferences } from '@/src/data/olden/artifacts'
import { artifactSetEntries, sourceSiteNavEntries, unitAssetEntries } from '@/src/data/olden/assets'
import { creatureStats } from '@/src/data/olden/creatures'

const cards = [
  {
    title: 'Items & Artifacts',
    href: '/docs/items',
    count: `${artifactReferences.length} artifacts/items / ${artifactSetEntries.length} sets`,
    body: 'Every item slot, rarity, effect, set, practical assignment note, source icon, and set-combination threshold.',
  },
  {
    title: 'Creature Stats',
    href: '/docs/stats',
    count: `${creatureStats.length} creatures / ${unitAssetEntries.length} source icons`,
    body: 'Full visible stat lines with source unit art: tier, type, attack profile, HP, damage, attack, defense, speed, initiative, growth, cost, experience, and abilities.',
  },
  {
    title: 'Heroes',
    href: '/docs/heroes',
    count: `${heroEntries.length} heroes`,
    body: 'Faction, class, starting skills, specialty text, portrait source links, and gameplay role notes.',
  },
  {
    title: 'Towns & Build Trees',
    href: '/docs/towns-build-tree',
    count: `${buildingEntries.length} building entries`,
    body: 'Faction building entries plus practical economy, dwelling, magic, defense, and unique-mechanic branches.',
  },
  {
    title: 'Mechanics',
    href: '/docs/mechanics',
    count: 'route, combat, economy, magic',
    body: 'Turn structure, movement, scouting, neutral fights, focus, morale/luck, spell value, laws, map objects, and siege decisions.',
  },
  {
    title: 'Source Database Map',
    href: '/docs/source-database',
    count: `${sourceSiteNavEntries.length} source surfaces`,
    body: 'Direct parity map for simulator, units, artefacts, sets, skills, laws, spells, heroes, classes, factions, objects, resources, and buildings.',
  },
  {
    title: 'Spells, Skills, Laws',
    href: '/docs/reference/spells',
    count: `${spellEntries.length} spells / ${skillEntries.length} skills / ${lawEntries.length} laws`,
    body: 'The high-volume rules surfaces need searchable tables and source links, not vague advice.',
  },
]

export function EncyclopediaOverview() {
  const secondaryCounts = [
    `${classEntries.length} classes`,
    `${neutralObjectEntries.length + combatObjectEntries.length} map objects`,
    `${resourceEntries.length} resources`,
    `${artifactDirectoryEntries.length} source artifact rows`,
    `${artifactSetEntries.length} set combinations`,
  ]

  return (
    <div className="not-prose my-8 space-y-5">
      <div className="olden-xl-grid-cols-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <a
            key={card.href}
            className="rounded-lg border border-fd-border bg-fd-card p-4 transition hover:border-fd-primary/50 hover:bg-fd-muted/30"
            href={card.href}
          >
            <div className="text-sm font-semibold text-fd-foreground">{card.title}</div>
            <div className="mt-1 text-xs font-medium text-fd-muted-foreground">{card.count}</div>
            <p className="mt-3 text-sm text-fd-muted-foreground">{card.body}</p>
          </a>
        ))}
      </div>
      <div className="rounded-lg border border-fd-border bg-fd-muted/30 px-4 py-3 text-xs text-fd-muted-foreground">
        Additional indexed coverage: {secondaryCounts.join(' / ')}.
      </div>
    </div>
  )
}

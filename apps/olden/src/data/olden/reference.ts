import type { ReferenceCategory } from './schema'

const verification = {
  lastVerified: '2026-05-31',
  gameVersion: 'v0.80.16',
  sourceIds: ['official-wiki-main-page'],
}

export const referenceCategories = [
  {
    id: 'heroes',
    title: 'Heroes',
    gameplayUse: 'Choose the leader whose specialty, starting army, skills, and spell access match your map plan.',
    beginnerPriority: 'Learn one main hero per faction before ranking every hero.',
    verification,
  },
  {
    id: 'units',
    title: 'Units',
    gameplayUse:
      'Understand which stacks deal damage, absorb hits, block shooters, fly, retaliate well, or must be protected.',
    beginnerPriority: 'Track speed, initiative, ranged/melee role, retaliation risk, and growth cost.',
    verification,
  },
  {
    id: 'spells',
    title: 'Spells',
    gameplayUse: 'Convert hero mana into army preservation, tempo, burst damage, control, or map utility.',
    beginnerPriority: 'Learn when a buff or control spell saves more army than direct damage.',
    verification,
  },
  {
    id: 'skills',
    title: 'Skills',
    gameplayUse: 'Shape a hero into a scout, main fighter, economy support, spellcaster, or control piece.',
    beginnerPriority: 'Prefer skills that support the hero job you are already playing.',
    verification,
  },
  {
    id: 'laws',
    title: 'Laws',
    gameplayUse: 'Faction laws turn town development and faction identity into long-term bonuses.',
    beginnerPriority: 'Pick laws that reinforce your first-week plan instead of solving a problem you do not have.',
    verification,
  },
  {
    id: 'artifacts',
    title: 'Artifacts',
    gameplayUse: 'Artifacts alter combat math, movement, economy, spell access, and specialist strategies.',
    beginnerPriority: 'Value artifacts by the next two fights or map timings they unlock, not only rarity.',
    verification,
  },
  {
    id: 'buildings',
    title: 'Buildings',
    gameplayUse: 'Town buildings define creature growth, economy, magic, defense, and faction mechanics.',
    beginnerPriority: 'Do not delay core dwellings and economy for upgrades that cannot affect this week.',
    verification,
  },
  {
    id: 'map-objects',
    title: 'Map Objects',
    gameplayUse:
      'Map objects are the route puzzle: mines, dwellings, stat boosts, shrines, banks, roads, portals, and objectives.',
    beginnerPriority: 'Scout object chains and ask which one creates the next town, mine, level, or power spike.',
    verification,
  },
] satisfies ReferenceCategory[]

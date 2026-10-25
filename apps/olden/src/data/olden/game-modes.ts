import type { GameMode } from './schema'

const verification = {
  lastVerified: '2026-05-31',
  gameVersion: 'v0.80.16',
  sourceIds: ['steam-store-3105440'],
}

export const gameModes = [
  {
    id: 'campaign',
    name: 'Campaign',
    playerPromise:
      'Story missions teach Jadame, faction stakes, scripted objectives, and campaign-specific constraints.',
    goodFor: ['Learning core UI', 'Understanding the setting', 'Practicing fights with authored pressure'],
    watchOutFor: [
      'Scripts may change during Early Access',
      'Campaign strength does not always equal skirmish strength',
    ],
    verification,
  },
  {
    id: 'classic',
    name: 'Classic',
    playerPromise: 'The standard Heroes loop: many heroes, towns, mines, exploration, and a full strategic map race.',
    goodFor: ['Learning economy', 'Practicing scouting', 'Testing long-form faction plans'],
    watchOutFor: [
      'Too many side heroes can distract from the main route',
      'Bad first-week routing compounds for hours',
    ],
    verification,
  },
  {
    id: 'single-hero',
    name: 'Single Hero',
    playerPromise:
      'A focused mode where one hero carries the whole plan, reducing chain complexity and increasing fight importance.',
    goodFor: ['New players', 'PvP practice', 'Learning hero build consequences'],
    watchOutFor: [
      'Every lost movement point matters more',
      'A bad hero build is harder to cover with secondary heroes',
    ],
    verification,
  },
  {
    id: 'arena',
    name: 'Arena',
    playerPromise: 'Fast tactical battles that isolate combat decisions from the full economy game.',
    goodFor: ['Testing unit roles', 'Practicing spells', 'Learning initiative and retaliation'],
    watchOutFor: [
      'Arena does not teach town tempo or map economy',
      'Some builds are better in map games than in isolated fights',
    ],
    verification,
  },
  {
    id: 'scenario',
    name: 'Scenario',
    playerPromise: 'Hand-authored maps with self-contained objectives, pacing, and story hooks.',
    goodFor: [
      'Players who prefer authored challenges',
      'Learning unusual map constraints',
      'Testing specific factions',
    ],
    watchOutFor: [
      'Scenario assumptions can differ from random maps',
      'Read objectives before optimizing a generic route',
    ],
    verification,
  },
  {
    id: 'multiplayer',
    name: 'Multiplayer',
    playerPromise: 'Human opponents punish loose routing, slow turns, exposed heroes, and predictable combat plans.',
    goodFor: ['Competitive improvement', 'Learning tempo', 'Testing faction counters'],
    watchOutFor: ['Agree on timer, map, and restart etiquette first', 'Early Access balance and networking may change'],
    verification,
  },
  {
    id: 'map-editor',
    name: 'Map Editor',
    playerPromise: 'Create custom maps and scenarios for practice, challenge design, or community play.',
    goodFor: ['Building practice maps', 'Testing town layouts', 'Creating themed scenarios'],
    watchOutFor: ['Editor features are planned to improve during Early Access', 'Validate custom maps after patches'],
    verification,
  },
] satisfies GameMode[]

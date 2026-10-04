import type { RoadmapItem } from './schema'

const verification = {
  lastVerified: '2026-05-31',
  gameVersion: 'v0.80.16',
  sourceIds: ['ubisoft-roadmap-2026-05-28'],
}

export const roadmapItems = [
  {
    name: 'Teamplay mode',
    horizon: 'near-term',
    playerImpact: 'Coordinated multiplayer should become easier to organize and teach once team rules are first-class.',
    verification,
  },
  {
    name: 'Hero skill rebalance',
    horizon: 'near-term',
    playerImpact: 'Build orders and hero tier advice must be revisited after the rebalance lands.',
    verification,
  },
  {
    name: 'Random map generator improvements',
    horizon: 'near-term',
    playerImpact: 'Map templates and first-week scouting advice may change as generated layouts improve.',
    verification,
  },
  {
    name: 'Observer mode and replays',
    horizon: 'near-term',
    playerImpact: 'Replay review should make PvP learning, tournament coverage, and guide screenshots easier.',
    verification,
  },
  {
    name: 'Elite Class rework',
    horizon: 'near-term',
    playerImpact: 'Faction power spikes and hero development pages need a full refresh after this change.',
    verification,
  },
  {
    name: 'Matchmaking improvements',
    horizon: 'near-term',
    playerImpact: 'Competitive onboarding should become less dependent on external coordination.',
    verification,
  },
  {
    name: 'Underground terrain',
    horizon: 'early-access',
    playerImpact: 'Scouting, movement, and map-control pages need new routing rules once underground maps ship.',
    verification,
  },
  {
    name: 'Map editor improvements',
    horizon: 'early-access',
    playerImpact: 'Custom map guidance should expand as editor workflows stabilize.',
    verification,
  },
  {
    name: 'Ironman campaign mode',
    horizon: 'early-access',
    playerImpact: 'Campaign advice should include risk management and recovery-light routes.',
    verification,
  },
  {
    name: 'Completion of single-player campaign',
    horizon: 'long-term',
    playerImpact: 'Story and mission pages should expand act by act after the campaign is complete.',
    verification,
  },
  {
    name: 'Map sharing support',
    horizon: 'long-term',
    playerImpact: 'The wiki can maintain recommended community maps and learning scenarios once sharing is official.',
    verification,
  },
  {
    name: 'New PvE mode',
    horizon: 'long-term',
    playerImpact: 'A dedicated PvE section should be added when mode rules are public and playable.',
    verification,
  },
] satisfies RoadmapItem[]

export type SourceKind =
  | 'official-wiki'
  | 'steam'
  | 'ubisoft-news'
  | 'manual-verification'
  | 'community-database'
  | 'youtube-video'

export type WikiSource = {
  id: string
  kind: SourceKind
  title: string
  url: string
  license:
    | 'CC-BY-SA-4.0'
    | 'Steam Subscriber Agreement'
    | 'Ubisoft News Terms'
    | 'YouTube Terms'
    | 'Community Site Terms'
    | 'Original'
  retrievedAt: string
}

export type Verification = {
  lastVerified: string
  gameVersion: string
  sourceIds: string[]
}

export type FactionId = 'temple' | 'necropolis' | 'grove' | 'dungeon' | 'hive' | 'schism'

export type Faction = {
  id: FactionId
  name: string
  nativeTerrain: string
  identity: string
  beginnerFit: 'easy' | 'medium' | 'hard'
  playstyleTags: string[]
  strengths: string[]
  weaknesses: string[]
  firstWeek: string[]
  combatPlan: string[]
  counterplay: string[]
  coreQuestions: string[]
  verification: Verification
}

export type GameMode = {
  id: string
  name: string
  playerPromise: string
  goodFor: string[]
  watchOutFor: string[]
  verification: Verification
}

export type RoadmapItem = {
  name: string
  horizon: 'near-term' | 'early-access' | 'long-term'
  playerImpact: string
  verification: Verification
}

export type ReferenceCategory = {
  id: string
  title: string
  gameplayUse: string
  beginnerPriority: string
  verification: Verification
}

export type CreatureFactionId = FactionId | 'neutral'

export type CreatureStat = {
  id: string
  name: string
  faction: CreatureFactionId
  tier: number
  creatureType: string
  attackType: 'Melee Attack' | 'Ranged Attack' | 'Long Reach'
  movement: 'Ground' | 'Flying'
  health: number
  attack: number
  defense: number
  damage: string
  speed: number
  initiative: number
  morale: number
  luck: number
  weeklyGrowth: number
  cost: string
  experience: number
  keyAbilities: string[]
  sourceIds: string[]
}

export type ArtifactReference = {
  id: string
  name: string
  slot: string
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
  effect: string
  set: string
  sourceIds: string[]
}

export type EncyclopediaEntry = {
  id: string
  name: string
  description: string
  url: string
  image?: string
  properties: Record<string, string>
}

export type SourceSiteNavEntry = {
  id: string
  label: string
  url: string
  coverage: string
  localHref: string
}

export type UnitAssetEntry = EncyclopediaEntry

export type ArtifactSetItem = {
  name: string
  slot: string
  rarity: string
  url: string
  image?: string
}

export type ArtifactSetEntry = {
  id: string
  name: string
  url: string
  image: string
  items: ArtifactSetItem[]
  effects: string[]
  playPattern: string
  sourceIds: string[]
}

export type MechanicsFormulaEntry = {
  id: string
  title: string
  rule: string
  check: string
  examples: string[]
  sourceIds: string[]
}

export type VideoTranscriptAudit = {
  id: string
  title: string
  channel: string
  duration: string
  url: string
  focus: 'beginner' | 'early-game' | 'combat' | 'magic' | 'faction' | 'pitfalls'
  transcriptStatus: 'blocked-by-youtube-bot-check'
  sourceId: string
  gameplayTakeaway: string
}

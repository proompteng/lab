export type SourceKind = 'official-wiki' | 'steam' | 'ubisoft-news' | 'manual-verification'

export type WikiSource = {
  id: string
  kind: SourceKind
  title: string
  url: string
  license: 'CC-BY-SA-4.0' | 'Steam Subscriber Agreement' | 'Ubisoft News Terms' | 'Original'
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

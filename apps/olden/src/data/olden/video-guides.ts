import type { VideoTranscriptAudit } from './schema'

export const videoTranscriptAudits = [
  {
    id: 'vilestride-combat-beginners',
    title: 'A Beginners Guide To Combat In Heroes of Might and Magic Olden Era',
    channel: 'Vilestride',
    duration: '13:43',
    url: 'https://www.youtube.com/watch?v=kDIDRLUaNm8',
    focus: 'combat',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-vilestride-combat-beginners',
    gameplayTakeaway:
      'Treat combat as a loss-minimization puzzle: identify the stack that must act first, then plan blocks, retaliation, and spell timing around that stack.',
  },
  {
    id: 'norovo-beginners-guide',
    title: 'Heroes of Might and Magic: Olden Era Beginners Guide! Tips You Need to Know',
    channel: 'Norovo',
    duration: '26:13',
    url: 'https://www.youtube.com/watch?v=C2Myl00diYs',
    focus: 'beginner',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-norovo-beginners-guide',
    gameplayTakeaway:
      'New players should learn the map loop before memorizing every rule: scout, take mines, preserve core stacks, and avoid wandering turns.',
  },
  {
    id: 'frags-combat-system',
    title: 'Heroes of Might & Magic: Olden Era Combat System Explained in 5 Minutes!',
    channel: 'Frags of War',
    duration: '5:01',
    url: 'https://www.youtube.com/watch?v=Dg8BAKFGBRk',
    focus: 'combat',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-frags-combat-system',
    gameplayTakeaway:
      'Combat reference pages should emphasize initiative, speed, ranged penalties, retaliation, and focus abilities because those mechanics decide fight cost.',
  },
  {
    id: 'icon-early-game-start',
    title: 'Tips For A Strong Early Game Start In HEROES OF MIGHT AND MAGIC OLDEN ERA',
    channel: 'Ic0n Gaming',
    duration: '11:28',
    url: 'https://www.youtube.com/watch?v=LqhTAkHAUic',
    focus: 'early-game',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-icon-early-game-start',
    gameplayTakeaway:
      'Early-game pages should judge choices by first-week tempo: mines, dwellings, safe experience, and whether the main hero reaches stronger fights on time.',
  },
  {
    id: 'vilestride-magic',
    title: 'Everything You NEED To Know About Magic In Heroes of Might and Magic: Olden Era',
    channel: 'Vilestride',
    duration: '8:22',
    url: 'https://www.youtube.com/watch?v=nkD9ePyLsW0',
    focus: 'magic',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-vilestride-magic',
    gameplayTakeaway:
      'Magic guidance should distinguish army-saving buffs and control from direct damage, then tie spell value to mana, school access, and the next fight.',
  },
  {
    id: 'frags-things-i-wish',
    title: 'Things I Wish I Knew Before Playing Heroes of Might & Magic: Olden Era',
    channel: 'Frags of War',
    duration: '8:06',
    url: 'https://www.youtube.com/watch?v=2EEqZI0JrZk',
    focus: 'pitfalls',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-frags-things-i-wish',
    gameplayTakeaway:
      'Pitfall pages should warn against overvaluing shiny rewards, delayed mines, and fights that permanently damage the army for minor route value.',
  },
  {
    id: 'tenkiei-mistakes',
    title: '5 Mistakes to Avoid in Heroes of Might & Magic: Olden Era',
    channel: 'Tenkiei',
    duration: '23:36',
    url: 'https://www.youtube.com/watch?v=DolVmSYlKWU',
    focus: 'pitfalls',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-tenkiei-mistakes',
    gameplayTakeaway:
      'Mistake-focused guidance should be framed as checklists players can use before ending a turn, taking a fight, or committing scarce resources.',
  },
  {
    id: 'turin-temple-guide',
    title: 'Heroes of Might & Magic: Olden Era - Temple Faction Beginners Guide',
    channel: 'Turin',
    duration: '46:21',
    url: 'https://www.youtube.com/watch?v=eJo12rD5iGk',
    focus: 'faction',
    transcriptStatus: 'blocked-by-youtube-bot-check',
    sourceId: 'youtube-turin-temple-guide',
    gameplayTakeaway:
      'Faction pages should connect roster stats to a concrete plan, especially how Temple protects ranged damage, uses buffs, and converts stable growth into week-two power.',
  },
] satisfies VideoTranscriptAudit[]

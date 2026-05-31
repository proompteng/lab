import type { WikiSource } from './schema'

export const wikiSources = [
  {
    id: 'steam-store-3105440',
    kind: 'steam',
    title: 'Heroes of Might and Magic: Olden Era on Steam',
    url: 'https://store.steampowered.com/app/3105440/Heroes_of_Might_and_Magic_Olden_Era/',
    license: 'Steam Subscriber Agreement',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'official-wiki-main-page',
    kind: 'official-wiki',
    title: 'Heroes of Might and Magic: Olden Era Official Wiki - Main Page',
    url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Main_Page',
    license: 'CC-BY-SA-4.0',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'official-wiki-factions',
    kind: 'official-wiki',
    title: 'Heroes of Might and Magic: Olden Era Official Wiki - Factions',
    url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Factions',
    license: 'CC-BY-SA-4.0',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'official-wiki-units',
    kind: 'official-wiki',
    title: 'Heroes of Might and Magic: Olden Era Official Wiki - Units',
    url: 'https://wiki.hoodedhorse.com/Heroes_of_Might_and_Magic_Olden_Era/Units',
    license: 'CC-BY-SA-4.0',
    retrievedAt: '2026-05-31',
  },
  {
    id: 'ubisoft-roadmap-2026-05-28',
    kind: 'ubisoft-news',
    title: 'Heroes of Might and Magic: Olden Era Early Access Roadmap',
    url: 'https://news.ubisoft.com/en-au/article/78nufFYRzpa1Vcp1Y8LnNF/heroes-of-might-and-magic-olden-era-early-access-roadmap',
    license: 'Ubisoft News Terms',
    retrievedAt: '2026-05-31',
  },
] satisfies WikiSource[]

export const sourceIds = new Set(wikiSources.map((source) => source.id))

export const currentVerification = {
  lastVerified: '2026-05-31',
  gameVersion: 'v0.80.16',
  sourceIds: ['official-wiki-main-page', 'official-wiki-factions', 'steam-store-3105440'],
}

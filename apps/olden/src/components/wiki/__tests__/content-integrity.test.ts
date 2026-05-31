import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'

import { artifactReferences } from '@/src/data/olden/artifacts'
import {
  artifactSetEntries,
  mechanicsFormulaEntries,
  sourceSiteNavEntries,
  unitAssetEntries,
} from '@/src/data/olden/assets'
import { creatureStats } from '@/src/data/olden/creatures'
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
import { factions } from '@/src/data/olden/factions'
import { gameModes } from '@/src/data/olden/game-modes'
import { referenceCategories } from '@/src/data/olden/reference'
import { roadmapItems } from '@/src/data/olden/roadmap'
import { sourceIds, wikiSources } from '@/src/data/olden/sources'
import { videoTranscriptAudits } from '@/src/data/olden/video-guides'
import {
  sourceNoteClassNames,
  sourceNoteItemStyles,
  sourceNoteListStyles,
  sourceNoteStyles,
} from '@/src/components/wiki/source-note'

const contentRoot = join(import.meta.dir, '../../../../content/docs')
const publicRoot = join(import.meta.dir, '../../../../public')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const mdxFiles = () => walk(contentRoot).filter((candidate) => candidate.endsWith('.mdx'))

const pagePath = (path: string) => relative(contentRoot, path).replaceAll('\\', '/')

describe('Olden Era wiki data', () => {
  it('registers exactly the six Early Access factions', () => {
    expect(factions.map((faction) => faction.id).sort()).toEqual([
      'dungeon',
      'grove',
      'hive',
      'necropolis',
      'schism',
      'temple',
    ])
  })

  it('uses valid source ids for structured data', () => {
    const sourceLists = [
      ...factions.map((faction) => faction.verification.sourceIds),
      ...gameModes.map((mode) => mode.verification.sourceIds),
      ...referenceCategories.map((category) => category.verification.sourceIds),
      ...roadmapItems.map((item) => item.verification.sourceIds),
      ...creatureStats.map((creature) => creature.sourceIds),
      ...artifactReferences.map((artifact) => artifact.sourceIds),
      ...artifactSetEntries.map((set) => set.sourceIds),
      ...mechanicsFormulaEntries.map((mechanic) => mechanic.sourceIds),
      ...videoTranscriptAudits.map((video) => [video.sourceId]),
    ]

    for (const ids of sourceLists) {
      expect(ids.length).toBeGreaterThan(0)
      for (const sourceId of ids) {
        expect(sourceIds.has(sourceId)).toBe(true)
      }
    }
  })

  it('records retrieval dates and URLs for every source', () => {
    for (const source of wikiSources) {
      expect(source.url).toMatch(/^https:\/\//)
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('keeps exhaustive creature stat rows renderable and sourced', () => {
    expect(creatureStats.length).toBeGreaterThanOrEqual(140)

    for (const creature of creatureStats) {
      expect(creature.name).toBeTruthy()
      expect(creature.tier).toBeGreaterThanOrEqual(1)
      expect(creature.health).toBeGreaterThan(0)
      expect(creature.damage).toMatch(/^\d+-\d+$/)
      expect(creature.attack).toBeGreaterThanOrEqual(0)
      expect(creature.defense).toBeGreaterThanOrEqual(0)
      expect(creature.speed).toBeGreaterThan(0)
      expect(creature.initiative).toBeGreaterThan(0)
      expect(creature.cost).toBeTruthy()
      expect(creature.sourceIds.length).toBeGreaterThan(0)
    }
  })

  it('keeps artifact effect rows renderable and sourced', () => {
    expect(artifactReferences.length).toBeGreaterThanOrEqual(150)

    for (const artifact of artifactReferences) {
      expect(artifact.name).toBeTruthy()
      expect(artifact.slot).toBeTruthy()
      expect(artifact.effect).toBeTruthy()
      expect(['common', 'rare', 'epic', 'legendary']).toContain(artifact.rarity)
      expect(artifact.sourceIds.length).toBeGreaterThan(0)
    }
  })

  it('keeps the high-volume encyclopedia rows visible from source snapshots', () => {
    expect(artifactDirectoryEntries.length).toBeGreaterThanOrEqual(150)
    expect(artifactSetEntries.length).toBeGreaterThanOrEqual(24)
    expect(unitAssetEntries.length).toBeGreaterThanOrEqual(144)
    expect(sourceSiteNavEntries.length).toBeGreaterThanOrEqual(14)
    expect(mechanicsFormulaEntries.length).toBeGreaterThanOrEqual(7)
    expect(heroEntries.length).toBeGreaterThanOrEqual(50)
    expect(skillEntries.length).toBeGreaterThanOrEqual(90)
    expect(lawEntries.length).toBeGreaterThanOrEqual(190)
    expect(spellEntries.length).toBeGreaterThanOrEqual(90)
    expect(classEntries.length).toBeGreaterThanOrEqual(12)
    expect(buildingEntries.length).toBeGreaterThanOrEqual(190)
    expect(neutralObjectEntries.length).toBeGreaterThanOrEqual(50)
    expect(combatObjectEntries.length).toBeGreaterThanOrEqual(20)
    expect(resourceEntries.length).toBeGreaterThanOrEqual(7)

    for (const entry of [
      ...artifactDirectoryEntries,
      ...heroEntries,
      ...skillEntries,
      ...lawEntries,
      ...spellEntries,
      ...classEntries,
      ...buildingEntries,
      ...neutralObjectEntries,
      ...combatObjectEntries,
      ...resourceEntries,
      ...unitAssetEntries,
    ]) {
      expect(entry.name).toBeTruthy()
      expect(entry.description).toBeTruthy()
      expect(entry.url).toMatch(/^https:\/\//)
    }

    for (const set of artifactSetEntries) {
      expect(set.name).toBeTruthy()
      expect(set.url).toMatch(/^https:\/\//)
      expect(set.image).toMatch(/^https:\/\//)
      expect(set.items.length).toBeGreaterThan(0)
      expect(set.effects.length).toBeGreaterThan(0)
      expect(set.playPattern).toBeTruthy()
    }
  })
})

describe('Olden Era wiki components', () => {
  it('keeps source notes compact and readable on the dark docs surface', () => {
    expect(sourceNoteClassNames.aside).toContain('px-3')
    expect(sourceNoteClassNames.aside).toContain('py-2')
    expect(sourceNoteClassNames.aside).toContain('overflow-x-auto')
    expect(sourceNoteClassNames.aside).toContain('whitespace-nowrap')
    expect(sourceNoteClassNames.list).toContain('whitespace-nowrap')
    expect(sourceNoteClassNames.item).toContain('whitespace-nowrap')
    expect(sourceNoteClassNames.label).toContain('text-zinc-200')
    expect(sourceNoteClassNames.link).toContain('text-zinc-100')
    expect(sourceNoteClassNames.meta).toContain('text-zinc-500')
    expect(sourceNoteStyles.backgroundColor).toBe('#09090b')
    expect(sourceNoteStyles.borderColor).toBe('#27272a')
    expect(sourceNoteListStyles.display).toBe('inline')
    expect(sourceNoteListStyles.whiteSpace).toBe('nowrap')
    expect(sourceNoteItemStyles.display).toBe('inline')
    expect(sourceNoteItemStyles.whiteSpace).toBe('nowrap')

    for (const className of Object.values(sourceNoteClassNames)) {
      expect(className).not.toContain('dark:')
      expect(className).not.toContain('bg-fd-card')
      expect(className).not.toContain('bg-zinc-50')
      expect(className).not.toContain('text-fd-foreground')
      expect(className).not.toContain('text-zinc-900')
      expect(className).not.toContain('text-zinc-950')
    }
  })
})

describe('Olden Era MDX content', () => {
  it('has title and description frontmatter on every page', () => {
    for (const path of mdxFiles()) {
      const content = readFileSync(path, 'utf8')
      expect(content).toMatch(/^---\ntitle: .+\ndescription: .+\n---/m)

      const descriptionLine = content.match(/^description: (.+)$/m)?.[1] ?? ''
      const descriptionIsQuoted = /^['"].*['"]$/.test(descriptionLine)
      expect(descriptionIsQuoted || !descriptionLine.includes(': ')).toBe(true)
    }
  })

  it('contains the required gameplay sections', () => {
    const pages = new Set(mdxFiles().map(pagePath))
    for (const requiredPage of [
      'getting-started/index.mdx',
      'getting-started/first-week.mdx',
      'fundamentals/combat.mdx',
      'fundamentals/economy.mdx',
      'fundamentals/movement.mdx',
      'factions/index.mdx',
      'factions/temple.mdx',
      'factions/necropolis.mdx',
      'factions/grove.mdx',
      'factions/dungeon.mdx',
      'factions/hive.mdx',
      'factions/schism.mdx',
      'reference/index.mdx',
      'reference/units.mdx',
      'reference/artifacts.mdx',
      'items.mdx',
      'stats.mdx',
      'heroes.mdx',
      'sets.mdx',
      'towns-build-tree.mdx',
      'mechanics.mdx',
      'source-database.mdx',
      'strategy/index.mdx',
      'meta/legal.mdx',
      'meta/sources.mdx',
      'meta/video-transcript-audit.mdx',
    ]) {
      expect(pages.has(requiredPage)).toBe(true)
    }
  })

  it('references committed visual assets from MDX pages', () => {
    const imageReferences = mdxFiles().flatMap((path) => {
      const content = readFileSync(path, 'utf8')
      return [...content.matchAll(/src="([^"]+)"/g)].map((match) => ({
        path,
        src: match[1],
      }))
    })

    expect(imageReferences.map((reference) => reference.src)).toEqual(
      expect.arrayContaining([
        '/visuals/generated/olden-complete-wiki-hero.png',
        '/visuals/generated/olden-artifact-inventory.png',
        '/visuals/generated/olden-creature-bestiary.png',
        '/visuals/generated/olden-hero-roster.png',
        '/visuals/generated/olden-mechanics-map.png',
        '/visuals/generated/olden-town-build-tree.png',
      ]),
    )

    for (const reference of imageReferences) {
      if (reference.src.startsWith('/')) {
        expect(existsSync(join(publicRoot, reference.src))).toBe(true)
      }
    }
  })

  it('records YouTube transcript blockers instead of pretending transcripts were analyzed', () => {
    expect(videoTranscriptAudits.length).toBeGreaterThanOrEqual(8)

    for (const video of videoTranscriptAudits) {
      expect(video.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/)
      expect(video.transcriptStatus).toBe('blocked-by-youtube-bot-check')
      expect(video.gameplayTakeaway.length).toBeGreaterThan(40)
    }
  })

  it('has enough original gameplay guidance to be useful', () => {
    const text = mdxFiles()
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
      .replace(/^---[\s\S]*?---/gm, '')
    const wordCount = text.split(/\s+/).filter(Boolean).length

    expect(wordCount).toBeGreaterThan(7_500)
  })

  it('does not ship planning scaffolding markers', () => {
    const disallowedMarkers = ['TO' + 'DO', 'TB' + 'D']
    for (const path of mdxFiles()) {
      const content = readFileSync(path, 'utf8')
      for (const marker of disallowedMarkers) {
        expect(content.includes(marker)).toBe(false)
      }
    }
  })
})

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'

import { factions } from '@/src/data/olden/factions'
import { gameModes } from '@/src/data/olden/game-modes'
import { referenceCategories } from '@/src/data/olden/reference'
import { roadmapItems } from '@/src/data/olden/roadmap'
import { sourceIds, wikiSources } from '@/src/data/olden/sources'

const contentRoot = join(import.meta.dir, '../../../../content/docs')

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
      'strategy/index.mdx',
      'meta/legal.mdx',
      'meta/sources.mdx',
    ]) {
      expect(pages.has(requiredPage)).toBe(true)
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

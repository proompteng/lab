import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { FactionGrid } from '@/src/components/wiki/faction-grid'
import { FreshnessBadge } from '@/src/components/wiki/freshness-badge'
import { GameModeList } from '@/src/components/wiki/game-mode-list'
import { ReferenceTable } from '@/src/components/wiki/reference-table'
import { RoadmapList } from '@/src/components/wiki/roadmap-list'
import { SourceNote } from '@/src/components/wiki/source-note'

// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    FactionGrid,
    FreshnessBadge,
    GameModeList,
    ReferenceTable,
    RoadmapList,
    SourceNote,
    ...components,
  }
}

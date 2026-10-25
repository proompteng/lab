import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { ArtifactReferenceTable } from '@/src/components/wiki/artifact-reference-table'
import { ArtifactSetReference } from '@/src/components/wiki/artifact-set-reference'
import { CreatureStatsTable } from '@/src/components/wiki/creature-stats-table'
import { EncyclopediaEntryTable } from '@/src/components/wiki/encyclopedia-entry-table'
import { EncyclopediaOverview } from '@/src/components/wiki/encyclopedia-overview'
import { FactionGrid } from '@/src/components/wiki/faction-grid'
import { FreshnessBadge } from '@/src/components/wiki/freshness-badge'
import { GameModeList } from '@/src/components/wiki/game-mode-list'
import { MechanicsFormulaReference } from '@/src/components/wiki/mechanics-formula-reference'
import { MechanicsMatrix } from '@/src/components/wiki/mechanics-matrix'
import { ReferenceTable } from '@/src/components/wiki/reference-table'
import { RoadmapList } from '@/src/components/wiki/roadmap-list'
import { SourceNote } from '@/src/components/wiki/source-note'
import { SourceSiteIndex } from '@/src/components/wiki/source-site-index'
import { TownBuildTree } from '@/src/components/wiki/town-build-tree'
import { VideoTranscriptAuditTable } from '@/src/components/wiki/video-transcript-audit-table'
import { WikiVisual } from '@/src/components/wiki/wiki-visual'

// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ArtifactReferenceTable,
    ArtifactSetReference,
    CreatureStatsTable,
    EncyclopediaEntryTable,
    EncyclopediaOverview,
    FactionGrid,
    FreshnessBadge,
    GameModeList,
    MechanicsFormulaReference,
    MechanicsMatrix,
    ReferenceTable,
    RoadmapList,
    SourceNote,
    SourceSiteIndex,
    TownBuildTree,
    VideoTranscriptAuditTable,
    WikiVisual,
    ...components,
  }
}

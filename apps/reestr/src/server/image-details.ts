import { createServerFn } from '@tanstack/react-start'

import type { TagManifestBreakdown } from '~/lib/registry'

import { fetchRepositoryTags, fetchTagManifestBreakdown } from './registry-client'

type ImageDetailsResponse = {
  repository: string
  tags: TagManifestBreakdown[]
  totalSizeBytes?: number
  hasTotalSize: boolean
  fetchedAt: string
  error?: string
}

const buildTotalSize = (tags: TagManifestBreakdown[]) => {
  const sizes = tags.map((tag) => tag.sizeBytes).filter((size): size is number => typeof size === 'number')
  return {
    total: sizes.reduce((total, size) => total + size, 0),
    hasTotal: sizes.length > 0,
  }
}

export const imageDetailsServerFn = createServerFn({ method: 'POST' }).handler(async ({ data }) => {
  const fetchedAt = new Date().toISOString()
  const repository = (data as { repository: string }).repository

  const tagsResult = await fetchRepositoryTags(repository)
  if (tagsResult.error) {
    return {
      repository,
      tags: [],
      totalSizeBytes: undefined,
      hasTotalSize: false,
      fetchedAt,
      error: tagsResult.error,
    } satisfies ImageDetailsResponse
  }

  const tagBreakdowns = await Promise.all(tagsResult.tags.map((tag) => fetchTagManifestBreakdown(repository, tag)))
  const filteredBreakdowns = tagBreakdowns.filter((tag) => !tag.error?.includes('Manifest request failed (404)'))
  const { total, hasTotal } = buildTotalSize(filteredBreakdowns)

  return {
    repository,
    tags: filteredBreakdowns,
    totalSizeBytes: hasTotal ? total : undefined,
    hasTotalSize: hasTotal,
    fetchedAt,
  } satisfies ImageDetailsResponse
})

export type { ImageDetailsResponse }

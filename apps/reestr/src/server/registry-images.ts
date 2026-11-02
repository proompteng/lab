import { createServerFn } from '@tanstack/react-start'

import type { TagDetails } from '~/lib/registry'

import { fetchRegistryCatalog, fetchRepositoryTags, fetchTagDetails } from './registry-client'

type RegistryImage = {
  name: string
  tags: string[]
  sizeBytes?: number
  sizeTag?: string
  sizeTimestamp?: string
  error?: string
  sizeError?: string
}

export type RegistryImagesResponse = {
  images: RegistryImage[]
  error?: string
  fetchedAt: string
}

function pickLatestTag(details: TagDetails[]): TagDetails | undefined {
  const withDates = details.filter((detail) => detail.createdAt)
  if (withDates.length) {
    return withDates.slice().sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0
      return rightTime - leftTime
    })[0]
  }

  return details.find((detail) => detail.sizeBytes)
}

const isMissingManifest = (error?: string) => error?.includes('Manifest request failed (404)')

const filterMissingManifestTagDetails = (details: TagDetails[]) =>
  details.filter((detail) => !isMissingManifest(detail.error))

async function computeRegistryImages(): Promise<RegistryImagesResponse> {
  const fetchedAt = new Date().toISOString()

  try {
    const catalogResult = await fetchRegistryCatalog()
    if (catalogResult.error) {
      return {
        images: [],
        error: catalogResult.error,
        fetchedAt,
      }
    }

    const repositories = catalogResult.repositories

    const images = await Promise.all(
      repositories.map(async (repository) => {
        const tagsResult = await fetchRepositoryTags(repository)
        if (tagsResult.error) {
          return {
            name: repository,
            tags: [],
            error: tagsResult.error,
          }
        }

        const tags = tagsResult.tags
        let sizeBytes: number | undefined
        let sizeTag: string | undefined
        let sizeTimestamp: string | undefined
        let sizeError: string | undefined

        let tagDetails: TagDetails[] = []

        if (tags.length) {
          tagDetails = await Promise.all(tags.map((tag) => fetchTagDetails(repository, tag)))
          const filteredDetails = filterMissingManifestTagDetails(tagDetails)
          const latestTag = pickLatestTag(filteredDetails)
          sizeBytes = latestTag?.sizeBytes
          sizeTag = latestTag?.tag
          sizeTimestamp = latestTag?.createdAt
          if (!sizeBytes) {
            sizeError = latestTag?.error ?? 'No valid manifest found'
          }
        }

        const filteredTags = filterMissingManifestTagDetails(tagDetails).map((detail) => detail.tag)

        if (!filteredTags.length) {
          return null
        }

        return {
          name: repository,
          tags: filteredTags,
          sizeTag,
          sizeBytes,
          sizeTimestamp,
          sizeError,
        }
      }),
    )

    return { images: images.filter(Boolean) as RegistryImage[], fetchedAt }
  } catch (error) {
    return {
      images: [],
      error: error instanceof Error ? error.message : 'Failed to load registry',
      fetchedAt,
    }
  }
}

const cacheTtlMs = Number(process.env.REESTR_REGISTRY_CACHE_TTL_MS ?? 30_000)
let cache: { expiresAt: number; value: RegistryImagesResponse } | null = null

export const registryImagesServerFn = createServerFn({ method: 'GET' }).handler(async () => {
  const now = Date.now()
  if (cache && cache.expiresAt > now) {
    return cache.value
  }

  const value = await computeRegistryImages()
  cache = {
    expiresAt: now + cacheTtlMs,
    value,
  }
  return value
})

export const __private = {
  filterMissingManifestTagDetails,
}

import { createFileRoute, Link } from '@tanstack/react-router'
import type { KeyboardEvent } from 'react'

import { ScrollArea } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import {
  encodeRepositoryParam,
  fetchRegistryCatalog,
  fetchRepositoryTags,
  fetchTagDetails,
  formatSize,
  type TagDetails,
} from '~/lib/registry'

type RegistryImage = {
  name: string
  tags: string[]
  sizeBytes?: number
  sizeTag?: string
  sizeTimestamp?: string
  error?: string
  sizeError?: string
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

async function fetchRegistryImages(): Promise<{
  images: RegistryImage[]
  error?: string
  fetchedAt: string
}> {
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

        if (tags.length) {
          const tagDetails = await Promise.all(tags.map((tag) => fetchTagDetails(repository, tag)))
          const latestTag = pickLatestTag(tagDetails)
          sizeBytes = latestTag?.sizeBytes
          sizeTag = latestTag?.tag
          sizeTimestamp = latestTag?.createdAt
          if (!sizeBytes) {
            sizeError = latestTag?.error ?? 'No valid manifest found'
          }
        } else {
          sizeError = 'No tags available'
        }

        return {
          name: repository,
          tags,
          sizeTag,
          sizeBytes,
          sizeTimestamp,
          sizeError,
        }
      }),
    )

    return { images, fetchedAt }
  } catch (error) {
    return {
      images: [],
      error: error instanceof Error ? error.message : 'Failed to load registry',
      fetchedAt,
    }
  }
}

export const Route = createFileRoute('/')({
  component: App,
  loader: fetchRegistryImages,
})

function App() {
  const { images, error, fetchedAt } = Route.useLoaderData()
  const _formattedTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(fetchedAt))

  const formatTimestamp = (value?: string) => {
    if (!value) {
      return null
    }

    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) {
      return value
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(parsed))
  }

  const handleRowLinkKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      event.currentTarget.click()
    }
  }

  return (
    <div className="flex h-dvh w-full justify-center">
      <section className="flex h-dvh w-full max-w-6xl flex-col px-6 py-6 text-neutral-100">
        <div className="flex min-h-0 flex-1 flex-col rounded-sm border border-neutral-800/80 bg-neutral-950 shadow-[0_0_0_1px_rgba(10,10,10,0.6)]">
          {error ? (
            <p role="alert" className="mt-4 px-6 text-sm text-rose-400">
              {error}
            </p>
          ) : null}
          <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain [&_[data-slot=table-container]]:overflow-x-visible">
            <Table className="table-fixed text-sm">
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[44%]" />
                <col className="w-[14%]" />
                <col className="w-[18%]" />
              </colgroup>
              <TableHeader>
                <TableRow className="h-12 border-neutral-800/80 text-xs uppercase tracking-wide text-neutral-400">
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Repository</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Tags</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Size</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {images.length === 0 ? (
                  <TableRow className="h-12 border-neutral-800/80">
                    <TableCell colSpan={4} className="px-4 py-0 text-center text-sm text-neutral-300">
                      No images found in the registry.
                    </TableCell>
                  </TableRow>
                ) : (
                  images.map((image) => {
                    const extraTags = Math.max(0, image.tags.length - 3)
                    const imageId = encodeRepositoryParam(image.name)
                    const linkProps = {
                      to: '/image/$imageId',
                      params: { imageId },
                    } as const

                    return (
                      <TableRow
                        key={image.name}
                        className="h-12 border-neutral-800/80 transition-colors hover:bg-neutral-900/50 focus-within:bg-neutral-900/50"
                      >
                        <TableCell className="px-0 py-0 font-medium text-neutral-100">
                          <Link
                            {...linkProps}
                            onKeyDown={handleRowLinkKeyDown}
                            className="flex h-full w-full items-center px-4 py-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-inset"
                          >
                            {image.name}
                          </Link>
                        </TableCell>
                        <TableCell className="min-w-0 px-0 py-0">
                          <Link
                            {...linkProps}
                            onKeyDown={handleRowLinkKeyDown}
                            className="flex min-w-0 items-center px-4 py-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-inset"
                          >
                            {image.tags.length ? (
                              <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden">
                                {image.tags.slice(0, 3).map((tag) => (
                                  <span
                                    key={tag}
                                    className="h-6 max-w-[120px] truncate whitespace-nowrap rounded-full border border-neutral-700/70 bg-neutral-900/70 px-2 py-0.5 text-xs text-neutral-200"
                                  >
                                    {tag}
                                  </span>
                                ))}
                                {extraTags > 0 ? (
                                  <>
                                    <span className="text-xs text-neutral-500">…</span>
                                    <span
                                      className="flex h-6 min-w-6 items-center justify-center rounded-full border border-neutral-700/70 bg-neutral-900/70 px-2 text-[11px] text-neutral-200"
                                      title={image.tags.slice(3).join(', ')}
                                    >
                                      +{extraTags}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            ) : (
                              <span className="text-xs text-neutral-500">No tags</span>
                            )}
                          </Link>
                        </TableCell>
                        <TableCell className="px-0 py-0 text-xs text-neutral-300">
                          <Link
                            {...linkProps}
                            onKeyDown={handleRowLinkKeyDown}
                            className="flex h-full w-full flex-col justify-center px-4 py-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-inset"
                          >
                            {image.sizeBytes ? (
                              <span className="text-sm font-medium text-neutral-100">
                                {formatSize(image.sizeBytes)}
                              </span>
                            ) : (
                              <span className="text-xs text-neutral-500">Unknown</span>
                            )}
                          </Link>
                        </TableCell>
                        <TableCell className="px-0 py-0 text-xs text-neutral-300">
                          <Link
                            {...linkProps}
                            onKeyDown={handleRowLinkKeyDown}
                            className="flex h-full w-full items-center px-4 py-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-inset"
                          >
                            {image.sizeTimestamp ? formatTimestamp(image.sizeTimestamp) : '—'}
                          </Link>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>
      </section>
    </div>
  )
}

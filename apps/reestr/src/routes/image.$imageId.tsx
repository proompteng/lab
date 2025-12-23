import { createFileRoute, Link } from '@tanstack/react-router'

import { ScrollArea } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import {
  decodeRepositoryParam,
  fetchRepositoryTags,
  fetchTagManifestBreakdown,
  formatSize,
  type TagManifestBreakdown,
} from '~/lib/registry'

type ImageDetailsLoaderData = {
  repository: string
  tags: TagManifestBreakdown[]
  totalSizeBytes?: number
  hasTotalSize: boolean
  fetchedAt: string
  error?: string
}

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

const buildTotalSize = (tags: TagManifestBreakdown[]) => {
  const sizes = tags.map((tag) => tag.sizeBytes).filter((size): size is number => typeof size === 'number')
  return {
    total: sizes.reduce((total, size) => total + size, 0),
    hasTotal: sizes.length > 0,
  }
}

export const Route = createFileRoute('/image/$imageId')({
  loader: async ({ params }): Promise<ImageDetailsLoaderData> => {
    const fetchedAt = new Date().toISOString()
    const repository = decodeRepositoryParam(params.imageId)
    const tagsResult = await fetchRepositoryTags(repository)
    if (tagsResult.error) {
      return {
        repository,
        tags: [],
        totalSizeBytes: undefined,
        hasTotalSize: false,
        fetchedAt,
        error: tagsResult.error,
      }
    }

    const tagBreakdowns = await Promise.all(tagsResult.tags.map((tag) => fetchTagManifestBreakdown(repository, tag)))
    const { total, hasTotal } = buildTotalSize(tagBreakdowns)

    return {
      repository,
      tags: tagBreakdowns,
      totalSizeBytes: hasTotal ? total : undefined,
      hasTotalSize: hasTotal,
      fetchedAt,
    }
  },
  component: ImageDetails,
})

function ImageDetails() {
  const { repository, tags, totalSizeBytes, hasTotalSize, fetchedAt, error } = Route.useLoaderData()
  const formattedTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(fetchedAt))

  return (
    <div className="flex h-dvh w-full justify-center">
      <section className="flex h-dvh w-full max-w-6xl flex-col px-6 py-6 text-neutral-100">
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <Link to="/" className="text-xs font-medium text-neutral-400 transition hover:text-neutral-100">
                ← Back to registry
              </Link>
              <div className="space-y-1">
                <h1 className="text-xl font-semibold text-neutral-100">{repository}</h1>
                <p className="text-xs text-neutral-500">Last refreshed {formattedTime}</p>
              </div>
            </div>
            <div className="rounded-sm border border-neutral-800/80 bg-neutral-950 px-4 py-3 text-right">
              <p className="text-[11px] uppercase tracking-wide text-neutral-500">Total size</p>
              <p className="text-lg font-semibold text-neutral-100">
                {hasTotalSize && totalSizeBytes !== undefined ? formatSize(totalSizeBytes) : 'Unknown'}
              </p>
              <p className="text-xs text-neutral-500">{tags.length} tags</p>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col rounded-sm border border-neutral-800/80 bg-neutral-950 shadow-[0_0_0_1px_rgba(10,10,10,0.6)]">
            {error ? (
              <p role="alert" className="mt-4 px-6 text-sm text-rose-400">
                {error}
              </p>
            ) : null}
            <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain [&_[data-slot=table-container]]:overflow-x-visible">
              <Table className="table-fixed text-sm">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[48%]" />
                  <col className="w-[14%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="h-12 border-neutral-800/80 text-xs uppercase tracking-wide text-neutral-400">
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Tag</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">
                      Manifest breakdown
                    </TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Size</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tags.length === 0 ? (
                    <TableRow className="h-12 border-neutral-800/80">
                      <TableCell colSpan={4} className="px-4 py-0 text-center text-sm text-neutral-300">
                        No tags found for this repository.
                      </TableCell>
                    </TableRow>
                  ) : (
                    tags.map((tag) => (
                      <TableRow key={tag.tag} className="border-neutral-800/80">
                        <TableCell className="px-4 py-3 align-top">
                          <div className="flex flex-col gap-1">
                            <span className="text-sm font-semibold text-neutral-100">{tag.tag}</span>
                            {tag.error ? <span className="text-xs text-rose-400">{tag.error}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          {tag.manifestType === 'list' ? (
                            tag.manifests?.length ? (
                              <div className="flex flex-col gap-2">
                                {tag.manifests.map((manifest) => (
                                  <div key={manifest.digest} className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="rounded-full border border-neutral-700/70 bg-neutral-900/70 px-2 py-0.5 text-neutral-200">
                                      {manifest.platformLabel}
                                    </span>
                                    <span className="text-neutral-300">
                                      {typeof manifest.sizeBytes === 'number'
                                        ? formatSize(manifest.sizeBytes)
                                        : 'Unknown'}
                                    </span>
                                    {manifest.error ? <span className="text-rose-400">{manifest.error}</span> : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-neutral-500">No manifest entries</span>
                            )
                          ) : (
                            <span className="text-xs text-neutral-500">Single manifest</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 text-xs text-neutral-300">
                          {typeof tag.sizeBytes === 'number' ? (
                            <span className="text-sm font-medium text-neutral-100">{formatSize(tag.sizeBytes)}</span>
                          ) : (
                            <span className="text-xs text-neutral-500">Unknown</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 text-xs text-neutral-300">
                          {tag.createdAt ? formatTimestamp(tag.createdAt) : '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>
        </div>
      </section>
    </div>
  )
}

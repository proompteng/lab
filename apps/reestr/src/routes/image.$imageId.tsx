import { IconHome2, IconPackage, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useRouterState } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Button } from '~/components/ui/button'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { decodeRepositoryParam, formatSize, type TagManifestBreakdown } from '~/lib/registry'
import { deleteTagServerFn } from '~/server/delete-tag'
import { type ImageDetailsResponse, imageDetailsServerFn } from '~/server/image-details'

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

export const Route = createFileRoute('/image/$imageId')({
  loader: async ({ params }): Promise<ImageDetailsLoaderData> => {
    const repository = decodeRepositoryParam(params.imageId)
    const result = await imageDetailsServerFn({ data: { repository } })
    return result as ImageDetailsLoaderData
  },
  component: ImageDetails,
})

const imageDetailsQueryKey = (repository: string) => ['imageDetails', repository] as const

function ImageDetails() {
  const queryClient = useQueryClient()
  const runDeleteTag = useServerFn(deleteTagServerFn)

  const initialData = Route.useLoaderData() as ImageDetailsResponse

  const { data } = useQuery({
    queryKey: imageDetailsQueryKey(initialData.repository),
    queryFn: () => imageDetailsServerFn({ data: { repository: initialData.repository } }),
    initialData,
    staleTime: 30_000,
  })

  const { repository, tags, totalSizeBytes, hasTotalSize, fetchedAt, error } = data
  const isRoutePending = useRouterState({
    select: (state) => state.isLoading || state.matches.some((match) => match.status === 'pending'),
  })
  const sortedTags = [...tags].sort((first, second) => {
    const firstTime = first.createdAt ? Date.parse(first.createdAt) : Number.NEGATIVE_INFINITY
    const secondTime = second.createdAt ? Date.parse(second.createdAt) : Number.NEGATIVE_INFINITY

    if (Number.isNaN(firstTime) && Number.isNaN(secondTime)) {
      return 0
    }
    if (Number.isNaN(firstTime)) {
      return 1
    }
    if (Number.isNaN(secondTime)) {
      return -1
    }

    return secondTime - firstTime
  })
  const formattedTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(fetchedAt))

  const [tagToDelete, setTagToDelete] = useState<TagManifestBreakdown | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [pruneOpen, setPruneOpen] = useState(false)
  const [pruneError, setPruneError] = useState<string | null>(null)
  const [isPruning, setIsPruning] = useState(false)
  const showSkeleton = isRoutePending || isDeleting
  const skeletonRows = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']
  const skeletonCells = ['cell-1', 'cell-2', 'cell-3', 'cell-4', 'cell-5']

  const handleConfirmDelete = async () => {
    if (!tagToDelete || isDeleting) {
      return
    }

    setIsDeleting(true)
    setDeleteError(null)

    try {
      await runDeleteTag({ data: { repository, tag: tagToDelete.tag } })

      setIsDeleting(false)
      setDeleteOpen(false)
      setTagToDelete(null)

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: imageDetailsQueryKey(repository) }),
        queryClient.invalidateQueries({ queryKey: ['registryImages'] }),
      ])
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete tag')
      setIsDeleting(false)
    }
  }

  const handleConfirmPrune = async () => {
    if (isPruning) {
      return
    }

    const tagsToDelete = sortedTags.slice(3)
    if (tagsToDelete.length === 0) {
      setPruneError('No tags to prune.')
      return
    }

    setIsPruning(true)
    setPruneError(null)

    try {
      const results = await Promise.allSettled(
        tagsToDelete.map((tag) => runDeleteTag({ data: { repository, tag: tag.tag } })),
      )
      const failedTags = results
        .map((result, index) => ({ result, tag: tagsToDelete[index]?.tag }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ tag }) => tag)
        .filter(Boolean) as string[]

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: imageDetailsQueryKey(repository) }),
        queryClient.invalidateQueries({ queryKey: ['registryImages'] }),
      ])

      if (failedTags.length) {
        const preview = failedTags.slice(0, 3).join(', ')
        const suffix = failedTags.length > 3 ? ` and ${failedTags.length - 3} more` : ''
        setPruneError(`Failed to delete ${failedTags.length} tag(s): ${preview}${suffix}`)
        setIsPruning(false)
        return
      }

      setIsPruning(false)
      setPruneOpen(false)
    } catch (error) {
      setPruneError(error instanceof Error ? error.message : 'Failed to prune tags')
      setIsPruning(false)
    }
  }

  const showLoadingState = showSkeleton || isPruning

  return (
    <div className="flex justify-center overflow-x-hidden h-dvh w-full">
      <section className="flex flex-col overflow-x-hidden h-dvh w-full max-w-6xl px-6 py-6 text-neutral-100">
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <header className="flex flex-col gap-3">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink
                    render={<Link to="/" />}
                    className="inline-flex items-center gap-2 text-neutral-400 leading-none"
                  >
                    <IconHome2 className="size-4" />
                    Registry
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="inline-flex items-center gap-2 leading-none break-words">
                    <IconPackage className="size-4" />
                    {repository}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-2">
                <div className="space-y-1">
                  <h1 className="text-xl font-semibold text-neutral-100">{repository}</h1>
                  <p className="text-xs text-neutral-500">Last refreshed {formattedTime}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={sortedTags.length <= 3 || isPruning}
                  onClick={() => {
                    setPruneError(null)
                    setPruneOpen(true)
                  }}
                >
                  Prune old tags
                </Button>
              </div>
              <div className="flex flex-col items-end gap-3">
                <div className="rounded-sm border border-neutral-800/80 bg-neutral-950 px-4 py-3 text-right">
                  <p className="text-[11px] uppercase tracking-wide text-neutral-500">Total size</p>
                  <p className="text-lg font-semibold text-neutral-100">
                    {hasTotalSize && totalSizeBytes !== undefined ? formatSize(totalSizeBytes) : 'Unknown'}
                  </p>
                  <p className="text-xs text-neutral-500">{tags.length} tags</p>
                </div>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col rounded-sm border border-neutral-800/80 bg-neutral-950 shadow-[0_0_0_1px_rgba(10,10,10,0.6)]">
            {error ? (
              <p role="alert" className="mt-4 px-6 text-sm text-rose-400">
                {error}
              </p>
            ) : null}
            <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain [&_[data-slot=table-container]]:overflow-x-hidden">
              <Table className="table-fixed text-sm" aria-busy={showLoadingState}>
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[46%]" />
                  <col className="w-[14%]" />
                  <col className="w-[14%]" />
                  <col className="w-[8%]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="h-12 border-neutral-800/80 text-xs uppercase tracking-wide text-neutral-400">
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 text-center font-semibold">
                      Tag
                    </TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 text-center font-semibold">
                      Manifest breakdown
                    </TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 text-center font-semibold">
                      Size
                    </TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 text-center font-semibold">
                      Updated
                    </TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 text-center font-semibold">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {showLoadingState ? (
                    skeletonRows.map((rowId) => (
                      <TableRow key={rowId} className="h-12 border-neutral-800/80">
                        {skeletonCells.map((cellId) => (
                          <TableCell key={`${rowId}-${cellId}`} className="px-4 py-3">
                            <div className="h-4 w-full rounded bg-neutral-800/70 animate-pulse" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : sortedTags.length === 0 ? (
                    <TableRow className="h-12 border-neutral-800/80">
                      <TableCell colSpan={5} className="px-4 py-0 text-center text-sm text-neutral-300">
                        No tags found for this repository.
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedTags.map((tag) => (
                      <TableRow key={tag.tag} className="border-neutral-800/80">
                        <TableCell className="px-4 py-3 align-top text-center break-words whitespace-normal">
                          <div className="flex flex-col items-center gap-1 text-center">
                            <span className="text-sm font-semibold text-neutral-100">{tag.tag}</span>
                            {tag.error ? <span className="break-words text-xs text-rose-400">{tag.error}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3 text-center break-words whitespace-normal">
                          {tag.manifestType === 'list' ? (
                            tag.manifests?.length ? (
                              <div className="flex flex-col items-center gap-2 text-center">
                                {tag.manifests.map((manifest) => (
                                  <div
                                    key={manifest.digest}
                                    className="flex flex-wrap items-center justify-center gap-2 text-xs"
                                  >
                                    <span className="rounded-full border border-neutral-700/70 bg-neutral-900/70 px-2 py-0.5 text-neutral-200">
                                      {manifest.platformLabel}
                                    </span>
                                    <span className="text-neutral-300">
                                      {typeof manifest.sizeBytes === 'number'
                                        ? formatSize(manifest.sizeBytes)
                                        : 'Unknown'}
                                    </span>
                                    {manifest.error ? (
                                      <span className="break-words text-rose-400">{manifest.error}</span>
                                    ) : null}
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
                        <TableCell className="px-4 py-3 text-center text-xs text-neutral-300">
                          {typeof tag.sizeBytes === 'number' ? (
                            <span className="text-sm font-medium text-neutral-100">{formatSize(tag.sizeBytes)}</span>
                          ) : (
                            <span className="text-xs text-neutral-500">Unknown</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 text-center text-xs text-neutral-300">
                          {tag.createdAt ? formatTimestamp(tag.createdAt) : '—'}
                        </TableCell>
                        <TableCell className="px-2 py-3 align-middle">
                          <div className="flex items-center justify-center">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Delete ${tag.tag}`}
                                    disabled={isPruning}
                                    onClick={() => {
                                      setTagToDelete(tag)
                                      setDeleteError(null)
                                      setDeleteOpen(true)
                                    }}
                                  >
                                    <IconTrash className="size-5 text-rose-400" />
                                  </Button>
                                }
                              />
                              <TooltipContent>Delete tag</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>

          <AlertDialog
            open={deleteOpen}
            onOpenChange={(open) => {
              if (!open && isDeleting) {
                return
              }

              setDeleteOpen(open)

              if (!open) {
                setTagToDelete(null)
                setDeleteError(null)
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete tag</AlertDialogTitle>
                <AlertDialogDescription>
                  {tagToDelete
                    ? `This will delete ${repository}:${tagToDelete.tag}. This cannot be undone.`
                    : 'Select a tag to delete.'}
                </AlertDialogDescription>
              </AlertDialogHeader>

              {deleteError ? <p className="text-xs text-rose-400">{deleteError}</p> : null}

              <AlertDialogFooter>
                <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={!tagToDelete || isDeleting}
                  onClick={handleConfirmDelete}
                >
                  {isDeleting ? 'Deleting…' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={pruneOpen}
            onOpenChange={(open) => {
              if (!open && isPruning) {
                return
              }

              setPruneOpen(open)

              if (!open) {
                setPruneError(null)
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Prune old tags</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete {Math.max(0, sortedTags.length - 3)} tag(s). The 3 most recently updated tags will be
                  kept.
                </AlertDialogDescription>
              </AlertDialogHeader>

              {pruneError ? <p className="text-xs text-rose-400">{pruneError}</p> : null}

              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPruning}>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" disabled={isPruning} onClick={handleConfirmPrune}>
                  {isPruning ? 'Pruning…' : 'Prune'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </section>
    </div>
  )
}

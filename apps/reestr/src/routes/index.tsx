import { IconHome2, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useRouterState } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import type { KeyboardEvent } from 'react'
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
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from '~/components/ui/breadcrumb'
import { Button } from '~/components/ui/button'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { encodeRepositoryParam, formatSize } from '~/lib/registry'
import { deleteTagServerFn } from '~/server/delete-tag'
import { type RegistryImagesResponse, registryImagesServerFn } from '~/server/registry-images'

export const Route = createFileRoute('/')({
  component: App,
  loader: async () => registryImagesServerFn(),
})

const registryImagesQueryKey = ['registryImages'] as const

function App() {
  const queryClient = useQueryClient()
  const runDeleteTag = useServerFn(deleteTagServerFn)
  const initialData = Route.useLoaderData() as RegistryImagesResponse

  const { data } = useQuery({
    queryKey: registryImagesQueryKey,
    queryFn: () => registryImagesServerFn(),
    initialData,
    staleTime: 30_000,
  })

  const isRoutePending = useRouterState({
    select: (state) => state.isLoading || state.matches.some((match) => match.status === 'pending'),
  })

  const { images, error, fetchedAt } = data
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

  const [imageToDelete, setImageToDelete] = useState<RegistryImagesResponse['images'][number] | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const showSkeleton = isRoutePending || isDeleting
  const skeletonRows = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']
  const skeletonCells = ['cell-1', 'cell-2', 'cell-3', 'cell-4', 'cell-5']

  const handleConfirmDelete = async () => {
    if (!imageToDelete || isDeleting) {
      return
    }

    if (!imageToDelete.tags.length) {
      setDeleteError('No tags found to delete.')
      return
    }

    setIsDeleting(true)
    setDeleteError(null)

    try {
      const results = await Promise.allSettled(
        imageToDelete.tags.map((tag) => runDeleteTag({ data: { repository: imageToDelete.name, tag } })),
      )
      const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')

      if (firstFailure) {
        const message =
          firstFailure.reason instanceof Error ? firstFailure.reason.message : 'Failed to delete image tags'
        setDeleteError(message)
        setIsDeleting(false)
        return
      }

      setIsDeleting(false)
      setDeleteOpen(false)
      setImageToDelete(null)

      queryClient.setQueryData<RegistryImagesResponse>(registryImagesQueryKey, (current) => {
        if (!current) {
          return current
        }

        return {
          ...current,
          images: current.images.filter((image) => image.name !== imageToDelete.name),
        }
      })

      await queryClient.invalidateQueries({ queryKey: registryImagesQueryKey })
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete image tags')
      setIsDeleting(false)
    }
  }

  return (
    <div className="flex justify-center overflow-x-hidden h-dvh w-full">
      <section className="flex flex-col overflow-x-hidden h-dvh w-full max-w-6xl px-6 py-6 text-neutral-100">
        <header className="flex items-center mb-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="inline-flex items-center gap-2 leading-none">
                  <IconHome2 className="size-4" />
                  Registry
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex min-h-0 flex-1 flex-col rounded-sm border border-neutral-800/80 bg-neutral-950 shadow-[0_0_0_1px_rgba(10,10,10,0.6)]">
          {error ? (
            <p role="alert" className="mt-4 px-6 text-sm text-rose-400">
              {error}
            </p>
          ) : null}
          <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain [&_[data-slot=table-container]]:overflow-x-hidden">
            <Table className="table-fixed text-sm" aria-busy={showSkeleton}>
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[42%]" />
                <col className="w-[14%]" />
                <col className="w-[16%]" />
                <col className="w-[6%]" />
              </colgroup>
              <TableHeader>
                <TableRow className="h-12 border-neutral-800/80 text-xs uppercase tracking-wide text-neutral-400">
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Repository</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Tags</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Size</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Updated</TableHead>
                  <TableHead className="sticky top-0 z-10 bg-neutral-950 px-2 py-0 text-center font-semibold">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {showSkeleton ? (
                  skeletonRows.map((rowId) => (
                    <TableRow key={rowId} className="h-12 border-neutral-800/80">
                      {skeletonCells.map((cellId) => (
                        <TableCell key={`${rowId}-${cellId}`} className="px-4 py-3">
                          <div className="h-4 w-full rounded bg-neutral-800/70 animate-pulse" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : images.length === 0 ? (
                  <TableRow className="h-12 border-neutral-800/80">
                    <TableCell colSpan={5} className="px-4 py-0 text-center text-sm text-neutral-300">
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
                        <TableCell className="px-0 py-0">
                          <div className="flex h-full items-center justify-center">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Delete tags for ${image.name}`}
                                    onClick={() => {
                                      setImageToDelete(image)
                                      setDeleteError(null)
                                      setDeleteOpen(true)
                                    }}
                                  >
                                    <IconTrash className="text-rose-400" />
                                  </Button>
                                }
                              />
                              <TooltipContent>Delete tags</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
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
              setImageToDelete(null)
              setDeleteError(null)
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete image tags</AlertDialogTitle>
              <AlertDialogDescription>
                {imageToDelete
                  ? `This will delete ${imageToDelete.tags.length} tag(s) for ${imageToDelete.name}. This cannot be undone.`
                  : 'Select an image to delete.'}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {deleteError ? <p className="text-xs text-rose-400">{deleteError}</p> : null}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!imageToDelete?.tags.length || isDeleting}
                onClick={handleConfirmDelete}
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  )
}

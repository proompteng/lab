import { IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
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
  AlertDialogMedia,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
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
  const formattedTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(fetchedAt))

  const [tagToDelete, setTagToDelete] = useState<TagManifestBreakdown | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

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
                  <col className="w-[20%]" />
                  <col className="w-[46%]" />
                  <col className="w-[14%]" />
                  <col className="w-[14%]" />
                  <col className="w-[6%]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="h-12 border-neutral-800/80 text-xs uppercase tracking-wide text-neutral-400">
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Tag</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">
                      Manifest breakdown
                    </TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Size</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 font-semibold">Updated</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-neutral-950 px-4 py-0 text-right font-semibold">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tags.length === 0 ? (
                    <TableRow className="h-12 border-neutral-800/80">
                      <TableCell colSpan={5} className="px-4 py-0 text-center text-sm text-neutral-300">
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
                        <TableCell className="px-2 py-3 align-top">
                          <div className="flex justify-end">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Delete ${tag.tag}`}
                                    onClick={() => {
                                      setTagToDelete(tag)
                                      setDeleteError(null)
                                      setDeleteOpen(true)
                                    }}
                                  >
                                    <IconTrash className="text-rose-400" />
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
                <AlertDialogMedia className="bg-rose-500/10 text-rose-400">
                  <IconTrash />
                </AlertDialogMedia>
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
        </div>
      </section>
    </div>
  )
}

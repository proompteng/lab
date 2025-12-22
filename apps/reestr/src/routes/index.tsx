import { createFileRoute } from '@tanstack/react-router'

import { ScrollArea } from '~/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'

type RegistryImage = {
  name: string
  tags: string[]
  sizeBytes?: number
  sizeTag?: string
  sizeTimestamp?: string
  error?: string
  sizeError?: string
}

const registryBaseUrl = 'https://registry.ide-newton.ts.net'
const registryAcceptHeader = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

type RegistryManifest = {
  config?: { size?: number; digest?: string }
  layers?: Array<{ size?: number }>
}

type ManifestDescriptor = {
  digest: string
  platform?: { architecture?: string; os?: string }
}

type ManifestList = {
  manifests?: ManifestDescriptor[]
}

function pickManifestDescriptor(manifests: ManifestDescriptor[]): ManifestDescriptor | undefined {
  const linuxArm64 = manifests.find(
    (manifest) => manifest.platform?.os === 'linux' && manifest.platform?.architecture === 'arm64',
  )
  if (linuxArm64) {
    return linuxArm64
  }

  const linuxAmd64 = manifests.find(
    (manifest) => manifest.platform?.os === 'linux' && manifest.platform?.architecture === 'amd64',
  )
  if (linuxAmd64) {
    return linuxAmd64
  }

  return manifests[0]
}

function isManifestList(payload: RegistryManifest | ManifestList): payload is ManifestList {
  return Array.isArray((payload as ManifestList).manifests)
}

function calculateManifestSize(manifest: RegistryManifest): number {
  const configSize = manifest.config?.size ?? 0
  const layerSize = manifest.layers?.reduce((total, layer) => total + (layer.size ?? 0), 0) ?? 0

  return configSize + layerSize
}

async function fetchManifest(
  repository: string,
  reference: string,
): Promise<{ payload?: RegistryManifest | ManifestList; error?: string }> {
  try {
    const response = await fetch(new URL(`/v2/${repository}/manifests/${reference}`, registryBaseUrl), {
      headers: {
        Accept: registryAcceptHeader,
      },
    })
    if (!response.ok) {
      return { error: `Manifest request failed (${response.status})` }
    }

    return { payload: (await response.json()) as RegistryManifest | ManifestList }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Failed to load manifest' }
  }
}

async function fetchRepositorySize(
  repository: string,
  reference: string,
): Promise<{ sizeBytes?: number; manifest?: RegistryManifest; error?: string }> {
  const manifestResult = await fetchManifest(repository, reference)
  if (!manifestResult.payload) {
    return { error: manifestResult.error }
  }

  if (isManifestList(manifestResult.payload)) {
    const descriptor = pickManifestDescriptor(manifestResult.payload.manifests ?? [])
    if (!descriptor) {
      return { error: 'No manifest entries returned' }
    }

    const nestedManifestResult = await fetchManifest(repository, descriptor.digest)
    if (!nestedManifestResult.payload || isManifestList(nestedManifestResult.payload)) {
      return { error: nestedManifestResult.error ?? 'Manifest payload was not an image manifest' }
    }

    return {
      sizeBytes: calculateManifestSize(nestedManifestResult.payload),
      manifest: nestedManifestResult.payload,
    }
  }

  return {
    sizeBytes: calculateManifestSize(manifestResult.payload),
    manifest: manifestResult.payload,
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0\u00A0B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let value = bytes

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value)

  return `${formatted}\u00A0${units[unitIndex]}`
}

type TagDetails = {
  tag: string
  sizeBytes?: number
  createdAt?: string
  error?: string
}

async function fetchTagCreatedAt(
  repository: string,
  configDigest: string,
): Promise<{ createdAt?: string; error?: string }> {
  try {
    const response = await fetch(new URL(`/v2/${repository}/blobs/${configDigest}`, registryBaseUrl))
    if (!response.ok) {
      return { error: `Config request failed (${response.status})` }
    }

    const payload = (await response.json()) as { created?: string }
    return { createdAt: payload.created }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Failed to load config' }
  }
}

async function fetchTagDetails(repository: string, tag: string): Promise<TagDetails> {
  const sizeResult = await fetchRepositorySize(repository, tag)
  if (!sizeResult.manifest) {
    return { tag, error: sizeResult.error ?? 'Manifest not available' }
  }

  const configDigest = sizeResult.manifest.config?.digest
  if (!configDigest) {
    return {
      tag,
      sizeBytes: sizeResult.sizeBytes,
      error: 'Manifest missing config digest',
    }
  }

  const createdResult = await fetchTagCreatedAt(repository, configDigest)

  return {
    tag,
    sizeBytes: sizeResult.sizeBytes,
    createdAt: createdResult.createdAt,
    error: createdResult.error,
  }
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
    const catalogResponse = await fetch(new URL('/v2/_catalog', registryBaseUrl))
    if (!catalogResponse.ok) {
      return {
        images: [],
        error: `Registry catalog request failed (${catalogResponse.status})`,
        fetchedAt,
      }
    }

    const catalog = (await catalogResponse.json()) as { repositories?: string[] }
    const repositories = catalog.repositories ?? []

    const images = await Promise.all(
      repositories.map(async (repository) => {
        try {
          const tagsResponse = await fetch(new URL(`/v2/${repository}/tags/list`, registryBaseUrl))
          if (!tagsResponse.ok) {
            return {
              name: repository,
              tags: [],
              error: `Tags request failed (${tagsResponse.status})`,
            }
          }

          const tagsPayload = (await tagsResponse.json()) as { tags?: string[] }
          const tags = tagsPayload.tags ?? []
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
        } catch (error) {
          return {
            name: repository,
            tags: [],
            error: error instanceof Error ? error.message : 'Failed to load tags',
          }
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

                    return (
                      <TableRow key={image.name} className="h-12 border-neutral-800/80">
                        <TableCell className="px-4 py-0 font-medium text-neutral-100">{image.name}</TableCell>
                        <TableCell className="min-w-0 px-4 py-0">
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
                                  <Tooltip>
                                    <TooltipTrigger
                                      type="button"
                                      aria-label={`Show ${extraTags} more tags`}
                                      className="flex h-6 min-w-6 items-center justify-center rounded-full border border-neutral-700/70 bg-neutral-900/70 px-2 text-[11px] text-neutral-200"
                                    >
                                      +{extraTags}
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="top"
                                      align="start"
                                      className="border border-neutral-700/80 bg-neutral-950 text-neutral-100 shadow-lg [&>*:last-child]:hidden"
                                    >
                                      <p className="max-w-xs text-xs text-neutral-100">
                                        {image.tags.slice(3).join(', ')}
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                </>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-xs text-neutral-500">No tags</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-0 text-xs text-neutral-300">
                          {image.sizeBytes ? (
                            <div className="flex flex-col gap-1">
                              <span className="text-sm font-medium text-neutral-100">
                                {formatSize(image.sizeBytes)}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-neutral-500">Unknown</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-0 text-xs text-neutral-300">
                          {image.sizeTimestamp ? formatTimestamp(image.sizeTimestamp) : '—'}
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

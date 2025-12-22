import { createFileRoute } from '@tanstack/react-router'

type RegistryImage = {
  name: string
  tags: string[]
  sizeBytes?: number
  sizeTag?: string
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
  config?: { size?: number }
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

async function fetchRepositorySize(repository: string, tag: string): Promise<{ sizeBytes?: number; error?: string }> {
  const manifestResult = await fetchManifest(repository, tag)
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

    return { sizeBytes: calculateManifestSize(nestedManifestResult.payload) }
  }

  return { sizeBytes: calculateManifestSize(manifestResult.payload) }
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

function pickSizeTag(tags: string[]): string | undefined {
  if (tags.includes('latest')) {
    return 'latest'
  }

  const sorted = [...tags].sort()
  return sorted[0]
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
          const sizeTag = pickSizeTag(tags)
          let sizeBytes: number | undefined
          let sizeError: string | undefined

          if (sizeTag) {
            const sizeResult = await fetchRepositorySize(repository, sizeTag)
            sizeBytes = sizeResult.sizeBytes
            sizeError = sizeResult.error
          }

          return {
            name: repository,
            tags,
            sizeTag,
            sizeBytes,
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
  const formattedTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(fetchedAt))

  return (
    <section className="bg-card text-card-foreground mx-auto mt-12 w-full max-w-5xl rounded-xl border p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Registry images</h2>
          <p className="text-muted-foreground text-sm">Data source: {registryBaseUrl}</p>
        </div>
        <p className="text-muted-foreground text-xs">Fetched {formattedTime}</p>
      </div>
      {error ? (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {error}
        </p>
      ) : null}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="text-muted-foreground mb-3 text-left text-xs">
            Registry repositories and their available tags.
          </caption>
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-2 py-2 font-semibold">
                Repository
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Tags
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Size
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {images.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-2 py-6 text-center text-sm">
                  No images found in the registry.
                </td>
              </tr>
            ) : (
              images.map((image) => (
                <tr key={image.name}>
                  <td className="px-2 py-3 font-medium">{image.name}</td>
                  <td className="px-2 py-3">
                    {image.tags.length ? (
                      <div className="flex flex-wrap gap-2">
                        {image.tags.map((tag) => (
                          <span key={tag} className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">No tags</span>
                    )}
                  </td>
                  <td className="px-2 py-3 text-xs">
                    {image.sizeBytes ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-sm font-medium">{formatSize(image.sizeBytes)}</span>
                        {image.sizeTag ? (
                          <span className="text-muted-foreground text-xs">Tag {image.sizeTag}</span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">Unknown</span>
                    )}
                  </td>
                  <td className="px-2 py-3 text-xs">
                    {image.error || image.sizeError ? (
                      <span className="text-destructive">{image.error ?? image.sizeError}</span>
                    ) : (
                      <span className="text-emerald-600">OK</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

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

type TagDetails = {
  tag: string
  sizeBytes?: number
  createdAt?: string
  error?: string
}

type TagManifestPlatform = {
  digest: string
  platformLabel: string
  sizeBytes?: number
  error?: string
}

type TagManifestBreakdown = {
  tag: string
  manifestType: 'single' | 'list'
  sizeBytes?: number
  createdAt?: string
  error?: string
  manifests?: TagManifestPlatform[]
}

const registryBaseUrl = 'https://registry.ide-newton.ts.net'
const registryAcceptHeader = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const decodeRepositoryParam = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const encodeRepositoryParam = (value: string): string => encodeURIComponent(value)

const formatPlatformLabel = (descriptor: ManifestDescriptor): string => {
  const os = descriptor.platform?.os
  const arch = descriptor.platform?.architecture
  if (os && arch) {
    return `${os}/${arch}`
  }

  return os ?? arch ?? 'unknown'
}

const pickManifestDescriptor = (manifests: ManifestDescriptor[]): ManifestDescriptor | undefined => {
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

const isManifestList = (payload: RegistryManifest | ManifestList): payload is ManifestList =>
  Array.isArray((payload as ManifestList).manifests)

const calculateManifestSize = (manifest: RegistryManifest): number => {
  const configSize = manifest.config?.size ?? 0
  const layerSize = manifest.layers?.reduce((total, layer) => total + (layer.size ?? 0), 0) ?? 0

  return configSize + layerSize
}

const fetchManifest = async (
  repository: string,
  reference: string,
): Promise<{ payload?: RegistryManifest | ManifestList; error?: string }> => {
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

const fetchTagCreatedAt = async (
  repository: string,
  configDigest: string,
): Promise<{ createdAt?: string; error?: string }> => {
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

const fetchRegistryCatalog = async (): Promise<{ repositories: string[]; error?: string }> => {
  try {
    const catalogResponse = await fetch(new URL('/v2/_catalog', registryBaseUrl))
    if (!catalogResponse.ok) {
      return {
        repositories: [],
        error: `Registry catalog request failed (${catalogResponse.status})`,
      }
    }

    const catalog = (await catalogResponse.json()) as { repositories?: string[] }
    return { repositories: catalog.repositories ?? [] }
  } catch (error) {
    return {
      repositories: [],
      error: error instanceof Error ? error.message : 'Failed to load registry',
    }
  }
}

const fetchRepositoryTags = async (repository: string): Promise<{ tags: string[]; error?: string }> => {
  try {
    const tagsResponse = await fetch(new URL(`/v2/${repository}/tags/list`, registryBaseUrl))
    if (!tagsResponse.ok) {
      return {
        tags: [],
        error: `Tags request failed (${tagsResponse.status})`,
      }
    }

    const tagsPayload = (await tagsResponse.json()) as { tags?: string[] }
    return { tags: tagsPayload.tags ?? [] }
  } catch (error) {
    return {
      tags: [],
      error: error instanceof Error ? error.message : 'Failed to load tags',
    }
  }
}

const fetchRepositorySize = async (
  repository: string,
  reference: string,
): Promise<{ sizeBytes?: number; manifest?: RegistryManifest; error?: string }> => {
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

const fetchTagDetails = async (repository: string, tag: string): Promise<TagDetails> => {
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

const fetchTagManifestBreakdown = async (repository: string, tag: string): Promise<TagManifestBreakdown> => {
  const manifestResult = await fetchManifest(repository, tag)
  if (!manifestResult.payload) {
    return {
      tag,
      manifestType: 'single',
      error: manifestResult.error ?? 'Manifest not available',
    }
  }

  if (isManifestList(manifestResult.payload)) {
    const descriptors = manifestResult.payload.manifests ?? []
    if (!descriptors.length) {
      return {
        tag,
        manifestType: 'list',
        error: 'No manifest entries returned',
        manifests: [],
      }
    }

    const manifestEntries = await Promise.all(
      descriptors.map(async (descriptor) => {
        const platformLabel = formatPlatformLabel(descriptor)
        const nestedResult = await fetchManifest(repository, descriptor.digest)
        if (!nestedResult.payload || isManifestList(nestedResult.payload)) {
          return {
            digest: descriptor.digest,
            platformLabel,
            error: nestedResult.error ?? 'Manifest payload was not an image manifest',
          }
        }

        return {
          digest: descriptor.digest,
          platformLabel,
          sizeBytes: calculateManifestSize(nestedResult.payload),
          configDigest: nestedResult.payload.config?.digest,
        }
      }),
    )

    const selectedDescriptor = pickManifestDescriptor(descriptors)
    const selectedEntry = selectedDescriptor
      ? manifestEntries.find((entry) => entry.digest === selectedDescriptor.digest)
      : undefined
    const configDigest = selectedEntry?.configDigest
    const createdResult = configDigest ? await fetchTagCreatedAt(repository, configDigest) : undefined
    const manifests = manifestEntries.map(({ configDigest: _configDigest, ...entry }) => entry)
    const sizes = manifests.map((entry) => entry.sizeBytes).filter((size): size is number => typeof size === 'number')
    const sizeBytes = sizes.length ? sizes.reduce((total, size) => total + size, 0) : undefined
    const error = createdResult?.error ?? (sizeBytes ? undefined : 'Manifest sizes unavailable')

    return {
      tag,
      manifestType: 'list',
      sizeBytes,
      createdAt: createdResult?.createdAt,
      error,
      manifests,
    }
  }

  const sizeBytes = calculateManifestSize(manifestResult.payload)
  const configDigest = manifestResult.payload.config?.digest
  const createdResult = configDigest ? await fetchTagCreatedAt(repository, configDigest) : undefined
  const error = createdResult?.error ?? (!configDigest ? 'Manifest missing config digest' : undefined)

  return {
    tag,
    manifestType: 'single',
    sizeBytes,
    createdAt: createdResult?.createdAt,
    error,
  }
}

const formatSize = (bytes: number): string => {
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

export type {
  ManifestDescriptor,
  ManifestList,
  RegistryManifest,
  TagDetails,
  TagManifestBreakdown,
  TagManifestPlatform,
}
export {
  decodeRepositoryParam,
  encodeRepositoryParam,
  fetchRegistryCatalog,
  fetchRepositoryTags,
  fetchTagDetails,
  fetchTagManifestBreakdown,
  formatSize,
}

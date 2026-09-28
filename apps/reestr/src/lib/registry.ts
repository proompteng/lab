export type RegistryManifest = {
  config?: { size?: number; digest?: string }
  layers?: Array<{ size?: number }>
}

export type ManifestDescriptor = {
  digest: string
  platform?: { architecture?: string; os?: string }
}

export type ManifestList = {
  manifests?: ManifestDescriptor[]
}

export type TagDetails = {
  tag: string
  sizeBytes?: number
  createdAt?: string
  error?: string
}

export type TagManifestPlatform = {
  digest: string
  platformLabel: string
  sizeBytes?: number
  error?: string
}

export type TagManifestBreakdown = {
  tag: string
  manifestType: 'single' | 'list'
  sizeBytes?: number
  createdAt?: string
  error?: string
  manifests?: TagManifestPlatform[]
}

export const decodeRepositoryParam = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const encodeRepositoryParam = (value: string): string => encodeURIComponent(value)

export const formatSize = (bytes: number): string => {
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

import { draftMode } from 'next/headers'
import { DEFAULT_LANDING_CONTENT, type LandingContent } from '@/app/config'

const cmsUrl = process.env.LANDING_CMS_URL ?? process.env.NEXT_PUBLIC_CMS_URL

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeValues = (base: unknown, override: unknown): unknown => {
  if (Array.isArray(override)) {
    return override.length > 0 ? override : base
  }

  if (isRecord(base) && isRecord(override)) {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      merged[key] = mergeValues(merged[key], value)
    }
    return merged
  }

  if (typeof override === 'string') {
    return override.trim().length > 0 ? override : base
  }

  return override ?? base
}

const mergeLandingContent = (base: LandingContent, override?: Partial<LandingContent>): LandingContent =>
  mergeValues(base, override ?? {}) as LandingContent

const fetchLandingOverride = async (): Promise<Partial<LandingContent> | null> => {
  if (!cmsUrl) return null

  const url = new URL('/api/globals/landing', cmsUrl)
  const { isEnabled } = draftMode()

  if (isEnabled) {
    url.searchParams.set('draft', 'true')
  }

  const response = await fetch(url.toString(), {
    next: { revalidate: isEnabled ? 0 : 60 },
  })

  if (!response.ok) return null

  return (await response.json()) as Partial<LandingContent>
}

export const getLandingContent = async (): Promise<LandingContent> => {
  try {
    const override = await fetchLandingOverride()
    return mergeLandingContent(DEFAULT_LANDING_CONTENT, override ?? undefined)
  } catch {
    return DEFAULT_LANDING_CONTENT
  }
}

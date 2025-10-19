import { Effect } from 'effect'

import type { FetchResponse } from './types'

export const DEFAULT_API_BASE_URL = 'https://api.github.com'
export const DEFAULT_USER_AGENT = 'froussard-webhook'

export const trimTrailingSlash = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value)

export const resolveGitHubGraphqlUrl = (apiBaseUrl: string): string => {
  const trimmed = trimTrailingSlash(apiBaseUrl)
  if (trimmed.endsWith('/api/v3')) {
    return `${trimmed.slice(0, -2)}graphql`
  }
  if (trimmed.endsWith('/api')) {
    return `${trimmed}/graphql`
  }
  return `${trimmed}/graphql`
}

export const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export const readResponseText = (response: FetchResponse) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: toError,
  })

export const coerceNumericId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

export const summarizeText = (value: unknown, maxLength = 200): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }
  if (normalized.length > maxLength) {
    return `${normalized.slice(0, maxLength - 1)}…`
  }
  return normalized
}

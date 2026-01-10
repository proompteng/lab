export type GithubReviewConfig = {
  githubToken: string | null
  githubApiBaseUrl: string
  reposAllowed: string[]
  reviewsWriteEnabled: boolean
  mergeWriteEnabled: boolean
  mergeForceEnabled: boolean
}

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'

const parseList = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const parseBool = (raw: string | undefined, fallback: boolean) => {
  if (!raw) return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return fallback
}

export const loadGithubReviewConfig = (): GithubReviewConfig => {
  const githubToken = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim() || null
  const githubApiBaseUrl = (process.env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE).trim()
  const reposAllowed = parseList(process.env.JANGAR_GITHUB_REPOS_ALLOWED)
  const reviewsWriteEnabled = parseBool(process.env.JANGAR_GITHUB_REVIEWS_WRITE, true)
  const mergeWriteEnabled = parseBool(process.env.JANGAR_GITHUB_MERGE_WRITE, false)
  const mergeForceEnabled = parseBool(process.env.JANGAR_GITHUB_MERGE_FORCE, false)

  return {
    githubToken,
    githubApiBaseUrl,
    reposAllowed,
    reviewsWriteEnabled,
    mergeWriteEnabled,
    mergeForceEnabled,
  }
}

export const isGithubRepoAllowed = (config: GithubReviewConfig, repository: string) => {
  if (!repository) return false
  if (config.reposAllowed.length === 0) return false
  if (config.reposAllowed.includes('*')) return true
  return config.reposAllowed.some((allowed) => allowed.toLowerCase() === repository.toLowerCase())
}

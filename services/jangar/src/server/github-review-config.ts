type EnvSource = Record<string, string | undefined>

export type GithubReviewConfig = {
  githubToken: string | null
  githubApiBaseUrl: string
  reposAllowed: string[]
  reviewsWriteEnabled: boolean
  mergeWriteEnabled: boolean
  mergeForceEnabled: boolean
  mergeHoldLabel: string | null
  automergeBranchPrefixes: string[]
  automergeRequiredCheckNames: string[]
  automergeAllowedFilePrefixes: string[]
  automergeBlockedFilePrefixes: string[]
  automergeAllowedRiskClasses: string[]
  minRequestSpacingMs: number
  worktreeRefreshFailureTtlMs: number
}

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'
const DEFAULT_MIN_REQUEST_SPACING_MS = 250
const DEFAULT_WORKTREE_REFRESH_FAILURE_TTL_MS = 60_000

const normalizeNonEmpty = (raw: string | undefined) => {
  const normalized = raw?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

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

const parsePositiveInt = (raw: string | undefined, fallback: number, minimum = 0) => {
  const normalized = normalizeNonEmpty(raw)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback
  return Math.floor(parsed)
}

export const loadGithubReviewConfig = (env: EnvSource = process.env): GithubReviewConfig => {
  const githubToken = normalizeNonEmpty(env.GITHUB_TOKEN ?? env.GH_TOKEN) ?? null
  const githubApiBaseUrl = normalizeNonEmpty(env.GITHUB_API_BASE_URL) ?? DEFAULT_GITHUB_API_BASE
  const reposAllowed = parseList(env.JANGAR_GITHUB_REPOS_ALLOWED)
  const reviewsWriteEnabled = parseBool(env.JANGAR_GITHUB_REVIEWS_WRITE, true)
  const mergeWriteEnabled = parseBool(env.JANGAR_GITHUB_MERGE_WRITE, false)
  const mergeForceEnabled = parseBool(env.JANGAR_GITHUB_MERGE_FORCE, false)
  const mergeHoldLabel = normalizeNonEmpty(env.JANGAR_GITHUB_MERGE_HOLD_LABEL ?? 'do-not-automerge') ?? null
  const automergeBranchPrefixes = parseList(env.JANGAR_GITHUB_AUTOMERGE_BRANCH_PREFIXES) || ['codex/swarm-']
  const automergeRequiredCheckNames = parseList(env.JANGAR_GITHUB_AUTOMERGE_REQUIRED_CHECKS)
  const automergeAllowedFilePrefixes = parseList(env.JANGAR_GITHUB_AUTOMERGE_ALLOWED_FILE_PREFIXES)
  const automergeBlockedFilePrefixes = parseList(env.JANGAR_GITHUB_AUTOMERGE_BLOCKED_FILE_PREFIXES)
  const automergeAllowedRiskClasses = parseList(env.JANGAR_GITHUB_AUTOMERGE_ALLOWED_RISK_CLASSES).map((value) =>
    value.toLowerCase(),
  )

  return {
    githubToken,
    githubApiBaseUrl,
    reposAllowed,
    reviewsWriteEnabled,
    mergeWriteEnabled,
    mergeForceEnabled,
    mergeHoldLabel,
    automergeBranchPrefixes,
    automergeRequiredCheckNames,
    automergeAllowedFilePrefixes,
    automergeBlockedFilePrefixes,
    automergeAllowedRiskClasses,
    minRequestSpacingMs: parsePositiveInt(env.JANGAR_GITHUB_MIN_REQUEST_SPACING_MS, DEFAULT_MIN_REQUEST_SPACING_MS, 0),
    worktreeRefreshFailureTtlMs:
      parsePositiveInt(env.JANGAR_GITHUB_WORKTREE_REFRESH_FAILURE_TTL_SECONDS, 60, 1) * 1_000 ||
      DEFAULT_WORKTREE_REFRESH_FAILURE_TTL_MS,
  }
}

export const validateGithubReviewConfig = (env: EnvSource = process.env) => {
  const config = loadGithubReviewConfig(env)
  new URL(config.githubApiBaseUrl)
}

export const isGithubRepoAllowed = (config: GithubReviewConfig, repository: string) => {
  if (!repository) return false
  if (config.reposAllowed.length === 0) return false
  if (config.reposAllowed.includes('*')) return true
  return config.reposAllowed.some((allowed) => allowed.toLowerCase() === repository.toLowerCase())
}

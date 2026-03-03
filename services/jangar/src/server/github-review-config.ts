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
  const mergeHoldLabel = (process.env.JANGAR_GITHUB_MERGE_HOLD_LABEL ?? 'do-not-automerge').trim() || null
  const automergeBranchPrefixes = parseList(process.env.JANGAR_GITHUB_AUTOMERGE_BRANCH_PREFIXES) || ['codex/swarm-']
  const automergeRequiredCheckNames = parseList(process.env.JANGAR_GITHUB_AUTOMERGE_REQUIRED_CHECKS)
  const automergeAllowedFilePrefixes = parseList(process.env.JANGAR_GITHUB_AUTOMERGE_ALLOWED_FILE_PREFIXES)
  const automergeBlockedFilePrefixes = parseList(process.env.JANGAR_GITHUB_AUTOMERGE_BLOCKED_FILE_PREFIXES)
  const automergeAllowedRiskClasses = parseList(process.env.JANGAR_GITHUB_AUTOMERGE_ALLOWED_RISK_CLASSES).map((value) =>
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
  }
}

export const isGithubRepoAllowed = (config: GithubReviewConfig, repository: string) => {
  if (!repository) return false
  if (config.reposAllowed.length === 0) return false
  if (config.reposAllowed.includes('*')) return true
  return config.reposAllowed.some((allowed) => allowed.toLowerCase() === repository.toLowerCase())
}

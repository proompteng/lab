type EnvSource = Record<string, string | undefined>

const DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const DEFAULT_WHITEPAPER_FINALIZE_BASE_URL = 'http://torghut.torghut.svc.cluster.local'
const DEFAULT_WHITEPAPER_OUTPUT_FETCH_ATTEMPTS = 12
const DEFAULT_WHITEPAPER_OUTPUT_FETCH_DELAY_MS = 5_000
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

const parseSecureFlag = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  return !['0', 'false', 'no', 'off', 'disabled'].includes(normalized)
}

export type WhitepaperControlConfig = {
  enabled: boolean
  baseUrl: string
  token: string | null
  useServiceAccountToken: boolean
  serviceAccountTokenPath: string
  outputFetchAttempts: number
  outputFetchDelayMs: number
}

export type WhitepaperGitHubConfig = {
  token: string | null
  apiBaseUrl: string
}

export type WhitepaperStorageConfig = {
  endpoint: string
  accessKey: string
  secretKey: string
  region: string
}

export const resolveWhitepaperControlConfig = (env: EnvSource = process.env): WhitepaperControlConfig => ({
  enabled: parseBoolean(env.JANGAR_WHITEPAPER_FINALIZE_ENABLED, true),
  baseUrl:
    normalizeNonEmpty(env.JANGAR_WHITEPAPER_CONTROL_BASE_URL) ??
    normalizeNonEmpty(env.JANGAR_WHITEPAPER_FINALIZE_BASE_URL) ??
    normalizeNonEmpty(env.TORGHUT_BASE_URL) ??
    DEFAULT_WHITEPAPER_FINALIZE_BASE_URL,
  token:
    normalizeNonEmpty(env.JANGAR_WHITEPAPER_CONTROL_TOKEN) ??
    normalizeNonEmpty(env.JANGAR_WHITEPAPER_FINALIZE_TOKEN) ??
    normalizeNonEmpty(env.WHITEPAPER_WORKFLOW_API_TOKEN) ??
    normalizeNonEmpty(env.JANGAR_API_KEY),
  useServiceAccountToken: parseBoolean(env.JANGAR_WHITEPAPER_FINALIZE_USE_SERVICE_ACCOUNT_TOKEN, true),
  serviceAccountTokenPath:
    normalizeNonEmpty(env.JANGAR_WHITEPAPER_SERVICE_ACCOUNT_TOKEN_PATH) ?? DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
  outputFetchAttempts: parsePositiveInt(
    env.JANGAR_WHITEPAPER_OUTPUT_FETCH_ATTEMPTS,
    DEFAULT_WHITEPAPER_OUTPUT_FETCH_ATTEMPTS,
  ),
  outputFetchDelayMs: parsePositiveInt(
    env.JANGAR_WHITEPAPER_OUTPUT_FETCH_DELAY_MS,
    DEFAULT_WHITEPAPER_OUTPUT_FETCH_DELAY_MS,
  ),
})

export const resolveWhitepaperGitHubConfig = (env: EnvSource = process.env): WhitepaperGitHubConfig => ({
  token: normalizeNonEmpty(env.GITHUB_TOKEN) ?? normalizeNonEmpty(env.GH_TOKEN),
  apiBaseUrl: normalizeNonEmpty(env.GITHUB_API_BASE_URL) ?? DEFAULT_GITHUB_API_BASE_URL,
})

export const resolveWhitepaperStorageConfig = (env: EnvSource = process.env): WhitepaperStorageConfig => {
  const explicitEndpoint = normalizeNonEmpty(env.WHITEPAPER_CEPH_ENDPOINT) ?? normalizeNonEmpty(env.MINIO_ENDPOINT)
  const bucketHost = normalizeNonEmpty(env.WHITEPAPER_CEPH_BUCKET_HOST) ?? normalizeNonEmpty(env.BUCKET_HOST)
  const bucketPort = normalizeNonEmpty(env.WHITEPAPER_CEPH_BUCKET_PORT) ?? normalizeNonEmpty(env.BUCKET_PORT)
  const secure = parseSecureFlag(env.WHITEPAPER_CEPH_USE_TLS ?? env.MINIO_SECURE, true)
  const endpoint =
    explicitEndpoint ??
    (bucketHost ? `${secure ? 'https' : 'http'}://${bucketHost}${bucketPort ? `:${bucketPort}` : ''}` : '')

  return {
    endpoint,
    accessKey:
      normalizeNonEmpty(env.WHITEPAPER_CEPH_ACCESS_KEY) ??
      normalizeNonEmpty(env.AWS_ACCESS_KEY_ID) ??
      normalizeNonEmpty(env.MINIO_ACCESS_KEY) ??
      '',
    secretKey:
      normalizeNonEmpty(env.WHITEPAPER_CEPH_SECRET_KEY) ??
      normalizeNonEmpty(env.AWS_SECRET_ACCESS_KEY) ??
      normalizeNonEmpty(env.MINIO_SECRET_KEY) ??
      '',
    region:
      normalizeNonEmpty(env.WHITEPAPER_CEPH_REGION) ??
      normalizeNonEmpty(env.AWS_REGION) ??
      normalizeNonEmpty(env.AWS_DEFAULT_REGION) ??
      'us-east-1',
  }
}

export const validateWhitepaperConfig = (env: EnvSource = process.env) => {
  const control = resolveWhitepaperControlConfig(env)
  new URL(control.baseUrl)
  const github = resolveWhitepaperGitHubConfig(env)
  new URL(github.apiBaseUrl)

  const storage = resolveWhitepaperStorageConfig(env)
  if (storage.endpoint) {
    new URL(storage.endpoint)
  }
}

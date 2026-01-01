import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { SQL } from 'bun'
import { Effect } from 'effect'
import * as TSemaphore from 'effect/TSemaphore'
import { Language, Parser } from 'web-tree-sitter'
import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml'

export type ReadRepoFileInput = {
  repoRoot: string
  filePath: string
  repository?: string
  ref?: string | null
  commit?: string | null
}

export type ListRepoFilesInput = {
  repoRoot: string
  ref?: string | null
  pathPrefix?: string | null
  maxFiles?: number | null
}

export type ListRepoFilesOutput = {
  files: string[]
  total: number
  skipped: number
}

export type FileMetadata = {
  repoName: string
  repoRef: string | null
  repoCommit: string | null
  path: string
  contentHash: string
  language: string | null
  byteSize: number
  lineCount: number
  sourceTimestamp: string | null
  metadata: Record<string, unknown>
}

export type TreeSitterFact = {
  nodeType: string
  matchText: string
  startLine: number
  endLine: number
  metadata?: Record<string, unknown>
}

export type ReadRepoFileOutput = {
  content: string
  metadata: FileMetadata
}

export type AstGrepInput = {
  repoRoot: string
  filePath: string
  content?: string
}

export type AstSummaryOutput = {
  astSummary: string
  facts: TreeSitterFact[]
  metadata: Record<string, unknown>
}

export type EnrichInput = {
  filename: string
  content: string
  astSummary: string
  context: string
}

export type EnrichOutput = {
  summary: string
  enriched: string
  metadata: Record<string, unknown>
}

export type EmbeddingInput = {
  text: string
}

export type PersistFileVersionInput = {
  fileMetadata: FileMetadata
}

export type PersistFileVersionOutput = {
  repositoryId: string
  fileKeyId: string
  fileVersionId: string
}

export type PersistEnrichmentRecordInput = {
  fileVersionId: string
  summary: string
  enriched: string
  astSummary: string
  contentHash: string
  metadata: Record<string, unknown>
}

export type PersistEnrichmentRecordOutput = {
  enrichmentId: string
}

export type PersistEmbeddingInput = {
  enrichmentId: string
  embedding: number[]
}

export type PersistFactsInput = {
  fileVersionId: string
  facts: TreeSitterFact[]
}

export type CleanupEnrichmentInput = {
  fileMetadata: FileMetadata
}

export type CleanupEnrichmentOutput = {
  fileVersions: number
  enrichments: number
  embeddings: number
  facts: number
}

export type MarkEventProcessedInput = {
  deliveryId: string
}

export type UpsertIngestionInput = {
  deliveryId: string
  workflowId: string
  status: string
  error?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export type UpsertIngestionOutput = {
  ingestionId: string
  eventId: string
} | null

export type UpsertEventFileInput = {
  deliveryId: string
  fileKeyId: string
  changeType: string
}

export type UpsertEventFileOutput = {
  eventFileId: string
  eventId: string
  fileKeyId: string
} | null

export type UpsertIngestionTargetInput = {
  ingestionId: string
  fileVersionId: string
  kind: string
}

export type BumbaActivities = typeof activities

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding-saigak:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024
const DEFAULT_OPENAI_COMPLETION_MODEL = 'gpt-5.2-codex'
const DEFAULT_SELF_HOSTED_COMPLETION_MODEL = 'qwen3-coder-saigak:30b-a3b-q4_K_M'
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'
const DEFAULT_GITHUB_API_VERSION = '2022-11-28'

const MAX_AST_BYTES = 200_000
const MAX_FACTS = 300
const MAX_FACT_CHARS = 200
const MAX_SUMMARY_NODES = 80
const MAX_COMPLETION_INPUT_CHARS = 12_000
const DEFAULT_COMPLETION_MAX_OUTPUT_TOKENS = 512
const MAX_COMPLETION_LOG_CHARS = 2_000
const DEFAULT_MODEL_CONCURRENCY = 2
const DEFAULT_COMPLETION_MAX_ATTEMPTS = 2
const DEFAULT_COMPLETION_RETRY_INITIAL_MS = 1_000
const DEFAULT_COMPLETION_RETRY_MAX_MS = 15_000
const DEFAULT_COMPLETION_RETRY_BACKOFF = 2
const DEFAULT_COMPLETION_REPAIR_OUTPUT_CHARS = 4_000
const DEFAULT_EMBEDDING_MAX_ATTEMPTS = 2
const DEFAULT_EMBEDDING_RETRY_INITIAL_MS = 500
const DEFAULT_EMBEDDING_RETRY_MAX_MS = 8_000
const DEFAULT_EMBEDDING_RETRY_BACKOFF = 2
const DEFAULT_EMBEDDING_BATCH_WINDOW_MS = 0
const DEFAULT_MAX_REPO_FILES = 5_000
const MAX_REPO_FILES = 20_000

const logActivity = (
  level: 'info' | 'error',
  event: string,
  activity: string,
  fields: Record<string, unknown> = {},
) => {
  const payload = { event, activity, ...fields }
  if (level === 'error') {
    console.error('[bumba:activity]', payload)
  } else {
    console.log('[bumba:activity]', payload)
  }
}

const formatActivityError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const createNonRetryableError = (message: string, name = 'NonRetryableError'): Error => {
  const error = new Error(message)
  error.name = name
  ;(error as { nonRetryable?: boolean }).nonRetryable = true
  return error
}

const createRetryableError = (message: string, retryAfterMs?: number): Error => {
  const error = new Error(message)
  error.name = 'RetryableError'
  ;(error as { retryable?: boolean; retryAfterMs?: number }).retryable = true
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    ;(error as { retryAfterMs?: number }).retryAfterMs = retryAfterMs
  }
  return error
}

const isRetryableError = (error: unknown): error is Error & { retryable?: boolean; retryAfterMs?: number } =>
  Boolean(error && typeof error === 'object' && (error as { retryable?: boolean }).retryable)

const isNonRetryableError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { nonRetryable?: boolean }).nonRetryable)

const sleepMs = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs)
  })

const jitterDelayMs = (delayMs: number) => {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  const jitter = delayMs * (0.15 + Math.random() * 0.2)
  return Math.max(0, Math.round(delayMs - jitter))
}

const computeBackoffDelayMs = (
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffCoefficient: number,
) => {
  if (attempt <= 1) return initialDelayMs
  const exponent = backoffCoefficient ** (attempt - 1)
  const delay = initialDelayMs * exponent
  return Math.min(delay, maxDelayMs)
}

const parseRetryAfterMs = (response: Response): number | undefined => {
  const header = response.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number.parseInt(header, 10)
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000
  }
  const parsedDate = Date.parse(header)
  if (Number.isFinite(parsedDate)) {
    const delayMs = parsedDate - Date.now()
    if (delayMs > 0) return delayMs
  }
  return undefined
}

const LOCK_FILENAMES = new Set([
  'bun.lock',
  'composer.lock',
  'cargo.lock',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'poetry.lock',
  'pipfile.lock',
  'yarn.lock',
  'npm-shrinkwrap.json',
])

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.db',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.icns',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.ttf',
  '.wav',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
  '.wasm',
  '.bin',
])

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeOptionalNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const normalizeOptionalBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value
  const trimmed = normalizeOptionalText(value)
  if (!trimmed) return null
  const normalized = trimmed.toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return null
}

const shouldSkipRepoFile = (filePath: string) => {
  const normalized = filePath.trim()
  if (!normalized) return true
  const lower = normalized.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  const extension = extname(base)

  if (LOCK_FILENAMES.has(base)) return true
  if (extension === '.lock') return true
  if (BINARY_EXTENSIONS.has(extension)) return true

  return false
}

const normalizePathPrefix = (value: unknown) => {
  const trimmed = normalizeOptionalText(value)
  if (!trimmed) return null
  if (trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new Error('pathPrefix must be repo-relative')
  }
  return trimmed.replace(/^\//, '')
}

const resolvePath = (repoRoot: string, filePath: string) => {
  const root = resolve(repoRoot)
  const fullPath = resolve(root, filePath)
  const relativePath = relative(root, fullPath)
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    throw new Error(`file path escapes repo root: ${filePath}`)
  }
  return fullPath
}

const normalizeRepositorySlug = (value: string) => {
  const trimmed = value.trim().replace(/\.git$/, '')
  const withoutPrefix = trimmed
    .replace(/^git@github\.com:/, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/^github\.com\//, '')
  return withoutPrefix
}

const normalizeRepositoryRef = (value: string | null | undefined) => {
  const trimmed = normalizeOptionalText(value)
  if (!trimmed) return null
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length)
  }
  if (trimmed.startsWith('refs/tags/')) {
    return `tags/${trimmed.slice('refs/tags/'.length)}`
  }
  if (trimmed.startsWith('refs/remotes/')) {
    return trimmed.slice('refs/remotes/'.length)
  }
  return trimmed
}

const resolveGithubToken = () =>
  normalizeOptionalText(process.env.GITHUB_TOKEN) ?? normalizeOptionalText(process.env.GH_TOKEN)

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

const loadEmbeddingDimension = (fallback: number) => {
  const dimension = Number.parseInt(process.env.OPENAI_EMBEDDING_DIMENSION ?? String(fallback), 10)
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_DIMENSION must be a positive integer', 'EmbeddingConfigError')
  }
  return dimension
}

const loadEmbeddingTimeoutMs = () => {
  const timeoutMs = Number.parseInt(process.env.OPENAI_EMBEDDING_TIMEOUT_MS ?? '15000', 10)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_TIMEOUT_MS must be a positive integer', 'EmbeddingConfigError')
  }
  return timeoutMs
}

const loadEmbeddingMaxInputChars = () => {
  const maxInputChars = Number.parseInt(process.env.OPENAI_EMBEDDING_MAX_INPUT_CHARS ?? '60000', 10)
  if (!Number.isFinite(maxInputChars) || maxInputChars <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_MAX_INPUT_CHARS must be a positive integer', 'EmbeddingConfigError')
  }
  return maxInputChars
}

const loadEmbeddingBatchSize = () => {
  const batchSize = Number.parseInt(process.env.OPENAI_EMBEDDING_BATCH_SIZE ?? '1', 10)
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_BATCH_SIZE must be a positive integer', 'EmbeddingConfigError')
  }
  return batchSize
}

const loadEmbeddingBatchWindowMs = () => {
  const windowMs = Number.parseInt(
    process.env.OPENAI_EMBEDDING_BATCH_WINDOW_MS ?? String(DEFAULT_EMBEDDING_BATCH_WINDOW_MS),
    10,
  )
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw createNonRetryableError(
      'OPENAI_EMBEDDING_BATCH_WINDOW_MS must be a non-negative integer',
      'EmbeddingConfigError',
    )
  }
  return windowMs
}

const loadEmbeddingBatchMaxChars = () => {
  const raw = process.env.OPENAI_EMBEDDING_MAX_BATCH_CHARS
  if (!raw) return null
  const maxChars = Number.parseInt(raw, 10)
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw createNonRetryableError(
      'OPENAI_EMBEDDING_MAX_BATCH_CHARS must be a positive integer when set',
      'EmbeddingConfigError',
    )
  }
  return maxChars
}

const loadEmbeddingRetryConfig = () => {
  const maxAttempts = Number.parseInt(
    process.env.OPENAI_EMBEDDING_MAX_ATTEMPTS ?? String(DEFAULT_EMBEDDING_MAX_ATTEMPTS),
    10,
  )
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_MAX_ATTEMPTS must be a positive integer', 'EmbeddingConfigError')
  }
  const initialDelayMs = Number.parseInt(
    process.env.OPENAI_EMBEDDING_RETRY_INITIAL_MS ?? String(DEFAULT_EMBEDDING_RETRY_INITIAL_MS),
    10,
  )
  const maxDelayMs = Number.parseInt(
    process.env.OPENAI_EMBEDDING_RETRY_MAX_MS ?? String(DEFAULT_EMBEDDING_RETRY_MAX_MS),
    10,
  )
  const backoffCoefficient = Number.parseFloat(
    process.env.OPENAI_EMBEDDING_RETRY_BACKOFF ?? String(DEFAULT_EMBEDDING_RETRY_BACKOFF),
  )
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
    throw createNonRetryableError(
      'OPENAI_EMBEDDING_RETRY_INITIAL_MS must be a positive integer',
      'EmbeddingConfigError',
    )
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_RETRY_MAX_MS must be a positive integer', 'EmbeddingConfigError')
  }
  if (!Number.isFinite(backoffCoefficient) || backoffCoefficient <= 0) {
    throw createNonRetryableError('OPENAI_EMBEDDING_RETRY_BACKOFF must be a positive number', 'EmbeddingConfigError')
  }
  return { maxAttempts, initialDelayMs, maxDelayMs, backoffCoefficient }
}

const resolveEmbeddingBaseUrl = (apiBaseUrl: string) => {
  const override = normalizeOptionalText(process.env.OPENAI_EMBEDDING_API_BASE_URL)
  const raw = override ?? apiBaseUrl
  return raw.replace(/\/+$/, '')
}

const isOllamaEmbedBaseUrl = (rawBaseUrl: string) => rawBaseUrl.endsWith('/api')

const resolveEmbeddingDefaults = (apiBaseUrl: string) => {
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  return {
    model: hosted ? DEFAULT_OPENAI_EMBEDDING_MODEL : DEFAULT_SELF_HOSTED_EMBEDDING_MODEL,
    dimension: hosted ? DEFAULT_OPENAI_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION,
  }
}

const resolveCompletionDefaults = (apiBaseUrl: string) => {
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  return {
    model: hosted ? DEFAULT_OPENAI_COMPLETION_MODEL : DEFAULT_SELF_HOSTED_COMPLETION_MODEL,
  }
}

const loadEmbeddingConfig = () => {
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY?.trim() || null
  if (!apiKey && isHostedOpenAiBaseUrl(apiBaseUrl)) {
    throw createNonRetryableError(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
      'EmbeddingConfigError',
    )
  }
  const embeddingBaseUrl = resolveEmbeddingBaseUrl(apiBaseUrl)
  const defaults = resolveEmbeddingDefaults(apiBaseUrl)
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? defaults.model
  const dimension = loadEmbeddingDimension(defaults.dimension)
  const timeoutMs = loadEmbeddingTimeoutMs()
  const maxInputChars = loadEmbeddingMaxInputChars()
  const truncate = normalizeOptionalBoolean(process.env.OPENAI_EMBEDDING_TRUNCATE) ?? false
  const keepAlive = normalizeOptionalText(process.env.OPENAI_EMBEDDING_KEEP_ALIVE)
  const batchSize = loadEmbeddingBatchSize()

  return {
    apiKey,
    apiBaseUrl,
    embeddingBaseUrl,
    model,
    dimension,
    timeoutMs,
    maxInputChars,
    truncate,
    keepAlive,
    batchSize,
  }
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const runCommandRaw = async (
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<CommandResult> => {
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: env ? { ...process.env, ...env } : process.env,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {
      exitCode,
      stdout,
      stderr,
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

const runCommandResult = async (
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<CommandResult> => {
  const result = await runCommandRaw(args, cwd, env)
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

const runCommand = async (
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<string | null> => {
  const result = await runCommandResult(args, cwd, env)
  if (result.exitCode !== 0) return null
  return result.stdout.length > 0 ? result.stdout : null
}

const buildGitAuthArgs = (token: string | null) =>
  token ? ['-c', `http.extraheader=Authorization: Bearer ${token}`] : []

const commitExistsLocally = async (repoRoot: string, commit: string) => {
  const result = await runCommandResult(['git', '-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`], repoRoot, {
    GIT_TERMINAL_PROMPT: '0',
  })
  return result.exitCode === 0
}

const fetchCommitFromOrigin = async (repoRoot: string, commit: string) => {
  const token = resolveGithubToken()
  const args = ['git', '-C', repoRoot, ...buildGitAuthArgs(token), 'fetch', '--quiet', '--depth=1', 'origin', commit]
  const result = await runCommandResult(args, repoRoot, { GIT_TERMINAL_PROMPT: '0' })
  return result.exitCode === 0
}

const readGitFile = async (repoRoot: string, ref: string, filePath: string) => {
  const result = await runCommandRaw(['git', '-C', repoRoot, 'show', `${ref}:${filePath}`], repoRoot, {
    GIT_TERMINAL_PROMPT: '0',
  })
  if (result.exitCode !== 0) return null
  return result.stdout
}

type RepositoryOverrides = {
  repository?: string | null
  ref?: string | null
  commit?: string | null
}

const resolveRepositoryInfo = async (repoRoot: string, overrides: RepositoryOverrides = {}) => {
  const overrideRepo = normalizeOptionalText(overrides.repository)
  const overrideRef = normalizeOptionalText(overrides.ref)
  const overrideCommit = normalizeOptionalText(overrides.commit)
  const envRepo = normalizeOptionalText(process.env.REPOSITORY)
  const envRef = normalizeOptionalText(process.env.REPOSITORY_REF)
  const envCommit = normalizeOptionalText(process.env.REPOSITORY_COMMIT)

  const fallbackName = basename(repoRoot)
  const defaultRepo =
    overrideRepo ??
    normalizeOptionalText(process.env.CODEX_REPO_SLUG) ??
    normalizeOptionalText(process.env.CODEX_REPO_URL) ??
    (await runCommand(['git', '-C', repoRoot, 'remote', 'get-url', 'origin'], repoRoot)) ??
    fallbackName
  const repoName = overrideRepo ?? envRepo ?? defaultRepo
  const repoRef =
    overrideRef ??
    envRef ??
    (await runCommand(['git', '-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)) ??
    null
  const repoCommit =
    overrideCommit ?? envCommit ?? (await runCommand(['git', '-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot)) ?? null

  const normalizedRepoName = repoName
    .replace(/\s+/g, '')
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^https?:\/\//, '')

  return {
    repoName: normalizedRepoName.length > 0 ? normalizedRepoName : fallbackName,
    repoRef: normalizeRepositoryRef(repoRef),
    repoCommit,
  }
}

type GithubFileResult = {
  content: string
  downloadUrl: string | null
  apiUrl: string
  sha: string | null
  size: number | null
}

const buildGithubHeaders = (token: string | null) => {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': DEFAULT_GITHUB_API_VERSION,
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  return headers
}

const encodeGithubPath = (filePath: string) =>
  filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

const fetchGithubFile = async (repository: string, filePath: string, ref: string | null): Promise<GithubFileResult> => {
  const token = resolveGithubToken()
  const apiBaseUrl = process.env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL
  const encodedPath = encodeGithubPath(filePath)
  const url = new URL(`/repos/${repository}/contents/${encodedPath}`, apiBaseUrl)
  if (ref) {
    url.searchParams.set('ref', ref)
  }

  const response = await fetch(url, { headers: buildGithubHeaders(token) })

  if (!response.ok) {
    const body = await response.text()
    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitHub auth failed; check GITHUB_TOKEN. ${response.status}: ${body}`)
    }
    throw new Error(`GitHub contents fetch failed (${response.status}): ${body}`)
  }

  const data = (await response.json()) as {
    type?: string
    content?: string
    encoding?: string
    sha?: string
    size?: number
    download_url?: string | null
    url?: string
    path?: string
  }

  if (!data || data.type !== 'file') {
    if (data?.type === 'dir' || data?.type === 'submodule') {
      const error = new Error(`GitHub contents API returned directory for ${filePath}`)
      error.name = 'DirectoryError'
      throw error
    }
    throw new Error(`GitHub contents API returned non-file for ${filePath}`)
  }

  if ((data.size ?? 0) === 0 && (!data.content || data.content.length === 0)) {
    return {
      content: '',
      downloadUrl: data.download_url ?? null,
      apiUrl: data.url ?? url.toString(),
      sha: data.sha ?? null,
      size: data.size ?? 0,
    }
  }

  if (data.content && data.encoding === 'base64') {
    const content = Buffer.from(data.content.replace(/\r?\n/g, ''), 'base64').toString('utf8')
    return {
      content,
      downloadUrl: data.download_url ?? null,
      apiUrl: data.url ?? url.toString(),
      sha: data.sha ?? null,
      size: data.size ?? null,
    }
  }

  if (data.download_url) {
    const rawResponse = await fetch(data.download_url)
    if (!rawResponse.ok) {
      const body = await rawResponse.text()
      throw new Error(`GitHub raw fetch failed (${rawResponse.status}): ${body}`)
    }
    const content = await rawResponse.text()
    return {
      content,
      downloadUrl: data.download_url ?? null,
      apiUrl: data.url ?? url.toString(),
      sha: data.sha ?? null,
      size: data.size ?? null,
    }
  }

  throw new Error(`GitHub contents API returned unsupported encoding for ${filePath}`)
}

type AstPoint = {
  row: number
  column: number
}

type AstNode = {
  type: string
  isNamed: boolean
  startIndex: number
  endIndex: number
  startPosition: AstPoint
  endPosition: AstPoint
  namedChildren: AstNode[]
}

type LoadedLanguage = {
  name: string
  language: Language
}

const require = createRequire(import.meta.url)
const runtimeWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm')

const languageNameByExtension = new Map<string, string>([
  ['.avsc', 'json'],
  ['.bash', 'bash'],
  ['.c', 'c'],
  ['.cfg', 'ini'],
  ['.cjs', 'javascript'],
  ['.conf', 'ini'],
  ['.css', 'css'],
  ['.erb', 'embedded-template'],
  ['.example', 'text'],
  ['.go', 'go'],
  ['.h', 'c'],
  ['.hcl', 'hcl'],
  ['.html', 'html'],
  ['.ini', 'ini'],
  ['.j2', 'jinja2'],
  ['.json', 'json'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.key', 'text'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.keep', 'text'],
  ['.md', 'markdown'],
  ['.mdx', 'mdx'],
  ['.mjs', 'javascript'],
  ['.mod', 'text'],
  ['.pem', 'text'],
  ['.proto', 'proto'],
  ['.properties', 'properties'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.ru', 'ruby'],
  ['.sh', 'bash'],
  ['.sql', 'sql'],
  ['.sum', 'text'],
  ['.svg', 'xml'],
  ['.tf', 'terraform'],
  ['.tmpl', 'embedded-template'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.txt', 'text'],
  ['.webmanifest', 'json'],
  ['.xml', 'xml'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.zig', 'zig'],
  ['.zsh', 'bash'],
])

const languageWasmByExtension = new Map<string, { name: string; wasmPath: string }>([
  ['.avsc', { name: 'json', wasmPath: require.resolve('tree-sitter-json/tree-sitter-json.wasm') }],
  ['.bash', { name: 'bash', wasmPath: require.resolve('tree-sitter-bash/tree-sitter-bash.wasm') }],
  ['.c', { name: 'c', wasmPath: require.resolve('tree-sitter-c/tree-sitter-c.wasm') }],
  ['.cjs', { name: 'javascript', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  ['.css', { name: 'css', wasmPath: require.resolve('tree-sitter-css/tree-sitter-css.wasm') }],
  [
    '.erb',
    {
      name: 'embedded-template',
      wasmPath: require.resolve('tree-sitter-embedded-template/tree-sitter-embedded_template.wasm'),
    },
  ],
  [
    '.tmpl',
    {
      name: 'embedded-template',
      wasmPath: require.resolve('tree-sitter-embedded-template/tree-sitter-embedded_template.wasm'),
    },
  ],
  ['.go', { name: 'go', wasmPath: require.resolve('tree-sitter-go/tree-sitter-go.wasm') }],
  ['.h', { name: 'c', wasmPath: require.resolve('tree-sitter-c/tree-sitter-c.wasm') }],
  ['.hcl', { name: 'hcl', wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-hcl.wasm') }],
  ['.html', { name: 'html', wasmPath: require.resolve('tree-sitter-html/tree-sitter-html.wasm') }],
  ['.j2', { name: 'jinja2', wasmPath: require.resolve('tree-sitter-jinja2/tree-sitter-jinja2.wasm') }],
  ['.json', { name: 'json', wasmPath: require.resolve('tree-sitter-json/tree-sitter-json.wasm') }],
  ['.js', { name: 'javascript', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  ['.jsx', { name: 'jsx', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  [
    '.kt',
    {
      name: 'kotlin',
      wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm'),
    },
  ],
  [
    '.kts',
    {
      name: 'kotlin',
      wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm'),
    },
  ],
  ['.mjs', { name: 'javascript', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  [
    '.properties',
    {
      name: 'properties',
      wasmPath: require.resolve('tree-sitter-properties/tree-sitter-properties.wasm'),
    },
  ],
  ['.py', { name: 'python', wasmPath: require.resolve('tree-sitter-python/tree-sitter-python.wasm') }],
  ['.rb', { name: 'ruby', wasmPath: require.resolve('tree-sitter-ruby/tree-sitter-ruby.wasm') }],
  ['.rs', { name: 'rust', wasmPath: require.resolve('tree-sitter-rust/tree-sitter-rust.wasm') }],
  ['.ru', { name: 'ruby', wasmPath: require.resolve('tree-sitter-ruby/tree-sitter-ruby.wasm') }],
  ['.sh', { name: 'bash', wasmPath: require.resolve('tree-sitter-bash/tree-sitter-bash.wasm') }],
  [
    '.tf',
    {
      name: 'terraform',
      wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-terraform.wasm'),
    },
  ],
  [
    '.toml',
    {
      name: 'toml',
      wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm'),
    },
  ],
  ['.ts', { name: 'typescript', wasmPath: require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm') }],
  ['.tsx', { name: 'tsx', wasmPath: require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm') }],
  ['.webmanifest', { name: 'json', wasmPath: require.resolve('tree-sitter-json/tree-sitter-json.wasm') }],
  [
    '.yaml',
    { name: 'yaml', wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm') },
  ],
  ['.yml', { name: 'yaml', wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm') }],
  [
    '.zig',
    {
      name: 'zig',
      wasmPath: require.resolve('@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm'),
    },
  ],
  ['.zsh', { name: 'bash', wasmPath: require.resolve('tree-sitter-bash/tree-sitter-bash.wasm') }],
])

let parserInitPromise: Promise<void> | null = null
const loadedLanguages = new Map<string, Language>()
const languageLoadPromises = new Map<string, Promise<Language>>()

const ensureParserInit = async () => {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile: () => runtimeWasmPath,
    })
  }
  await parserInitPromise
}

const loadLanguageForExtension = async (ext: string): Promise<LoadedLanguage | null> => {
  const entry = languageWasmByExtension.get(ext)
  if (!entry) return null

  await ensureParserInit()

  const cached = loadedLanguages.get(entry.name)
  if (cached) return { name: entry.name, language: cached }

  let loadPromise = languageLoadPromises.get(entry.name)
  if (!loadPromise) {
    loadPromise = Language.load(entry.wasmPath)
    languageLoadPromises.set(entry.name, loadPromise)
  }

  try {
    const language = await loadPromise
    loadedLanguages.set(entry.name, language)
    languageLoadPromises.delete(entry.name)
    return { name: entry.name, language }
  } catch (error) {
    languageLoadPromises.delete(entry.name)
    throw error
  }
}

const clampNumber = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback)
const clampNonNegativeNumber = (value: number, fallback: number) =>
  Number.isFinite(value) && value >= 0 ? value : fallback
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

const completionConcurrency = clampNumber(
  Number.parseInt(process.env.BUMBA_COMPLETION_CONCURRENCY ?? '', 10),
  clampNumber(Number.parseInt(process.env.BUMBA_MODEL_CONCURRENCY ?? '', 10), DEFAULT_MODEL_CONCURRENCY),
)
const embeddingConcurrency = clampNumber(
  Number.parseInt(process.env.BUMBA_EMBEDDING_CONCURRENCY ?? '', 10),
  clampNumber(Number.parseInt(process.env.BUMBA_MODEL_CONCURRENCY ?? '', 10), DEFAULT_MODEL_CONCURRENCY),
)
const completionSemaphore = TSemaphore.unsafeMake(completionConcurrency)
const embeddingSemaphore = TSemaphore.unsafeMake(embeddingConcurrency)
const withCompletionConcurrency = async <T>(fn: () => Promise<T>): Promise<T> =>
  await Effect.runPromise(
    TSemaphore.withPermits(
      completionSemaphore,
      1,
    )(
      Effect.tryPromise({
        try: fn,
        catch: (error) => toError(error),
      }),
    ),
  )
const withEmbeddingConcurrency = async <T>(fn: () => Promise<T>): Promise<T> =>
  await Effect.runPromise(
    TSemaphore.withPermits(
      embeddingSemaphore,
      1,
    )(
      Effect.tryPromise({
        try: fn,
        catch: (error) => toError(error),
      }),
    ),
  )

const loadRepoListLimit = (requested?: number | null) => {
  const envLimit = clampNumber(Number.parseInt(process.env.BUMBA_MAX_REPO_FILES ?? '', 10), DEFAULT_MAX_REPO_FILES)
  const raw = normalizeOptionalNumber(requested) ?? envLimit
  const limited = clampNumber(raw, envLimit)
  return Math.min(limited, MAX_REPO_FILES)
}

const loadAstLimits = () => {
  const maxBytes = clampNumber(Number.parseInt(process.env.BUMBA_MAX_AST_BYTES ?? '', 10), MAX_AST_BYTES)
  const maxFacts = clampNumber(Number.parseInt(process.env.BUMBA_MAX_AST_FACTS ?? '', 10), MAX_FACTS)
  const maxFactChars = clampNumber(Number.parseInt(process.env.BUMBA_MAX_FACT_CHARS ?? '', 10), MAX_FACT_CHARS)
  const maxSummaryNodes = clampNumber(Number.parseInt(process.env.BUMBA_MAX_SUMMARY_NODES ?? '', 10), MAX_SUMMARY_NODES)

  return { maxBytes, maxFacts, maxFactChars, maxSummaryNodes }
}

const safeSlice = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...`
}

const summarizeCompletionOutput = (output: string, maxChars: number) => {
  if (output.length <= maxChars) {
    return {
      outputLength: output.length,
      outputHead: output,
      outputTail: '',
    }
  }

  const headSize = Math.floor(maxChars / 2)
  const tailSize = maxChars - headSize
  return {
    outputLength: output.length,
    outputHead: output.slice(0, headSize),
    outputTail: output.slice(-tailSize),
  }
}

const splitLines = (source: string) => source.split(/\r?\n/)

const interestingNodeTypes = [
  'class',
  'class_declaration',
  'class_definition',
  'function',
  'function_definition',
  'function_declaration',
  'method_definition',
  'method',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'struct_item',
  'trait_item',
  'impl_item',
  'import_statement',
  'import_declaration',
  'export_statement',
  'export_clause',
  'call_expression',
  'assignment_expression',
  'variable_declaration',
  'const_declaration',
  'let_declaration',
]

const isInterestingNode = (node: AstNode) => {
  if (!node.isNamed) return false
  if (interestingNodeTypes.includes(node.type)) return true
  return node.type.includes('declaration') || node.type.includes('definition')
}

const findIdentifier = (node: AstNode) => {
  const stack = [...node.namedChildren]
  while (stack.length > 0) {
    const current = stack.shift()
    if (!current) continue
    if (current.type === 'identifier' || current.type === 'property_identifier' || current.type === 'type_identifier') {
      return current
    }
    stack.push(...current.namedChildren)
  }
  return null
}

const buildAstSummary = (root: AstNode, source: string, maxSummaryNodes: number, maxFactChars: number) => {
  const summaries: string[] = []
  const children = root.namedChildren
  for (const node of children) {
    if (summaries.length >= maxSummaryNodes) break
    if (!node.isNamed) continue
    const identifier = findIdentifier(node)
    const name = identifier ? source.slice(identifier.startIndex, identifier.endIndex) : ''
    const start = node.startPosition.row + 1
    const end = node.endPosition.row + 1
    const label = name ? `${node.type} ${name}` : node.type
    summaries.push(`${label} (${start}-${end})`)
  }

  if (summaries.length === 0) {
    return 'No named AST nodes detected.'
  }

  return summaries.map((line) => safeSlice(line, maxFactChars)).join('\n')
}

const collectFacts = (root: AstNode, source: string, maxFacts: number, maxFactChars: number) => {
  const facts: TreeSitterFact[] = []
  const stack: AstNode[] = [root]

  while (stack.length > 0 && facts.length < maxFacts) {
    const node = stack.pop()
    if (!node) continue

    if (isInterestingNode(node)) {
      const matchText = safeSlice(source.slice(node.startIndex, node.endIndex).trim(), maxFactChars)
      facts.push({
        nodeType: node.type,
        matchText,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        metadata: undefined,
      })
    }

    const children = node.namedChildren
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (child) stack.push(child)
    }
  }

  return facts
}

const resolveLineRange = (lineCounter: LineCounter, range?: [number, number, number]) => {
  if (!range) return { startLine: 1, endLine: 1 }
  const start = lineCounter.linePos(range[0])?.line ?? 0
  const end = lineCounter.linePos(range[1])?.line ?? start
  return { startLine: start + 1, endLine: end + 1 }
}

const formatYamlValue = (value: unknown, maxFactChars: number) => {
  if (isScalar(value)) {
    return safeSlice(String(value.value ?? ''), maxFactChars)
  }
  if (isMap(value)) return '{...}'
  if (isSeq(value)) return '[...]'
  return safeSlice(String(value ?? ''), maxFactChars)
}

const _parseYamlAst = (
  source: string,
  maxFacts: number,
  maxFactChars: number,
  maxSummaryNodes: number,
): AstSummaryOutput => {
  const lineCounter = new LineCounter()

  try {
    const documents = parseAllDocuments(source, { lineCounter })
    if (documents.length === 0) {
      return {
        astSummary: 'Empty YAML document.',
        facts: [],
        metadata: { skipped: true, reason: 'empty_document', language: 'yaml' },
      }
    }

    const summaries: string[] = []
    const facts: TreeSitterFact[] = []

    for (const doc of documents) {
      const root = doc.contents
      if (!root) continue

      const stack: Array<{ node: unknown; path: string }> = [{ node: root, path: '' }]

      while (stack.length > 0 && (facts.length < maxFacts || summaries.length < maxSummaryNodes)) {
        const current = stack.pop()
        if (!current) continue

        const { node, path } = current
        if (isMap(node)) {
          for (const item of node.items) {
            const pair = item as { key?: unknown; value?: unknown; range?: [number, number, number] }
            const keyText = isScalar(pair.key) ? String(pair.key.value ?? '') : 'key'
            const nextPath = path ? `${path}.${keyText}` : keyText
            const { startLine, endLine } = resolveLineRange(lineCounter, pair.range)
            if (summaries.length < maxSummaryNodes) {
              summaries.push(`${nextPath} (${startLine}-${endLine})`)
            }
            if (facts.length < maxFacts) {
              facts.push({
                nodeType: 'yaml-pair',
                matchText: safeSlice(`${keyText}: ${formatYamlValue(pair.value, maxFactChars)}`, maxFactChars),
                startLine,
                endLine,
                metadata: undefined,
              })
            }
            if (pair.value) stack.push({ node: pair.value, path: nextPath })
          }
          continue
        }

        if (isSeq(node)) {
          node.items.forEach((item, index) => {
            const nextPath = `${path}${path ? '.' : ''}[${index}]`
            const range = (item as { range?: [number, number, number] }).range
            const { startLine, endLine } = resolveLineRange(lineCounter, range)
            if (summaries.length < maxSummaryNodes) {
              summaries.push(`${nextPath} (${startLine}-${endLine})`)
            }
            if (facts.length < maxFacts) {
              facts.push({
                nodeType: 'yaml-seq-item',
                matchText: safeSlice(`${nextPath}: ${formatYamlValue(item, maxFactChars)}`, maxFactChars),
                startLine,
                endLine,
                metadata: undefined,
              })
            }
            stack.push({ node: item, path: nextPath })
          })
        }
      }
    }

    if (summaries.length === 0) {
      summaries.push('No structured YAML nodes detected.')
    }

    return {
      astSummary: summaries.map((line) => safeSlice(line, maxFactChars)).join('\n'),
      facts,
      metadata: {
        language: 'yaml',
        parser: 'yaml',
        factCount: facts.length,
        documentCount: documents.length,
      },
    }
  } catch (error) {
    return {
      astSummary: 'YAML parse failed.',
      facts: [],
      metadata: {
        skipped: true,
        reason: 'parse_failed',
        language: 'yaml',
        error: error instanceof Error ? error.message : 'unknown_error',
      },
    }
  }
}

const parsePlainTextAst = (
  source: string,
  maxFacts: number,
  maxFactChars: number,
  maxSummaryNodes: number,
  language: string,
  parser = 'text',
): AstSummaryOutput => {
  const lines = splitLines(source)
  const summaries: string[] = []
  const facts: TreeSitterFact[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    const lineNumber = i + 1
    if (summaries.length < maxSummaryNodes) {
      summaries.push(`Line ${lineNumber}: ${safeSlice(line, maxFactChars)}`)
    }
    if (facts.length < maxFacts) {
      facts.push({
        nodeType: 'line',
        matchText: safeSlice(line, maxFactChars),
        startLine: lineNumber,
        endLine: lineNumber,
        metadata: undefined,
      })
    }
    if (summaries.length >= maxSummaryNodes && facts.length >= maxFacts) break
  }

  return {
    astSummary: summaries.length > 0 ? summaries.join('\n') : 'No non-empty lines detected.',
    facts,
    metadata: {
      language,
      parser,
      factCount: facts.length,
    },
  }
}

const createPlainTextParser =
  (language: string, parser = 'text') =>
  (source: string, maxFacts: number, maxFactChars: number, maxSummaryNodes: number) =>
    parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, language, parser)

const parseMarkdownAst = (
  source: string,
  maxFacts: number,
  maxFactChars: number,
  maxSummaryNodes: number,
): AstSummaryOutput => {
  const lines = splitLines(source)
  const summaries: string[] = []
  const facts: TreeSitterFact[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const match = line.match(/^(#{1,6})\s+(.*)$/)
    if (!match) continue
    const level = match[1]?.length ?? 1
    const text = (match[2] ?? '').trim()
    const lineNumber = i + 1
    if (summaries.length < maxSummaryNodes) {
      summaries.push(`H${level} ${safeSlice(text, maxFactChars)} (${lineNumber})`)
    }
    if (facts.length < maxFacts) {
      facts.push({
        nodeType: 'heading',
        matchText: safeSlice(text, maxFactChars),
        startLine: lineNumber,
        endLine: lineNumber,
        metadata: { level },
      })
    }
    if (summaries.length >= maxSummaryNodes && facts.length >= maxFacts) break
  }

  if (summaries.length === 0) {
    return parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, 'markdown', 'markdown')
  }

  return {
    astSummary: summaries.join('\n'),
    facts,
    metadata: {
      language: 'markdown',
      parser: 'markdown',
      factCount: facts.length,
    },
  }
}

const parseProtoAst = (
  source: string,
  maxFacts: number,
  maxFactChars: number,
  maxSummaryNodes: number,
): AstSummaryOutput => {
  const lines = splitLines(source)
  const summaries: string[] = []
  const facts: TreeSitterFact[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const lineNumber = i + 1
    const definition = line.match(/^\s*(message|enum|service)\s+([A-Za-z_][A-Za-z0-9_]*)/)
    const rpc = line.match(/^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (definition) {
      const [, kind, name] = definition
      if (summaries.length < maxSummaryNodes) {
        summaries.push(`${kind} ${safeSlice(name, maxFactChars)} (${lineNumber})`)
      }
      if (facts.length < maxFacts) {
        facts.push({
          nodeType: kind ?? 'definition',
          matchText: safeSlice(name ?? '', maxFactChars),
          startLine: lineNumber,
          endLine: lineNumber,
          metadata: undefined,
        })
      }
    } else if (rpc) {
      const name = rpc[1] ?? ''
      if (summaries.length < maxSummaryNodes) {
        summaries.push(`rpc ${safeSlice(name, maxFactChars)} (${lineNumber})`)
      }
      if (facts.length < maxFacts) {
        facts.push({
          nodeType: 'rpc',
          matchText: safeSlice(name, maxFactChars),
          startLine: lineNumber,
          endLine: lineNumber,
          metadata: undefined,
        })
      }
    }
    if (summaries.length >= maxSummaryNodes && facts.length >= maxFacts) break
  }

  if (summaries.length === 0) {
    return parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, 'proto', 'proto')
  }

  return {
    astSummary: summaries.join('\n'),
    facts,
    metadata: {
      language: 'proto',
      parser: 'proto',
      factCount: facts.length,
    },
  }
}

const parseIniAst = (
  source: string,
  maxFacts: number,
  maxFactChars: number,
  maxSummaryNodes: number,
): AstSummaryOutput => {
  const lines = splitLines(source)
  const summaries: string[] = []
  const facts: TreeSitterFact[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const lineNumber = i + 1
    const section = line.match(/^\[([^\]]+)\]$/)
    if (section) {
      const name = section[1] ?? ''
      if (summaries.length < maxSummaryNodes) {
        summaries.push(`[${safeSlice(name, maxFactChars)}] (${lineNumber})`)
      }
      if (facts.length < maxFacts) {
        facts.push({
          nodeType: 'section',
          matchText: safeSlice(name, maxFactChars),
          startLine: lineNumber,
          endLine: lineNumber,
          metadata: undefined,
        })
      }
    } else {
      const entry = line.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/)
      if (!entry) continue
      const key = entry[1] ?? ''
      const value = entry[2] ?? ''
      if (summaries.length < maxSummaryNodes) {
        summaries.push(`${safeSlice(key, maxFactChars)} (${lineNumber})`)
      }
      if (facts.length < maxFacts) {
        facts.push({
          nodeType: 'entry',
          matchText: safeSlice(`${key}=${value}`, maxFactChars),
          startLine: lineNumber,
          endLine: lineNumber,
          metadata: undefined,
        })
      }
    }
    if (summaries.length >= maxSummaryNodes && facts.length >= maxFacts) break
  }

  if (summaries.length === 0) {
    return parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, 'ini', 'ini')
  }

  return {
    astSummary: summaries.join('\n'),
    facts,
    metadata: {
      language: 'ini',
      parser: 'ini',
      factCount: facts.length,
    },
  }
}

const parseXmlAst = (
  source: string,
  maxFacts: number,
  maxFactChars: number,
  maxSummaryNodes: number,
): AstSummaryOutput => {
  const lines = splitLines(source)
  const summaries: string[] = []
  const facts: TreeSitterFact[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const lineNumber = i + 1
    const matches = line.matchAll(/<([A-Za-z0-9:_-]+)(\s|>|\/)/g)
    for (const match of matches) {
      const tag = match[1] ?? ''
      if (!tag || tag.startsWith('?') || tag.startsWith('!')) continue
      if (summaries.length < maxSummaryNodes) {
        summaries.push(`<${safeSlice(tag, maxFactChars)}> (${lineNumber})`)
      }
      if (facts.length < maxFacts) {
        facts.push({
          nodeType: 'tag',
          matchText: safeSlice(tag, maxFactChars),
          startLine: lineNumber,
          endLine: lineNumber,
          metadata: undefined,
        })
      }
      if (summaries.length >= maxSummaryNodes && facts.length >= maxFacts) break
    }
    if (summaries.length >= maxSummaryNodes && facts.length >= maxFacts) break
  }

  if (summaries.length === 0) {
    return parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, 'xml', 'xml')
  }

  return {
    astSummary: summaries.join('\n'),
    facts,
    metadata: {
      language: 'xml',
      parser: 'xml',
      factCount: facts.length,
    },
  }
}

const customAstParsers = new Map<
  string,
  (source: string, maxFacts: number, maxFactChars: number, maxSummaryNodes: number) => AstSummaryOutput
>([
  ['.cfg', parseIniAst],
  ['.conf', parseIniAst],
  ['.ini', parseIniAst],
  ['.key', createPlainTextParser('text')],
  ['.md', parseMarkdownAst],
  ['.mdx', parseMarkdownAst],
  ['.mod', createPlainTextParser('text')],
  ['.pem', createPlainTextParser('text')],
  ['.proto', parseProtoAst],
  ['.sql', createPlainTextParser('sql', 'text')],
  ['.sum', createPlainTextParser('text')],
  ['.svg', parseXmlAst],
  ['.txt', createPlainTextParser('text')],
  ['.xml', parseXmlAst],
  ['.example', createPlainTextParser('text')],
  ['.keep', createPlainTextParser('text')],
])

const parseAst = async (source: string, filePath: string): Promise<AstSummaryOutput> => {
  const { maxBytes, maxFacts, maxFactChars, maxSummaryNodes } = loadAstLimits()
  if (source.length > maxBytes) {
    return {
      astSummary: `AST parsing skipped (file too large: ${source.length} bytes).`,
      facts: [],
      metadata: { skipped: true, reason: 'max_bytes', maxBytes },
    }
  }

  const ext = extname(filePath).toLowerCase()
  const customParser = customAstParsers.get(ext)
  if (customParser) {
    return customParser(source, maxFacts, maxFactChars, maxSummaryNodes)
  }
  const fallbackLanguage = languageNameByExtension.get(ext) ?? 'text'
  let entry: LoadedLanguage | null

  try {
    entry = await loadLanguageForExtension(ext)
  } catch (error) {
    const fallback = parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, fallbackLanguage, 'text')
    return {
      ...fallback,
      metadata: {
        ...fallback.metadata,
        skipped: true,
        reason: 'language_load_failed',
        error: error instanceof Error ? error.message : 'unknown_error',
      },
    }
  }

  if (!entry) {
    const fallback = parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, fallbackLanguage, 'text')
    return {
      ...fallback,
      metadata: {
        ...fallback.metadata,
        skipped: true,
        reason: 'language_missing',
      },
    }
  }

  try {
    const parser = new Parser()
    parser.setLanguage(entry.language)
    const tree = parser.parse(source)
    if (!tree) {
      return {
        astSummary: 'Tree-sitter parse failed.',
        facts: [],
        metadata: { skipped: true, reason: 'parse_failed', language: entry.name },
      }
    }
    const root = tree.rootNode as AstNode

    const facts = collectFacts(root, source, maxFacts, maxFactChars)
    const astSummary = buildAstSummary(root, source, maxSummaryNodes, maxFactChars)
    if (facts.length === 0) {
      const fallback = parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, fallbackLanguage, 'text')
      return {
        astSummary,
        facts: fallback.facts,
        metadata: {
          language: entry.name,
          factCount: fallback.facts.length,
          factsFallback: 'text',
          factsFallbackLanguage: fallbackLanguage,
        },
      }
    }

    return {
      astSummary,
      facts,
      metadata: {
        language: entry.name,
        factCount: facts.length,
      },
    }
  } catch (error) {
    const fallback = parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, fallbackLanguage, 'text')
    return {
      ...fallback,
      metadata: {
        ...fallback.metadata,
        skipped: true,
        reason: 'parser_error',
        language: entry.name,
        error: error instanceof Error ? error.message : 'unknown_error',
      },
    }
  }
}

const dedupeFacts = (facts: TreeSitterFact[]) => {
  const seen = new Map<string, TreeSitterFact>()
  for (const fact of facts) {
    const start = fact.startLine ?? -1
    const end = fact.endLine ?? -1
    const key = `${fact.nodeType}::${fact.matchText}::${start}::${end}`
    if (!seen.has(key)) {
      seen.set(key, fact)
    }
  }
  return Array.from(seen.values())
}

const loadCompletionConfig = () => {
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY?.trim() || null
  if (!apiKey && isHostedOpenAiBaseUrl(apiBaseUrl)) {
    throw createNonRetryableError(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
      'CompletionConfigError',
    )
  }

  const defaults = resolveCompletionDefaults(apiBaseUrl)
  const model = process.env.OPENAI_COMPLETION_MODEL ?? process.env.OPENAI_MODEL ?? defaults.model
  const timeoutMs = Number.parseInt(process.env.OPENAI_COMPLETION_TIMEOUT_MS ?? '60000', 10)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw createNonRetryableError('OPENAI_COMPLETION_TIMEOUT_MS must be a positive integer', 'CompletionConfigError')
  }
  const maxInputChars = clampNumber(
    Number.parseInt(process.env.OPENAI_COMPLETION_MAX_INPUT_CHARS ?? '', 10),
    MAX_COMPLETION_INPUT_CHARS,
  )

  const maxOutputTokens = clampNumber(
    Number.parseInt(process.env.OPENAI_COMPLETION_MAX_OUTPUT_TOKENS ?? '', 10),
    DEFAULT_COMPLETION_MAX_OUTPUT_TOKENS,
  )

  return { apiBaseUrl, apiKey, model, timeoutMs, maxInputChars, maxOutputTokens }
}

const loadCompletionRetryConfig = () => {
  const maxAttempts = Number.parseInt(
    process.env.OPENAI_COMPLETION_MAX_ATTEMPTS ?? String(DEFAULT_COMPLETION_MAX_ATTEMPTS),
    10,
  )
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    throw createNonRetryableError('OPENAI_COMPLETION_MAX_ATTEMPTS must be a positive integer', 'CompletionConfigError')
  }
  const initialDelayMs = Number.parseInt(
    process.env.OPENAI_COMPLETION_RETRY_INITIAL_MS ?? String(DEFAULT_COMPLETION_RETRY_INITIAL_MS),
    10,
  )
  const maxDelayMs = Number.parseInt(
    process.env.OPENAI_COMPLETION_RETRY_MAX_MS ?? String(DEFAULT_COMPLETION_RETRY_MAX_MS),
    10,
  )
  const backoffCoefficient = Number.parseFloat(
    process.env.OPENAI_COMPLETION_RETRY_BACKOFF ?? String(DEFAULT_COMPLETION_RETRY_BACKOFF),
  )
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
    throw createNonRetryableError(
      'OPENAI_COMPLETION_RETRY_INITIAL_MS must be a positive integer',
      'CompletionConfigError',
    )
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    throw createNonRetryableError('OPENAI_COMPLETION_RETRY_MAX_MS must be a positive integer', 'CompletionConfigError')
  }
  if (!Number.isFinite(backoffCoefficient) || backoffCoefficient <= 0) {
    throw createNonRetryableError('OPENAI_COMPLETION_RETRY_BACKOFF must be a positive number', 'CompletionConfigError')
  }
  return { maxAttempts, initialDelayMs, maxDelayMs, backoffCoefficient }
}

const parseStreamingCompletion = async (response: Response) => {
  if (!response.body) return ''

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let output = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) break

      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      const dataLines = event
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())

      if (dataLines.length === 0) continue

      const data = dataLines.join('\n')
      if (data === '[DONE]') {
        return output.trim()
      }

      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }

      if (payload && typeof payload === 'object') {
        const errorMessage = (payload as { error?: { message?: string } }).error?.message
        if (errorMessage) {
          throw new Error(`completion error: ${errorMessage}`)
        }

        const delta = (payload as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content
        if (typeof delta === 'string') {
          output += delta
        }
      }
    }
  }

  return output.trim()
}

export const parseCompletionOutput = (rawText: string) => {
  const normalizeSummary = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const normalizeEnriched = (value: unknown) => {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
      const lines = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      if (lines.length === 0) return ''
      return lines.map((line) => (line.startsWith('-') ? line : `- ${line}`)).join('\n')
    }
    return ''
  }
  const extractErrorMessage = (value: unknown) => {
    if (!value || typeof value !== 'object') return null
    const errorValue = (value as { error?: unknown }).error
    if (!errorValue || typeof errorValue !== 'object') return null
    const message = (errorValue as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim()
    }
    return null
  }

  const trimmed = rawText.trim()
  if (trimmed.length === 0) {
    throw new Error('completion response was empty')
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = trimmed.slice(firstBrace, lastBrace + 1)
    try {
      const parsed = JSON.parse(jsonCandidate) as { summary?: unknown; enriched?: unknown; error?: unknown }
      const errorMessage = extractErrorMessage(parsed)
      if (errorMessage) {
        throw new Error(`completion error: ${errorMessage}`)
      }
      const summary = normalizeSummary(parsed.summary)
      const enriched = normalizeEnriched(parsed.enriched)
      if (!summary && !enriched) {
        throw new Error('completion response missing summary/enriched')
      }
      return {
        summary: summary || enriched,
        enriched: enriched || summary,
        metadata: { parsedJson: true },
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('completion error:')) {
        throw error
      }
      if (error instanceof Error && error.message.includes('summary/enriched')) {
        throw error
      }
      throw new Error('completion response was not valid JSON')
    }
  }

  throw new Error('completion response was not valid JSON')
}

const normalizeEmbeddingMatrix = (raw: unknown): number[][] | null => {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return []
  const first = raw[0]
  if (Array.isArray(first)) {
    const matrix = raw as unknown[][]
    for (const row of matrix) {
      if (!Array.isArray(row) || row.some((value) => typeof value !== 'number')) {
        return null
      }
    }
    return matrix as number[][]
  }
  if (raw.some((value) => typeof value !== 'number')) return null
  return [raw as number[]]
}

const isRetryableStatus = (status: number) =>
  status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504

const requestEmbeddingBatchOnce = async (texts: string[]): Promise<number[][]> => {
  const { apiKey, embeddingBaseUrl, model, dimension, timeoutMs, maxInputChars, truncate, keepAlive } =
    loadEmbeddingConfig()

  for (const text of texts) {
    if (text.length > maxInputChars) {
      throw createNonRetryableError(
        `embedding input too large (${text.length} chars; max ${maxInputChars})`,
        'EmbeddingInputError',
      )
    }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const isOllamaEmbed = isOllamaEmbedBaseUrl(embeddingBaseUrl)
  const url = `${embeddingBaseUrl}/${isOllamaEmbed ? 'embed' : 'embeddings'}`
  const body = isOllamaEmbed
    ? {
        model,
        input: texts,
        ...(truncate === null ? {} : { truncate }),
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
      }
    : {
        model,
        input: texts,
        dimensions: dimension,
      }

  try {
    const response = await withEmbeddingConcurrency(() => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeoutSignal,
      })
    })

    if (!response.ok) {
      const errorBody = await response.text()
      const retryAfterMs = parseRetryAfterMs(response)
      if (isRetryableStatus(response.status)) {
        throw createRetryableError(`embedding request failed (${response.status}): ${errorBody}`, retryAfterMs)
      }
      throw createNonRetryableError(
        `embedding request failed (${response.status}): ${errorBody}`,
        'EmbeddingResponseError',
      )
    }

    const json = (await response.json()) as {
      data?: { embedding?: number[] }[]
      embeddings?: unknown
      embedding?: unknown
    }
    const rawEmbeddings = isOllamaEmbed
      ? (json.embeddings ?? json.embedding)
      : json.data?.map((entry) => entry.embedding)
    const embeddings = normalizeEmbeddingMatrix(rawEmbeddings)
    if (!embeddings) {
      throw createRetryableError('embedding response missing embeddings')
    }
    if (embeddings.length !== texts.length) {
      throw createRetryableError(`embedding response missing embeddings for ${texts.length} inputs`)
    }

    for (const embedding of embeddings) {
      if (embedding.length !== dimension) {
        throw createNonRetryableError(
          `embedding dimension mismatch: expected ${dimension} but got ${embedding.length}`,
          'EmbeddingDimensionMismatchError',
        )
      }
    }

    return embeddings
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createRetryableError(`embedding request timed out after ${timeoutMs}ms`)
    }
    throw error
  }
}

const requestEmbeddingBatch = async (texts: string[]): Promise<number[][]> => {
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffCoefficient } = loadEmbeddingRetryConfig()
  let attempt = 1
  let lastError: unknown

  while (attempt <= maxAttempts) {
    try {
      return await requestEmbeddingBatchOnce(texts)
    } catch (error) {
      lastError = error
      if (isNonRetryableError(error) || attempt >= maxAttempts) {
        throw error
      }
      const retryable = isRetryableError(error) || error instanceof Error
      if (!retryable) {
        throw error
      }
      const retryAfterMs = isRetryableError(error) ? error.retryAfterMs : undefined
      const backoffDelay = computeBackoffDelayMs(attempt, initialDelayMs, maxDelayMs, backoffCoefficient)
      const delayMs = retryAfterMs ?? backoffDelay
      await sleepMs(jitterDelayMs(delayMs))
      attempt += 1
    }
  }

  throw lastError instanceof Error ? lastError : new Error('embedding request failed')
}

type EmbeddingRequest = {
  text: string
  resolve: (embedding: number[]) => void
  reject: (error: Error) => void
}

const embeddingQueue: EmbeddingRequest[] = []
let embeddingFlushScheduled = false
let embeddingFlushPromise: Promise<void> | null = null
let embeddingFlushTimer: ReturnType<typeof setTimeout> | null = null

const buildEmbeddingBatches = (pending: EmbeddingRequest[], batchSize: number, batchMaxChars: number | null) => {
  const batches: EmbeddingRequest[][] = []
  while (pending.length > 0) {
    const batch: EmbeddingRequest[] = []
    let batchChars = 0
    while (pending.length > 0 && batch.length < batchSize) {
      const next = pending[0]
      if (!next) break
      const nextChars = next.text.length
      if (batchMaxChars && batch.length > 0 && batchChars + nextChars > batchMaxChars) {
        break
      }
      pending.shift()
      batch.push(next)
      batchChars += nextChars
    }
    if (batch.length === 0) {
      const fallback = pending.shift()
      if (fallback) {
        batch.push(fallback)
      }
    }
    if (batch.length > 0) {
      batches.push(batch)
    }
  }
  return batches
}

const processEmbeddingBatch = (batch: EmbeddingRequest[]) => {
  const texts = batch.map((item) => item.text)
  return Effect.matchEffect(
    Effect.tryPromise({
      try: () => requestEmbeddingBatch(texts),
      catch: (error) => toError(error),
    }),
    {
      onFailure: (error) =>
        Effect.sync(() => {
          for (const item of batch) {
            item.reject(error)
          }
        }),
      onSuccess: (embeddings) =>
        Effect.sync(() => {
          embeddings.forEach((embedding, index) => {
            batch[index]?.resolve(embedding)
          })
        }),
    },
  )
}

const scheduleEmbeddingFlush = () => {
  if (embeddingFlushScheduled) return
  embeddingFlushScheduled = true
  const windowMs = loadEmbeddingBatchWindowMs()
  if (windowMs === 0) {
    queueMicrotask(() => {
      embeddingFlushScheduled = false
      void flushEmbeddingQueue()
    })
    return
  }
  if (embeddingFlushTimer) {
    return
  }
  embeddingFlushTimer = setTimeout(() => {
    embeddingFlushTimer = null
    embeddingFlushScheduled = false
    void flushEmbeddingQueue()
  }, windowMs)
}

const flushEmbeddingQueue = async (): Promise<void> => {
  if (embeddingFlushPromise) return embeddingFlushPromise

  embeddingFlushPromise = Effect.runPromise(
    Effect.gen(function* () {
      while (embeddingQueue.length > 0) {
        let batchSize = 1
        let batchMaxChars: number | null = null
        try {
          batchSize = loadEmbeddingBatchSize()
          batchMaxChars = loadEmbeddingBatchMaxChars()
        } catch (error) {
          const batch = embeddingQueue.splice(0)
          const failure = toError(error)
          for (const item of batch) {
            item.reject(failure)
          }
          return
        }

        const pending = embeddingQueue.splice(0)
        const batches = buildEmbeddingBatches(pending, batchSize, batchMaxChars)

        if (batches.length > 0) {
          yield* Effect.all(batches.map(processEmbeddingBatch), { discard: true })
        }
      }
    }),
  ).finally(() => {
    embeddingFlushPromise = null
    if (embeddingQueue.length > 0) {
      scheduleEmbeddingFlush()
    }
  })

  return embeddingFlushPromise
}

const embedText = async (text: string): Promise<number[]> => {
  const batchSize = loadEmbeddingBatchSize()
  if (batchSize <= 1) {
    const embeddings = await requestEmbeddingBatch([text])
    return embeddings[0] ?? []
  }

  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        new Promise<number[]>((resolve, reject) => {
          embeddingQueue.push({
            text,
            resolve,
            reject,
          })
          scheduleEmbeddingFlush()
        }),
      catch: (error) => toError(error),
    }),
  )
}

const withDefaultSslMode = (rawUrl: string) => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  const params = url.searchParams
  if (params.get('sslmode')) return rawUrl

  const envMode = process.env.PGSSLMODE?.trim()
  const sslmode = envMode && envMode.length > 0 ? envMode : 'require'
  params.set('sslmode', sslmode)

  url.search = params.toString()
  return url.toString()
}

let atlasDb: SQL | null | undefined

const getAtlasDb = () => {
  if (atlasDb !== undefined) return atlasDb

  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    atlasDb = null
    return atlasDb
  }

  atlasDb = new SQL(withDefaultSslMode(url))
  return atlasDb
}

const resolveGithubEventId = async (db: SQL, deliveryId: string) => {
  const rows = (await db`
    SELECT id
    FROM atlas.github_events
    WHERE delivery_id = ${deliveryId}
    LIMIT 1;
  `) as Array<{ id: string }>
  return rows[0]?.id ?? null
}

export const activities = {
  async listRepoFiles(input: ListRepoFilesInput): Promise<ListRepoFilesOutput> {
    const repoRoot = resolve(input.repoRoot)
    const ref = normalizeOptionalText(input.ref) ?? 'HEAD'
    const pathPrefix = normalizePathPrefix(input.pathPrefix)
    const maxFiles = loadRepoListLimit(input.maxFiles)
    const startedAt = Date.now()

    logActivity('info', 'started', 'listRepoFiles', {
      repoRoot,
      ref,
      pathPrefix: pathPrefix ?? null,
      maxFiles,
    })

    try {
      const args = ['git', 'ls-tree', '-r', '-z', ref]
      if (pathPrefix) {
        args.push('--', pathPrefix)
      }

      const output = await runCommand(args, repoRoot)
      if (output === null) {
        throw new Error('Failed to list repository files')
      }

      const entries = output
        .split('\0')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

      const files: string[] = []
      let skipped = 0

      for (const entry of entries) {
        const [meta, path] = entry.split('\t')
        if (!meta || !path) {
          skipped += 1
          continue
        }
        const type = meta.split(' ')[1]
        if (type !== 'blob') {
          skipped += 1
          continue
        }
        if (shouldSkipRepoFile(path)) {
          skipped += 1
          continue
        }
        if (files.length >= maxFiles) {
          skipped += 1
          continue
        }
        files.push(path)
      }

      const result = {
        files,
        total: entries.length,
        skipped,
      }

      logActivity('info', 'completed', 'listRepoFiles', {
        repoRoot,
        ref,
        pathPrefix: pathPrefix ?? null,
        maxFiles,
        durationMs: Date.now() - startedAt,
        total: entries.length,
        skipped,
        returned: files.length,
      })

      return result
    } catch (error) {
      logActivity('error', 'failed', 'listRepoFiles', {
        repoRoot,
        ref,
        pathPrefix: pathPrefix ?? null,
        maxFiles,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async readRepoFile(input: ReadRepoFileInput): Promise<ReadRepoFileOutput> {
    const startedAt = Date.now()
    const normalizedRef = normalizeOptionalText(input.ref)
    const normalizedCommit = normalizeOptionalText(input.commit)

    logActivity('info', 'started', 'readRepoFile', {
      repoRoot: input.repoRoot,
      filePath: input.filePath,
      repository: input.repository ?? null,
      ref: normalizedRef ?? null,
      commit: normalizedCommit ?? null,
    })

    try {
      const fullPath = resolvePath(input.repoRoot, input.filePath)
      const repoInfo = await resolveRepositoryInfo(input.repoRoot, {
        repository: input.repository,
        ref: normalizedRef,
        commit: normalizedCommit,
      })

      const repoRootStats = await stat(input.repoRoot).catch(() => null)
      const fileStats = repoRootStats?.isDirectory() ? await stat(fullPath).catch(() => null) : null
      let content: string | null = null
      let stats = fileStats
      let source: 'local' | 'github' | 'git' = 'local'
      let sourceMeta: Record<string, unknown> = { repoRoot: input.repoRoot, source: 'local' }

      const setGitSource = (ref: string, commit?: string | null) => {
        source = 'git'
        stats = null
        sourceMeta = {
          repoRoot: input.repoRoot,
          source: 'git',
          gitRef: ref,
          gitCommit: commit ?? null,
        }
      }

      if (normalizedCommit) {
        content = await readGitFile(input.repoRoot, normalizedCommit, input.filePath)
        if (!content) {
          const hasCommit = await commitExistsLocally(input.repoRoot, normalizedCommit)
          if (!hasCommit) {
            const fetched = await fetchCommitFromOrigin(input.repoRoot, normalizedCommit)
            if (fetched) {
              content = await readGitFile(input.repoRoot, normalizedCommit, input.filePath)
            }
          }
        }
        if (content) {
          setGitSource(normalizedCommit, normalizedCommit)
        }
      }

      if (!content) {
        const fallbackRef =
          normalizedRef ?? (!normalizedCommit ? (repoInfo.repoCommit ?? repoInfo.repoRef ?? null) : null)
        if (fallbackRef) {
          const fallbackContent = await readGitFile(input.repoRoot, fallbackRef, input.filePath)
          if (fallbackContent) {
            content = fallbackContent
            setGitSource(fallbackRef, normalizedCommit ?? null)
          }
        }
      }

      if (!content && !normalizedCommit && fileStats && fileStats.isFile()) {
        content = await readFile(fullPath, 'utf8')
        source = 'local'
        stats = fileStats
        sourceMeta = { repoRoot: input.repoRoot, source: 'local' }
      }

      if (!content && fileStats && !fileStats.isFile()) {
        const error = new Error(`Path is a directory: ${input.filePath}`)
        error.name = 'DirectoryError'
        throw error
      }

      if (!content) {
        const repoSlug = normalizeRepositorySlug(normalizeOptionalText(input.repository) ?? repoInfo.repoName ?? '')
        if (!repoSlug.includes('/')) {
          throw new Error('GitHub repository slug is required to fetch remote content')
        }

        const ref = normalizedCommit ?? repoInfo.repoCommit ?? repoInfo.repoRef
        const fetched = await fetchGithubFile(repoSlug, input.filePath, ref)
        source = 'github'
        content = fetched.content
        stats = null
        sourceMeta = {
          repoRoot: input.repoRoot,
          source: 'github',
          githubApiUrl: fetched.apiUrl,
          githubDownloadUrl: fetched.downloadUrl,
          githubSha: fetched.sha,
          githubRef: ref,
        }
      }

      const contentHash = createHash('sha256').update(content).digest('hex')
      const lineCount = content.split(/\r?\n/).length
      const language = languageNameByExtension.get(extname(input.filePath).toLowerCase()) ?? null

      const result = {
        content,
        metadata: {
          repoName: repoInfo.repoName,
          repoRef: repoInfo.repoRef,
          repoCommit: normalizedCommit ?? repoInfo.repoCommit,
          path: input.filePath,
          contentHash,
          language,
          byteSize: stats?.size ?? Buffer.byteLength(content, 'utf8'),
          lineCount,
          sourceTimestamp: stats?.mtime ? stats.mtime.toISOString() : null,
          metadata: sourceMeta,
        },
      }

      logActivity('info', 'completed', 'readRepoFile', {
        repoRoot: input.repoRoot,
        filePath: input.filePath,
        repository: input.repository ?? null,
        ref: normalizedRef ?? null,
        commit: normalizedCommit ?? null,
        source,
        language,
        byteSize: result.metadata.byteSize,
        lineCount: result.metadata.lineCount,
        contentHash: result.metadata.contentHash,
        durationMs: Date.now() - startedAt,
      })

      return result
    } catch (error) {
      logActivity('error', 'failed', 'readRepoFile', {
        repoRoot: input.repoRoot,
        filePath: input.filePath,
        repository: input.repository ?? null,
        ref: normalizedRef ?? null,
        commit: normalizedCommit ?? null,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async extractAstSummary(input: AstGrepInput): Promise<AstSummaryOutput> {
    const startedAt = Date.now()

    logActivity('info', 'started', 'extractAstSummary', {
      repoRoot: input.repoRoot,
      filePath: input.filePath,
      hasInlineContent: Boolean(input.content),
    })

    try {
      const content = input.content ?? (await readFile(resolvePath(input.repoRoot, input.filePath), 'utf8'))
      const result = await parseAst(content, input.filePath)

      logActivity('info', 'completed', 'extractAstSummary', {
        repoRoot: input.repoRoot,
        filePath: input.filePath,
        durationMs: Date.now() - startedAt,
        facts: result.facts.length,
        summaryChars: result.astSummary.length,
      })

      return result
    } catch (error) {
      logActivity('error', 'failed', 'extractAstSummary', {
        repoRoot: input.repoRoot,
        filePath: input.filePath,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async enrichWithModel(input: EnrichInput): Promise<EnrichOutput> {
    const startedAt = Date.now()
    const { apiBaseUrl, apiKey, model, timeoutMs, maxInputChars, maxOutputTokens } = loadCompletionConfig()

    logActivity('info', 'started', 'enrichWithModel', {
      filename: input.filename,
      model,
      timeoutMs,
      contentChars: input.content.length,
      astSummaryChars: input.astSummary.length,
      contextChars: input.context.length,
      maxInputChars,
      maxOutputTokens,
    })

    const truncatedContent =
      input.content.length > maxInputChars ? input.content.slice(0, maxInputChars) : input.content
    const wasTruncated = truncatedContent.length !== input.content.length

    const systemPrompt = [
      'You are an Atlas enrichment agent.',
      'Return a valid JSON object ONLY with keys "summary" and "enriched".',
      'The response MUST be a single JSON object, with no extra keys, no filename, and no code.',
      'Do not include markdown, code fences, arrays, or nested objects.',
      'Return ONLY this shape: {"summary":"...","enriched":"- ...\\n- ..."}',
      '"summary": 2-4 sentences (<= 400 chars) describing what the file does.',
      '"enriched": a single string of 3-6 bullet lines, each starting with "- ". Each bullet <= 120 chars.',
      'Bullets should cover: purpose, key APIs/entry points, data flow, side effects/IO, risks/edge cases.',
      'If information is missing, say "Unknown" instead of guessing.',
      'If input is truncated, include a bullet: "Input truncated; details may be missing."',
      'Never return file metadata objects, schemas, or code samples; only summary/enriched.',
      'If you are unable to comply, return exactly: {"summary":"Unknown","enriched":"- Unknown"}',
      'Invalid responses include JSON objects that list fields, schemas, or code.',
      'Do NOT output objects like {"filename":"...","code":"..."} or {"activityId":"string", ...}.',
    ].join(' ')

    const userSections = [
      `Filename: ${input.filename}`,
      input.context ? `Context: ${input.context}` : null,
      `Input truncated: ${wasTruncated ? 'yes' : 'no'}`,
      `AST summary:\n${input.astSummary}`,
      `Content${wasTruncated ? ' (truncated)' : ''}:\n${truncatedContent}`,
    ].filter((section) => section && section.length > 0)

    const completionRetry = loadCompletionRetryConfig()
    const repairMaxChars = clampNonNegativeNumber(
      Number.parseInt(
        process.env.OPENAI_COMPLETION_REPAIR_OUTPUT_CHARS ?? String(DEFAULT_COMPLETION_REPAIR_OUTPUT_CHARS),
        10,
      ),
      DEFAULT_COMPLETION_REPAIR_OUTPUT_CHARS,
    )

    type CompletionMessage = { role: 'system' | 'user'; content: string }

    const buildCompletionMessages = (
      mode: 'initial' | 'repair',
      context?: { output?: string; error?: string },
    ): CompletionMessage[] => {
      if (mode === 'repair') {
        const previousOutput = context?.output ? safeSlice(context.output, repairMaxChars) : ''
        const repairPrompt = [
          systemPrompt,
          'The previous response was invalid JSON or missing required fields.',
          context?.error ? `Error: ${context.error}` : null,
          'Return ONLY a valid JSON object with keys "summary" and "enriched".',
          'Do not add extra keys or markdown.',
          'Ignore any previous response that does not already contain summary/enriched.',
          'Do not include filenames or code.',
          'If you are unable to comply, return exactly: {"summary":"Unknown","enriched":"- Unknown"}',
          'If the previous response contained useful content, reuse it; otherwise regenerate from the input below.',
        ]
          .filter((entry) => entry && entry.length > 0)
          .join(' ')
        const repairSections = [
          `Filename: ${input.filename}`,
          input.context ? `Context: ${input.context}` : null,
          `Input truncated: ${wasTruncated ? 'yes' : 'no'}`,
          `AST summary:\n${input.astSummary}`,
          previousOutput ? `Previous response:\n${previousOutput}` : null,
        ].filter((section) => section && section.length > 0)
        return [
          { role: 'system', content: repairPrompt },
          { role: 'user', content: repairSections.join('\n\n') },
        ]
      }

      return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userSections.join('\n\n') },
      ]
    }

    const buildCompletionPayload = (messages: CompletionMessage[], includeFormat: boolean) => ({
      model,
      stream: true,
      max_tokens: maxOutputTokens,
      temperature: 0,
      messages,
      ...(includeFormat ? { response_format: { type: 'json_object' } } : {}),
    })

    const logCompletion = (responseFormat: 'json_object' | 'none', result: EnrichOutput) => {
      logActivity('info', 'completed', 'enrichWithModel', {
        filename: input.filename,
        model,
        responseFormat,
        wasTruncated,
        summaryChars: result.summary.length,
        enrichedChars: result.enriched.length,
        durationMs: Date.now() - startedAt,
      })
    }

    const requestCompletion = async (
      signal: AbortSignal,
      messages: CompletionMessage[],
    ): Promise<{ output: string; responseFormat: 'json_object' | 'none' }> => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`
      }

      const payloadWithFormat = buildCompletionPayload(messages, true)
      const payload = buildCompletionPayload(messages, false)

      try {
        const response = await fetch(`${apiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payloadWithFormat),
          signal,
        })

        if (!response.ok) {
          const body = await response.text()
          const lowerBody = body.toLowerCase()
          const formatUnsupported =
            lowerBody.includes('response_format') ||
            lowerBody.includes('json_schema') ||
            lowerBody.includes('json object') ||
            lowerBody.includes('unsupported') ||
            lowerBody.includes('unknown parameter')
          if (formatUnsupported) {
            const fallbackResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
              signal,
            })
            if (!fallbackResponse.ok) {
              const fallbackBody = await fallbackResponse.text()
              if (isRetryableStatus(fallbackResponse.status)) {
                throw createRetryableError(
                  `completion request failed (${fallbackResponse.status}): ${fallbackBody}`,
                  parseRetryAfterMs(fallbackResponse),
                )
              }
              throw createNonRetryableError(
                `completion request failed (${fallbackResponse.status}): ${fallbackBody}`,
                'CompletionResponseError',
              )
            }
            const output = await parseStreamingCompletion(fallbackResponse)
            return { output, responseFormat: 'none' }
          }
          if (isRetryableStatus(response.status)) {
            throw createRetryableError(
              `completion request failed (${response.status}): ${body}`,
              parseRetryAfterMs(response),
            )
          }
          throw createNonRetryableError(
            `completion request failed (${response.status}): ${body}`,
            'CompletionResponseError',
          )
        }

        const output = await parseStreamingCompletion(response)
        return { output, responseFormat: 'json_object' }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw createRetryableError(`completion request timed out after ${timeoutMs}ms`)
        }
        if (error instanceof Error && error.name === 'TypeError') {
          throw createRetryableError(`completion request network error: ${error.message}`)
        }
        throw error
      }
    }

    try {
      let attempt = 1
      let lastOutput: string | undefined
      let lastParseError: string | undefined
      let lastResponseFormat: 'json_object' | 'none' | undefined

      while (attempt <= completionRetry.maxAttempts) {
        const mode = lastParseError ? 'repair' : 'initial'
        const messages = buildCompletionMessages(mode, { output: lastOutput, error: lastParseError })
        const timeoutSignal = AbortSignal.timeout(timeoutMs)

        try {
          const { output, responseFormat } = await withCompletionConcurrency(() =>
            requestCompletion(timeoutSignal, messages),
          )
          lastOutput = output
          lastResponseFormat = responseFormat
          const parsed = parseCompletionOutput(output)
          const result = {
            summary: parsed.summary,
            enriched: parsed.enriched,
            metadata: {
              model,
              wasTruncated,
              parsedJson: parsed.metadata.parsedJson,
              responseFormat,
            },
          }
          logCompletion(responseFormat, result)
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const isParseError = message.startsWith('completion response')
          if (isParseError) {
            lastParseError = message
            if (lastOutput !== undefined) {
              const outputSummary = summarizeCompletionOutput(lastOutput, MAX_COMPLETION_LOG_CHARS)
              logActivity('error', 'completionParseError', 'enrichWithModel', {
                filename: input.filename,
                model,
                wasTruncated,
                responseFormat: lastResponseFormat ?? 'unknown',
                parseError: message,
                ...outputSummary,
              })
            }
          } else {
            lastParseError = undefined
          }

          if (isNonRetryableError(error) || attempt >= completionRetry.maxAttempts) {
            throw error
          }
          const retryAfterMs = isRetryableError(error) ? error.retryAfterMs : undefined
          const backoffDelay = computeBackoffDelayMs(
            attempt,
            completionRetry.initialDelayMs,
            completionRetry.maxDelayMs,
            completionRetry.backoffCoefficient,
          )
          const delayMs = retryAfterMs ?? backoffDelay
          await sleepMs(jitterDelayMs(delayMs))
          attempt += 1
        }
      }

      throw new Error('completion request failed after retries')
    } catch (error) {
      const timeoutError =
        error instanceof Error && (error.name === 'AbortError' || error.message.includes('timed out'))
      const message = timeoutError ? `completion request timed out after ${timeoutMs}ms` : formatActivityError(error)
      logActivity('error', 'failed', 'enrichWithModel', {
        filename: input.filename,
        model,
        wasTruncated,
        durationMs: Date.now() - startedAt,
        error: message,
      })
      if (timeoutError) {
        throw new Error(message)
      }
      throw error
    }
  },

  async createEmbedding(input: EmbeddingInput): Promise<{ embedding: number[] }> {
    const startedAt = Date.now()
    const { model, dimension, maxInputChars } = loadEmbeddingConfig()

    logActivity('info', 'started', 'createEmbedding', {
      model,
      dimension,
      textChars: input.text.length,
      maxInputChars,
    })

    try {
      const embedding = await embedText(input.text)
      const result = { embedding }

      logActivity('info', 'completed', 'createEmbedding', {
        model,
        dimension,
        textChars: input.text.length,
        vectorLength: embedding.length,
        durationMs: Date.now() - startedAt,
      })

      return result
    } catch (error) {
      logActivity('error', 'failed', 'createEmbedding', {
        model,
        dimension,
        textChars: input.text.length,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async cleanupEnrichment(input: CleanupEnrichmentInput): Promise<CleanupEnrichmentOutput> {
    const startedAt = Date.now()
    const fileMeta = input.fileMetadata
    const repositoryName = fileMeta.repoName
    const repositoryRef = normalizeRepositoryRef(fileMeta.repoRef) ?? 'main'
    const repositoryCommit = fileMeta.repoCommit ?? null

    logActivity('info', 'started', 'cleanupEnrichment', {
      repository: repositoryName,
      repositoryRef,
      repositoryCommit,
      path: fileMeta.path,
    })

    const logResult = (result: CleanupEnrichmentOutput) => {
      logActivity('info', 'completed', 'cleanupEnrichment', {
        repository: repositoryName,
        repositoryRef,
        repositoryCommit,
        path: fileMeta.path,
        durationMs: Date.now() - startedAt,
        ...result,
      })
      return result
    }

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      const repositoryRows = (await db`
        SELECT id
        FROM atlas.repositories
        WHERE name = ${repositoryName};
      `) as Array<{ id: string }>

      const repositoryId = repositoryRows[0]?.id
      if (!repositoryId) {
        return logResult({ fileVersions: 0, enrichments: 0, embeddings: 0, facts: 0 })
      }

      const fileKeyRows = (await db`
        SELECT id
        FROM atlas.file_keys
        WHERE repository_id = ${repositoryId}
          AND path = ${fileMeta.path};
      `) as Array<{ id: string }>

      const fileKeyId = fileKeyRows[0]?.id
      if (!fileKeyId) {
        return logResult({ fileVersions: 0, enrichments: 0, embeddings: 0, facts: 0 })
      }

      let fileVersionRows: Array<{ id: string }>
      if (repositoryCommit) {
        fileVersionRows = (await db`
          SELECT id
          FROM atlas.file_versions
          WHERE file_key_id = ${fileKeyId}
            AND repository_commit = ${repositoryCommit};
        `) as Array<{ id: string }>
      } else {
        fileVersionRows = (await db`
          SELECT id
          FROM atlas.file_versions
          WHERE file_key_id = ${fileKeyId}
            AND repository_ref = ${repositoryRef};
        `) as Array<{ id: string }>
      }

      const fileVersionIds = [...new Set(fileVersionRows.map((row) => row.id))]
      if (fileVersionIds.length === 0) {
        return logResult({ fileVersions: 0, enrichments: 0, embeddings: 0, facts: 0 })
      }

      const fileVersionArray = db.array(fileVersionIds, 'uuid')

      const enrichmentRows = (await db`
        SELECT id
        FROM atlas.enrichments
        WHERE file_version_id = ANY(${fileVersionArray})
          AND source = ${'bumba'}
          AND kind = ${'model_enrichment'};
      `) as Array<{ id: string }>

      const enrichmentIds = [...new Set(enrichmentRows.map((row) => row.id))]
      let embeddingsDeleted = 0
      if (enrichmentIds.length > 0) {
        const embeddingRows = (await db`
          DELETE FROM atlas.embeddings
          WHERE enrichment_id = ANY(${db.array(enrichmentIds, 'uuid')})
          RETURNING enrichment_id;
        `) as Array<{ enrichment_id: string }>
        embeddingsDeleted = embeddingRows.length
      }

      const enrichmentsDeleted = (await db`
        DELETE FROM atlas.enrichments
        WHERE file_version_id = ANY(${fileVersionArray})
          AND source = ${'bumba'}
          AND kind = ${'model_enrichment'}
        RETURNING id;
      `) as Array<{ id: string }>

      const factsDeleted = (await db`
        DELETE FROM atlas.tree_sitter_facts
        WHERE file_version_id = ANY(${fileVersionArray})
        RETURNING file_version_id;
      `) as Array<{ file_version_id: string }>

      return logResult({
        fileVersions: fileVersionIds.length,
        enrichments: enrichmentsDeleted.length,
        embeddings: embeddingsDeleted,
        facts: factsDeleted.length,
      })
    } catch (error) {
      logActivity('error', 'failed', 'cleanupEnrichment', {
        repository: repositoryName,
        repositoryRef,
        repositoryCommit,
        path: fileMeta.path,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async persistFileVersion(input: PersistFileVersionInput): Promise<PersistFileVersionOutput> {
    const startedAt = Date.now()
    const fileMeta = input.fileMetadata
    const repositoryName = fileMeta.repoName
    const repositoryRef = normalizeRepositoryRef(fileMeta.repoRef) ?? 'main'
    const repositoryCommit = fileMeta.repoCommit ?? null
    const contentHash = fileMeta.contentHash ?? ''

    logActivity('info', 'started', 'persistFileVersion', {
      repository: repositoryName,
      repositoryRef,
      repositoryCommit,
      path: fileMeta.path,
      contentHash,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      const repositoryRows = (await db`
        INSERT INTO atlas.repositories (name, default_ref, metadata)
        VALUES (${repositoryName}, ${repositoryRef}, ${JSON.stringify({ source: 'bumba' })}::jsonb)
        ON CONFLICT (name) DO UPDATE
        SET default_ref = COALESCE(EXCLUDED.default_ref, atlas.repositories.default_ref),
            updated_at = now()
        RETURNING id;
      `) as Array<{ id: string }>

      const repositoryId = repositoryRows[0]?.id
      if (!repositoryId) throw new Error('failed to upsert repository')

      const fileKeyRows = (await db`
        INSERT INTO atlas.file_keys (repository_id, path)
        VALUES (${repositoryId}, ${fileMeta.path})
        ON CONFLICT (repository_id, path) DO UPDATE
        SET path = EXCLUDED.path
        RETURNING id;
      `) as Array<{ id: string }>

      const fileKeyId = fileKeyRows[0]?.id
      if (!fileKeyId) throw new Error('failed to upsert file key')

      const fileVersionRows = (await db`
        INSERT INTO atlas.file_versions (
          file_key_id,
          repository_ref,
          repository_commit,
          content_hash,
          language,
          byte_size,
          line_count,
          metadata,
          source_timestamp
        )
        VALUES (
          ${fileKeyId},
          ${repositoryRef},
          ${repositoryCommit},
          ${contentHash},
          ${fileMeta.language},
          ${fileMeta.byteSize},
          ${fileMeta.lineCount},
          ${JSON.stringify(fileMeta.metadata)}::jsonb,
          ${fileMeta.sourceTimestamp}
        )
        ON CONFLICT (file_key_id, repository_ref, repository_commit, content_hash) DO UPDATE
        SET updated_at = now(),
            metadata = EXCLUDED.metadata
        RETURNING id;
      `) as Array<{ id: string }>

      const fileVersionId = fileVersionRows[0]?.id
      if (!fileVersionId) throw new Error('failed to upsert file version')

      const result = { repositoryId, fileKeyId, fileVersionId }
      logActivity('info', 'completed', 'persistFileVersion', {
        repository: repositoryName,
        repositoryRef,
        repositoryCommit,
        path: fileMeta.path,
        durationMs: Date.now() - startedAt,
        ...result,
      })

      return result
    } catch (error) {
      logActivity('error', 'failed', 'persistFileVersion', {
        repository: repositoryName,
        repositoryRef,
        repositoryCommit,
        path: fileMeta.path,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async persistEnrichmentRecord(input: PersistEnrichmentRecordInput): Promise<PersistEnrichmentRecordOutput> {
    const startedAt = Date.now()

    logActivity('info', 'started', 'persistEnrichmentRecord', {
      fileVersionId: input.fileVersionId,
      summaryChars: input.summary.length,
      enrichedChars: input.enriched.length,
      astSummaryChars: input.astSummary.length,
      metadataKeys: Object.keys(input.metadata ?? {}).length,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      const enrichmentMetadata = {
        ...input.metadata,
        astSummary: input.astSummary,
        contentHash: input.contentHash,
      }

      const enrichmentRows = (await db`
        INSERT INTO atlas.enrichments (
          file_version_id,
          kind,
          source,
          content,
          summary,
          tags,
          metadata
        )
        VALUES (
          ${input.fileVersionId},
          ${'model_enrichment'},
          ${'bumba'},
          ${input.enriched},
          ${input.summary},
          ${db.array([], 'text')}::text[],
          ${JSON.stringify(enrichmentMetadata)}::jsonb
        )
        ON CONFLICT (file_version_id, kind, source) WHERE chunk_id IS NULL DO UPDATE
        SET content = EXCLUDED.content,
            summary = EXCLUDED.summary,
            metadata = EXCLUDED.metadata
        RETURNING id;
      `) as Array<{ id: string }>

      const enrichmentId = enrichmentRows[0]?.id
      if (!enrichmentId) throw new Error('failed to upsert enrichment')

      const result = { enrichmentId }
      logActivity('info', 'completed', 'persistEnrichmentRecord', {
        fileVersionId: input.fileVersionId,
        durationMs: Date.now() - startedAt,
        ...result,
      })

      return result
    } catch (error) {
      logActivity('error', 'failed', 'persistEnrichmentRecord', {
        fileVersionId: input.fileVersionId,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async persistEmbedding(input: PersistEmbeddingInput): Promise<void> {
    const startedAt = Date.now()
    const { model, dimension } = loadEmbeddingConfig()

    logActivity('info', 'started', 'persistEmbedding', {
      enrichmentId: input.enrichmentId,
      model,
      dimension,
      vectorLength: input.embedding.length,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      const vectorString = vectorToPgArray(input.embedding)

      await db`
        INSERT INTO atlas.embeddings (enrichment_id, model, dimension, embedding)
        VALUES (${input.enrichmentId}, ${model}, ${dimension}, ${vectorString}::vector)
        ON CONFLICT (enrichment_id, model, dimension) DO UPDATE
        SET embedding = EXCLUDED.embedding;
      `

      logActivity('info', 'completed', 'persistEmbedding', {
        enrichmentId: input.enrichmentId,
        model,
        dimension,
        vectorLength: input.embedding.length,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      logActivity('error', 'failed', 'persistEmbedding', {
        enrichmentId: input.enrichmentId,
        model,
        dimension,
        vectorLength: input.embedding.length,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async persistFacts(input: PersistFactsInput): Promise<{ inserted: number }> {
    const startedAt = Date.now()

    logActivity('info', 'started', 'persistFacts', {
      fileVersionId: input.fileVersionId,
      requested: input.facts.length,
    })

    const logResult = (inserted: number) => {
      logActivity('info', 'completed', 'persistFacts', {
        fileVersionId: input.fileVersionId,
        requested: input.facts.length,
        inserted,
        durationMs: Date.now() - startedAt,
      })
      return { inserted }
    }

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      if (input.facts.length === 0) {
        return logResult(0)
      }

      const uniqueFacts = dedupeFacts(input.facts)
      if (uniqueFacts.length === 0) {
        return logResult(0)
      }

      await db`DELETE FROM atlas.tree_sitter_facts WHERE file_version_id = ${input.fileVersionId};`

      const nodeTypes = uniqueFacts.map((fact) => fact.nodeType)
      const matchTexts = uniqueFacts.map((fact) => fact.matchText)
      const startLines = uniqueFacts.map((fact) => fact.startLine ?? null)
      const endLines = uniqueFacts.map((fact) => fact.endLine ?? null)
      const metadataValues = uniqueFacts.map((fact) => JSON.stringify(fact.metadata ?? {}))

      await db`
        INSERT INTO atlas.tree_sitter_facts (
          file_version_id,
          node_type,
          match_text,
          start_line,
          end_line,
          metadata
        )
        SELECT
          ${input.fileVersionId},
          node_type,
          match_text,
          start_line,
          end_line,
          metadata::jsonb
        FROM UNNEST(
          ${db.array(nodeTypes, 'text')},
          ${db.array(matchTexts, 'text')},
          ${db.array(startLines, 'int4')},
          ${db.array(endLines, 'int4')},
          ${db.array(metadataValues, 'text')}
        ) AS fact(node_type, match_text, start_line, end_line, metadata)
        ON CONFLICT DO NOTHING;
      `

      return logResult(uniqueFacts.length)
    } catch (error) {
      logActivity('error', 'failed', 'persistFacts', {
        fileVersionId: input.fileVersionId,
        requested: input.facts.length,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async upsertIngestion(input: UpsertIngestionInput): Promise<UpsertIngestionOutput> {
    const startedAt = Date.now()
    const deliveryId = input.deliveryId.trim()
    const workflowId = input.workflowId.trim()
    const status = input.status.trim()
    const errorText = typeof input.error === 'string' ? input.error.trim() : ''
    const error = errorText.length > 0 ? errorText : null

    if (!deliveryId || !workflowId || !status) {
      logActivity('info', 'skipped', 'upsertIngestion', {
        reason: 'missing_required_fields',
        deliveryId: deliveryId || null,
        workflowId: workflowId || null,
        status: status || null,
        durationMs: Date.now() - startedAt,
      })
      return null
    }

    logActivity('info', 'started', 'upsertIngestion', {
      deliveryId,
      workflowId,
      status,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      const eventId = await resolveGithubEventId(db, deliveryId)
      if (!eventId) {
        logActivity('info', 'skipped', 'upsertIngestion', {
          deliveryId,
          workflowId,
          status,
          reason: 'event_not_found',
          durationMs: Date.now() - startedAt,
        })
        return null
      }

      const startedAtValue = input.startedAt ? new Date(input.startedAt) : null
      const finishedAtValue = input.finishedAt
        ? new Date(input.finishedAt)
        : status === 'completed' || status === 'failed' || status === 'skipped'
          ? new Date()
          : null

      const rows = (await db`
        INSERT INTO atlas.ingestions (event_id, workflow_id, status, error, started_at, finished_at)
        VALUES (
          ${eventId},
          ${workflowId},
          ${status},
          ${error},
          COALESCE(${startedAtValue}, now()),
          ${finishedAtValue}
        )
        ON CONFLICT (event_id, workflow_id) DO UPDATE
        SET status = CASE
              WHEN atlas.ingestions.status IN ('completed', 'failed', 'skipped') THEN atlas.ingestions.status
              ELSE EXCLUDED.status
            END,
            error = COALESCE(EXCLUDED.error, atlas.ingestions.error),
            started_at = COALESCE(EXCLUDED.started_at, atlas.ingestions.started_at),
            finished_at = COALESCE(EXCLUDED.finished_at, atlas.ingestions.finished_at)
        RETURNING id, event_id;
      `) as Array<{ id: string; event_id: string }>

      const row = rows[0]
      if (!row) {
        throw new Error('ingestion upsert failed')
      }

      logActivity('info', 'completed', 'upsertIngestion', {
        deliveryId,
        workflowId,
        status,
        ingestionId: row.id,
        durationMs: Date.now() - startedAt,
      })

      return { ingestionId: row.id, eventId: row.event_id }
    } catch (error) {
      logActivity('error', 'failed', 'upsertIngestion', {
        deliveryId,
        workflowId,
        status,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async upsertEventFile(input: UpsertEventFileInput): Promise<UpsertEventFileOutput> {
    const startedAt = Date.now()
    const deliveryId = input.deliveryId.trim()
    const fileKeyId = input.fileKeyId.trim()
    const changeType = input.changeType.trim()

    if (!deliveryId || !fileKeyId || !changeType) {
      logActivity('info', 'skipped', 'upsertEventFile', {
        reason: 'missing_required_fields',
        deliveryId: deliveryId || null,
        fileKeyId: fileKeyId || null,
        changeType: changeType || null,
        durationMs: Date.now() - startedAt,
      })
      return null
    }

    logActivity('info', 'started', 'upsertEventFile', {
      deliveryId,
      fileKeyId,
      changeType,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      const eventId = await resolveGithubEventId(db, deliveryId)
      if (!eventId) {
        logActivity('info', 'skipped', 'upsertEventFile', {
          deliveryId,
          fileKeyId,
          changeType,
          reason: 'event_not_found',
          durationMs: Date.now() - startedAt,
        })
        return null
      }

      const rows = (await db`
        INSERT INTO atlas.event_files (event_id, file_key_id, change_type)
        VALUES (${eventId}, ${fileKeyId}, ${changeType})
        ON CONFLICT (event_id, file_key_id) DO UPDATE
        SET change_type = EXCLUDED.change_type
        RETURNING id;
      `) as Array<{ id: string }>

      const row = rows[0]
      if (!row) {
        throw new Error('event file upsert failed')
      }

      logActivity('info', 'completed', 'upsertEventFile', {
        deliveryId,
        fileKeyId,
        changeType,
        eventFileId: row.id,
        durationMs: Date.now() - startedAt,
      })

      return { eventFileId: row.id, eventId, fileKeyId }
    } catch (error) {
      logActivity('error', 'failed', 'upsertEventFile', {
        deliveryId,
        fileKeyId,
        changeType,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async upsertIngestionTarget(input: UpsertIngestionTargetInput): Promise<void> {
    const startedAt = Date.now()
    const ingestionId = input.ingestionId.trim()
    const fileVersionId = input.fileVersionId.trim()
    const kind = input.kind.trim()

    if (!ingestionId || !fileVersionId || !kind) {
      logActivity('info', 'skipped', 'upsertIngestionTarget', {
        reason: 'missing_required_fields',
        ingestionId: ingestionId || null,
        fileVersionId: fileVersionId || null,
        kind: kind || null,
        durationMs: Date.now() - startedAt,
      })
      return
    }

    logActivity('info', 'started', 'upsertIngestionTarget', {
      ingestionId,
      fileVersionId,
      kind,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      await db`
        INSERT INTO atlas.ingestion_targets (ingestion_id, file_version_id, kind)
        VALUES (${ingestionId}, ${fileVersionId}, ${kind})
        ON CONFLICT (ingestion_id, file_version_id, kind) DO UPDATE
        SET kind = EXCLUDED.kind;
      `

      logActivity('info', 'completed', 'upsertIngestionTarget', {
        ingestionId,
        fileVersionId,
        kind,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      logActivity('error', 'failed', 'upsertIngestionTarget', {
        ingestionId,
        fileVersionId,
        kind,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },

  async markEventProcessed(input: MarkEventProcessedInput): Promise<void> {
    const startedAt = Date.now()
    const deliveryId = input.deliveryId.trim()

    if (deliveryId.length === 0) {
      logActivity('info', 'skipped', 'markEventProcessed', {
        reason: 'empty_delivery_id',
        durationMs: Date.now() - startedAt,
      })
      return
    }

    logActivity('info', 'started', 'markEventProcessed', {
      deliveryId,
    })

    try {
      const db = getAtlasDb()
      if (!db) {
        throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
      }

      await db`
        UPDATE atlas.github_events
        SET processed_at = now()
        WHERE delivery_id = ${deliveryId};
      `

      logActivity('info', 'completed', 'markEventProcessed', {
        deliveryId,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      logActivity('error', 'failed', 'markEventProcessed', {
        deliveryId,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    }
  },
}

export default activities

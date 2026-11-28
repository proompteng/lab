import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { extname, resolve } from 'node:path'
import { SQL } from 'bun'
import { Effect } from 'effect'
import * as Semaphore from 'effect/Semaphore'
import { Language, Parser, type Tree } from 'web-tree-sitter'

import { currentActivityContext } from '@proompteng/temporal-bun-sdk/worker'

import { LEGACY_RECONCILE_PENDING_ERROR } from '../atlas/ingestion-status'
import {
  assertAtlasManifestMatches,
  type AtlasCurrentFile,
  type AtlasGitFile,
  parseAtlasGitTree,
  planAtlasFileChanges,
} from '../atlas/reconciliation'
import { runCommandIsolated } from '../command-runner'
import {
  publishMainMergeMemoryNoteActivity,
  runGitFetchWithPublicFallback,
  type MainMergeMemoryNoteInput,
} from '../event-consumer'

export type ReconcileAtlasRepositoryInput = {
  repoRoot: string
  repository: string
  ref?: string | null
  commit?: string | null
}

export type ReconcileAtlasRepositoryOutput = {
  repository: string
  ref: string
  commit: string
  treeHash: string
  expectedFiles: number
  indexedFiles: number
  deletedFiles: number
  changedFiles: number
  unchangedFiles: number
  chunks: number
  embeddings: number
}

type UpsertIngestionInput = {
  deliveryId: string
  workflowId: string
  status: string
  error?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  correctLegacyPendingFailure?: boolean
}

type UpsertIngestionOutput = {
  ingestionId: string
  eventId: string
} | null

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding-saigak:8b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 4096
const DEFAULT_ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION = 1024
const MAX_AST_BYTES = 200_000
const DEFAULT_MODEL_CONCURRENCY = 2
const DEFAULT_EMBEDDING_MAX_ATTEMPTS = 2
const DEFAULT_EMBEDDING_RETRY_INITIAL_MS = 500
const DEFAULT_EMBEDDING_RETRY_MAX_MS = 8_000
const DEFAULT_EMBEDDING_RETRY_BACKOFF = 2
const ATLAS_CHUNKER_VERSION = 'atlas-chunker-v2'
const ATLAS_RECONCILIATION_HEARTBEAT_INTERVAL_MS = 15_000
const ATLAS_RECONCILIATION_LEASE_MS = 5 * 60_000

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

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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

type EmbeddingRuntimeConfig = ReturnType<typeof loadEmbeddingConfig>

const loadAtlasCodeSearchEmbeddingConfig = (): EmbeddingRuntimeConfig => {
  const base = loadEmbeddingConfig()
  const rawDimension =
    process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION ?? String(DEFAULT_ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION)
  const dimension = Number.parseInt(rawDimension, 10)
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw createNonRetryableError(
      'ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION must be a positive integer',
      'EmbeddingConfigError',
    )
  }
  return {
    ...base,
    model: normalizeOptionalText(process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL) ?? base.model,
    dimension,
  }
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const COMMAND_TIMEOUT_MS = 30_000

const runCommandRaw = async (
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<CommandResult> => {
  try {
    const result = await runCommandIsolated(args, cwd, COMMAND_TIMEOUT_MS, env)
    const { stdout, stderr } = result
    if (result.exitCode === null) {
      return {
        exitCode: 1,
        stdout,
        stderr: stderr || `command timed out after ${COMMAND_TIMEOUT_MS}ms`,
      }
    }
    return {
      exitCode: result.exitCode,
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

const commitExistsLocally = async (repoRoot: string, commit: string) => {
  const result = await runCommandResult(['git', '-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`], repoRoot, {
    GIT_TERMINAL_PROMPT: '0',
  })
  return result.exitCode === 0
}

const fetchCommitFromOrigin = async (repoRoot: string, commit: string) => {
  const fetchArgs = ['fetch', '--no-auto-maintenance', '--quiet', '--depth=1', 'origin', commit]
  const result = await runGitFetchWithPublicFallback(fetchArgs, (args) =>
    runCommandResult(['git', '-C', repoRoot, ...args], repoRoot, { GIT_TERMINAL_PROMPT: '0' }),
  )
  return result.exitCode === 0
}

const fetchFromOrigin = async (repoRoot: string, ref: string) => {
  const refspec = ref === 'main' ? '+refs/heads/main:refs/remotes/origin/main' : ref
  const fetchArgs = ['fetch', '--no-auto-maintenance', '--quiet', '--depth=1', 'origin', refspec]
  const result = await runGitFetchWithPublicFallback(fetchArgs, (args) =>
    runCommandResult(['git', '-C', repoRoot, ...args], repoRoot, { GIT_TERMINAL_PROMPT: '0' }),
  )
  return result.exitCode === 0
}

const readGitFile = async (repoRoot: string, ref: string, filePath: string) => {
  const result = await runCommandRaw(['git', '-C', repoRoot, 'show', `${ref}:${filePath}`], repoRoot, {
    GIT_TERMINAL_PROMPT: '0',
  })
  if (result.exitCode !== 0) return null
  return result.stdout
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

type TreeSitterParserResource = {
  setLanguage: (language: Language) => unknown
  parse: (source: string) => Tree | null
  delete: () => void
}

const withParsedTree = <T>(
  language: Language,
  source: string,
  read: (tree: Tree) => T,
  createParser: () => TreeSitterParserResource = () => new Parser(),
): T | null => {
  const parser = createParser()
  let tree: Tree | null = null

  try {
    parser.setLanguage(language)
    tree = parser.parse(source)
    return tree ? read(tree) : null
  } finally {
    try {
      tree?.delete()
    } finally {
      parser.delete()
    }
  }
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

const loadLanguageForExtension = async (ext: string): Promise<Language | null> => {
  const entry = languageWasmByExtension.get(ext)
  if (!entry) return null

  await ensureParserInit()

  const cached = loadedLanguages.get(entry.name)
  if (cached) return cached

  let loadPromise = languageLoadPromises.get(entry.name)
  if (!loadPromise) {
    loadPromise = Language.load(entry.wasmPath)
    languageLoadPromises.set(entry.name, loadPromise)
  }

  try {
    const language = await loadPromise
    loadedLanguages.set(entry.name, language)
    languageLoadPromises.delete(entry.name)
    return language
  } catch (error) {
    languageLoadPromises.delete(entry.name)
    throw error
  }
}

const clampNumber = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback)
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

const embeddingConcurrency = clampNumber(
  Number.parseInt(process.env.BUMBA_EMBEDDING_CONCURRENCY ?? '', 10),
  clampNumber(Number.parseInt(process.env.BUMBA_MODEL_CONCURRENCY ?? '', 10), DEFAULT_MODEL_CONCURRENCY),
)
const embeddingSemaphore = Semaphore.makeUnsafe(embeddingConcurrency)
const withEmbeddingConcurrency = async <T>(fn: () => Promise<T>): Promise<T> =>
  await Effect.runPromise(
    embeddingSemaphore.withPermits(1)(
      Effect.tryPromise({
        try: fn,
        catch: (error) => toError(error),
      }),
    ),
  )

const splitLines = (source: string) => source.split(/\r?\n/)

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

type ExtractedFileChunk = {
  chunkIndex: number
  startLine: number
  endLine: number
  content: string
  tokenCount: number
  metadata: Record<string, unknown>
}

const loadChunkingConfig = () => {
  const linesPerChunk = clampNumber(Number.parseInt(process.env.BUMBA_ATLAS_CHUNK_LINES ?? '', 10), 80)
  const minChunkLines = clampNumber(Number.parseInt(process.env.BUMBA_ATLAS_MIN_CHUNK_LINES ?? '', 10), 1)
  const maxChunkLines = clampNumber(Number.parseInt(process.env.BUMBA_ATLAS_MAX_CHUNK_LINES ?? '', 10), 220)
  const maxChunks = clampNumber(Number.parseInt(process.env.BUMBA_ATLAS_MAX_CHUNKS ?? '', 10), 1_000)
  const overlapLines = Math.min(
    linesPerChunk - 1,
    clampNumber(Number.parseInt(process.env.BUMBA_ATLAS_CHUNK_OVERLAP_LINES ?? '', 10), 12),
  )
  return { linesPerChunk, minChunkLines, maxChunkLines, maxChunks, overlapLines }
}

const chunkNodeTypes = new Set([
  // TS/JS
  'function_declaration',
  'method_definition',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
  'assignment_expression',
  // Go
  'function_declaration',
  'method_declaration',
  'type_declaration',
  // Python
  'function_definition',
  'class_definition',
  // Kotlin
  'class_declaration',
  'object_declaration',
  'function_declaration',
  // YAML
  'yaml-pair',
  'yaml-seq-item',
])

const isChunkNode = (node: AstNode) =>
  node.isNamed && (chunkNodeTypes.has(node.type) || node.type.endsWith('_declaration'))

const estimateTokenCount = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

const extractTreeSitterChunks = (root: AstNode, source: string, config: ReturnType<typeof loadChunkingConfig>) => {
  const candidates: Array<{
    nodeType: string
    name: string | null
    startLine: number
    endLine: number
  }> = []

  const stack: AstNode[] = [root]
  while (stack.length > 0 && candidates.length < config.maxChunks * 4) {
    const node = stack.pop()
    if (!node) continue

    if (isChunkNode(node)) {
      const startLine = node.startPosition.row + 1
      const endLine = node.endPosition.row + 1
      const lineSpan = endLine - startLine + 1
      if (lineSpan >= config.minChunkLines && lineSpan <= config.maxChunkLines) {
        const identifier = findIdentifier(node)
        const name = identifier ? source.slice(identifier.startIndex, identifier.endIndex).trim() : null
        candidates.push({ nodeType: node.type, name, startLine, endLine })
      }
    }

    const children = node.namedChildren
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (child) stack.push(child)
    }
  }

  candidates.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)

  const selected: typeof candidates = []
  for (const candidate of candidates) {
    if (selected.length >= config.maxChunks) break
    const last = selected[selected.length - 1]
    if (last && candidate.startLine <= last.endLine) {
      // Avoid overlapping/nested nodes to keep chunks stable.
      continue
    }
    selected.push(candidate)
  }

  const lines = splitLines(source)
  const chunks: ExtractedFileChunk[] = []
  selected.forEach((range, idx) => {
    const start = Math.max(1, range.startLine)
    const end = Math.min(lines.length, Math.max(start, range.endLine))
    const content = lines.slice(start - 1, end).join('\n')
    chunks.push({
      chunkIndex: idx,
      startLine: start,
      endLine: end,
      content,
      tokenCount: estimateTokenCount(content),
      metadata: {
        chunkType: 'ast_node',
        nodeType: range.nodeType,
        name: range.name,
      },
    })
  })

  return chunks
}

const extractFixedLineChunks = (source: string, config: ReturnType<typeof loadChunkingConfig>) => {
  const lines = splitLines(source)
  const chunks: ExtractedFileChunk[] = []
  if (lines.length === 0) return chunks
  let index = 0
  const stride = Math.max(1, config.linesPerChunk - config.overlapLines)
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(lines.length, start + config.linesPerChunk)
    const content = lines.slice(start, end).join('\n')
    chunks.push({
      chunkIndex: index,
      startLine: start + 1,
      endLine: end,
      content,
      tokenCount: estimateTokenCount(content),
      metadata: {
        chunkType: 'fixed_lines',
      },
    })
    index += 1
    if (end === lines.length) break
  }
  return chunks
}

const addUncoveredLineChunks = (
  source: string,
  chunks: ExtractedFileChunk[],
  config: ReturnType<typeof loadChunkingConfig>,
) => {
  const lines = splitLines(source)
  const covered = new Uint8Array(lines.length)
  for (const chunk of chunks) {
    for (let line = Math.max(1, chunk.startLine); line <= Math.min(lines.length, chunk.endLine); line += 1) {
      covered[line - 1] = 1
    }
  }

  while (true) {
    const firstUncovered = lines.findIndex((line, index) => line.trim().length > 0 && covered[index] === 0)
    if (firstUncovered === -1) break

    const start = Math.max(0, firstUncovered - config.overlapLines)
    const end = Math.min(lines.length, start + config.linesPerChunk)
    const content = lines.slice(start, end).join('\n')
    chunks.push({
      chunkIndex: chunks.length,
      startLine: start + 1,
      endLine: end,
      content,
      tokenCount: estimateTokenCount(content),
      metadata: {
        chunkType: 'uncovered_lines',
      },
    })

    for (let line = start; line < end; line += 1) {
      covered[line] = 1
    }
  }

  return chunks
}

const assertChunkCoverage = (source: string, chunks: ExtractedFileChunk[]) => {
  const lines = splitLines(source)
  const covered = new Uint8Array(lines.length)
  for (const chunk of chunks) {
    for (let line = Math.max(1, chunk.startLine); line <= Math.min(lines.length, chunk.endLine); line += 1) {
      covered[line - 1] = 1
    }
  }

  const uncovered = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line, number }) => line.trim().length > 0 && covered[number - 1] === 0)
    .map(({ number }) => number)

  if (uncovered.length > 0) {
    throw new Error(`Atlas chunk coverage failed for nonblank lines: ${uncovered.slice(0, 20).join(', ')}`)
  }
}

const finalizeFileChunks = (
  source: string,
  chunks: ExtractedFileChunk[],
  config: ReturnType<typeof loadChunkingConfig>,
) => {
  const sorted = chunks.sort(
    (left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine || left.content.localeCompare(right.content),
  )
  if (sorted.length > config.maxChunks) {
    throw new Error(`Atlas chunk limit exceeded: generated ${sorted.length}, maximum ${config.maxChunks}`)
  }

  const finalized = sorted.map((chunk, chunkIndex) => ({
    ...chunk,
    chunkIndex,
    metadata: {
      ...chunk.metadata,
      chunkerVersion: ATLAS_CHUNKER_VERSION,
      contentHash: createHash('sha256').update(chunk.content).digest('hex'),
    },
  }))
  assertChunkCoverage(source, finalized)
  return finalized
}

const extractFileChunks = async (source: string, filePath: string): Promise<ExtractedFileChunk[]> => {
  const config = loadChunkingConfig()
  if (!source.trim()) return []

  const maxBytes = clampNumber(Number.parseInt(process.env.BUMBA_MAX_AST_BYTES ?? '', 10), MAX_AST_BYTES)
  if (source.length > maxBytes) {
    return finalizeFileChunks(source, extractFixedLineChunks(source, config), config)
  }

  let language: Language | null
  try {
    language = await loadLanguageForExtension(extname(filePath).toLowerCase())
  } catch {
    return finalizeFileChunks(source, extractFixedLineChunks(source, config), config)
  }

  if (!language) {
    return finalizeFileChunks(source, extractFixedLineChunks(source, config), config)
  }

  try {
    const chunks = withParsedTree(language, source, (tree) => {
      const extracted = extractTreeSitterChunks(tree.rootNode as AstNode, source, config)
      return extracted.length > 0
        ? addUncoveredLineChunks(source, extracted, config)
        : extractFixedLineChunks(source, config)
    })
    return finalizeFileChunks(source, chunks ?? extractFixedLineChunks(source, config), config)
  } catch {
    return finalizeFileChunks(source, extractFixedLineChunks(source, config), config)
  }
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

const requestEmbeddingBatchOnce = async (texts: string[], config: EmbeddingRuntimeConfig): Promise<number[][]> => {
  const { apiKey, embeddingBaseUrl, model, dimension, timeoutMs, maxInputChars, truncate, keepAlive } = config

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
        dimensions: dimension,
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

const requestEmbeddingBatch = async (texts: string[], config: EmbeddingRuntimeConfig): Promise<number[][]> => {
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffCoefficient } = loadEmbeddingRetryConfig()
  let attempt = 1
  let lastError: unknown

  while (attempt <= maxAttempts) {
    try {
      return await requestEmbeddingBatchOnce(texts, config)
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

const embedTexts = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return []

  const config = loadAtlasCodeSearchEmbeddingConfig()
  const batchSize = config.batchSize
  const batchMaxChars = loadEmbeddingBatchMaxChars()
  if (batchSize <= 1 && !batchMaxChars) {
    return await requestEmbeddingBatch(texts, config)
  }

  const chunks: number[][] = []
  for (let i = 0; i < texts.length; ) {
    const batch: string[] = []
    let batchChars = 0
    while (i < texts.length && batch.length < batchSize) {
      const next = texts[i] ?? ''
      const nextChars = next.length
      if (batchMaxChars && batch.length > 0 && batchChars + nextChars > batchMaxChars) {
        break
      }
      batch.push(next)
      batchChars += nextChars
      i += 1
    }
    if (batch.length === 0) {
      batch.push(texts[i] ?? '')
      i += 1
    }
    const embeddings = await requestEmbeddingBatch(batch, config)
    chunks.push(...embeddings)
  }
  return chunks
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

const truncateMetadataError = (error: unknown) => {
  const message = formatActivityError(error)
  return message.length > 500 ? `${message.slice(0, 500)}...` : message
}

type AtlasRepositoryStateRow = {
  id: string
  metadata: Record<string, unknown> | string | null
}

type AtlasCurrentFileRow = AtlasCurrentFile & {
  file_key_id: string
  file_version_id: string
  repository_commit: string | null
}

type PreparedAtlasFile = {
  git: AtlasGitFile
  contentHash: string
  language: string | null
  lineCount: number
  chunks: Array<ExtractedFileChunk & { embedding: number[] }>
}

type AtlasReconciliationProgress = {
  version: 1
  buildId: string
  commit: string
  preparedFiles: number
  changedFiles: number
  deletedFiles: number
  unchangedFiles: number
}

const asMetadataRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return asMetadataRecord(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const toDatabaseCount = (value: unknown) => {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseInt(value, 10)
  return 0
}

const batchValues = <T>(values: T[], size: number) => {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

const resolveAtlasTargetCommit = async (
  repoRoot: string,
  ref: string,
  requestedCommit: string | null,
  resumeCommit: string | null,
) => {
  const fetched = await fetchFromOrigin(repoRoot, ref)
  if (!fetched) {
    throw new Error(`failed to fetch the authoritative origin/${ref} ref`)
  }

  const remoteCommit = await runCommand(
    ['git', '-C', repoRoot, 'rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`],
    repoRoot,
    { GIT_TERMINAL_PROMPT: '0' },
  )
  if (!remoteCommit || !/^[0-9a-f]{40}$/i.test(remoteCommit)) {
    throw new Error(`unable to resolve an exact 40-character origin/${ref} commit`)
  }
  const targetCommit = resumeCommit ?? remoteCommit
  if (!(await commitExistsLocally(repoRoot, targetCommit))) {
    const fetched = await fetchCommitFromOrigin(repoRoot, targetCommit)
    if (!fetched || !(await commitExistsLocally(repoRoot, targetCommit))) {
      throw new Error(`target commit ${targetCommit} is not available in the repository`)
    }
  }
  if (resumeCommit && resumeCommit !== remoteCommit) {
    logActivity('info', 'resumed', 'reconcileAtlasRepository', {
      resumeCommit,
      currentCommit: remoteCommit,
    })
  } else if (requestedCommit && requestedCommit !== targetCommit) {
    logActivity('info', 'superseded', 'reconcileAtlasRepository', {
      requestedCommit,
      targetCommit,
    })
  }
  return targetCommit
}

const loadAtlasGitManifest = async (repoRoot: string, commit: string) => {
  const result = await runCommandRaw(['git', '-C', repoRoot, 'ls-tree', '-r', '-z', '--long', commit], repoRoot, {
    GIT_TERMINAL_PROMPT: '0',
  })
  if (result.exitCode !== 0) {
    throw new Error(`failed to enumerate Git tree ${commit}: ${result.stderr}`)
  }
  return parseAtlasGitTree(result.stdout)
}

const loadAtlasRepositoryState = async (db: SQL, repository: string) => {
  const repositoryRows = (await db`
    SELECT id, metadata
    FROM atlas.repositories
    WHERE name = ${repository}
    LIMIT 1;
  `) as AtlasRepositoryStateRow[]
  const repositoryRow = repositoryRows[0] ?? null
  if (!repositoryRow) return { repository: null, files: [] as AtlasCurrentFileRow[] }

  const files = (await db`
    SELECT
      fk.id AS file_key_id,
      fv.id AS file_version_id,
      fk.path,
      fv.content_hash AS "contentHash",
      NULLIF(fv.metadata->>'gitObjectId', '') AS "gitObjectId",
      fv.repository_commit
    FROM atlas.file_keys fk
    LEFT JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
    WHERE fk.repository_id = ${repositoryRow.id}
    ORDER BY fk.path;
  `) as AtlasCurrentFileRow[]
  return { repository: repositoryRow, files }
}

const readAtlasReconciliationProgress = (value: unknown): AtlasReconciliationProgress | null => {
  const record = asMetadataRecord(value)
  const integer = (field: string) => {
    const candidate = record[field]
    return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 ? candidate : null
  }
  const buildId = typeof record.buildId === 'string' ? record.buildId : ''
  const commit = typeof record.commit === 'string' ? record.commit : ''
  const preparedFiles = integer('preparedFiles')
  const changedFiles = integer('changedFiles')
  const deletedFiles = integer('deletedFiles')
  const unchangedFiles = integer('unchangedFiles')
  if (
    record.version !== 1 ||
    !buildId ||
    !/^[0-9a-f]{40}$/i.test(commit) ||
    preparedFiles === null ||
    changedFiles === null ||
    deletedFiles === null ||
    unchangedFiles === null
  ) {
    return null
  }
  return { version: 1, buildId, commit, preparedFiles, changedFiles, deletedFiles, unchangedFiles }
}

const beginAtlasReconciliation = async (input: {
  db: SQL
  repository: string
  commit: string
  manifest: Awaited<ReturnType<typeof loadAtlasGitManifest>>
  baseIndexedCommit: string | null
  buildId: string
  embeddingModel: string
  embeddingDimension: number
  preparedFiles: number
}) => {
  const {
    db,
    repository,
    commit,
    manifest,
    baseIndexedCommit,
    buildId,
    embeddingModel,
    embeddingDimension,
    preparedFiles,
  } = input
  const manifestPaths = manifest.files.map((file) => file.path)
  const now = new Date()
  const metadataPatch = JSON.stringify({
    indexStatus: 'building',
    buildId,
    targetCommit: commit,
    gitHead: commit,
    treeHash: manifest.treeHash,
    expectedFiles: manifest.files.length,
    targetEligibilityVersion: manifest.eligibilityVersion,
    targetChunkerVersion: ATLAS_CHUNKER_VERSION,
    targetEmbeddingModel: embeddingModel,
    targetEmbeddingDimension: embeddingDimension,
    preparedFiles,
    lastError: null,
    failedAt: null,
    buildStartedAt: now.toISOString(),
    buildHeartbeatAt: now.toISOString(),
  })

  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`atlas:${repository}`}, 0));`
    await tx`
      INSERT INTO atlas.repositories (name, default_ref, metadata)
      VALUES (${repository}, ${'main'}, '{}'::jsonb)
      ON CONFLICT (name) DO NOTHING;
    `
    const rows = (await tx`
      SELECT id, metadata
      FROM atlas.repositories
      WHERE name = ${repository}
      FOR UPDATE;
    `) as AtlasRepositoryStateRow[]
    const row = rows[0]
    if (!row) throw new Error(`Atlas repository state disappeared for ${repository}`)
    const metadata = asMetadataRecord(row.metadata)
    const indexedCommit =
      typeof metadata.indexedCommit === 'string' && metadata.indexedCommit.length > 0 ? metadata.indexedCommit : null
    if (indexedCommit !== baseIndexedCommit) {
      throw createRetryableError(
        `Atlas reconciliation was superseded: prepared from ${baseIndexedCommit ?? 'empty'}, current is ${indexedCommit ?? 'empty'}`,
      )
    }

    const activeBuildId = typeof metadata.buildId === 'string' ? metadata.buildId : null
    const heartbeatAt =
      typeof metadata.buildHeartbeatAt === 'string' ? Date.parse(metadata.buildHeartbeatAt) : Number.NaN
    const activeLease =
      metadata.indexStatus === 'building' &&
      activeBuildId &&
      activeBuildId !== buildId &&
      Number.isFinite(heartbeatAt) &&
      now.getTime() - heartbeatAt < ATLAS_RECONCILIATION_LEASE_MS
    if (activeLease) {
      throw createRetryableError(`Atlas reconciliation ${activeBuildId} is already active for ${repository}`)
    }

    await tx`
      UPDATE atlas.repositories
      SET default_ref = 'main',
          metadata = COALESCE(metadata, '{}'::jsonb) || ${metadataPatch}::text::jsonb,
          updated_at = now()
      WHERE id = ${row.id};
    `

    if (manifestPaths.length > 0) {
      await tx`
        INSERT INTO atlas.file_keys (repository_id, path)
        SELECT ${row.id}, path
        FROM UNNEST(${tx.array(manifestPaths, 'text')}) AS manifest(path)
        ON CONFLICT (repository_id, path) DO UPDATE SET path = EXCLUDED.path;
      `
      await tx`
        DELETE FROM atlas.file_keys
        WHERE repository_id = ${row.id}
          AND NOT (path = ANY(${tx.array(manifestPaths, 'text')}));
      `
    } else {
      await tx`DELETE FROM atlas.file_keys WHERE repository_id = ${row.id};`
    }
  })
}

const markAtlasRepositoryFailed = async (db: SQL, repository: string, buildId: string, error: unknown) => {
  const patch = JSON.stringify({
    indexStatus: 'failed',
    lastError: truncateMetadataError(error),
    failedAt: new Date().toISOString(),
    buildHeartbeatAt: new Date().toISOString(),
  })
  await db`
    UPDATE atlas.repositories
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${patch}::text::jsonb,
        updated_at = now()
    WHERE name = ${repository}
      AND metadata->>'buildId' = ${buildId};
  `
}

const prepareAtlasFile = async (repoRoot: string, commit: string, file: AtlasGitFile): Promise<PreparedAtlasFile> => {
  const content = await readGitFile(repoRoot, commit, file.path)
  if (content === null) {
    throw new Error(`failed to read ${file.path} from Git commit ${commit}`)
  }
  if (content.includes('\0')) {
    throw new Error(`eligible Atlas file contains NUL bytes: ${file.path}`)
  }

  const actualBytes = Buffer.byteLength(content, 'utf8')
  if (actualBytes !== file.byteSize) {
    throw new Error(`Git byte-size mismatch for ${file.path}: expected ${file.byteSize}, read ${actualBytes}`)
  }

  const chunks = await extractFileChunks(content, file.path)
  const config = loadAtlasCodeSearchEmbeddingConfig()
  const inputs = chunks.map((chunk) =>
    chunk.content.length > config.maxInputChars ? chunk.content.slice(0, config.maxInputChars) : chunk.content,
  )
  const embeddings = await embedTexts(inputs)
  if (embeddings.length !== chunks.length) {
    throw new Error(`embedding count mismatch for ${file.path}: expected ${chunks.length}, got ${embeddings.length}`)
  }

  return {
    git: file,
    contentHash: createHash('sha256').update(content).digest('hex'),
    language: languageNameByExtension.get(extname(file.path).toLowerCase()) ?? null,
    lineCount: content.split(/\r?\n/).length,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? [],
    })),
  }
}

const applyAtlasReconciliation = async (input: {
  db: SQL
  repository: string
  ref: string
  commit: string
  manifest: Awaited<ReturnType<typeof loadAtlasGitManifest>>
  preparedFiles: PreparedAtlasFile[]
  buildId: string
  preparedFileCount: number
  totalChangedFiles: number
  deletedFiles: number
  unchangedFiles: number
  finalize: boolean
}): Promise<ReconcileAtlasRepositoryOutput | null> => {
  const { db, repository, ref, commit, manifest, preparedFiles, buildId } = input
  const embeddingConfig = loadAtlasCodeSearchEmbeddingConfig()
  const manifestPaths = manifest.files.map((file) => file.path)
  const manifestObjectIds = manifest.files.map((file) => file.objectId)
  const preparedPaths = preparedFiles.map((file) => file.git.path)

  return await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`atlas:${repository}`}, 0));`

    const lockedRows = (await tx`
      SELECT id, metadata
      FROM atlas.repositories
      WHERE name = ${repository}
      FOR UPDATE;
    `) as AtlasRepositoryStateRow[]
    const lockedRepository = lockedRows[0]
    if (!lockedRepository) throw new Error(`Atlas repository state disappeared for ${repository}`)
    const lockedMetadata = asMetadataRecord(lockedRepository.metadata)
    if (lockedMetadata.buildId !== buildId || lockedMetadata.targetCommit !== commit) {
      throw createRetryableError(`Atlas reconciliation ${buildId} no longer owns ${repository} at ${commit}`)
    }

    const fileKeyRows = preparedPaths.length
      ? ((await tx`
          SELECT id, path
          FROM atlas.file_keys
          WHERE repository_id = ${lockedRepository.id}
            AND path = ANY(${tx.array(preparedPaths, 'text')});
        `) as Array<{ id: string; path: string }>)
      : []
    const fileKeyIdByPath = new Map(fileKeyRows.map((row) => [row.path, row.id]))

    if (preparedPaths.length > 0) {
      await tx`
        DELETE FROM atlas.file_versions fv
        USING atlas.file_keys fk
        WHERE fv.file_key_id = fk.id
          AND fk.repository_id = ${lockedRepository.id}
          AND fk.path = ANY(${tx.array(preparedPaths, 'text')});
      `
    }

    const fileVersionIdByPath = new Map<string, string>()
    for (const batch of batchValues(preparedFiles, 500)) {
      const ids = batch.map(() => randomUUID())
      const fileKeyIds = batch.map((file) => {
        const id = fileKeyIdByPath.get(file.git.path)
        if (!id) throw new Error(`missing file key for prepared path ${file.git.path}`)
        return id
      })
      const rows = (await tx`
        INSERT INTO atlas.file_versions (
          id,
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
        SELECT
          id,
          file_key_id,
          ${ref},
          ${commit},
          content_hash,
          language,
          byte_size,
          line_count,
          jsonb_build_object(
            'source', 'git',
            'gitObjectId', git_object_id,
            'indexedCommit', ${commit}::text,
            'eligibilityVersion', ${manifest.eligibilityVersion}::text,
            'chunkerVersion', ${ATLAS_CHUNKER_VERSION}::text
          ),
          NULL
        FROM UNNEST(
          ${tx.array(ids, 'uuid')},
          ${tx.array(fileKeyIds, 'uuid')},
          ${tx.array(
            batch.map((file) => file.contentHash),
            'text',
          )},
          ${tx.array(
            batch.map((file) => file.language),
            'text',
          )},
          ${tx.array(
            batch.map((file) => file.git.byteSize),
            'int4',
          )},
          ${tx.array(
            batch.map((file) => file.lineCount),
            'int4',
          )},
          ${tx.array(
            batch.map((file) => file.git.objectId),
            'text',
          )}
        ) AS source(id, file_key_id, content_hash, language, byte_size, line_count, git_object_id)
        RETURNING id, file_key_id;
      `) as Array<{ id: string; file_key_id: string }>
      const pathByFileKeyId = new Map(batch.map((file, index) => [fileKeyIds[index], file.git.path]))
      for (const row of rows) {
        const path = pathByFileKeyId.get(row.file_key_id)
        if (path) fileVersionIdByPath.set(path, row.id)
      }
    }

    if (input.finalize) {
      await tx`
        UPDATE atlas.file_versions fv
        SET repository_ref = ${ref},
            repository_commit = ${commit},
            metadata = COALESCE(fv.metadata, '{}'::jsonb) || jsonb_build_object(
              'gitObjectId', manifest.object_id,
              'indexedCommit', ${commit}::text,
              'eligibilityVersion', ${manifest.eligibilityVersion}::text,
              'chunkerVersion', ${ATLAS_CHUNKER_VERSION}::text
            ),
            updated_at = now()
        FROM atlas.file_keys fk
        JOIN UNNEST(
          ${tx.array(manifestPaths, 'text')},
          ${tx.array(manifestObjectIds, 'text')}
        ) AS manifest(path, object_id) ON manifest.path = fk.path
        WHERE fv.file_key_id = fk.id
          AND fk.repository_id = ${lockedRepository.id};
      `
    }

    const preparedChunks = preparedFiles.flatMap((file) => {
      const fileVersionId = fileVersionIdByPath.get(file.git.path)
      if (!fileVersionId) throw new Error(`missing file version for prepared path ${file.git.path}`)
      return file.chunks.map((chunk) => ({
        ...chunk,
        id: randomUUID(),
        fileVersionId,
      }))
    })

    for (const batch of batchValues(preparedChunks, 500)) {
      await tx`
        INSERT INTO atlas.file_chunks (
          id,
          file_version_id,
          chunk_index,
          start_line,
          end_line,
          content,
          token_count,
          metadata,
          text_tsvector
        )
        SELECT
          id,
          file_version_id,
          chunk_index,
          start_line,
          end_line,
          content,
          token_count,
          jsonb_strip_nulls(jsonb_build_object(
            'chunkType', chunk_type,
            'nodeType', node_type,
            'name', chunk_name,
            'chunkerVersion', ${ATLAS_CHUNKER_VERSION}::text,
            'contentHash', content_hash
          )),
          to_tsvector('simple', content)
        FROM UNNEST(
          ${tx.array(
            batch.map((chunk) => chunk.id),
            'uuid',
          )},
          ${tx.array(
            batch.map((chunk) => chunk.fileVersionId),
            'uuid',
          )},
          ${tx.array(
            batch.map((chunk) => chunk.chunkIndex),
            'int4',
          )},
          ${tx.array(
            batch.map((chunk) => chunk.startLine),
            'int4',
          )},
          ${tx.array(
            batch.map((chunk) => chunk.endLine),
            'int4',
          )},
          ${tx.array(
            batch.map((chunk) => chunk.content),
            'text',
          )},
          ${tx.array(
            batch.map((chunk) => chunk.tokenCount),
            'int4',
          )},
          ${tx.array(
            batch.map((chunk) => (typeof chunk.metadata.chunkType === 'string' ? chunk.metadata.chunkType : 'unknown')),
            'text',
          )},
          ${tx.array(
            batch.map((chunk) => (typeof chunk.metadata.nodeType === 'string' ? chunk.metadata.nodeType : null)),
            'text',
          )},
          ${tx.array(
            batch.map((chunk) => (typeof chunk.metadata.name === 'string' ? chunk.metadata.name : null)),
            'text',
          )},
          ${tx.array(
            batch.map((chunk) => (typeof chunk.metadata.contentHash === 'string' ? chunk.metadata.contentHash : '')),
            'text',
          )}
        ) AS chunk(
          id,
          file_version_id,
          chunk_index,
          start_line,
          end_line,
          content,
          token_count,
          chunk_type,
          node_type,
          chunk_name,
          content_hash
        );
      `
    }

    for (const batch of batchValues(preparedChunks, 100)) {
      await tx`
        INSERT INTO atlas.chunk_embeddings (chunk_id, model, dimension, embedding)
        SELECT chunk_id, ${embeddingConfig.model}, ${embeddingConfig.dimension}, embedding::vector
        FROM UNNEST(
          ${tx.array(
            batch.map((chunk) => chunk.id),
            'uuid',
          )},
          ${tx.array(
            batch.map((chunk) => vectorToPgArray(chunk.embedding)),
            'text',
          )}
        ) AS embedding(chunk_id, embedding);
      `
    }

    if (!input.finalize) {
      const progressMetadata = JSON.stringify({
        buildHeartbeatAt: new Date().toISOString(),
        preparedFiles: input.preparedFileCount,
      })
      await tx`
        UPDATE atlas.repositories
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${progressMetadata}::text::jsonb,
            updated_at = now()
        WHERE id = ${lockedRepository.id};
      `
      return null
    }

    const indexedRows = (await tx`
      SELECT
        fk.path,
        fv.repository_commit,
        fv.metadata->>'gitObjectId' AS object_id
      FROM atlas.file_keys fk
      JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
      WHERE fk.repository_id = ${lockedRepository.id}
      ORDER BY fk.path;
    `) as Array<{ path: string; repository_commit: string | null; object_id: string | null }>
    assertAtlasManifestMatches(
      manifest,
      indexedRows.map((row) => ({
        path: row.path,
        repositoryCommit: row.repository_commit,
        gitObjectId: row.object_id,
      })),
      commit,
    )

    const coverageRows = (await tx`
      SELECT
        count(fc.id)::bigint AS chunks,
        count(ce.chunk_id)::bigint AS embeddings,
        count(fc.id) FILTER (WHERE ce.chunk_id IS NULL)::bigint AS missing_embeddings
      FROM atlas.file_keys fk
      JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
      LEFT JOIN atlas.file_chunks fc ON fc.file_version_id = fv.id
      LEFT JOIN atlas.chunk_embeddings ce
        ON ce.chunk_id = fc.id
       AND ce.model = ${embeddingConfig.model}
       AND ce.dimension = ${embeddingConfig.dimension}
      WHERE fk.repository_id = ${lockedRepository.id};
    `) as Array<{ chunks: unknown; embeddings: unknown; missing_embeddings: unknown }>
    const chunks = toDatabaseCount(coverageRows[0]?.chunks)
    const embeddings = toDatabaseCount(coverageRows[0]?.embeddings)
    const missingEmbeddings = toDatabaseCount(coverageRows[0]?.missing_embeddings)
    if (missingEmbeddings !== 0 || chunks !== embeddings) {
      throw new Error(
        `Atlas embedding coverage mismatch: chunks=${chunks}, embeddings=${embeddings}, missing=${missingEmbeddings}`,
      )
    }

    const readyMetadata = JSON.stringify({
      indexStatus: 'ready',
      indexedCommit: commit,
      gitHead: commit,
      treeHash: manifest.treeHash,
      eligibilityVersion: manifest.eligibilityVersion,
      chunkerVersion: ATLAS_CHUNKER_VERSION,
      embeddingModel: embeddingConfig.model,
      embeddingDimension: embeddingConfig.dimension,
      expectedFiles: manifest.files.length,
      indexedFiles: indexedRows.length,
      missingPaths: 0,
      stalePaths: 0,
      hashMismatches: 0,
      uncoveredLines: 0,
      expectedChunks: chunks,
      indexedChunks: chunks,
      embeddedChunks: embeddings,
      lastError: null,
      indexedAt: new Date().toISOString(),
    })
    await tx`
      UPDATE atlas.repositories
      SET default_ref = 'main',
          metadata = (
            COALESCE(metadata, '{}'::jsonb)
            - 'buildId'
            - 'targetCommit'
            - 'buildStartedAt'
            - 'buildHeartbeatAt'
            - 'preparedFiles'
            - 'targetEligibilityVersion'
            - 'targetChunkerVersion'
            - 'targetEmbeddingModel'
            - 'targetEmbeddingDimension'
          ) || ${readyMetadata}::text::jsonb,
          updated_at = now()
      WHERE id = ${lockedRepository.id};
    `

    return {
      repository,
      ref,
      commit,
      treeHash: manifest.treeHash,
      expectedFiles: manifest.files.length,
      indexedFiles: indexedRows.length,
      deletedFiles: input.deletedFiles,
      changedFiles: input.totalChangedFiles,
      unchangedFiles: input.unchangedFiles,
      chunks,
      embeddings,
    }
  })
}

const productionActivities = {
  async publishMainMergeMemoryNote(input: MainMergeMemoryNoteInput): Promise<void> {
    await publishMainMergeMemoryNoteActivity(input)
  },

  async reconcileAtlasRepository(input: ReconcileAtlasRepositoryInput): Promise<ReconcileAtlasRepositoryOutput> {
    const startedAt = Date.now()
    const repoRoot = resolve(input.repoRoot)
    const repository = normalizeRepositorySlug(input.repository)
    const ref = normalizeRepositoryRef(input.ref) ?? 'main'
    const requestedCommit = normalizeOptionalText(input.commit)
    if (!repository.includes('/')) throw new Error('Atlas repository must be an owner/name slug')
    if (ref !== 'main') throw new Error(`Atlas indexes only main; received ${ref}`)

    const db = getAtlasDb()
    if (!db) throw new Error('DATABASE_URL is required for Atlas reconciliation')

    const initialState = await loadAtlasRepositoryState(db, repository)
    const initialMetadata = asMetadataRecord(initialState.repository?.metadata)
    const baseIndexedCommit =
      typeof initialMetadata.indexedCommit === 'string' && initialMetadata.indexedCommit.length > 0
        ? initialMetadata.indexedCommit
        : null
    const activityContext = currentActivityContext()
    const previousProgress = readAtlasReconciliationProgress(activityContext?.info.lastHeartbeatDetails[0])
    let buildId: string = randomUUID()
    let progress: AtlasReconciliationProgress | null = null
    let heartbeatFailure: unknown = null
    let heartbeatInFlight = false
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null

    const sendHeartbeat = async () => {
      if (!activityContext || !progress) return
      await activityContext.heartbeat(progress)
      activityContext.throwIfCancelled()
    }

    const assertHeartbeatHealthy = () => {
      activityContext?.throwIfCancelled()
      if (heartbeatFailure) throw heartbeatFailure
    }

    logActivity('info', 'started', 'reconcileAtlasRepository', {
      repository,
      ref,
      requestedCommit,
      baseIndexedCommit,
    })

    try {
      const commit = await resolveAtlasTargetCommit(repoRoot, ref, requestedCommit, previousProgress?.commit ?? null)
      const manifest = await loadAtlasGitManifest(repoRoot, commit)
      const embeddingConfig = loadAtlasCodeSearchEmbeddingConfig()
      const planned = planAtlasFileChanges(manifest, initialState.files)
      const readyConfigurationMatches =
        initialMetadata.eligibilityVersion === manifest.eligibilityVersion &&
        initialMetadata.chunkerVersion === ATLAS_CHUNKER_VERSION &&
        initialMetadata.embeddingModel === embeddingConfig.model &&
        initialMetadata.embeddingDimension === embeddingConfig.dimension
      const resumedConfigurationMatches =
        previousProgress?.commit === commit &&
        initialMetadata.targetEligibilityVersion === manifest.eligibilityVersion &&
        initialMetadata.targetChunkerVersion === ATLAS_CHUNKER_VERSION &&
        initialMetadata.targetEmbeddingModel === embeddingConfig.model &&
        initialMetadata.targetEmbeddingDimension === embeddingConfig.dimension
      const configurationMatches = readyConfigurationMatches || resumedConfigurationMatches
      const changedFiles = configurationMatches ? planned.changed : manifest.files
      const unchangedFiles = configurationMatches ? planned.unchanged : []
      if (previousProgress?.commit === commit) buildId = previousProgress.buildId
      const totalChangedFiles =
        previousProgress?.commit === commit
          ? Math.max(previousProgress.changedFiles, changedFiles.length)
          : changedFiles.length
      const deletedFiles = previousProgress?.commit === commit ? previousProgress.deletedFiles : planned.deleted.length
      const originalUnchangedFiles =
        previousProgress?.commit === commit ? previousProgress.unchangedFiles : unchangedFiles.length
      let preparedFileCount = Math.max(0, totalChangedFiles - changedFiles.length)
      progress = {
        version: 1,
        buildId,
        commit,
        preparedFiles: preparedFileCount,
        changedFiles: totalChangedFiles,
        deletedFiles,
        unchangedFiles: originalUnchangedFiles,
      }

      await beginAtlasReconciliation({
        db,
        repository,
        commit,
        manifest,
        baseIndexedCommit,
        buildId,
        embeddingModel: embeddingConfig.model,
        embeddingDimension: embeddingConfig.dimension,
        preparedFiles: preparedFileCount,
      })
      await sendHeartbeat()
      heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight) return
        heartbeatInFlight = true
        void sendHeartbeat()
          .catch((error) => {
            heartbeatFailure ??= error
          })
          .finally(() => {
            heartbeatInFlight = false
          })
      }, ATLAS_RECONCILIATION_HEARTBEAT_INTERVAL_MS)

      const prepareConcurrency = clampNumber(Number.parseInt(process.env.BUMBA_ATLAS_PREPARE_CONCURRENCY ?? '', 10), 4)
      let nextProgressLog = Math.floor(preparedFileCount / 100) * 100 + 100
      for (const batch of batchValues(changedFiles, prepareConcurrency)) {
        assertHeartbeatHealthy()
        const preparedFiles = await Promise.all(batch.map((file) => prepareAtlasFile(repoRoot, commit, file)))
        assertHeartbeatHealthy()
        preparedFileCount += preparedFiles.length
        const partial = await applyAtlasReconciliation({
          db,
          repository,
          ref,
          commit,
          manifest,
          preparedFiles,
          buildId,
          preparedFileCount,
          totalChangedFiles,
          deletedFiles,
          unchangedFiles: originalUnchangedFiles,
          finalize: false,
        })
        if (partial !== null) throw new Error('Atlas partial reconciliation unexpectedly finalized')
        progress = { ...progress, preparedFiles: preparedFileCount }
        if (preparedFileCount >= nextProgressLog || preparedFileCount === totalChangedFiles) {
          logActivity('info', 'progress', 'reconcileAtlasRepository', {
            repository,
            commit,
            preparedFiles: preparedFileCount,
            changedFiles: totalChangedFiles,
          })
          nextProgressLog = Math.floor(preparedFileCount / 100) * 100 + 100
        }
      }

      await sendHeartbeat()
      assertHeartbeatHealthy()
      const result = await applyAtlasReconciliation({
        db,
        repository,
        ref,
        commit,
        manifest,
        preparedFiles: [],
        buildId,
        preparedFileCount,
        totalChangedFiles,
        deletedFiles,
        unchangedFiles: originalUnchangedFiles,
        finalize: true,
      })
      if (!result) throw new Error('Atlas reconciliation did not produce a final result')
      logActivity('info', 'completed', 'reconcileAtlasRepository', {
        ...result,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      await markAtlasRepositoryFailed(db, repository, buildId, error).catch((stateError) => {
        logActivity('error', 'failed', 'markAtlasRepositoryFailed', {
          repository,
          error: formatActivityError(stateError),
        })
      })
      logActivity('error', 'failed', 'reconcileAtlasRepository', {
        repository,
        ref,
        requestedCommit,
        durationMs: Date.now() - startedAt,
        error: formatActivityError(error),
      })
      throw error
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }
  },

  async upsertIngestion(input: UpsertIngestionInput): Promise<UpsertIngestionOutput> {
    const startedAt = Date.now()
    const deliveryId = input.deliveryId.trim()
    const workflowId = input.workflowId.trim()
    const status = input.status.trim()
    const errorText = typeof input.error === 'string' ? input.error.trim() : ''
    const error = errorText.length > 0 ? errorText : null
    const correctLegacyPendingFailure = input.correctLegacyPendingFailure === true
    const validLegacyCorrection =
      (status === 'completed' && error === null) ||
      (status === 'failed' && error !== null && error !== LEGACY_RECONCILE_PENDING_ERROR)

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
    if (correctLegacyPendingFailure && !validLegacyCorrection) {
      throw new Error('Legacy pending-failure correction requires completion or a real failure')
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
              WHEN ${correctLegacyPendingFailure}
                AND atlas.ingestions.status = 'failed'
                AND atlas.ingestions.error = ${LEGACY_RECONCILE_PENDING_ERROR}
              THEN EXCLUDED.status
              WHEN atlas.ingestions.status IN ('completed', 'failed', 'skipped') THEN atlas.ingestions.status
              ELSE EXCLUDED.status
            END,
            error = CASE
              WHEN ${correctLegacyPendingFailure}
                AND atlas.ingestions.status = 'failed'
                AND atlas.ingestions.error = ${LEGACY_RECONCILE_PENDING_ERROR}
              THEN EXCLUDED.error
              ELSE COALESCE(EXCLUDED.error, atlas.ingestions.error)
            END,
            started_at = COALESCE(EXCLUDED.started_at, atlas.ingestions.started_at),
            finished_at = COALESCE(EXCLUDED.finished_at, atlas.ingestions.finished_at)
        RETURNING id, event_id, status, error;
      `) as Array<{ id: string; event_id: string; status: string; error: string | null }>

      const row = rows[0]
      if (!row) {
        throw new Error('ingestion upsert failed')
      }
      if (correctLegacyPendingFailure && (row.status !== status || row.error !== error)) {
        throw new Error('Ingestion does not match the legacy pending-failure correction guard')
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
}

export const __test__ = {
  ATLAS_CHUNKER_VERSION,
  assertChunkCoverage,
  embedTexts,
  extractFileChunks,
  withParsedTree,
  resetAtlasDb: async () => {
    if (atlasDb) await atlasDb.close()
    atlasDb = undefined
  },
}

export default productionActivities

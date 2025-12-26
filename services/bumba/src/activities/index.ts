import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { SQL } from 'bun'
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

export type PersistInput = {
  filename: string
  summary: string
  content: string
  astSummary: string
  enriched: string
  embedding: number[]
  metadata: Record<string, unknown>
  fileMetadata: FileMetadata
  facts: TreeSitterFact[]
  eventDeliveryId?: string
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

export type BumbaActivities = typeof activities

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024
const DEFAULT_OPENAI_COMPLETION_MODEL = 'gpt-5.2-codex'
const DEFAULT_SELF_HOSTED_COMPLETION_MODEL = 'qwen3-coder:30b-a3b-q4_K_M'
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'
const DEFAULT_GITHUB_API_VERSION = '2022-11-28'

const MAX_AST_BYTES = 200_000
const MAX_FACTS = 300
const MAX_FACT_CHARS = 200
const MAX_SUMMARY_NODES = 80
const MAX_COMPLETION_INPUT_CHARS = 12_000
const DEFAULT_MAX_REPO_FILES = 5_000
const MAX_REPO_FILES = 20_000

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
    throw new Error('OPENAI_EMBEDDING_DIMENSION must be a positive integer')
  }
  return dimension
}

const loadEmbeddingTimeoutMs = () => {
  const timeoutMs = Number.parseInt(process.env.OPENAI_EMBEDDING_TIMEOUT_MS ?? '15000', 10)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('OPENAI_EMBEDDING_TIMEOUT_MS must be a positive integer')
  }
  return timeoutMs
}

const loadEmbeddingMaxInputChars = () => {
  const maxInputChars = Number.parseInt(process.env.OPENAI_EMBEDDING_MAX_INPUT_CHARS ?? '60000', 10)
  if (!Number.isFinite(maxInputChars) || maxInputChars <= 0) {
    throw new Error('OPENAI_EMBEDDING_MAX_INPUT_CHARS must be a positive integer')
  }
  return maxInputChars
}

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
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
    )
  }
  const defaults = resolveEmbeddingDefaults(apiBaseUrl)
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? defaults.model
  const dimension = loadEmbeddingDimension(defaults.dimension)
  const timeoutMs = loadEmbeddingTimeoutMs()
  const maxInputChars = loadEmbeddingMaxInputChars()

  return { apiKey, apiBaseUrl, model, dimension, timeoutMs, maxInputChars }
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const runCommand = async (args: string[], cwd: string): Promise<string | null> => {
  try {
    const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const trimmed = output.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
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
    repoRef,
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
    throw new Error(`GitHub contents API returned non-file for ${filePath}`)
  }
  if (!data.content || data.encoding !== 'base64') {
    throw new Error(`GitHub contents API returned unsupported encoding for ${filePath}`)
  }

  const content = Buffer.from(data.content.replace(/\r?\n/g, ''), 'base64').toString('utf8')

  return {
    content,
    downloadUrl: data.download_url ?? null,
    apiUrl: data.url ?? url.toString(),
    sha: data.sha ?? null,
    size: data.size ?? null,
  }
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

  const language = await Language.load(entry.wasmPath)
  loadedLanguages.set(entry.name, language)
  return { name: entry.name, language }
}

const clampNumber = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback)

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

const parseYamlAst = (
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
  ['.yaml', parseYamlAst],
  ['.yml', parseYamlAst],
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
  const entry = await loadLanguageForExtension(ext)
  if (!entry) {
    const fallbackLanguage = languageNameByExtension.get(ext) ?? 'text'
    return parsePlainTextAst(source, maxFacts, maxFactChars, maxSummaryNodes, fallbackLanguage, 'text')
  }

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

  return {
    astSummary,
    facts,
    metadata: {
      language: entry.name,
      factCount: facts.length,
    },
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
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
    )
  }

  const defaults = resolveCompletionDefaults(apiBaseUrl)
  const model = process.env.OPENAI_COMPLETION_MODEL ?? process.env.OPENAI_MODEL ?? defaults.model
  const timeoutMs = Number.parseInt(process.env.OPENAI_COMPLETION_TIMEOUT_MS ?? '30000', 10)
  const maxInputChars = clampNumber(
    Number.parseInt(process.env.OPENAI_COMPLETION_MAX_INPUT_CHARS ?? '', 10),
    MAX_COMPLETION_INPUT_CHARS,
  )

  return { apiBaseUrl, apiKey, model, timeoutMs, maxInputChars }
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

const parseCompletionOutput = (rawText: string) => {
  const trimmed = rawText.trim()
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = trimmed.slice(firstBrace, lastBrace + 1)
    try {
      const parsed = JSON.parse(jsonCandidate) as { summary?: string; enriched?: string }
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
      const enriched = typeof parsed.enriched === 'string' ? parsed.enriched.trim() : ''
      if (summary || enriched) {
        return {
          summary: summary || enriched,
          enriched: enriched || summary,
          metadata: { parsedJson: true },
        }
      }
    } catch {
      // fall through
    }
  }

  const fallback = trimmed.length > 0 ? trimmed : 'No enrichment response.'
  const summary = fallback.split(/\n\n+/)[0] ?? fallback
  return {
    summary: summary.trim(),
    enriched: fallback,
    metadata: { parsedJson: false },
  }
}

const embedText = async (text: string): Promise<number[]> => {
  const { apiKey, apiBaseUrl, model, dimension, timeoutMs, maxInputChars } = loadEmbeddingConfig()
  if (text.length > maxInputChars) {
    throw new Error(`embedding input too large (${text.length} chars; max ${maxInputChars})`)
  }

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`
    }

    const response = await fetch(`${apiBaseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`embedding request failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as { data?: { embedding?: number[] }[] }
    const embedding = json.data?.[0]?.embedding
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('embedding response missing data[0].embedding')
    }
    if (embedding.length !== dimension) {
      throw new Error(`embedding dimension mismatch: expected ${dimension} but got ${embedding.length}`)
    }

    return embedding
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`embedding request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutHandle)
  }
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

export const activities = {
  async listRepoFiles(input: ListRepoFilesInput): Promise<ListRepoFilesOutput> {
    const repoRoot = resolve(input.repoRoot)
    const ref = normalizeOptionalText(input.ref) ?? 'HEAD'
    const pathPrefix = normalizePathPrefix(input.pathPrefix)
    const maxFiles = loadRepoListLimit(input.maxFiles)

    const args = ['git', 'ls-tree', '-r', '--name-only', ref]
    if (pathPrefix) {
      args.push('--', pathPrefix)
    }

    const output = await runCommand(args, repoRoot)
    if (output === null) {
      throw new Error('Failed to list repository files')
    }

    const entries = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const files: string[] = []
    let skipped = 0

    for (const entry of entries) {
      if (shouldSkipRepoFile(entry)) {
        skipped += 1
        continue
      }
      if (files.length >= maxFiles) {
        skipped += 1
        continue
      }
      files.push(entry)
    }

    return {
      files,
      total: entries.length,
      skipped,
    }
  },

  async readRepoFile(input: ReadRepoFileInput): Promise<ReadRepoFileOutput> {
    const normalizedRef = normalizeOptionalText(input.ref)
    const normalizedCommit = normalizeOptionalText(input.commit)
    const fullPath = resolvePath(input.repoRoot, input.filePath)
    const repoInfo = await resolveRepositoryInfo(input.repoRoot, {
      repository: input.repository,
      ref: normalizedRef,
      commit: normalizedCommit,
    })

    const repoRootStats = await stat(input.repoRoot).catch(() => null)
    const fileStats = repoRootStats?.isDirectory() ? await stat(fullPath).catch(() => null) : null
    let content: string
    let stats = fileStats
    let source: 'local' | 'github' = 'local'
    let sourceMeta: Record<string, unknown> = { repoRoot: input.repoRoot }

    if (fileStats) {
      if (normalizedCommit) {
        const headCommit = await runCommand(['git', '-C', input.repoRoot, 'rev-parse', 'HEAD'], input.repoRoot)
        if (headCommit !== normalizedCommit) {
          source = 'github'
        }
      }
    } else {
      source = 'github'
    }

    if (source === 'local') {
      content = await readFile(fullPath, 'utf8')
    } else {
      const repoSlug = normalizeRepositorySlug(normalizeOptionalText(input.repository) ?? repoInfo.repoName ?? '')
      if (!repoSlug.includes('/')) {
        throw new Error('GitHub repository slug is required to fetch remote content')
      }

      const ref = normalizedCommit ?? repoInfo.repoCommit ?? repoInfo.repoRef
      const fetched = await fetchGithubFile(repoSlug, input.filePath, ref)
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

    return {
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
  },

  async extractAstSummary(input: AstGrepInput): Promise<AstSummaryOutput> {
    const content = input.content ?? (await readFile(resolvePath(input.repoRoot, input.filePath), 'utf8'))
    return await parseAst(content, input.filePath)
  },

  async enrichWithModel(input: EnrichInput): Promise<EnrichOutput> {
    const { apiBaseUrl, apiKey, model, timeoutMs, maxInputChars } = loadCompletionConfig()

    const truncatedContent =
      input.content.length > maxInputChars ? input.content.slice(0, maxInputChars) : input.content
    const wasTruncated = truncatedContent.length !== input.content.length

    const systemPrompt = [
      'You are an Atlas enrichment agent.',
      'Return a valid JSON object ONLY with keys "summary" and "enriched".',
      'Do not include markdown, code fences, or extra keys.',
      '"summary": 2-4 sentences (<= 400 chars) describing what the file does.',
      '"enriched": a single string of 3-6 bullet lines, each starting with "- ". Each bullet <= 120 chars.',
      'Bullets should cover: purpose, key APIs/entry points, data flow, side effects/IO, risks/edge cases.',
      'If information is missing, say "Unknown" instead of guessing.',
      'If input is truncated, include a bullet: "Input truncated; details may be missing."',
    ].join(' ')

    const userSections = [
      `Filename: ${input.filename}`,
      input.context ? `Context: ${input.context}` : null,
      `Input truncated: ${wasTruncated ? 'yes' : 'no'}`,
      `AST summary:\n${input.astSummary}`,
      `Content${wasTruncated ? ' (truncated)' : ''}:\n${truncatedContent}`,
    ].filter((section) => section && section.length > 0)

    const payload = {
      model,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userSections.join('\n\n') },
      ],
    }
    const payloadWithFormat = {
      ...payload,
      response_format: { type: 'json_object' },
    }

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`
      }

      const response = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payloadWithFormat),
        signal: controller.signal,
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
            signal: controller.signal,
          })
          if (!fallbackResponse.ok) {
            const fallbackBody = await fallbackResponse.text()
            throw new Error(`completion request failed (${fallbackResponse.status}): ${fallbackBody}`)
          }
          const output = await parseStreamingCompletion(fallbackResponse)
          const parsed = parseCompletionOutput(output)
          return {
            summary: parsed.summary,
            enriched: parsed.enriched,
            metadata: {
              model,
              wasTruncated,
              parsedJson: parsed.metadata.parsedJson,
              responseFormat: 'none',
            },
          }
        }
        throw new Error(`completion request failed (${response.status}): ${body}`)
      }

      const output = await parseStreamingCompletion(response)
      const parsed = parseCompletionOutput(output)

      return {
        summary: parsed.summary,
        enriched: parsed.enriched,
        metadata: {
          model,
          wasTruncated,
          parsedJson: parsed.metadata.parsedJson,
          responseFormat: 'json_object',
        },
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`completion request timed out after ${timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeoutHandle)
    }
  },

  async createEmbedding(input: EmbeddingInput): Promise<{ embedding: number[] }> {
    const embedding = await embedText(input.text)
    return { embedding }
  },

  async cleanupEnrichment(input: CleanupEnrichmentInput): Promise<CleanupEnrichmentOutput> {
    const db = getAtlasDb()
    if (!db) {
      throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
    }

    const fileMeta = input.fileMetadata
    const repositoryName = fileMeta.repoName
    const repositoryRef = fileMeta.repoRef ?? 'main'
    const repositoryCommit = fileMeta.repoCommit ?? null

    const repositoryRows = (await db`
      SELECT id
      FROM atlas.repositories
      WHERE name = ${repositoryName};
    `) as Array<{ id: string }>

    const repositoryId = repositoryRows[0]?.id
    if (!repositoryId) {
      return { fileVersions: 0, enrichments: 0, embeddings: 0, facts: 0 }
    }

    const fileKeyRows = (await db`
      SELECT id
      FROM atlas.file_keys
      WHERE repository_id = ${repositoryId}
        AND path = ${fileMeta.path};
    `) as Array<{ id: string }>

    const fileKeyId = fileKeyRows[0]?.id
    if (!fileKeyId) {
      return { fileVersions: 0, enrichments: 0, embeddings: 0, facts: 0 }
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
      return { fileVersions: 0, enrichments: 0, embeddings: 0, facts: 0 }
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

    return {
      fileVersions: fileVersionIds.length,
      enrichments: enrichmentsDeleted.length,
      embeddings: embeddingsDeleted,
      facts: factsDeleted.length,
    }
  },

  async persistEnrichment(input: PersistInput): Promise<{ id: string }> {
    const db = getAtlasDb()
    if (!db) {
      throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
    }

    const fileMeta = input.fileMetadata
    const repositoryName = fileMeta.repoName
    const repositoryRef = fileMeta.repoRef ?? 'main'
    const repositoryCommit = fileMeta.repoCommit ?? null
    const contentHash = fileMeta.contentHash ?? ''

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

    const enrichmentMetadata = {
      ...input.metadata,
      astSummary: input.astSummary,
      contentHash,
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
        ${fileVersionId},
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

    const { model, dimension } = loadEmbeddingConfig()
    const vectorString = vectorToPgArray(input.embedding)

    await db`
      INSERT INTO atlas.embeddings (enrichment_id, model, dimension, embedding)
      VALUES (${enrichmentId}, ${model}, ${dimension}, ${vectorString}::vector)
      ON CONFLICT (enrichment_id, model, dimension) DO UPDATE
      SET embedding = EXCLUDED.embedding;
    `

    if (input.facts.length > 0) {
      const uniqueFacts = dedupeFacts(input.facts)
      await db`DELETE FROM atlas.tree_sitter_facts WHERE file_version_id = ${fileVersionId};`
      for (const fact of uniqueFacts) {
        await db`
          INSERT INTO atlas.tree_sitter_facts (
            file_version_id,
            node_type,
            match_text,
            start_line,
            end_line,
            metadata
          )
          VALUES (
            ${fileVersionId},
            ${fact.nodeType},
            ${fact.matchText},
            ${fact.startLine},
            ${fact.endLine},
            ${JSON.stringify(fact.metadata ?? {})}::jsonb
          )
          ON CONFLICT DO NOTHING;
        `
      }
    }

    const deliveryId = input.eventDeliveryId?.trim()
    if (deliveryId) {
      await db`
        UPDATE atlas.github_events
        SET processed_at = now()
        WHERE delivery_id = ${deliveryId};
      `
    }

    return { id: enrichmentId }
  },

  async markEventProcessed(input: MarkEventProcessedInput): Promise<void> {
    const db = getAtlasDb()
    if (!db) {
      throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
    }

    const deliveryId = input.deliveryId.trim()
    if (deliveryId.length === 0) return
    await db`
      UPDATE atlas.github_events
      SET processed_at = now()
      WHERE delivery_id = ${deliveryId};
    `
  },
}

export default activities

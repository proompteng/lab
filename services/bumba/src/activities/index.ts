import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { SQL } from 'bun'
import { Language, Parser } from 'web-tree-sitter'

export type ReadRepoFileInput = {
  repoRoot: string
  filePath: string
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
}

export type BumbaActivities = typeof activities

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024
const DEFAULT_COMPLETION_MODEL = 'gpt-5.2-codex'

const MAX_AST_BYTES = 200_000
const MAX_FACTS = 300
const MAX_FACT_CHARS = 200
const MAX_SUMMARY_NODES = 80
const MAX_COMPLETION_INPUT_CHARS = 12_000

const resolvePath = (repoRoot: string, filePath: string) => {
  const root = resolve(repoRoot)
  const fullPath = resolve(root, filePath)
  const relativePath = relative(root, fullPath)
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    throw new Error(`file path escapes repo root: ${filePath}`)
  }
  return fullPath
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

const resolveRepositoryInfo = async (repoRoot: string) => {
  const envRepo = process.env.BUMBA_REPOSITORY?.trim()
  const envRef = process.env.BUMBA_REPOSITORY_REF?.trim()
  const envCommit = process.env.BUMBA_REPOSITORY_COMMIT?.trim()

  if (envRepo && envRepo.length > 0) {
    return {
      repoName: envRepo,
      repoRef: envRef && envRef.length > 0 ? envRef : null,
      repoCommit: envCommit && envCommit.length > 0 ? envCommit : null,
    }
  }

  const fallbackName = basename(repoRoot)
  const repoName = (await runCommand(['git', '-C', repoRoot, 'remote', 'get-url', 'origin'], repoRoot)) ?? fallbackName
  const repoRef = (await runCommand(['git', '-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)) ?? null
  const repoCommit = (await runCommand(['git', '-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot)) ?? null

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
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.json', 'json'],
  ['.go', 'go'],
  ['.py', 'python'],
  ['.rs', 'rust'],
])

const languageWasmByExtension = new Map<string, { name: string; wasmPath: string }>([
  ['.ts', { name: 'typescript', wasmPath: require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm') }],
  ['.tsx', { name: 'tsx', wasmPath: require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm') }],
  ['.js', { name: 'javascript', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  ['.jsx', { name: 'jsx', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  ['.mjs', { name: 'javascript', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  ['.cjs', { name: 'javascript', wasmPath: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm') }],
  ['.json', { name: 'json', wasmPath: require.resolve('tree-sitter-json/tree-sitter-json.wasm') }],
  ['.go', { name: 'go', wasmPath: require.resolve('tree-sitter-go/tree-sitter-go.wasm') }],
  ['.py', { name: 'python', wasmPath: require.resolve('tree-sitter-python/tree-sitter-python.wasm') }],
  ['.rs', { name: 'rust', wasmPath: require.resolve('tree-sitter-rust/tree-sitter-rust.wasm') }],
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
  const entry = await loadLanguageForExtension(ext)
  if (!entry) {
    return {
      astSummary: `No Tree-sitter parser configured for ${ext || 'unknown'} files.`,
      facts: [],
      metadata: { skipped: true, reason: 'unsupported_extension', extension: ext || null },
    }
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

const loadCompletionConfig = () => {
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY?.trim() || null
  if (!apiKey && isHostedOpenAiBaseUrl(apiBaseUrl)) {
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
    )
  }

  const model = process.env.OPENAI_COMPLETION_MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_COMPLETION_MODEL
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
  async readRepoFile(input: ReadRepoFileInput): Promise<ReadRepoFileOutput> {
    const fullPath = resolvePath(input.repoRoot, input.filePath)
    const [content, stats, repoInfo] = await Promise.all([
      readFile(fullPath, 'utf8'),
      stat(fullPath),
      resolveRepositoryInfo(input.repoRoot),
    ])

    const contentHash = createHash('sha256').update(content).digest('hex')
    const lineCount = content.split(/\r?\n/).length
    const language = languageNameByExtension.get(extname(input.filePath).toLowerCase()) ?? null

    return {
      content,
      metadata: {
        repoName: repoInfo.repoName,
        repoRef: repoInfo.repoRef,
        repoCommit: repoInfo.repoCommit,
        path: input.filePath,
        contentHash,
        language,
        byteSize: stats.size,
        lineCount,
        sourceTimestamp: stats.mtime ? stats.mtime.toISOString() : null,
        metadata: {
          repoRoot: input.repoRoot,
        },
      },
    }
  },

  async extractAstSummary(input: AstGrepInput): Promise<AstSummaryOutput> {
    const fullPath = resolvePath(input.repoRoot, input.filePath)
    const content = await readFile(fullPath, 'utf8')
    return await parseAst(content, input.filePath)
  },

  async enrichWithModel(input: EnrichInput): Promise<EnrichOutput> {
    const { apiBaseUrl, apiKey, model, timeoutMs, maxInputChars } = loadCompletionConfig()

    const truncatedContent =
      input.content.length > maxInputChars ? input.content.slice(0, maxInputChars) : input.content
    const wasTruncated = truncatedContent.length !== input.content.length

    const systemPrompt =
      'You are an Atlas enrichment agent. Summarize the file and provide a concise enrichment. ' +
      'Return JSON only with keys "summary" and "enriched". The enriched field should be short bullet points.'

    const userSections = [
      `Filename: ${input.filename}`,
      input.context ? `Context: ${input.context}` : null,
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
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text()
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

  async persistEnrichment(input: PersistInput): Promise<{ id: string }> {
    const db = getAtlasDb()
    if (!db) {
      throw new Error('DATABASE_URL is required for Atlas enrichment persistence')
    }

    const fileMeta = input.fileMetadata
    const repositoryName = fileMeta.repoName
    const repositoryRef = fileMeta.repoRef
    const repositoryCommit = fileMeta.repoCommit
    const contentHash = fileMeta.contentHash

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
      ON CONFLICT (file_version_id, kind, source) DO UPDATE
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
      await db`DELETE FROM atlas.tree_sitter_facts WHERE file_version_id = ${fileVersionId};`
      for (const fact of input.facts) {
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
          );
        `
      }
    }

    return { id: enrichmentId }
  },
}

export default activities

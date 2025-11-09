import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promptCatalogSchema, promptDefinitionSchema } from './schema'
import type { PromptCatalog, PromptDefinition } from './types'

type DriverOptions = {
  catalogPath: string
  grafUrl: string
  promptId?: string
  streamId?: string
  token?: string
  tokenFile?: string
  dryRun: boolean
}

const DEFAULT_CATALOG = resolve(process.cwd(), 'docs/graf-codex-research/prompts/catalog.json')
const DEFAULT_GRAF_URL = 'http://localhost:8080'

const usage = () => {
  console.log(`Usage: run-prompts [options]

Options:
  --catalog <path>         Path to the prompt catalog JSON (defaults to ${DEFAULT_CATALOG})
  --prompt-id <id>         Submit only the prompt with this ID
  --stream-id <id>         Submit prompts associated with this stream
  --graf-url <url>         Graf base URL (default ${DEFAULT_GRAF_URL})
  --token <token>          Bearer token for Graf
  --token-file <path>      File containing the bearer token
  --dry-run                Only validate prompts and log what would be posted
  -h, --help               Show this help message`)
}

const parseArgs = (argv: string[]): DriverOptions => {
  const options: DriverOptions = {
    catalogPath: DEFAULT_CATALOG,
    grafUrl: DEFAULT_GRAF_URL,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--catalog':
        options.catalogPath = argv[++i]
        break
      case '--prompt-id':
        options.promptId = argv[++i]
        break
      case '--stream-id':
        options.streamId = argv[++i]
        break
      case '--graf-url':
        options.grafUrl = argv[++i]
        break
      case '--token':
        options.token = argv[++i]
        break
      case '--token-file':
        options.tokenFile = argv[++i]
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '-h':
        usage()
        process.exit(0)
        break
      case '--help':
        usage()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

const loadCatalog = async (path: string): Promise<PromptCatalog> => {
  const raw = await readFile(path, 'utf8')
  return promptCatalogSchema.parse(JSON.parse(raw))
}

const loadPrompt = async (baseDir: string, entryFile: string): Promise<PromptDefinition> => {
  const fullPath = resolve(baseDir, entryFile)
  const raw = await readFile(fullPath, 'utf8')
  return promptDefinitionSchema.parse(JSON.parse(raw))
}

const shouldSubmit = (options: DriverOptions, entry: PromptDefinition): boolean => {
  if (options.promptId && entry.promptId !== options.promptId) {
    return false
  }
  if (options.streamId && entry.streamId !== options.streamId) {
    return false
  }
  return true
}

const resolveToken = async (options: DriverOptions): Promise<string | undefined> => {
  if (options.token) {
    return options.token
  }
  if (options.tokenFile) {
    const raw = await readFile(options.tokenFile, 'utf8')
    return raw.trim()
  }
  return process.env.GRAF_API_TOKEN ?? process.env.GRAF_TOKEN
}

const postPrompt = async (
  grafUrl: string,
  definition: PromptDefinition,
  metadata: Record<string, string>,
  token?: string,
) => {
  const url = `${grafUrl.replace(/\/$/, '')}/v1/codex-research`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: definition.promptTemplate,
      metadata,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Graf responded ${response.status}: ${body}`)
  }

  const payload = await response.json()
  const workflowId = payload.workflowId ?? payload.argoWorkflowName ?? 'unknown'
  const runId = payload.runId ?? 'unknown'
  console.log(`prompt=${definition.promptId} workflowId=${workflowId} runId=${runId}`)
}

const run = async () => {
  const options = parseArgs(process.argv.slice(2))
  const catalog = await loadCatalog(options.catalogPath)
  const catalogDir = dirname(options.catalogPath)
  const token = await resolveToken(options)

  const entries: Array<{ prompt: PromptDefinition; stream: PromptCatalog['streams'][number] }> = []
  for (const stream of catalog.streams) {
    const prompt = await loadPrompt(catalogDir, stream.file)
    if (shouldSubmit(options, prompt)) {
      entries.push({ prompt, stream })
    }
  }

  if (entries.length === 0) {
    console.warn('No prompts matched the filter criteria; nothing to submit.')
    return
  }

  for (const { prompt, stream } of entries) {
    const metadata: Record<string, string> = {
      promptId: prompt.promptId,
      streamId: prompt.streamId,
      catalogVersion: catalog.version,
      priority: stream.priority ?? 'normal',
      cadence: stream.cadence ?? 'unknown',
      citationPolicy: prompt.citationPolicy.summary,
    }
    if (stream.metadata) {
      Object.assign(metadata, stream.metadata)
    }

    if (options.dryRun) {
      console.log(`dry-run prompt=${prompt.promptId} metadata=${JSON.stringify(metadata)}`)
      continue
    }

    await postPrompt(options.grafUrl, prompt, metadata, token)
  }
}

run().catch((error) => {
  console.error('run-prompts failed:', error)
  process.exit(1)
})

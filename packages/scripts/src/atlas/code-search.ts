#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fatal } from '../shared/cli'

type CodeSearchItem = {
  repository?: string
  ref?: string
  commit?: string
  path?: string
  startLine?: number | null
  endLine?: number | null
  score?: number
  snippet?: string | null
  signals?: {
    semanticDistance?: number | null
    lexicalRank?: number | null
    matchedIdentifiers?: string[]
  }
}

type CodeSearchResponse = {
  ok?: boolean
  error?: string
  message?: string
  total?: number
  items?: CodeSearchItem[]
}

type Options = {
  query: string
  limit: number
  repository?: string
  ref?: string
  pathPrefix?: string
  language?: string
  baseUrl: string
  json: boolean
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/atlas/code-search.ts --query <text> [options]

Options:
  -q, --query <text>         Search query text
      --query-file <path>    Read query text from file
      --limit <n>            Max results (default: 10)
      --repository <name>    Repository filter (e.g. proompteng/lab)
      --ref <ref>            Ref filter (default: main on server)
      --path-prefix <path>   Path prefix filter
      --language <name>      Language filter (e.g. typescript, go)
      --base-url <url>       Base URL (default: $ATLAS_BASE_URL, $JANGAR_BASE_URL, or ${DEFAULT_BASE_URL})
      --json                 Print raw JSON response
  -h, --help                 Show this help message

Examples:
  bun run packages/scripts/src/atlas/code-search.ts --query "where is chunk indexing enabled in bumba"
  bun run packages/scripts/src/atlas/code-search.ts --query "temporal task queue" --repository proompteng/lab --path-prefix services/bumba
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const readFileValue = (path: string) => {
  try {
    return readFileSync(resolve(path), 'utf8')
  } catch (error) {
    fatal(`Failed to read file: ${path}`, error)
  }
}

const parseLimit = (raw: string) => {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fatal(`Invalid --limit value: ${raw}`)
  }
  return parsed
}

const parseArgs = (argv: string[]): Options => {
  const options: Partial<Options> = {
    limit: 10,
    json: false,
    baseUrl: process.env.ATLAS_BASE_URL ?? process.env.JANGAR_BASE_URL ?? DEFAULT_BASE_URL,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--query' || arg === '-q') {
      options.query = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--query=')) {
      options.query = arg.slice('--query='.length)
      continue
    }

    if (arg === '--query-file') {
      options.query = readFileValue(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--query-file=')) {
      options.query = readFileValue(arg.slice('--query-file='.length))
      continue
    }

    if (arg === '--limit') {
      options.limit = parseLimit(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--limit=')) {
      options.limit = parseLimit(arg.slice('--limit='.length))
      continue
    }

    if (arg === '--repository') {
      options.repository = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }

    if (arg === '--ref') {
      options.ref = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--ref=')) {
      options.ref = arg.slice('--ref='.length)
      continue
    }

    if (arg === '--path-prefix' || arg === '--pathPrefix') {
      options.pathPrefix = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--path-prefix=')) {
      options.pathPrefix = arg.slice('--path-prefix='.length)
      continue
    }

    if (arg.startsWith('--pathPrefix=')) {
      options.pathPrefix = arg.slice('--pathPrefix='.length)
      continue
    }

    if (arg === '--language') {
      options.language = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--language=')) {
      options.language = arg.slice('--language='.length)
      continue
    }

    if (arg === '--base-url') {
      options.baseUrl = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  if (!options.query || options.query.trim().length === 0) {
    fatal('Missing --query or --query-file')
  }

  return options as Options
}

const previewSnippet = (snippet: string | null | undefined) => {
  if (!snippet) return ''
  return snippet.replace(/\s+/g, ' ').trim().slice(0, 220)
}

const renderHuman = (items: CodeSearchItem[]) => {
  if (items.length === 0) {
    console.log('no code search matches found')
    return
  }

  items.forEach((item, index) => {
    const lineStart = item.startLine ?? '?'
    const lineEnd = item.endLine ?? '?'
    const score = typeof item.score === 'number' ? item.score.toFixed(4) : 'n/a'
    const semantic =
      typeof item.signals?.semanticDistance === 'number' ? item.signals.semanticDistance.toFixed(4) : 'n/a'
    const lexical = typeof item.signals?.lexicalRank === 'number' ? item.signals.lexicalRank.toFixed(4) : 'n/a'
    const identifiers = item.signals?.matchedIdentifiers?.join(', ') || ''

    console.log(`\n[${index + 1}] ${item.path ?? '(unknown path)'}:${lineStart}-${lineEnd}`)
    console.log(`  repository/ref: ${item.repository ?? '?'}/${item.ref ?? '?'}`)
    if (item.commit) {
      console.log(`  commit: ${item.commit}`)
    }
    console.log(`  score: ${score} (semanticDistance=${semantic}, lexicalRank=${lexical})`)
    if (identifiers) {
      console.log(`  identifiers: ${identifiers}`)
    }
    const preview = previewSnippet(item.snippet)
    if (preview) {
      console.log(`  snippet: ${preview}`)
    }
  })
  console.log('')
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const endpoint = new URL('/api/code-search', options.baseUrl)
  const body = {
    query: options.query,
    limit: options.limit,
    repository: options.repository,
    ref: options.ref,
    pathPrefix: options.pathPrefix,
    language: options.language,
  }

  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const payloadText = await response.text()
  let payload: CodeSearchResponse = {}
  try {
    payload = payloadText ? (JSON.parse(payloadText) as CodeSearchResponse) : {}
  } catch {
    fatal(`Code search returned non-JSON response (${response.status}): ${payloadText}`)
  }

  if (!response.ok || payload.ok === false) {
    const message = payload.error ?? payload.message ?? payloadText
    fatal(`Code search failed (${response.status}): ${message}`)
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  const items = Array.isArray(payload.items) ? payload.items : []
  renderHuman(items)
}

if (import.meta.main) {
  main().catch((error) => fatal('Code search failed', error))
}

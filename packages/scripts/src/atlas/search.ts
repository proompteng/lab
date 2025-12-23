#!/usr/bin/env bun

import { fatal } from '../shared/cli'

type Options = {
  query: string
  limit: number
  repository?: string
  ref?: string
  pathPrefix?: string
  tags: string[]
  kinds: string[]
  baseUrl: string
  pretty: boolean
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/atlas/search.ts --query <text> [options]

Options:
  -q, --query <text>         Search query (required)
      --limit <n>            Max results (default: 10)
      --repository <name>    Repository filter
      --ref <ref>            Ref filter (branch/tag/sha)
      --path-prefix <path>   Path prefix filter
      --tag <tag>            Tag filter (repeatable or comma-separated)
      --kind <kind>          Kind filter (repeatable or comma-separated)
      --base-url <url>       Base URL for Atlas API (default: $ATLAS_BASE_URL, $JANGAR_BASE_URL, or ${DEFAULT_BASE_URL})
      --compact              Minify JSON output
  -h, --help                 Show this help message

Examples:
  bun run packages/scripts/src/atlas/search.ts --query "semantic search" --limit 5
  bun run packages/scripts/src/atlas/search.ts --query "atlas" --repository proompteng/lab --tag code --tag docs
`.trim()

const parseList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const parseLimit = (value: string) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fatal(`Invalid --limit value: ${value}`)
  }
  return parsed
}

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options: Partial<Options> = {
    limit: 10,
    tags: [],
    kinds: [],
    pretty: true,
    baseUrl: process.env.ATLAS_BASE_URL ?? process.env.JANGAR_BASE_URL ?? DEFAULT_BASE_URL,
  }

  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--compact') {
      options.pretty = false
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

    if (arg === '--tag' || arg === '--tags') {
      options.tags?.push(...parseList(readValue(arg, argv, i)))
      i += 1
      continue
    }

    if (arg.startsWith('--tag=')) {
      options.tags?.push(...parseList(arg.slice('--tag='.length)))
      continue
    }

    if (arg.startsWith('--tags=')) {
      options.tags?.push(...parseList(arg.slice('--tags='.length)))
      continue
    }

    if (arg === '--kind' || arg === '--kinds') {
      options.kinds?.push(...parseList(readValue(arg, argv, i)))
      i += 1
      continue
    }

    if (arg.startsWith('--kind=')) {
      options.kinds?.push(...parseList(arg.slice('--kind='.length)))
      continue
    }

    if (arg.startsWith('--kinds=')) {
      options.kinds?.push(...parseList(arg.slice('--kinds='.length)))
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

  if (!options.query) {
    if (positional.length === 1) {
      options.query = positional[0]
    } else if (positional.length === 0) {
      fatal('Missing --query')
    } else {
      fatal('Too many positional arguments')
    }
  }

  return options as Options
}

const buildSearchUrl = (options: Options) => {
  const url = new URL('/api/search', options.baseUrl)
  url.searchParams.set('query', options.query)
  url.searchParams.set('limit', options.limit.toString())

  if (options.repository) url.searchParams.set('repository', options.repository)
  if (options.ref) url.searchParams.set('ref', options.ref)
  if (options.pathPrefix) url.searchParams.set('pathPrefix', options.pathPrefix)

  for (const tag of options.tags) {
    url.searchParams.append('tags[]', tag)
  }

  for (const kind of options.kinds) {
    url.searchParams.append('kinds[]', kind)
  }

  return url
}

const fetchJson = async (url: URL) => {
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    fatal(`Search failed (${response.status} ${response.statusText})${body ? `\n${body}` : ''}`)
  }

  try {
    return (await response.json()) as unknown
  } catch (error) {
    fatal('Failed to parse JSON response', error)
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const url = buildSearchUrl(options)
  const payload = await fetchJson(url)
  const indent = options.pretty ? 2 : 0
  process.stdout.write(`${JSON.stringify(payload, null, indent)}\n`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Atlas search failed', error))
}

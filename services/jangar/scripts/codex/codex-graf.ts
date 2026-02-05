#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { runCli } from './lib/cli'

const DEFAULT_GRAF_BASE_URL = 'http://graf.graf.svc.cluster.local'

interface Options {
  endpoint?: string
  method: string
  grafUrl?: string
  body?: string
  bodyFile?: string
  token?: string
  tokenFile?: string
  dryRun: boolean
}

interface RunOptions {
  argv?: string[]
  stdin?: NodeJS.ReadableStream
}

const usage = () => {
  console.log(`Usage: codex-graf --endpoint <path> [options]

Posts JSON payloads to Graf's HTTP API from within the Codex runtime.

Options:
  --endpoint <path>   Graf path (relative to /v1 or full URL) to POST, e.g. codex-research or /v1/entities
  --method <name>     HTTP method (default POST)
  --graf-url <url>    Graf base URL (default ${DEFAULT_GRAF_BASE_URL})
  --body <json>       Inline JSON payload
  --body-file <path>  JSON payload file
  --token <value>     Bearer token for Authorization header
  --token-file <path> Bearer token file
  --dry-run           Print the request without sending it
  -h, --help          Show this help message

Environment:
  CODEX_GRAF_BASE_URL      Base URL used when --graf-url is not provided
  CODEX_GRAF_BEARER_TOKEN  Fallback bearer token when --token/--token-file are omitted
`)
}

const parseArgs = (argv: string[]): Options => {
  const result: Options = { method: 'POST', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) {
      continue
    }
    switch (arg) {
      case '--endpoint':
        result.endpoint = argv[++i]
        break
      case '--method':
        result.method = argv[++i] ?? result.method
        break
      case '--graf-url':
        result.grafUrl = argv[++i]
        break
      case '--body':
        result.body = argv[++i]
        break
      case '--body-file':
        result.bodyFile = argv[++i]
        break
      case '--token':
        result.token = argv[++i]
        break
      case '--token-file':
        result.tokenFile = argv[++i]
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '-h':
      case '--help':
        usage()
        throw new Error('help requested')
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        throw new Error(`Unexpected argument: ${arg}`)
    }
  }
  return result
}

const readFromStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  const tty = (stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY
  if (tty) {
    throw new Error('Payload must be provided via --body, --body-file, or stdin')
  }
  let content = ''
  for await (const chunk of stdin) {
    content += chunk
  }
  return content
}

const validateJsonPayload = (value: string) => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error('Payload cannot be empty')
  }
  try {
    JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`Payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return trimmed
}

const loadPayload = async (options: Options, stdin: NodeJS.ReadableStream): Promise<string> => {
  if (options.body && options.bodyFile) {
    throw new Error('Provide only one of --body or --body-file')
  }
  if (options.body) {
    return validateJsonPayload(options.body)
  }
  if (options.bodyFile) {
    const file = await readFile(options.bodyFile, 'utf8')
    return validateJsonPayload(file)
  }
  return validateJsonPayload(await readFromStdin(stdin))
}

const loadToken = async (options: Options) => {
  if (options.token && options.tokenFile) {
    throw new Error('Provide only one of --token or --token-file')
  }
  if (options.token) {
    return options.token.trim()
  }
  if (options.tokenFile) {
    const file = await readFile(options.tokenFile, 'utf8')
    return file.trim()
  }
  const envToken = process.env.CODEX_GRAF_BEARER_TOKEN
  return envToken?.trim()
}

const buildRequestUrl = (baseUrl: string, endpoint: string) => {
  const trimmedEndpoint = endpoint.trim()
  if (trimmedEndpoint.length === 0) {
    throw new Error('Graf endpoint cannot be empty')
  }
  if (/^https?:\/\//i.test(trimmedEndpoint)) {
    return trimmedEndpoint
  }
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '')
  if (normalizedBase.length === 0) {
    throw new Error('Graf base URL cannot be empty')
  }
  const normalizedEndpoint = trimmedEndpoint.replace(/^\/+/, '').replace(/\/+$/, '')
  return normalizedEndpoint.length === 0 ? normalizedBase : `${normalizedBase}/${normalizedEndpoint}`
}

const prettyPrintResponse = (text: string) => {
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

export const runCodexGraf = async (options: RunOptions = {}) => {
  const argv = options.argv ?? process.argv.slice(2)
  const stdin = options.stdin ?? process.stdin
  const parsed = parseArgs(argv)
  const endpoint = parsed.endpoint
  if (!endpoint) {
    throw new Error('--endpoint is required')
  }
  const payload = await loadPayload(parsed, stdin)
  const method = parsed.method.toUpperCase()
  const baseUrl = parsed.grafUrl ?? process.env.CODEX_GRAF_BASE_URL ?? DEFAULT_GRAF_BASE_URL
  const requestUrl = buildRequestUrl(baseUrl, endpoint)
  const token = await loadToken(parsed)
  const headers: Record<string, string> = {}
  headers['Content-Type'] = 'application/json'
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const safeHeaders = { ...headers }
  if (safeHeaders.Authorization) {
    safeHeaders.Authorization = 'Bearer *****'
  }
  console.log(`Graf request: ${method} ${requestUrl}`)
  console.log('Headers:', safeHeaders)
  console.log(`Payload (${payload.length} bytes):`)
  console.log(payload)
  if (parsed.dryRun) {
    console.log('Dry-run mode enabled; skipping network call')
    return
  }
  const response = await fetch(requestUrl, {
    method,
    headers,
    body: payload,
  })
  const bodyText = await response.text()
  if (bodyText.length > 0) {
    console.log(`Response body (${bodyText.length} bytes):`)
    console.log(prettyPrintResponse(bodyText))
  }
  console.log(`Response status: ${response.status} ${response.statusText}`)
  if (!response.ok) {
    throw new Error(`Graf request failed with status ${response.status}`)
  }
}

await runCli(import.meta, async () => {
  await runCodexGraf()
})

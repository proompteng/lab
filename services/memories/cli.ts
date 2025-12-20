import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// Lightweight helpers shared between the save and retrieve scripts.
export type FlagMap = Record<string, string | true>

export function parseCliFlags(argv: string[] = []) {
  const flags: FlagMap = {}
  let i = 0

  while (i < argv.length) {
    const token = argv[i]
    if (!token) {
      throw new Error('unexpected missing argument while parsing flags')
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument ${token}; use --key value`)
    }

    const parts = token.slice(2).split('=')
    const key = parts[0]
    if (!key) {
      throw new Error('unexpected empty flag key')
    }

    if (parts.length > 1) {
      flags[key] = parts.slice(1).join('=')
      i += 1
      continue
    }

    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i += 2
      continue
    }

    flags[key] = true
    i += 1
  }

  return flags
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`missing ${name}; set it before running the embedding helpers`)
  }
  return value
}

export const DEFAULT_OPENAI_API_BASE_URL = 'http://192.168.1.190:11434/v1'
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
export const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
export const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
export const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024

export const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

export const resolveEmbeddingDefaults = (apiBaseUrl: string) => {
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  return {
    hosted,
    model: hosted ? DEFAULT_OPENAI_EMBEDDING_MODEL : DEFAULT_SELF_HOSTED_EMBEDDING_MODEL,
    dimension: hosted ? DEFAULT_OPENAI_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION,
  }
}

export const resolveEmbeddingApiKey = (apiBaseUrl: string) => {
  const { hosted } = resolveEmbeddingDefaults(apiBaseUrl)
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? ''
  if (!apiKey && hosted) {
    throw new Error('missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at a self-hosted endpoint')
  }
  return apiKey || null
}

export const LOCAL_DATABASE_URL = 'postgres://cerebrum:cerebrum@localhost:5432/cerebrum?sslmode=disable'
const DEFAULT_KUBE_SECRET = 'jangar-db-app'
const DEFAULT_KUBE_SERVICE = 'svc/jangar-db-rw'
const DEFAULT_KUBE_PORT = 5432

export function toPgTextArray(values: string[]) {
  if (!values.length) {
    return '{}'
  }
  const escaped = values.map((value) => JSON.stringify(value))
  return `{${escaped.join(',')}}`
}

export function getFlagValue(flags: FlagMap, key: string): string | undefined {
  const raw = flags[key]
  if (typeof raw === 'string' && raw.length > 0) {
    return raw
  }
  if (raw === true) {
    return 'true'
  }
  return undefined
}

export function parseCommaList(input?: string) {
  if (!input) {
    return []
  }
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function parseJson(input?: string) {
  if (!input) {
    return {} as Record<string, unknown>
  }
  try {
    return JSON.parse(input)
  } catch (error) {
    throw new Error(`unable to parse JSON for metadata: ${String(error)}`)
  }
}

export function vectorToPgArray(values: number[]) {
  return `[${values.join(',')}]`
}

export async function readFile(path: string) {
  return await Bun.file(path).text()
}

type PortForwardHandle = {
  localPort: number
  stop: () => Promise<void>
}

export type DatabaseSession = {
  databaseUrl: string
  stop: () => Promise<void>
}

const namespaceArgs = () => {
  const namespace = process.env.MEMORIES_KUBE_NAMESPACE ?? 'jangar'
  return ['-n', namespace]
}

const capture = async (args: string[]): Promise<string> => {
  const subprocess = Bun.spawn(['kubectl', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = subprocess.stdout ? await new Response(subprocess.stdout).text() : ''
  const stderr = subprocess.stderr ? await new Response(subprocess.stderr).text() : ''
  const exitCode = await subprocess.exited

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `kubectl ${args.join(' ')} failed with exit code ${exitCode}`)
  }

  return stdout
}

const decodeDatabaseSecret = async () => {
  const secretName = process.env.MEMORIES_KUBE_SECRET ?? DEFAULT_KUBE_SECRET
  const output = await capture(['get', 'secret', secretName, ...namespaceArgs(), '-o', 'jsonpath={.data.uri}'])
  const encoded = output.trim()
  if (!encoded) {
    throw new Error(`Secret ${secretName} does not contain a uri key`)
  }
  return Buffer.from(encoded, 'base64').toString('utf8')
}

const startPortForward = async (): Promise<PortForwardHandle> => {
  const service = process.env.MEMORIES_KUBE_SERVICE ?? DEFAULT_KUBE_SERVICE
  const portRaw = process.env.MEMORIES_KUBE_PORT ?? String(DEFAULT_KUBE_PORT)
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid MEMORIES_KUBE_PORT: ${portRaw}`)
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      ['port-forward', ...namespaceArgs(), service, `0:${port}`, '--address', '127.0.0.1'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill('SIGINT')
        reject(new Error('Timed out establishing kubectl port-forward'))
      }
    }, 15_000)

    const buffer: string[] = []
    const handleForwardingLine = (text: string) => {
      const match = text.match(/Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)/)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        const localPort = Number(match[1])
        console.log(`kubectl port-forward established on 127.0.0.1:${localPort}`)
        const killOnExit = () => {
          if (child.exitCode === null) {
            child.kill('SIGINT')
          }
        }
        const teardownHooks = () => {
          process.off('exit', killOnExit)
          process.off('SIGINT', killOnExit)
          process.off('SIGTERM', killOnExit)
        }
        process.on('exit', killOnExit)
        process.on('SIGINT', killOnExit)
        process.on('SIGTERM', killOnExit)
        const stop = async () => {
          teardownHooks()
          if (child.exitCode !== null || child.signalCode) {
            return
          }
          child.kill('SIGINT')
          await once(child, 'exit')
        }
        resolve({ localPort, stop })
      }
    }

    const logStream = (data: Buffer) => {
      const text = data.toString()
      buffer.push(text)
      handleForwardingLine(text)
      if (/error/i.test(text) && !resolved) {
        clearTimeout(timeout)
        resolved = true
        if (child.exitCode === null) {
          child.kill('SIGINT')
        }
        reject(new Error(text.trim()))
      }
    }

    child.stdout?.on('data', (data) => logStream(data))
    child.stderr?.on('data', (data) => logStream(data))

    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (!resolved) {
        resolved = true
        reject(new Error(`kubectl port-forward exited with code ${code ?? 0}`))
      }
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      if (!resolved) {
        resolved = true
        reject(error)
      }
    })
  })
}

const rewriteDatabaseUrl = (databaseUrl: string, localPort: number): string => {
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch (error) {
    throw new Error(`Invalid database URL; unable to parse for port-forwarding: ${String(error)}`)
  }
  parsed.hostname = '127.0.0.1'
  parsed.port = String(localPort)
  return parsed.toString()
}

export const resolveDatabaseSession = async (): Promise<DatabaseSession> => {
  if (process.env.DATABASE_URL) {
    return { databaseUrl: process.env.DATABASE_URL, stop: async () => {} }
  }

  const databaseUrl = await decodeDatabaseSecret()
  const forward = await startPortForward()
  const localUrl = rewriteDatabaseUrl(databaseUrl, forward.localPort)
  return { databaseUrl: localUrl, stop: forward.stop }
}

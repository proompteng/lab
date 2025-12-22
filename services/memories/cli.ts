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

export const DEFAULT_JANGAR_BASE_URL = 'http://jangar'

export const resolveJangarBaseUrl = () => {
  const raw =
    process.env.MEMORIES_JANGAR_URL ??
    process.env.JANGAR_BASE_URL ??
    process.env.MEMORIES_BASE_URL ??
    DEFAULT_JANGAR_BASE_URL
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
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

export async function readFile(path: string) {
  return await Bun.file(path).text()
}

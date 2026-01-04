export type CodexIterationsMode = 'fixed' | 'until' | 'budget' | 'adaptive'

export interface CodexIterationsPolicy {
  mode: CodexIterationsMode
  count?: number
  min?: number
  max?: number
  stopOn?: string[]
  reason?: string
}

export interface CodexIssueMetadata {
  version: number | null
  iterations: CodexIterationsPolicy
  autonomous: boolean
}

const DEFAULT_ITERATIONS: CodexIterationsPolicy = {
  mode: 'fixed',
  count: 1,
}

const MAX_ITERATION_COUNT = 25

const normalizeMode = (value: unknown): CodexIterationsMode => {
  if (typeof value !== 'string') return 'fixed'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'until' || normalized === 'budget' || normalized === 'adaptive') {
    return normalized
  }
  return 'fixed'
}

const clampCount = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_ITERATION_COUNT, Math.floor(value)))
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(MAX_ITERATION_COUNT, parsed))
    }
  }
  return Math.max(1, Math.min(MAX_ITERATION_COUNT, fallback))
}

const toOptionalCount = (value: unknown) => {
  if (value === undefined || value === null) return undefined
  return clampCount(value, 1)
}

const normalizeStopOn = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

const extractCodexBlock = (body: string): string | null => {
  const match = body.match(/```codex\s*([\s\S]*?)```/i)
  if (!match) return null
  const block = match[1] ?? ''
  return block.trim() ? block : null
}

const parseScalar = (value: string): unknown => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const parsed = Number.parseFloat(trimmed)
  if (!Number.isNaN(parsed) && /^[+-]?\d+(\.\d+)?$/.test(trimmed)) return parsed
  return trimmed.replace(/^["']|["']$/g, '')
}

const parseYamlBlock = (block: string): Record<string, unknown> => {
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [{ indent: -1, value: root }]

  const lines = block.replace(/\r/g, '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? ''
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue

    const indent = rawLine.match(/^\s*/)?.[0]?.length ?? 0
    const line = rawLine.trim()

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop()
    }

    const current = stack[stack.length - 1]?.value
    if (line.startsWith('- ')) {
      if (Array.isArray(current)) {
        current.push(parseScalar(line.slice(2)))
      }
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1 || !current || Array.isArray(current)) continue

    const key = line.slice(0, separatorIndex).trim()
    const rest = line.slice(separatorIndex + 1).trim()

    if (!rest) {
      const nextLine = lines[index + 1]?.trim() ?? ''
      const nextIndent = lines[index + 1]?.match(/^\s*/)?.[0]?.length ?? 0
      if (nextLine.startsWith('- ')) {
        const arr: unknown[] = []
        current[key] = arr
        stack.push({ indent: indent, value: arr })
      } else if (nextIndent > indent) {
        const obj: Record<string, unknown> = {}
        current[key] = obj
        stack.push({ indent: indent, value: obj })
      } else {
        current[key] = ''
      }
      continue
    }

    current[key] = parseScalar(rest)
  }

  return root
}

const parseIterationsPolicy = (value: unknown): CodexIterationsPolicy => {
  if (typeof value === 'number' || typeof value === 'string') {
    return {
      mode: 'fixed',
      count: clampCount(value, 1),
    }
  }

  if (!value || typeof value !== 'object') return { ...DEFAULT_ITERATIONS }

  const record = value as Record<string, unknown>
  const mode = normalizeMode(record.mode)
  if (mode === 'fixed') {
    return {
      mode,
      count: clampCount(record.count ?? record.iterations ?? 1, 1),
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    }
  }

  return {
    mode,
    min: toOptionalCount(record.min),
    max: toOptionalCount(record.max),
    stopOn: normalizeStopOn(record.stop_on ?? record.stopOn),
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    count: toOptionalCount(record.count),
  }
}

export const parseCodexIssueMetadata = (body: string): CodexIssueMetadata => {
  const block = extractCodexBlock(body)
  if (!block) {
    return { version: null, iterations: { ...DEFAULT_ITERATIONS }, autonomous: false }
  }

  let parsed: Record<string, unknown> = {}
  if (block.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(block) as Record<string, unknown>
    } catch {
      parsed = parseYamlBlock(block)
    }
  } else {
    parsed = parseYamlBlock(block)
  }

  const versionRaw = parsed.version
  const version = typeof versionRaw === 'number' ? versionRaw : Number.parseInt(String(versionRaw ?? ''), 10)
  if (!Number.isFinite(version) || version <= 0) {
    return { version: null, iterations: { ...DEFAULT_ITERATIONS }, autonomous: false }
  }

  if (version !== 1) {
    return { version, iterations: { ...DEFAULT_ITERATIONS }, autonomous: false }
  }

  const iterations = parseIterationsPolicy(parsed.iterations ?? parsed.iteration)
  const autonomousFlag =
    parsed.autonomous === true ||
    parsed.autonomous === 'true' ||
    parsed.pipeline === 'autonomous' ||
    parsed.pipeline === 'auto'

  return {
    version,
    iterations,
    autonomous: Boolean(autonomousFlag),
  }
}

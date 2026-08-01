import { createHash } from 'node:crypto'

export const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const forbiddenCandidateArtifactIdentifiers = new Set([
  'Atomics',
  'Bun',
  'Date',
  'EventSource',
  'FinalizationRegistry',
  'Function',
  'Intl',
  'Loader',
  'Promise',
  'ShadowRealm',
  'SharedArrayBuffer',
  'SharedWorker',
  'Temporal',
  'WebAssembly',
  'WebSocket',
  'WeakRef',
  'Worker',
  'XMLHttpRequest',
  'async',
  'await',
  'console',
  'crypto',
  'eval',
  'fetch',
  'import',
  'localeCompare',
  'module',
  'navigator',
  'performance',
  'process',
  'queueMicrotask',
  'require',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
])

export const candidateArtifactIdentifierIssues = (source: string): readonly string[] => {
  const issues: string[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === "'" || character === '"') {
      const quote = character
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index] === quote) {
          index += 1
          break
        } else index += 1
      }
      continue
    }
    if (character === '`') {
      issues.push('template-literal')
      break
    }
    if (character === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (character !== undefined && /[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end] ?? '')) end += 1
      const identifier = source.slice(index, end)
      if (forbiddenCandidateArtifactIdentifiers.has(identifier)) issues.push(identifier)
      index = end
      continue
    }
    index += 1
  }
  return [...new Set(issues)].sort()
}

export const candidateArtifactDowncompiledHelpers = [
  '__assign',
  '__awaiter',
  '__extends',
  '__generator',
  '__read',
  '__spreadArray',
  '__values',
] as const

export const candidateMarketPayloadField = (name: string): string | undefined => {
  const normalized = name.replaceAll(/[-_\s]/gu, '').toLowerCase()
  if (normalized === 'sessiondate' || normalized === 'sessiondates' || normalized === 'date' || normalized === 'dates')
    return 'sessionDate'
  if (normalized === 'open' || normalized === 'opens') return 'open'
  if (normalized === 'high' || normalized === 'highs') return 'high'
  if (normalized === 'low' || normalized === 'lows') return 'low'
  if (normalized === 'close' || normalized === 'closes') return 'close'
  if (normalized === 'volume' || normalized === 'volumes') return 'volume'
  return undefined
}

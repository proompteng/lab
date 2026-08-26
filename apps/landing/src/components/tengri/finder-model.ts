import type { TengriFileEntry } from '@/lib/tengri/types'

export const FINDER_HOME_PATH = '/'
export const FINDER_WORKSPACE_PATH = '/workspace'

const finderDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function hasInvalidPathCharacter(value: string): boolean {
  return value.includes('\0') || value.includes('\r') || value.includes('\n')
}

export function normalizeFinderPath(value: string): string | null {
  const candidate = value.trim()
  if (!candidate.startsWith('/') || hasInvalidPathCharacter(candidate)) return null

  const segments: string[] = []
  for (const segment of candidate.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  return segments.length ? `/${segments.join('/')}` : FINDER_HOME_PATH
}

export function formatFinderBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}

export function formatFinderDate(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : finderDateFormatter.format(date)
}

export function finderFileKind(entry: Pick<TengriFileEntry, 'directory' | 'name'>): 'code' | 'file' | 'folder' {
  if (entry.directory) return 'folder'
  return /\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|jsx|json|kt|md|py|rb|rs|sh|toml|ts|tsx|ya?ml)$/i.test(entry.name)
    ? 'code'
    : 'file'
}

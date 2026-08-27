import type { TengriFileEntry } from '@/lib/tengri/types'

export const FINDER_HOME_PATH = '/'
export const FINDER_WORKSPACE_PATH = '/workspace'

const protectedFinderPaths = new Set([FINDER_HOME_PATH, FINDER_WORKSPACE_PATH])

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

export function finderChildPath(parentPath: string, name: string): string | null {
  const parent = normalizeFinderPath(parentPath)
  const child = name.trim()
  if (!parent || !child || child === '.' || child === '..' || child.includes('/') || hasInvalidPathCharacter(child))
    return null

  return parent === FINDER_HOME_PATH ? `/${child}` : `${parent}/${child}`
}

export function finderRenamePath(sourcePath: string, name: string): string | null {
  const source = normalizeFinderPath(sourcePath)
  if (!source || source === FINDER_HOME_PATH) return null
  const separator = source.lastIndexOf('/')
  const parent = separator > 0 ? source.slice(0, separator) : FINDER_HOME_PATH
  return finderChildPath(parent, name)
}

export function updateFinderSelection(
  current: ReadonlySet<string>,
  orderedEntries: readonly Pick<TengriFileEntry, 'path'>[],
  targetPath: string,
  options: { additive: boolean; anchorPath?: string; range: boolean },
): Set<string> {
  if (options.range && options.anchorPath) {
    const anchorPath = options.anchorPath
    const anchorIndex = orderedEntries.findIndex((entry) => entry.path === anchorPath)
    const targetIndex = orderedEntries.findIndex((entry) => entry.path === targetPath)
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
      const range = orderedEntries.slice(start, end + 1).map((entry) => entry.path)
      return new Set(options.additive ? [...current, ...range] : range)
    }
  }

  if (options.additive) {
    const next = new Set(current)
    if (next.has(targetPath)) next.delete(targetPath)
    else next.add(targetPath)
    return next
  }

  return new Set([targetPath])
}

export function finderDeletionTargets(entries: readonly TengriFileEntry[]): TengriFileEntry[] {
  const directories = entries
    .filter((entry) => entry.directory && !protectedFinderPaths.has(entry.path))
    .map((entry) => entry.path)
  return entries.filter(
    (entry) =>
      !protectedFinderPaths.has(entry.path) &&
      !directories.some((directory) => entry.path !== directory && entry.path.startsWith(`${directory}/`)),
  )
}

export function finderCanMutate(path: string): boolean {
  const normalized = normalizeFinderPath(path)
  return normalized !== null && !protectedFinderPaths.has(normalized)
}

export function finderCanPreviewContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/javascript' ||
    normalized === 'application/toml' ||
    normalized === 'application/xml' ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml')
  )
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

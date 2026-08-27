import type { TengriFileEntry } from '@/lib/tengri/types'

export const FINDER_WORKSPACE_PATH = '/'
export const FINDER_SEARCH_REFRESH_MS = 2_000

const finderDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function hasInvalidPathCharacter(value: string): boolean {
  return value.includes('\0') || value.includes('\r') || value.includes('\n')
}

export function normalizeFinderPath(value: string): string | null {
  const candidate = value
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

  return segments.length ? `/${segments.join('/')}` : FINDER_WORKSPACE_PATH
}

export function finderSearchRefreshInterval(active: boolean, query: string): number | null {
  return active && query.trim() ? FINDER_SEARCH_REFRESH_MS : null
}

export function retainVisibleFinderEntry<T extends Pick<TengriFileEntry, 'path'>>(
  current: T | null,
  entries: readonly Pick<TengriFileEntry, 'path'>[],
): T | null {
  return current && entries.some((entry) => entry.path === current.path) ? current : null
}

export function finderCanBeginRename<T extends Pick<TengriFileEntry, 'path'>>(
  entry: T | null,
  actionBusy: boolean,
): entry is T {
  return Boolean(entry && entry.path !== FINDER_WORKSPACE_PATH && !actionBusy)
}

export function finderChildPath(parentPath: string, name: string): string | null {
  const parent = normalizeFinderPath(parentPath)
  const child = name
  if (
    !parent ||
    !child.trim() ||
    child === '.' ||
    child === '..' ||
    child.includes('/') ||
    hasInvalidPathCharacter(child)
  )
    return null

  return parent === FINDER_WORKSPACE_PATH ? `/${child}` : `${parent}/${child}`
}

export function finderRenamePath(sourcePath: string, name: string): string | null {
  const source = normalizeFinderPath(sourcePath)
  if (!source || source === FINDER_WORKSPACE_PATH) return null
  const separator = source.lastIndexOf('/')
  const parent = separator > 0 ? source.slice(0, separator) : FINDER_WORKSPACE_PATH
  return finderChildPath(parent, name)
}

export function updateFinderSelection(
  current: ReadonlySet<string>,
  orderedEntries: readonly Pick<TengriFileEntry, 'path'>[],
  targetPath: string,
  anchorPath: string | null,
  options: { additive: boolean; range: boolean },
): { anchorPath: string; selected: Set<string> } {
  if (options.range && current.size) {
    const effectiveAnchor = orderedEntries.some((entry) => entry.path === anchorPath) ? anchorPath : targetPath
    const anchorIndex = orderedEntries.findIndex((entry) => entry.path === effectiveAnchor)
    const targetIndex = orderedEntries.findIndex((entry) => entry.path === targetPath)
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
      const range = orderedEntries.slice(start, end + 1).map((entry) => entry.path)
      return {
        anchorPath: effectiveAnchor || targetPath,
        selected: new Set(options.additive ? [...current, ...range] : range),
      }
    }
  }

  if (options.additive) {
    const next = new Set(current)
    if (next.has(targetPath)) next.delete(targetPath)
    else next.add(targetPath)
    return { anchorPath: targetPath, selected: next }
  }

  return { anchorPath: targetPath, selected: new Set([targetPath]) }
}

export function finderDeletionTargets(
  entries: readonly Pick<TengriFileEntry, 'directory' | 'path'>[],
): Pick<TengriFileEntry, 'directory' | 'path'>[] {
  const candidates = entries.filter((entry) => entry.path !== FINDER_WORKSPACE_PATH)
  const selectedDirectories = candidates.filter((entry) => entry.directory).map((entry) => entry.path)
  return candidates.filter(
    (entry) =>
      !selectedDirectories.some(
        (directory) =>
          entry.path !== directory && entry.path.startsWith(directory.endsWith('/') ? directory : `${directory}/`),
      ),
  )
}

export function finderDeletionDescription(entries: readonly Pick<TengriFileEntry, 'path'>[]): string {
  if (entries.length === 1) return `“${entries[0]?.path}” will be permanently removed from this agent’s workspace.`
  const visiblePaths = entries.slice(0, 3).map((entry) => entry.path)
  const remainder = entries.length - visiblePaths.length
  const suffix = remainder > 0 ? ` and ${remainder} more` : ''
  return `${entries.length} items will be permanently removed: ${visiblePaths.join(', ')}${suffix}.`
}

export function finderCanPreviewText(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  return (
    mediaType.startsWith('text/') ||
    ['application/javascript', 'application/json', 'application/toml', 'application/xml', 'application/yaml'].includes(
      mediaType,
    )
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

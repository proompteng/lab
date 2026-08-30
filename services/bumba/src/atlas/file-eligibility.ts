export const ATLAS_ELIGIBILITY_VERSION = 'atlas-eligibility-v1'
export const DEFAULT_ATLAS_MAX_FILE_BYTES = 2_000_000

const LOCK_FILENAMES = new Set([
  'bun.lock',
  'composer.lock',
  'cargo.lock',
  'deno.lock',
  'gemfile.lock',
  'go.sum',
  'go.work.sum',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'yarn.lock',
  'npm-shrinkwrap.json',
])

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.avif',
  '.bin',
  '.bmp',
  '.bz2',
  '.class',
  '.db',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.icns',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.ttf',
  '.wav',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
])

const extensionOf = (path: string) => {
  const base = path.toLowerCase().split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot) : ''
}

export const resolveAtlasMaxFileBytes = (env: Record<string, string | undefined> = process.env) => {
  const raw = env.ATLAS_MAX_FILE_BYTES?.trim()
  if (!raw) return DEFAULT_ATLAS_MAX_FILE_BYTES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('ATLAS_MAX_FILE_BYTES must be a positive integer')
  }
  return parsed
}

export const shouldSkipAtlasPath = (path: string) => {
  const normalized = path.trim()
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return true

  const base = normalized.toLowerCase().split('/').pop() ?? ''
  const extension = extensionOf(normalized)
  return LOCK_FILENAMES.has(base) || extension === '.lock' || BINARY_EXTENSIONS.has(extension)
}

export const isAtlasGitFileEligible = (
  entry: { path: string; mode: string; byteSize: number },
  env: Record<string, string | undefined> = process.env,
) => {
  if (entry.mode !== '100644' && entry.mode !== '100755') return false
  if (!Number.isFinite(entry.byteSize) || entry.byteSize < 0 || entry.byteSize > resolveAtlasMaxFileBytes(env)) {
    return false
  }
  return !shouldSkipAtlasPath(entry.path)
}

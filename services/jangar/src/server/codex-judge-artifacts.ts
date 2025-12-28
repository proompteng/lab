import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const safeParseJson = (value: string) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const normalizeRepo = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizeNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const normalizeSha = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return /^[a-f0-9]{7,40}$/i.test(trimmed) ? trimmed : null
}

const extractCommitSha = (manifest: Record<string, unknown>) => {
  const candidates = [
    manifest.commitSha,
    manifest.commit_sha,
    manifest.headSha,
    manifest.head_sha,
    manifest.sha,
    manifest.commit,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeSha(candidate)
    if (normalized) return normalized
  }
  return null
}

export type ImplementationManifestContext = {
  repository: string | null
  issueNumber: number | null
  prompt: string | null
  sessionId: string | null
  commitSha: string | null
}

export const parseImplementationManifest = (raw: string): ImplementationManifestContext | null => {
  const parsed = safeParseJson(raw)
  if (!isRecord(parsed)) return null

  const repository = normalizeRepo(parsed.repository)
  const issueNumber = normalizeNumber(parsed.issueNumber)
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : null
  const sessionId =
    typeof parsed.sessionId === 'string'
      ? parsed.sessionId
      : typeof parsed.session_id === 'string'
        ? parsed.session_id
        : null
  const commitSha = extractCommitSha(parsed)

  return {
    repository: repository || null,
    issueNumber: issueNumber || null,
    prompt,
    sessionId,
    commitSha,
  }
}

const extractTarEntry = async (archivePath: string, entryPath: string) => {
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn('tar', ['-xOzf', archivePath, entryPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      if (stderr.trim().length > 0) {
        resolve(null)
        return
      }
      resolve(null)
    })
  })
}

const listTarEntries = async (archivePath: string) => {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn('tar', ['-tzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve([])
        return
      }
      const entries = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      resolve(entries)
    })
  })
}

const normalizeTarEntry = (entry: string) => entry.replace(/^\.\/+/, '')

const selectTarEntry = (entries: string[], hints: string[]) => {
  if (entries.length === 0) return null
  const normalizedEntries = entries.map((entry) => ({
    original: entry,
    normalized: normalizeTarEntry(entry),
  }))

  for (const hint of hints) {
    const normalizedHint = normalizeTarEntry(hint)
    const directMatch = normalizedEntries.find((entry) => entry.normalized === normalizedHint)
    if (directMatch) return directMatch.original
    const suffixMatch = normalizedEntries.find((entry) => entry.normalized.endsWith(`/${normalizedHint}`))
    if (suffixMatch) return suffixMatch.original
  }

  const firstFile = normalizedEntries.find((entry) => !entry.normalized.endsWith('/'))
  return (firstFile ?? normalizedEntries[0]).original
}

export const extractImplementationManifestFromArchive = async (archive: Buffer) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-judge-archive-'))
  const archivePath = join(tempDir, 'implementation-changes.tgz')
  try {
    await writeFile(archivePath, archive)
    const entryPaths = ['metadata/manifest.json', './metadata/manifest.json']
    for (const entryPath of entryPaths) {
      const manifestRaw = await extractTarEntry(archivePath, entryPath)
      if (!manifestRaw) continue
      return parseImplementationManifest(manifestRaw)
    }
    return null
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export const extractTextFromArchive = async (archive: Buffer, entryHints: string[] = []) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'codex-judge-archive-'))
  const archivePath = join(tempDir, 'artifact.tgz')
  try {
    await writeFile(archivePath, archive)

    for (const hint of entryHints) {
      const direct = await extractTarEntry(archivePath, hint)
      if (direct) return direct
      const normalized = normalizeTarEntry(hint)
      if (normalized !== hint) {
        const normalizedResult = await extractTarEntry(archivePath, normalized)
        if (normalizedResult) return normalizedResult
      }
      const dotted = `./${normalized}`
      const dottedResult = await extractTarEntry(archivePath, dotted)
      if (dottedResult) return dottedResult
    }

    const entries = await listTarEntries(archivePath)
    const selected = selectTarEntry(entries, entryHints)
    if (!selected) return null
    return extractTarEntry(archivePath, selected)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

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

import { lstat, readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const maxFiles = 5_000
const maxFileBytes = 5 * 1024 * 1024
const maxTotalBytes = 100 * 1024 * 1024

const allowedWorkspaceFiles = new Set([
  'AGENTS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'MEMORY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
])
const allowedWorkspaceDirectories = new Set(['memory', 'skills'])
const forbiddenPathComponents = new Set([
  '.aws',
  '.env',
  '.git',
  '.gnupg',
  '.openclaw',
  '.ssh',
  'auth.json',
  'credentials',
  'credentials.json',
  'logs',
  'openclaw.json',
  'secrets',
  'sessions',
])

const credentialPatterns = [
  {
    reason: 'private key material',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    reason: 'bearer credential',
    pattern: /\bbearer\s+[a-z0-9._~+/=-]{20,}/i,
  },
  {
    reason: 'provider credential',
    pattern:
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:hf|npm)_[A-Za-z0-9]{20,}|ops_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{30,}|(?:r|s)k_live_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  },
  {
    reason: 'credential-bearing connection URL',
    pattern: /\b(?:amqps?|mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis):\/\/[^\s/:@]+:[^\s/@]{8,}@/i,
  },
  {
    reason: 'basic authorization credential',
    pattern: /\bauthorization\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/=]{12,}/i,
  },
  {
    reason: 'JWT credential',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    reason: 'Discord-style credential',
    pattern: /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/,
  },
  {
    reason: 'credential assignment',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret|token)\s*[:=]\s*["']?(?!<|\$\{|example\b|placeholder\b|redacted\b|changeme\b|replace[-_]?me\b)[^\s"'`]{12,}/i,
  },
] as const

export type MigrationAuditIssue = {
  path: string
  reason: string
}

export type MigrationAuditResult = {
  files: number
  totalBytes: number
  issues: MigrationAuditIssue[]
}

const portablePath = (root: string, path: string): string => relative(root, path).split(sep).join('/') || '.'

const validateLayout = (path: string): string | undefined => {
  const components = path.split('/')
  if (components[0] !== 'workspace') return 'unexpected top-level path'
  if (components.length === 1) return undefined

  const workspaceEntry = components[1]
  if (allowedWorkspaceFiles.has(workspaceEntry)) {
    return components.length === 2 ? undefined : 'file-only workspace entry contains descendants'
  }
  if (allowedWorkspaceDirectories.has(workspaceEntry)) return undefined
  return 'path is outside the approved user-data allowlist'
}

const validatePathComponents = (path: string): string | undefined => {
  for (const component of path.split('/')) {
    const normalized = component.toLowerCase()
    if (forbiddenPathComponents.has(normalized)) return 'credential, session, or log path is forbidden'
    if (/\.(?:key|p12|pfx|pem)$/i.test(component)) return 'credential file extension is forbidden'
  }
  return undefined
}

export async function auditMigrationSource(sourceRoot: string): Promise<MigrationAuditResult> {
  const root = resolve(sourceRoot)
  const result: MigrationAuditResult = { files: 0, totalBytes: 0, issues: [] }
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { ...result, issues: [{ path: '.', reason: 'source root must be a real directory' }] }
  }

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const displayPath = portablePath(root, path)
      const stat = await lstat(path)

      const layoutIssue = validateLayout(displayPath)
      if (layoutIssue) result.issues.push({ path: displayPath, reason: layoutIssue })
      const componentIssue = validatePathComponents(displayPath)
      if (componentIssue) result.issues.push({ path: displayPath, reason: componentIssue })

      if (stat.isSymbolicLink()) {
        result.issues.push({ path: displayPath, reason: 'symbolic links are forbidden' })
        continue
      }
      if (stat.isDirectory()) {
        await visit(path)
        continue
      }
      if (!stat.isFile()) {
        result.issues.push({ path: displayPath, reason: 'only regular files and directories are allowed' })
        continue
      }

      result.files += 1
      result.totalBytes += stat.size
      if (result.files > maxFiles) {
        result.issues.push({ path: displayPath, reason: `file count exceeds ${maxFiles}` })
        continue
      }
      if (stat.size > maxFileBytes) {
        result.issues.push({ path: displayPath, reason: `file exceeds ${maxFileBytes} bytes` })
        continue
      }
      if (result.totalBytes > maxTotalBytes) {
        result.issues.push({ path: displayPath, reason: `total content exceeds ${maxTotalBytes} bytes` })
        continue
      }

      const content = await readFile(path)
      if (content.includes(0)) {
        result.issues.push({ path: displayPath, reason: 'binary content is forbidden' })
        continue
      }

      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content)
      } catch {
        result.issues.push({ path: displayPath, reason: 'content is not valid UTF-8 text' })
        continue
      }

      for (const { pattern, reason } of credentialPatterns) {
        if (pattern.test(text)) result.issues.push({ path: displayPath, reason })
      }
    }
  }

  await visit(root)
  if (result.files === 0) result.issues.push({ path: '.', reason: 'source contains no approved files' })
  return result
}

async function main(): Promise<void> {
  const sourceRoot = process.argv[2]
  if (!sourceRoot) throw new Error('usage: audit-migration-source.ts <sanitized-openclaw-root>')

  const result = await auditMigrationSource(sourceRoot)
  if (result.issues.length > 0) {
    console.error(`migration source audit failed: ${result.issues.length} issue(s)`)
    for (const issue of result.issues) console.error(`${issue.path}: ${issue.reason}`)
    process.exit(1)
  }
  console.log(`migration source audit passed: ${result.files} UTF-8 files, ${result.totalBytes} bytes`)
}

if (import.meta.main) await main()

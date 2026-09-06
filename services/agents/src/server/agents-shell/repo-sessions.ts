import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { AuthContext } from './auth'
import { isInsidePath } from './workspace-policy'

export type RepoSession = {
  id: string
  ownerSubject: string
  baseBranch: string
  baseSha: string
  branch: string
  worktree: string
  createdAt: string
}

const slugify = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug || 'session').slice(0, 40).replace(/-+$/g, '') || 'session'
}

export const createRepoSessionIdentity = (workspaceRoot: string, name?: string | null) => {
  const suffix = randomUUID().slice(0, 8)
  const slug = slugify(name ?? 'session')
  return {
    id: `repo-${slug}-${suffix}`,
    branch: `codex/${slug}-${suffix}`,
    worktree: resolve(workspaceRoot, 'worktrees', 'lab', `${slug}-${suffix}`),
  }
}

export class RepoSessionStore {
  private readonly sessions = new Map<string, RepoSession>()
  private readonly metadataRoot: string
  private readonly worktreeRoot: string

  constructor(workspaceRoot: string) {
    this.metadataRoot = resolve(workspaceRoot, '.agents-shell', 'repo-sessions')
    this.worktreeRoot = resolve(workspaceRoot, 'worktrees', 'lab')
    mkdirSync(this.metadataRoot, { recursive: true })
    this.loadPersistedSessions()
  }

  private metadataPath(sessionId: string) {
    return join(this.metadataRoot, `${sessionId}.json`)
  }

  private parsePersistedSession(value: unknown): RepoSession | null {
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    const fields = ['id', 'ownerSubject', 'baseBranch', 'baseSha', 'branch', 'worktree', 'createdAt'] as const
    if (fields.some((field) => typeof record[field] !== 'string' || record[field].length === 0)) return null
    const session = record as RepoSession
    const expectedMetadataPath = this.metadataPath(session.id)
    if (!isInsidePath(this.metadataRoot, expectedMetadataPath)) return null
    if (!isInsidePath(this.worktreeRoot, resolve(session.worktree))) return null
    return session
  }

  private loadPersistedSessions() {
    for (const entry of readdirSync(this.metadataRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(this.metadataRoot, entry.name)
      try {
        const session = this.parsePersistedSession(JSON.parse(readFileSync(path, 'utf8')))
        if (!session || !existsSync(session.worktree)) {
          unlinkSync(path)
          continue
        }
        this.sessions.set(session.id, session)
      } catch (error) {
        console.warn('[agents-shell] ignoring invalid persisted repo session', { path, error: String(error) })
      }
    }
  }

  private persist(session: RepoSession) {
    const path = this.metadataPath(session.id)
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(session)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, path)
  }

  set(session: RepoSession) {
    this.persist(session)
    this.sessions.set(session.id, session)
    return session
  }

  require(sessionId: string, auth: AuthContext) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`unknown repo session: ${sessionId}`)
    if (session.ownerSubject !== auth.subject) throw new Error(`repo session is owned by another subject: ${sessionId}`)
    return session
  }

  delete(sessionId: string) {
    const deleted = this.sessions.delete(sessionId)
    try {
      unlinkSync(this.metadataPath(sessionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return deleted
  }
}

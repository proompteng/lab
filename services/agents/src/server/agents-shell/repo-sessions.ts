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

type RepoSessionRecord = {
  session: RepoSession
  closing: boolean
  activeOperations: number
  idleWaiters: Set<() => void>
}

const repoSessionRecord = (session: RepoSession): RepoSessionRecord => ({
  session,
  closing: false,
  activeOperations: 0,
  idleWaiters: new Set(),
})

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
  private readonly sessions = new Map<string, RepoSessionRecord>()
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
        this.sessions.set(session.id, repoSessionRecord(session))
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
    this.sessions.set(session.id, repoSessionRecord(session))
    return session
  }

  require(sessionId: string, auth: AuthContext, options: { allowClosing?: boolean } = {}) {
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`unknown repo session: ${sessionId}`)
    if (record.session.ownerSubject !== auth.subject) {
      throw new Error(`repo session is owned by another subject: ${sessionId}`)
    }
    if (record.closing && !options.allowClosing) throw new Error(`repo session is closing: ${sessionId}`)
    return record.session
  }

  beginClose(sessionId: string, auth: AuthContext) {
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`unknown repo session: ${sessionId}`)
    if (record.session.ownerSubject !== auth.subject) {
      throw new Error(`repo session is owned by another subject: ${sessionId}`)
    }
    if (record.closing) throw new Error(`repo session is already closing: ${sessionId}`)
    record.closing = true
    return record.session
  }

  cancelClose(sessionId: string) {
    const record = this.sessions.get(sessionId)
    if (record) record.closing = false
  }

  acquire(sessionId: string, auth: AuthContext) {
    const session = this.require(sessionId, auth)
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`unknown repo session: ${sessionId}`)
    record.activeOperations += 1
    return session
  }

  release(sessionId: string) {
    const record = this.sessions.get(sessionId)
    if (!record) return
    record.activeOperations = Math.max(0, record.activeOperations - 1)
    if (record.activeOperations !== 0) return
    for (const resolveWaiter of record.idleWaiters) resolveWaiter()
    record.idleWaiters.clear()
  }

  waitForIdle(sessionId: string, auth: AuthContext) {
    this.require(sessionId, auth, { allowClosing: true })
    const record = this.sessions.get(sessionId)
    if (!record || record.activeOperations === 0) return Promise.resolve()
    return new Promise<void>((resolvePromise) => record.idleWaiters.add(resolvePromise))
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

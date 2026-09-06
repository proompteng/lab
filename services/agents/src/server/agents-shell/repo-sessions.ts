import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { AuthContext } from './auth'

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

  set(session: RepoSession) {
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
    return this.sessions.delete(sessionId)
  }
}

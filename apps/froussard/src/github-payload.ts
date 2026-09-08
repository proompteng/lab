import { logger } from '@/logger'

import type { Nullable } from './codex'

export interface GithubUser {
  login?: Nullable<string>
}

export interface GithubRepository {
  full_name?: Nullable<string>
  name?: Nullable<string>
  owner?: Nullable<GithubUser>
  default_branch?: Nullable<string>
}

export interface GithubIssue {
  number?: Nullable<number>
  title?: Nullable<string>
  body?: Nullable<string>
  user?: Nullable<GithubUser>
  html_url?: Nullable<string>
  repository_url?: Nullable<string>
  repository?: Nullable<GithubRepository>
}

export interface GithubIssueEventPayload {
  action?: Nullable<string>
  issue?: Nullable<GithubIssue>
  repository?: Nullable<GithubRepository>
  sender?: Nullable<GithubUser>
}

export interface GithubComment {
  id?: Nullable<number>
  body?: Nullable<string>
  html_url?: Nullable<string>
  user?: Nullable<GithubUser>
}

export interface GithubIssueCommentEventPayload {
  action?: Nullable<string>
  issue?: Nullable<GithubIssue>
  comment?: Nullable<GithubComment>
  sender?: Nullable<GithubUser>
  repository?: Nullable<GithubRepository>
}

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export const isGithubIssueEvent = (payload: unknown): payload is GithubIssueEventPayload => {
  if (!isRecord(payload)) {
    return false
  }
  return 'issue' in payload
}

export const isGithubIssueCommentEvent = (payload: unknown): payload is GithubIssueCommentEventPayload => {
  if (!isRecord(payload)) {
    return false
  }
  return 'comment' in payload
}

export const deriveRepositoryFullName = (
  repository?: Nullable<GithubRepository>,
  repositoryUrl?: Nullable<string>,
): string | null => {
  if (repository && typeof repository.full_name === 'string' && repository.full_name.length > 0) {
    return repository.full_name
  }

  if (typeof repositoryUrl === 'string' && repositoryUrl.length > 0) {
    try {
      const parsed = new URL(repositoryUrl)
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (segments.length >= 2) {
        const owner = segments[segments.length - 2]
        const repo = segments[segments.length - 1]
        if (owner && repo) {
          return `${owner}/${repo}`
        }
      }
    } catch (error: unknown) {
      logger.warn({ err: error, repositoryUrl }, 'failed to parse repository url')
    }
  }

  return null
}

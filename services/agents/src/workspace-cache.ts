import { join } from 'node:path'

export const SHARED_WORKSPACE_CACHE_MOUNT_PATH = '/var/cache/agents-shared'
export const LAB_REPOSITORY = 'proompteng/lab'

export const isGitHubCloneBaseUrl = (url: string | null | undefined) =>
  url?.replace(/\/+$/, '') === 'https://github.com'

export const isSafeRepositorySlug = (repository: string) => {
  const parts = repository.split('/')
  return (
    parts.length === 2 && parts.every((part) => part && part !== '.' && part !== '..' && !/[^A-Za-z0-9_.-]/.test(part))
  )
}

export const resolveWorkspaceMirrorPath = (cacheRoot: string, repository: string) =>
  isSafeRepositorySlug(repository) ? join(cacheRoot, 'git', `${repository}.git`) : null

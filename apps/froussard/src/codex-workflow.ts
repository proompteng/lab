import type { Nullable } from './codex'

interface GithubUser {
  login?: Nullable<string>
}

interface GithubRepository {
  full_name?: Nullable<string>
  name?: Nullable<string>
  owner?: Nullable<GithubUser>
  default_branch?: Nullable<string>
}

interface GithubIssue {
  repository?: Nullable<GithubRepository>
}

export const selectReactionRepository = (
  issue?: Nullable<GithubIssue>,
  fallback?: Nullable<GithubRepository>,
): Nullable<GithubRepository> => {
  if (issue?.repository) {
    return issue.repository
  }
  return fallback ?? null
}

export function githubSubjectId(user: { githubId?: unknown }) {
  const githubId = typeof user.githubId === 'string' ? user.githubId : ''
  return /^\d+$/.test(githubId) ? githubId : null
}

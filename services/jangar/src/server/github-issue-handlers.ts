import { createGitHubClient } from '~/server/github-client'
import { isGithubRepoAllowed, loadGithubReviewConfig } from '~/server/github-review-config'

const ISSUE_AUTOMATION_MARKER = '<!-- codex:skip-automation -->'

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const parseRepository = (value: string) => {
  const [owner, repo] = value.split('/')
  if (!owner || !repo) return null
  return { owner: owner.trim(), repo: repo.trim() }
}

const normalizeLabels = (value: unknown) => {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

const ensureSkipMarker = (body: string) => {
  if (body.includes(ISSUE_AUTOMATION_MARKER)) return body
  if (!body.trim()) return ISSUE_AUTOMATION_MARKER
  return `${body}\n\n${ISSUE_AUTOMATION_MARKER}`
}

export const createIssueHandler = async (request: Request) => {
  const config = loadGithubReviewConfig()
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const repository = asString(payload?.repository)
  const title = asString(payload?.title)
  const body = asString(payload?.body) ?? ''
  const labels = normalizeLabels(payload?.labels)

  if (!repository) {
    return jsonResponse({ ok: false, error: 'Repository is required' }, 400)
  }
  const parsedRepo = parseRepository(repository)
  if (!parsedRepo) {
    return jsonResponse({ ok: false, error: 'Repository must be in owner/repo format' }, 400)
  }
  if (!title) {
    return jsonResponse({ ok: false, error: 'Title is required' }, 400)
  }
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }
  if (!config.githubToken) {
    return jsonResponse({ ok: false, error: 'GitHub token unavailable' }, 503)
  }

  try {
    const github = createGitHubClient({ token: config.githubToken, apiBaseUrl: config.githubApiBaseUrl })
    const result = await github.createIssue({
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
      title,
      body: ensureSkipMarker(body),
      labels: labels.length > 0 ? labels : undefined,
    })

    return jsonResponse({
      ok: true,
      issue: {
        number: result.number,
        title: result.title,
        url: result.htmlUrl ?? `https://github.com/${repository}/issues/${result.number}`,
        body: result.body,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create GitHub issue'
    return jsonResponse({ ok: false, error: message }, 500)
  }
}

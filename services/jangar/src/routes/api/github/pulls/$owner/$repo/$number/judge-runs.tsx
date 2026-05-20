import { createFileRoute } from '@tanstack/react-router'
import { fetchCodexRunsByPrFromAgentsService } from '@proompteng/agent-contracts/codex-runs-client'

import { isGithubRepoAllowed, loadGithubReviewConfig } from '~/server/github-review-config'

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

const parseNumberParam = (value: string | undefined) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/judge-runs')({
  server: {
    handlers: {
      GET: async ({ params }: JangarServerRouteArgsWith<JangarGithubPullRouteParams>) =>
        getGithubPullJudgeRunsHandler(params),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

type GithubPullJudgeRunsClient = typeof fetchCodexRunsByPrFromAgentsService

export const getGithubPullJudgeRunsHandler = async (
  params: JangarGithubPullRouteParams,
  client: GithubPullJudgeRunsClient = fetchCodexRunsByPrFromAgentsService,
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  const repository = `${params.owner}/${params.repo}`
  const config = loadGithubReviewConfig()
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const result = await client({ repository, prNumber })
  if (!result.ok) {
    return jsonResponse({ ok: false, error: result.error ?? 'Unable to load judge runs' }, result.status || 502)
  }
  return jsonResponse(result.body)
}

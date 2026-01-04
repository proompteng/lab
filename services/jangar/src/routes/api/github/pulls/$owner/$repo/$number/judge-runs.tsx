import { createFileRoute } from '@tanstack/react-router'

import { createCodexJudgeStore } from '~/server/codex-judge-store'
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
      GET: async ({ params }) => {
        const prNumber = parseNumberParam(params.number)
        if (!prNumber) {
          return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
        }

        const repository = `${params.owner}/${params.repo}`
        const config = loadGithubReviewConfig()
        if (!isGithubRepoAllowed(config, repository)) {
          return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
        }

        const store = createCodexJudgeStore()
        try {
          const runs = await store.listRunsByPrNumber(repository, prNumber)
          return jsonResponse({ ok: true, runs })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to load judge runs'
          return jsonResponse({ ok: false, error: message }, 500)
        } finally {
          await store.close()
        }
      },
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

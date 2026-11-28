import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Schema } from 'effect'
import { approvalBody } from './contracts'

type Review = { id: number; state: string; commit_id: string; body: string; user: { login: string }; html_url: string }
const DraftSchema = Schema.Struct({ commit_id: Schema.String, body: Schema.String })

export const startGithubFixture = async () => {
  const state = {
    head: 'a'.repeat(40),
    ci: 'success',
    draft: false,
    merged: false,
    actor: 'tuslagch',
    codeReviewReady: true,
    thumbsUp: true,
    unresolved: false,
    hideSubmittedLists: true,
    requestCount: 0,
    approvalPosts: 0,
    draftPosts: 0,
    reviews: new Map<number, Review>(),
    afterDraft: async () => {},
    afterSubmit: async () => {},
  }
  const errors: string[] = []
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    state.requestCount++
    const url = new URL(request.url ?? '/', 'http://github.test')
    const path = url.pathname
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (path === '/user') return send({ login: state.actor })
    if (path === '/graphql')
      return send({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: state.unresolved
                  ? [
                      {
                        isResolved: false,
                        comments: {
                          nodes: [
                            { body: 'Fix this', url: 'http://github.test/thread', author: { login: 'reviewer' } },
                          ],
                        },
                      },
                    ]
                  : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      })
    if (/\/pulls\/\d+$/.test(path))
      return send({
        number: Number(path.split('/').at(-1)),
        title: 'Change',
        body: '',
        html_url: 'http://github.test/pull',
        draft: state.draft,
        merged: state.merged,
        state: state.merged ? 'closed' : 'open',
        user: { login: 'gregkonush' },
        head: { ref: 'feature', sha: state.head },
        base: { ref: 'main' },
        mergeable_state: 'clean',
        additions: 1,
        deletions: 0,
        changed_files: 1,
      })
    if (path.endsWith('/reactions'))
      return send(state.thumbsUp ? [{ id: 1, content: '+1', user: { login: 'chatgpt-codex-connector[bot]' } }] : [])
    if (path.endsWith('/comments'))
      return send([
        {
          user: { login: 'chatgpt-codex-connector[bot]' },
          body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: state.head, status: state.codeReviewReady ? 'completed' : 'pending', has_unresolved_findings: false } })} -->`,
        },
      ])
    if (path.endsWith('/check-runs'))
      return send({ check_runs: [{ name: 'CI', status: 'completed', conclusion: state.ci }] })
    if (path.endsWith('/status')) return send({ state: 'success', statuses: [] })
    if (path.endsWith('/actions/runs')) return send({ workflow_runs: [] })
    if (path.endsWith('/reviews') && request.method === 'GET')
      return send(
        state.hideSubmittedLists && [...state.reviews.values()].some((review) => review.state === 'APPROVED')
          ? []
          : [...state.reviews.values()],
      )
    const exact = /\/reviews\/(\d+)(\/events)?$/.exec(path)
    if (exact?.[1]) {
      const review = state.reviews.get(Number(exact[1]))
      if (!review) return send({ message: 'Not found' }, 404)
      if (request.method === 'GET') return send(review)
      if (request.method === 'DELETE' && review.state === 'PENDING') {
        state.reviews.delete(review.id)
        return send({})
      }
      if (request.method === 'POST' && exact[2]) {
        state.approvalPosts++
        if (review.state !== 'PENDING') return send({ message: 'Not pending' }, 422)
        review.state = 'APPROVED'
        await state.afterSubmit()
        return send(review)
      }
    }
    if (path.endsWith('/reviews') && request.method === 'POST') {
      if ([...state.reviews.values()].some((review) => review.state === 'PENDING'))
        return send({ message: 'Pending review exists' }, 422)
      const parts: Buffer[] = []
      for await (const part of request) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
      const data = Schema.decodeUnknownSync(DraftSchema)(JSON.parse(Buffer.concat(parts).toString()))
      if (data.body !== approvalBody(data.commit_id)) return send({ message: 'Invalid automation body' }, 422)
      state.draftPosts++
      const review = {
        id: state.draftPosts,
        state: 'PENDING',
        commit_id: data.commit_id,
        body: data.body,
        user: { login: 'tuslagch' },
        html_url: `http://github.test/reviews/${state.draftPosts}`,
      }
      state.reviews.set(review.id, review)
      await state.afterDraft()
      return send(review)
    }
    errors.push(`${request.method} ${path}`)
    send({ message: 'Unhandled fixture request', path }, 500)
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing GitHub fixture port')
  return {
    state,
    errors,
    origin: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

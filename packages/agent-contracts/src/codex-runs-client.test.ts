import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  AgentsHttpClient,
  type AgentsHttpClientService,
  type AgentsJsonEffectRequest,
  type AgentsServiceJsonSuccess,
} from './agents-http'
import {
  fetchCodexIssuesFromAgentsServiceEffect,
  fetchCodexRecentRunsFromAgentsServiceEffect,
  fetchCodexRunHistoryFromAgentsServiceEffect,
  fetchCodexRunsPageFromAgentsServiceEffect,
} from './codex-runs-client'

describe('codex-runs-client', () => {
  it('fetches Codex run projection APIs from Agents v1 endpoints', async () => {
    const requests: AgentsJsonEffectRequest[] = []
    const client: AgentsHttpClientService = {
      requestJson: <T>(request: AgentsJsonEffectRequest) =>
        Effect.sync(() => {
          requests.push(request)
          return {
            ok: true,
            status: 200,
            body: { ok: true, runs: [], issues: [], total: 0, stats: {} },
          } satisfies AgentsServiceJsonSuccess<T>
        }),
      fetchJson: (path, env) => client.requestJson({ path, env, method: 'GET' }),
      postJson: () => Effect.die('unused'),
      patchJson: () => Effect.die('unused'),
    }
    const layer = Layer.succeed(AgentsHttpClient, client)

    await Effect.runPromise(
      fetchCodexRunHistoryFromAgentsServiceEffect({
        repository: 'owner/repo',
        issueNumber: 123,
        branch: 'codex/split',
        limit: 10,
      }).pipe(Effect.provide(layer)),
    )
    await Effect.runPromise(
      fetchCodexRunsPageFromAgentsServiceEffect({
        repository: 'owner/repo',
        page: 2,
        pageSize: 25,
      }).pipe(Effect.provide(layer)),
    )
    await Effect.runPromise(
      fetchCodexRecentRunsFromAgentsServiceEffect({ repository: 'owner/repo', limit: 20 }).pipe(Effect.provide(layer)),
    )
    await Effect.runPromise(
      fetchCodexIssuesFromAgentsServiceEffect({ repository: 'owner/repo', limit: 50 }).pipe(Effect.provide(layer)),
    )

    expect(requests.map((request) => request.path)).toEqual([
      '/v1/codex/runs?repository=owner%2Frepo&issueNumber=123&branch=codex%2Fsplit&limit=10',
      '/v1/codex/runs/list?repository=owner%2Frepo&page=2&pageSize=25',
      '/v1/codex/runs/recent?repository=owner%2Frepo&limit=20',
      '/v1/codex/issues?repository=owner%2Frepo&limit=50',
    ])
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  })
})

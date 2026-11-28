import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { GithubServiceDefinition } from '@/services/github/service.types'
import type { PullRequestSummary } from '@/services/github/types'
import { readReadyApproval } from './readiness'

const pull: PullRequestSummary = {
  number: 7,
  title: 'Change',
  body: '',
  htmlUrl: 'https://github.com/owner/repo/pull/7',
  draft: false,
  merged: false,
  state: 'open',
  headRef: 'feature',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  authorLogin: 'gregkonush',
  mergeableState: 'clean',
  additions: 1,
  deletions: 0,
  changedFiles: 1,
}
const fixture = () => {
  const service = {
    fetchPullRequest: vi.fn<GithubServiceDefinition['fetchPullRequest']>(() =>
      Effect.succeed({ ok: true, pullRequest: pull }),
    ),
    listPullRequestReviewThreads: vi.fn<GithubServiceDefinition['listPullRequestReviewThreads']>(() =>
      Effect.succeed({ ok: true, threads: [] }),
    ),
    listPullRequestBlockingChecks: vi.fn<GithubServiceDefinition['listPullRequestBlockingChecks']>(() =>
      Effect.succeed({ ok: true, checks: [] }),
    ),
    issueHasReaction: vi.fn<GithubServiceDefinition['issueHasReaction']>(() =>
      Effect.succeed({ ok: true, hasReaction: true }),
    ),
  }
  const run = () =>
    readReadyApproval({
      repositoryFullName: 'owner/repo',
      pullNumber: 7,
      deliveryId: 'delivery',
      github: { token: 'test', apiBaseUrl: 'https://github.test', userAgent: 'test', ackReaction: '+1' },
      githubService: service,
      runGithub: (factory) => Effect.runPromise(factory()),
    })
  return { service, run }
}

describe('durable approval readiness', () => {
  it('retains a current clean head for both Codex and other branches', async () => {
    const api = fixture()
    expect(await api.run()).toMatchObject({ headSha: pull.headSha, pullNumber: 7 })
    api.service.fetchPullRequest.mockReturnValue(
      Effect.succeed({ ok: true, pullRequest: { ...pull, headRef: 'codex/change' } }),
    )
    expect(await api.run()).toMatchObject({ headSha: pull.headSha })
  })
  it.each([{ draft: true }, { state: 'closed' }, { merged: true }, { mergeableState: 'dirty' }, { headSha: '' }])(
    'blocks unsafe pull state %j',
    async (change) => {
      const api = fixture()
      api.service.fetchPullRequest.mockReturnValue(Effect.succeed({ ok: true, pullRequest: { ...pull, ...change } }))
      expect(await api.run()).toBeNull()
    },
  )
  it.each(['queued', 'in_progress', 'failure'])('blocks CI that is %s', async (conclusion) => {
    const api = fixture()
    api.service.listPullRequestBlockingChecks.mockReturnValue(
      Effect.succeed({ ok: true, checks: [{ name: 'CI', conclusion }] }),
    )
    expect(await api.run()).toBeNull()
  })
  it('blocks unresolved threads and a missing thumbs-up reaction', async () => {
    const api = fixture()
    api.service.listPullRequestReviewThreads.mockReturnValueOnce(
      Effect.succeed({ ok: true, threads: [{ summary: 'Fix this' }] }),
    )
    expect(await api.run()).toBeNull()
    api.service.issueHasReaction.mockReturnValue(Effect.succeed({ ok: true, hasReaction: false }))
    expect(await api.run()).toBeNull()
  })
  it.each([
    'fetchPullRequest',
    'listPullRequestReviewThreads',
    'listPullRequestBlockingChecks',
    'issueHasReaction',
  ] as const)('retries when %s cannot be read', async (method) => {
    const api = fixture()
    api.service[method].mockReturnValue(Effect.succeed({ ok: false, reason: 'http-error', status: 503 }))
    await expect(api.run()).rejects.toThrow('503')
  })
})

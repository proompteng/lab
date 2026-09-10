import { afterEach, describe, expect, it, vi } from 'vitest'

import { configureAgentsV1Runtime, resetAgentsV1RuntimeForTests } from '../../../server/v1/runtime'
import type { CodexGithubEventsApiDependencies } from '../../../server/v1/codex-github-events'
import type { CodexRunRecord } from '../../../server/codex-run-projection-store'

import { postCodexGithubEventsHandler } from './github-events'

type CodexGithubEventsTestStore =
  NonNullable<CodexGithubEventsApiDependencies['storeFactory']> extends () => infer Store ? Store : never

const run: CodexRunRecord = {
  id: 'codex-run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/split',
  attempt: 1,
  agentRunName: 'agent-run-1',
  agentRunUid: null,
  agentRunNamespace: 'agents',
  turnId: null,
  threadId: null,
  stage: null,
  status: 'run_complete',
  phase: null,
  iteration: null,
  iterationCycle: null,
  prompt: null,
  nextPrompt: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  ciStatus: null,
  ciUrl: null,
  ciStatusUpdatedAt: null,
  reviewStatus: null,
  reviewSummary: {},
  reviewStatusUpdatedAt: null,
  notifyPayload: null,
  runCompletePayload: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
}

const createStore = () =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listRunsByBranch: vi.fn(async () => [run]),
    listRunsByCommitSha: vi.fn(async () => [run]),
    listRunsByPrNumber: vi.fn(async () => [run]),
    updateCiStatus: vi.fn(async () => ({ ...run, ciStatus: 'success' })),
    updateReviewStatus: vi.fn(async () => ({ ...run, reviewStatus: 'commented' })),
    updateRunPrInfo: vi.fn(async () => ({ ...run, prNumber: 7299 })),
  }) as CodexGithubEventsTestStore

const request = () =>
  new Request('http://agents.local/v1/codex/github-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'pull_request',
      action: 'opened',
      payload: {
        repository: { full_name: 'owner/repo' },
        pull_request: {
          number: 7299,
          html_url: 'https://github.com/owner/repo/pull/7299',
          state: 'open',
          merged: false,
          head: { ref: 'codex/split', sha: 'abcdef1234567890' },
        },
      },
    }),
  })

describe('Codex GitHub event route runtime', () => {
  afterEach(() => {
    resetAgentsV1RuntimeForTests()
  })

  it('uses configured Agents runtime dependencies for GitHub event projection', async () => {
    const store = createStore()
    configureAgentsV1Runtime({
      codexGithubEvents: {
        storeFactory: () => store,
      },
    })

    const response = await postCodexGithubEventsHandler(request())

    expect(response.status).toBe(202)
    expect(store.listRunsByBranch).toHaveBeenCalledWith('owner/repo', 'codex/split')
    expect(store.updateRunPrInfo).toHaveBeenCalledWith(
      'codex-run-1',
      7299,
      'https://github.com/owner/repo/pull/7299',
      'abcdef1234567890',
      'open',
      false,
    )
  })
})

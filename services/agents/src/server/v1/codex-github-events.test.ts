import { describe, expect, it, vi } from 'vitest'

import type { CodexRunRecord } from '../codex-run-projection-store'

import { postCodexGithubEventsHandler } from './codex-github-events'

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

const createStore = () => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  listRunsByBranch: vi.fn(async () => [run]),
  listRunsByCommitSha: vi.fn(async () => [run]),
  listRunsByPrNumber: vi.fn(async () => [run]),
  updateCiStatus: vi.fn(async () => ({ ...run, ciStatus: 'success' })),
  updateReviewStatus: vi.fn(async () => ({ ...run, reviewStatus: 'commented' })),
  updateRunPrInfo: vi.fn(async () => ({ ...run, prNumber: 7299 })),
})

const request = (payload: Record<string, unknown>) =>
  new Request('http://agents.test/v1/codex/github-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('Codex GitHub events v1 API', () => {
  it('projects pull request events into Agents-owned Codex runs', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request({
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
      { storeFactory: () => store },
    )

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
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      event: 'pull_request',
      updatedRunIds: ['codex-run-1'],
    })
  })

  it('projects completed check events into Agents-owned Codex CI status', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request({
        event: 'check_run',
        action: 'completed',
        payload: {
          repository: { full_name: 'owner/repo' },
          check_run: {
            head_sha: 'abcdef1234567890',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/owner/repo/actions/runs/1',
            pull_requests: [{ number: 7299 }],
          },
        },
      }),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.listRunsByCommitSha).toHaveBeenCalledWith('owner/repo', 'abcdef1234567890')
    expect(store.updateCiStatus).toHaveBeenCalledWith({
      runId: 'codex-run-1',
      status: 'success',
      url: 'https://github.com/owner/repo/actions/runs/1',
      commitSha: 'abcdef1234567890',
    })
  })

  it('rejects unsupported GitHub events before opening storage', async () => {
    const storeFactory = vi.fn(() => createStore())

    const response = await postCodexGithubEventsHandler(request({ event: 'ping', payload: {} }), { storeFactory })

    expect(response.status).toBe(422)
    expect(storeFactory).not.toHaveBeenCalled()
  })
})
